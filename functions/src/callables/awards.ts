import { onCall } from "firebase-functions/v2/https";
import { DocumentData, getFirestore, Timestamp } from "firebase-admin/firestore";
import { fail } from "./errors";
import { CALLABLE_OPTS, Data, dataOf, requireString, requireUid } from "./shared";
import { resolveDocId } from "../services/identity";
import {
  AWARD_SLOTS, AwardSlot, AwardsDoc, loadAwardContext, notifyWinners, organizerValue, rosterMember, writeAwards,
} from "../services/tournamentAwards";

/**
 * setTournamentAwards({ tournamentId, playerOfSeries?, bestBatter?, bestBowler? })
 *   -> { awards } (timestamps as epoch milliseconds)
 * Organizer only, cricket only, once the tournament has finished. Each award
 * is `{ key }` (a player id or `guest:<name>` on a team roster in this
 * tournament) or `null` to clear it; omitted awards keep their value. Set or
 * cleared awards become source "organizer" and are never auto-updated again.
 * The server fills name, teamId and (batter/bowler) the stats. A newly
 * awarded registered player is notified (`award_won`).
 */
export const setTournamentAwards = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const tournamentId = requireString(d, "tournamentId", 64);
  const input: Partial<Record<AwardSlot, string | null>> = {};
  for (const slot of AWARD_SLOTS) {
    if (!(slot in d) || d[slot] === undefined) continue;
    const v = d[slot];
    if (v === null) {
      input[slot] = null;
      continue;
    }
    if (typeof v !== "object" || Array.isArray(v)) {
      fail("invalid-argument", "INVALID_ARGUMENT", `${slot} must be { key } or null.`);
    }
    const key = (v as Data).key;
    if (typeof key !== "string" || key.trim().length === 0 || key.length > 100) {
      fail("invalid-argument", "INVALID_ARGUMENT", `Pick a player for ${slot}.`);
    }
    input[slot] = key;
  }
  const db = getFirestore();
  const tid = await resolveDocId(db, "tournaments", tournamentId);

  const result = await db.runTransaction(async (tx) => {
    const ctx = await loadAwardContext(db, tid, tx);
    if (!ctx) fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
    const t = ctx.state.tournament.doc;
    if (!t.createdBy || t.createdBy !== uid) {
      fail("permission-denied", "NOT_ORGANIZER", "Only the organizer can set the awards.");
    }
    if (!ctx.isCricket) fail("failed-precondition", "SPORT_NOT_ALLOWED", "Awards are only for cricket tournaments.");
    if (!ctx.finished) {
      fail("failed-precondition", "NOT_FINISHED", "Awards can be set once the tournament is finished.");
    }
    const overrides: Partial<Record<AwardSlot, DocumentData | null>> = {};
    for (const slot of AWARD_SLOTS) {
      if (!(slot in input)) continue;
      const key = input[slot];
      if (key === null || key === undefined) {
        overrides[slot] = null;
        continue;
      }
      const member = rosterMember(ctx, key);
      if (!member) {
        fail("invalid-argument", "INVALID_ARGUMENT", "Awards can only go to players on a team in this tournament.");
      }
      overrides[slot] = organizerValue(slot, member, ctx);
    }
    const w = writeAwards(tx, ctx, overrides);
    const current = w.awards ?? ((t as unknown as DocumentData).awards as AwardsDoc);
    return { w, current, title: t.title, id: ctx.state.tournament.id };
  });

  if (result.w.awards) await notifyWinners(db, result.id, result.title, result.w.awards, result.w.newWinners);
  return { awards: plain(result.current) };
});

/** Awards with timestamps as epoch milliseconds (callable responses can't carry Timestamps). */
function plain(a: AwardsDoc | undefined): Record<string, unknown> | null {
  if (!a) return null;
  const out: Record<string, unknown> = { ...a };
  for (const k of ["computedAt", "updatedAt"] as const) {
    const v = a[k];
    out[k] = v instanceof Timestamp ? v.toMillis() : v ?? null;
  }
  return out;
}
