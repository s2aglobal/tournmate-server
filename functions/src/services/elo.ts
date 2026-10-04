import { Firestore, DocumentReference } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { MatchDoc, PlayerDoc, RegistrationDoc, TournamentDoc, SportType, parseSportType } from "../types";

/**
 * Elo engine — the single authority for ratings. Matches the iOS
 * `EloEngine` / Android `EloEngine`: K = 24, pairwise winner × loser,
 * applied in place in that order, no rounding.
 *
 * Ratings live per sport in `players.eloRatings`. The legacy `elo` field
 * always holds the badminton rating so app versions from before
 * multi-sport keep showing the right number.
 */

export const ELO_K = 24;
export const DEFAULT_ELO = 1200;

/** Expected score of `rating` against `opponent` (standard Elo formula). */
function expected(rating: number, opponent: number): number {
  return 1 / (1 + Math.pow(10, (opponent - rating) / 400));
}

/**
 * Merges the legacy `elo` field and the `eloRatings` map — same rules as the
 * apps' `resolveEloRatings`. `elo` is the source of truth for badminton,
 * except when a client stored the preferred sport's rating in it.
 */
export function resolveEloRatings(
  legacyElo: number | undefined,
  stored: Record<string, unknown> | undefined,
  preferredSport: SportType,
): Record<string, number> {
  const ratings: Record<string, number> = {};
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) ratings[key] = value;
  }
  const legacy = typeof legacyElo === "number" ? legacyElo : DEFAULT_ELO;
  const writtenAsPreferredSport = preferredSport !== "badminton" &&
    ratings[preferredSport] === legacy &&
    ratings.badminton !== undefined;
  if (!writtenAsPreferredSport) ratings.badminton = legacy;
  return ratings;
}

/**
 * Applies one match result to per-sport ratings in place.
 * Each winner plays each loser in order, using the updated ratings — exactly
 * how the apps' in-place EloEngine loop behaves.
 */
export function applyMatchResult(
  winners: Array<Record<string, number>>,
  losers: Array<Record<string, number>>,
  sport: SportType,
): void {
  for (const w of winners) {
    for (const l of losers) {
      const rw = w[sport] ?? DEFAULT_ELO;
      const rl = l[sport] ?? DEFAULT_ELO;
      w[sport] = rw + ELO_K * (1 - expected(rw, rl));
      l[sport] = rl + ELO_K * (0 - expected(rl, rw));
    }
  }
}

/** Winning registration id from the stored winner, set scores, or simple score. */
export function winnerRegistrationId(match: MatchDoc): string | undefined {
  if (match.winnerRegistrationId) return match.winnerRegistrationId;
  if (match.setScores && match.setScores.length > 0) {
    let a = 0;
    let b = 0;
    for (const s of match.setScores) {
      if (s.teamAPoints > s.teamBPoints) a += 1;
      else if (s.teamBPoints > s.teamAPoints) b += 1;
    }
    if (a !== b) return a > b ? match.teamAId : match.teamBId;
    return undefined;
  }
  if (match.scoreA !== undefined && match.scoreB !== undefined && match.scoreA !== match.scoreB) {
    return match.scoreA > match.scoreB ? match.teamAId : match.teamBId;
  }
  return undefined;
}

type PlayerEntry = { ref: DocumentReference; doc: PlayerDoc; ratings: Record<string, number> };

/** Loads players by id inside the transaction. Older docs may use a lowercase id. */
async function loadPlayers(
  db: Firestore,
  tx: FirebaseFirestore.Transaction,
  ids: string[],
): Promise<PlayerEntry[]> {
  const entries: PlayerEntry[] = [];
  for (const id of ids) {
    for (const candidate of [id, id.toUpperCase(), id.toLowerCase()]) {
      const ref = db.collection("players").doc(candidate);
      const snap = await tx.get(ref);
      if (!snap.exists) continue;
      const doc = snap.data() as PlayerDoc;
      const ratings = resolveEloRatings(doc.elo, doc.eloRatings, parseSportType(doc.preferredSport));
      entries.push({ ref, doc, ratings });
      break;
    }
  }
  return entries;
}

/**
 * Applies Elo and streaks for a finished match, once. Runs in a transaction
 * and marks the match `eloApplied`, so trigger retries or a match that is
 * finished again (e.g. after a dispute) never double-count.
 */
export async function applyEloForMatch(db: Firestore, matchRef: DocumentReference): Promise<void> {
  await db.runTransaction(async (tx) => {
    const matchSnap = await tx.get(matchRef);
    const match = matchSnap.data() as MatchDoc | undefined;
    if (!match || match.statusRaw !== "finished" || match.eloApplied) return;

    const winnerId = winnerRegistrationId(match);
    if (!winnerId) {
      logger.info(`Match ${matchRef.id}: no winner (draw or missing score); skipping Elo.`);
      tx.update(matchRef, { eloApplied: true });
      return;
    }
    const loserId = winnerId === match.teamAId ? match.teamBId : match.teamAId;

    const winnerReg = await tx.get(db.collection("registrations").doc(winnerId));
    const loserReg = await tx.get(db.collection("registrations").doc(loserId));
    const tournamentSnap = await tx.get(db.collection("tournaments").doc(match.tournamentId));
    if (!winnerReg.exists || !loserReg.exists) {
      logger.warn(`Match ${matchRef.id}: registration missing; skipping Elo.`);
      return;
    }

    const tournament = tournamentSnap.data() as TournamentDoc | undefined;
    const sport = parseSportType(match.sportType ?? tournament?.sportType);

    const teamIds = (reg: RegistrationDoc) => [reg.playerId, reg.partnerId].filter(Boolean) as string[];
    const winners = await loadPlayers(db, tx, teamIds(winnerReg.data() as RegistrationDoc));
    const losers = await loadPlayers(db, tx, teamIds(loserReg.data() as RegistrationDoc));
    if (winners.length === 0 || losers.length === 0) {
      logger.warn(`Match ${matchRef.id}: players missing; skipping Elo.`);
      return;
    }

    applyMatchResult(winners.map((e) => e.ratings), losers.map((e) => e.ratings), sport);

    const write = (e: PlayerEntry, won: boolean) => {
      const streak = e.doc.streak ?? 0;
      tx.update(e.ref, {
        eloRatings: e.ratings,
        elo: e.ratings.badminton ?? DEFAULT_ELO,
        streak: won ? Math.max(streak, 0) + 1 : Math.min(streak, 0) - 1,
      });
    };
    winners.forEach((e) => write(e, true));
    losers.forEach((e) => write(e, false));
    tx.update(matchRef, { eloApplied: true });

    logger.info(`Match ${matchRef.id}: Elo applied for ${sport} (${winners.length}v${losers.length}).`);
  });
}
