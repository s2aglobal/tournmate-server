import { FieldValue, Firestore } from "firebase-admin/firestore";
import { DrawState, loadDrawState } from "./draw/tournament";
import { isTournamentFinished } from "./tournamentProgress";

/*
 * Server-maintained `finished` / `finishedAt` on the tournament doc, so the
 * apps' tournament lists can show COMPLETED without reading every match.
 * Written only by the server (firestore.rules locks both):
 *
 *   finished:   isTournamentFinished(...) of the current matches (all sports;
 *               a Manual Draw counts as finished whenever every match created
 *               so far is, exactly like the awards).
 *   finishedAt: when `finished` last became true; removed when it goes back
 *               to false (a new Manual Draw match, an edited result, a reset).
 *
 * Kept in step by the match trigger (triggers/onMatchWritten.ts) and cleared by
 * resetDraw; `scripts/backfillTournamentFinished.ts` sets it on older docs.
 * Only written when the stored value differs, and no tournament trigger reacts
 * to these fields, so there is no write loop.
 */

/** Whether the tournament in `state` has finished (tournamentProgress.ts). */
export function finishedFor(state: DrawState): boolean {
  const t = state.tournament;
  return isTournamentFinished({
    matchFormat: t.matchFormat,
    swissRounds: t.config.swissRounds,
    advancingPerGroup: t.config.advancingPerGroup,
    formedTeamCount: state.formedTeams.length,
    matches: state.matches.map((m) => m.doc),
  });
}

/** The update that stores `finished` (null when the stored value already matches). */
export function finishedUpdate(stored: unknown, finished: boolean): Record<string, unknown> | null {
  if (stored === finished) return null;
  return finished
    ? { finished: true, finishedAt: FieldValue.serverTimestamp() }
    : { finished: false, finishedAt: FieldValue.delete() };
}

export type FinishedSync = "set" | "unset" | "unchanged" | "missing";

/**
 * Recomputes `finished` for a tournament and writes it when it differs.
 * `dryRun` only reports what would change (backfill script).
 */
export async function syncTournamentFinished(db: Firestore, tournamentId: string, dryRun = false): Promise<FinishedSync> {
  return db.runTransaction(async (tx) => {
    const state = await loadDrawState(db, tournamentId, tx);
    if (!state) return "missing";
    const finished = finishedFor(state);
    const update = finishedUpdate((state.tournament.doc as { finished?: unknown }).finished, finished);
    if (!update) return "unchanged";
    if (!dryRun) tx.update(state.tournamentRef, update);
    return finished ? "set" : "unset";
  });
}
