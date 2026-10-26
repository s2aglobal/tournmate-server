import { CallableRequest, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue, Firestore, Transaction, getFirestore } from "firebase-admin/firestore";
import { MatchDoc, PlayerDoc, RegistrationDoc, TournamentDoc, parseSportType, registrationPlayerIds } from "../types";
import { fail } from "./errors";
import { SetScore, resolveScoring, validateMatchScores, validateSimpleScore } from "../services/scoring";
import {
  CricketResult,
  cricketOutcome,
  decodeCricketResult,
  knockoutIssue,
  knockoutRules,
  outcomeSummary,
  resolveCricketRules,
  validateCricketResult,
} from "../services/cricket";
import { PlayerStats, decodePlayerStats, validatePlayerStats } from "../services/cricketPlayerStats";
import { planElo } from "../services/elo";
import { isTeamEvent, matchWinnerId } from "../services/standings";
import { notifyMatchFinished, notifyScoreDisputed, notifyScoreSubmitted, safely } from "../services/matchNotifications";

/**
 * Score callables: the only way iOS 1.8 / Android 1.1 / web change a score.
 *
 * - `submitScore`: the organizer's score is final; a participant's waits for
 *   the other side (`scoreSubmitted`).
 * - `confirmScore` / `disputeScore`: the opposing side of the submitter only.
 * - `resolveDispute`: organizer sets the final score (also "Edit score").
 *
 * Each writes exactly the match fields the iOS app writes today
 * (`FirestoreMatchRepository`), validates like the apps (`services/scoring.ts`,
 * `services/cricket.ts`, `services/cricketPlayerStats.ts`), and applies Elo in
 * the transaction that finishes the match (`eloApplied`), so the
 * `onMatchFinished` trigger never rates it twice.
 */

const OPTIONS = { region: "us-central1" };

type Side = "A" | "B";
type Fields = Record<string, unknown>;

// ─── Input ──────────────────────────────────────────────

function requireUid(req: CallableRequest): string {
  const uid = req.auth?.uid;
  if (!uid) fail("unauthenticated", "UNAUTHENTICATED", "Sign in to continue.");
  return uid;
}

function input(req: CallableRequest): Record<string, unknown> {
  const data = req.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Something went wrong. Update the app and try again.");
  }
  return data as Record<string, unknown>;
}

function requireMatchId(data: Record<string, unknown>): string {
  const id = data.matchId;
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || id.includes("/")) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Missing match.");
  }
  return id;
}

interface PlayerOfMatchInput {
  key: string;
  name: string;
  teamRegistrationId: string;
}

type Score =
  | { kind: "sets"; sets: SetScore[] }
  | { kind: "simple"; scoreA: number; scoreB: number }
  | { kind: "cricket"; result: CricketResult; playerOfMatch: PlayerOfMatchInput | null; stats: PlayerStats | null };

/** Reads the score from the request: cricket scorecard, set scores, or a simple score. */
function parseScore(data: Record<string, unknown>, teamEvent: boolean): Score {
  if (teamEvent) {
    const c = data.cricket;
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      fail("invalid-argument", "INVALID_ARGUMENT", "Enter the scorecard.");
    }
    const cricket = c as Record<string, unknown>;
    const json = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
    const result = decodeCricketResult(json(cricket.resultData));
    if (!result) fail("invalid-argument", "INVALID_SCORE", "The scorecard couldn't be read. Update the app and try again.");

    let stats: PlayerStats | null = null;
    if (cricket.playerStatsData !== undefined && cricket.playerStatsData !== null && cricket.playerStatsData !== "") {
      stats = decodePlayerStats(json(cricket.playerStatsData));
      if (!stats) fail("invalid-argument", "INVALID_SCORE", "The player figures couldn't be read. Update the app and try again.");
    }

    const { playerOfMatchKey: key, playerOfMatchName: name, playerOfMatchTeamId: team } = cricket;
    let playerOfMatch: PlayerOfMatchInput | null = null;
    if ([key, name, team].some((v) => v !== undefined && v !== null)) {
      if (typeof key !== "string" || !key || typeof name !== "string" || !name || typeof team !== "string" || !team) {
        fail("invalid-argument", "INVALID_ARGUMENT", "Choose the Player of the Match again.");
      }
      playerOfMatch = { key, name, teamRegistrationId: team };
    }
    return { kind: "cricket", result, playerOfMatch, stats };
  }
  if (data.cricket !== undefined && data.cricket !== null) {
    fail("invalid-argument", "INVALID_ARGUMENT", "This match is scored in games, not with a scorecard.");
  }
  if (Array.isArray(data.setScores) && data.setScores.length > 0) {
    return { kind: "sets", sets: data.setScores as SetScore[] };
  }
  if (data.scoreA !== undefined || data.scoreB !== undefined) {
    return { kind: "simple", scoreA: data.scoreA as number, scoreB: data.scoreB as number };
  }
  fail("invalid-argument", "INVALID_SCORE", "Enter the score.");
}

// ─── Loading and roles ──────────────────────────────────

interface Loaded {
  match: MatchDoc;
  tournament: TournamentDoc;
  regA: RegistrationDoc | null;
  regB: RegistrationDoc | null;
}

async function load(db: Firestore, tx: Transaction, matchId: string): Promise<Loaded> {
  const matchSnap = await tx.get(db.collection("matches").doc(matchId));
  if (!matchSnap.exists) fail("not-found", "NOT_FOUND", "This match no longer exists.");
  const match = matchSnap.data() as MatchDoc;
  const tSnap = await tx.get(db.collection("tournaments").doc(match.tournamentId));
  if (!tSnap.exists) fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
  const [a, b] = await Promise.all([
    tx.get(db.collection("registrations").doc(match.teamAId)),
    tx.get(db.collection("registrations").doc(match.teamBId)),
  ]);
  return {
    match,
    tournament: tSnap.data() as TournamentDoc,
    regA: a.exists ? (a.data() as RegistrationDoc) : null,
    regB: b.exists ? (b.data() as RegistrationDoc) : null,
  };
}

/** Upper-cased ids of every player profile linked to `uid`. */
async function playerIdsForUid(db: Firestore, uid: string, tx?: Transaction): Promise<Set<string>> {
  const query = db.collection("players").where("firebaseUid", "==", uid);
  const snap = tx ? await tx.get(query) : await query.get();
  return new Set(snap.docs.map((d) => d.id.toUpperCase()));
}

function hasUidLists(match: MatchDoc): boolean {
  return Array.isArray(match.teamAUids) || Array.isArray(match.teamBUids);
}

/**
 * The side `uid` plays for: `teamAUids` / `teamBUids` when the match has
 * them; otherwise the registrations' player, partner and roster ids against
 * the caller's player profiles (ids in any case).
 */
function sideOf(l: Loaded, uid: string, playerIds: Set<string>): Side | null {
  if (hasUidLists(l.match)) {
    if (l.match.teamAUids?.includes(uid)) return "A";
    if (l.match.teamBUids?.includes(uid)) return "B";
    return null;
  }
  const plays = (reg: RegistrationDoc | null) =>
    !!reg && registrationPlayerIds(reg).some((id) => playerIds.has(id.toUpperCase()));
  if (plays(l.regA)) return "A";
  if (plays(l.regB)) return "B";
  return null;
}

/**
 * The side that submitted the pending score. `submittedBy` is the
 * submitter's auth uid (apps); the old REST API stored a player id.
 */
async function submitterSide(db: Firestore, tx: Transaction, l: Loaded): Promise<Side | null> {
  const by = l.match.submittedBy;
  if (!by) return null;
  if (hasUidLists(l.match)) {
    const side = sideOf(l, by, new Set());
    if (side) return side;
  }
  const ids = await playerIdsForUid(db, by, tx);
  ids.add(by.toUpperCase());
  return sideOf({ ...l, match: { ...l.match, teamAUids: undefined, teamBUids: undefined } }, by, ids);
}

function isOrganizer(l: Loaded, uid: string): boolean {
  return !!l.tournament.createdBy && l.tournament.createdBy === uid;
}

function requireParticipant(l: Loaded, uid: string, playerIds: Set<string>, message: string): Side {
  const side = sideOf(l, uid, playerIds);
  if (side) return side;
  if (!hasUidLists(l.match) && playerIds.size === 0) {
    fail("failed-precondition", "NO_PROFILE", "Create your player profile first.");
  }
  fail("permission-denied", "NOT_PARTICIPANT", message);
}

// ─── Match fields (as iOS FirestoreMatchRepository writes them) ─────────

/** A field update plus the match as it will be stored. */
class Patch {
  readonly fields: Fields = {};
  readonly after: MatchDoc;
  constructor(match: MatchDoc) {
    this.after = { ...match };
  }
  set(key: string, value: unknown): this {
    this.fields[key] = value;
    (this.after as unknown as Fields)[key] = value;
    return this;
  }
  delete(key: string): this {
    this.fields[key] = FieldValue.delete();
    delete (this.after as unknown as Fields)[key];
    return this;
  }
  setOrDelete(key: string, value: unknown): this {
    return value === null || value === undefined ? this.delete(key) : this.set(key, value);
  }
}

function winnerFor(a: number, b: number, match: MatchDoc): string | null {
  if (a === b) return null;
  return a > b ? match.teamAId : match.teamBId;
}

/** `applySetScores`: sets, games won per side and the winner. */
function applySetScores(p: Patch, sets: SetScore[], match: MatchDoc): Patch {
  const a = sets.filter((s) => s.teamAPoints > s.teamBPoints).length;
  const b = sets.filter((s) => s.teamBPoints > s.teamAPoints).length;
  return p
    .set("setScores", sets.map((s) => ({ teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints })))
    .set("scoreA", a)
    .set("scoreB", b)
    .setOrDelete("winnerRegistrationId", winnerFor(a, b, match));
}

/** `writeFinalScore`: organizer's simple score; replaces any game-by-game score. */
function applyFinalScore(p: Patch, a: number, b: number, match: MatchDoc): Patch {
  return p
    .set("scoreA", a)
    .set("scoreB", b)
    .delete("setScores")
    .set("statusRaw", "finished")
    .setOrDelete("winnerRegistrationId", winnerFor(a, b, match));
}

/** Sorted keys, compact, `/` escaped: Swift `JSONEncoder` with `.sortedKeys`. */
function encodeSorted(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, sort(o[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value)).replace(/\//g, "\\/");
}

function encodeResult(r: CricketResult): string {
  return encodeSorted({
    innings: r.innings.map((i) => ({
      battingRegistrationId: i.battingRegistrationId, runs: i.runs, wickets: i.wickets, balls: i.balls,
    })),
    revisedTarget: r.revisedTarget ? { runs: r.revisedTarget.runs, overs: r.revisedTarget.overs } : undefined,
    superOverWinnerRegistrationId: r.superOverWinnerRegistrationId,
    noResult: r.noResult,
  });
}

function encodeStats(s: PlayerStats): string {
  return encodeSorted({
    batting: s.batting.map((f) => ({
      teamRegistrationId: f.teamRegistrationId, key: f.key, name: f.name, runs: f.runs, balls: f.balls, out: f.out,
    })),
    bowling: s.bowling.map((f) => ({
      teamRegistrationId: f.teamRegistrationId, key: f.key, name: f.name, balls: f.balls, runs: f.runs, wickets: f.wickets,
    })),
  });
}

/** Player names for a registration's display name (`Registration.displayName()`). */
async function registrationName(db: Firestore, tx: Transaction, reg: RegistrationDoc | null): Promise<string> {
  if (!reg) return "";
  if (reg.teamName) return reg.teamName;
  const name = async (id: string | undefined): Promise<string | null> => {
    if (!id) return null;
    for (const candidate of [...new Set([id, id.toUpperCase(), id.toLowerCase()])]) {
      const snap = await tx.get(db.collection("players").doc(candidate));
      if (snap.exists) return (snap.data() as PlayerDoc).name ?? "";
    }
    return null;
  };
  return [await name(reg.playerId), await name(reg.partnerId)].filter((n): n is string => n !== null).join(" & ");
}

/**
 * Validates a cricket scorecard like the app (`submitCricketResult`) and
 * applies its fields. `final` = organizer (finished at once).
 */
async function applyCricket(
  db: Firestore,
  tx: Transaction,
  p: Patch,
  l: Loaded,
  score: Extract<Score, { kind: "cricket" }>,
  uid: string,
  final: boolean,
): Promise<Patch> {
  const { match, tournament } = l;
  const teamA = match.teamAId;
  const teamB = match.teamBId;
  const rules = knockoutRules(resolveCricketRules(tournament.rulesData), tournament.matchFormatRaw, match.groupLabel);
  const issue = validateCricketResult(score.result, rules, teamA, teamB)[0] ??
    knockoutIssue(score.result, rules, tournament.matchFormatRaw, match.groupLabel);
  if (issue) fail("invalid-argument", "INVALID_SCORE", issue.message);

  const nameA = await registrationName(db, tx, l.regA);
  const nameB = await registrationName(db, tx, l.regB);
  const names = (id: string) => (id === teamA ? nameA : nameB);
  if (score.stats) {
    const statsIssue = validatePlayerStats(score.stats, score.result, teamA, teamB, names)[0];
    if (statsIssue) fail("invalid-argument", "INVALID_SCORE", statsIssue.message);
  }
  // No award for an abandoned match.
  const pom = score.result.noResult ? null : score.playerOfMatch;
  if (pom && pom.teamRegistrationId !== teamA && pom.teamRegistrationId !== teamB) {
    fail("invalid-argument", "INVALID_ARGUMENT", "The Player of the Match must play for one of the two teams.");
  }

  const outcome = cricketOutcome(score.result, rules);
  const summary = outcomeSummary(outcome, names);
  const runs = (id: string) => score.result.innings.find((i) => i.battingRegistrationId === id)?.runs ?? null;
  const statsJson = score.stats && (score.stats.batting.length > 0 || score.stats.bowling.length > 0)
    ? encodeStats(score.stats) : null;

  p.set("resultData", encodeResult(score.result))
    .set("resultType", outcome.resultType)
    .set("summary", summary)
    .setOrDelete("winnerRegistrationId", outcome.winnerRegistrationId)
    .setOrDelete("scoreA", runs(teamA))
    .setOrDelete("scoreB", runs(teamB))
    .delete("setScores")
    .set("submittedBy", uid)
    .set("statusRaw", final ? "finished" : "scoreSubmitted")
    .setOrDelete("playerOfMatchKey", pom?.key)
    .setOrDelete("playerOfMatchName", pom?.name)
    .setOrDelete("playerOfMatchTeamId", pom?.teamRegistrationId)
    .setOrDelete("playerStatsData", statsJson);
  if (final) p.set("confirmedBy", uid);
  return p;
}

function validateSets(sets: SetScore[], l: Loaded): void {
  const sport = parseSportType(l.tournament.sportType);
  const { config, enforce } = resolveScoring(l.tournament.scoringConfigData, sport);
  const issue = validateMatchScores(sets, config, enforce, sport)[0];
  if (issue) fail("invalid-argument", "INVALID_SCORE", issue.message);
}

function validateSimple(a: unknown, b: unknown, l: Loaded): void {
  const sport = parseSportType(l.tournament.sportType);
  const { config, enforce } = resolveScoring(l.tournament.scoringConfigData, sport);
  const issue = validateSimpleScore(a, b, config, enforce, sport)[0];
  if (issue) fail("invalid-argument", "INVALID_SCORE", issue.message);
}

/** Organizer's final score (`finalizeMatch`, `submitAndConfirmSetScores`, cricket `final`). */
async function organizerFinal(db: Firestore, tx: Transaction, l: Loaded, score: Score, uid: string): Promise<Patch> {
  const p = new Patch(l.match);
  switch (score.kind) {
    case "cricket":
      return applyCricket(db, tx, p, l, score, uid, true);
    case "simple":
      validateSimple(score.scoreA, score.scoreB, l);
      return applyFinalScore(p, score.scoreA, score.scoreB, l.match);
    case "sets":
      validateSets(score.sets, l);
      // Submit, then confirm with the submitted scores and winner.
      return applySetScores(p, score.sets, l.match)
        .set("submittedBy", uid)
        .set("confirmedBy", uid)
        .set("statusRaw", "finished");
  }
}

// ─── Commit ─────────────────────────────────────────────

interface Committed {
  match: MatchDoc;
  /** Elo was applied (and `eloApplied` set) by this write. */
  ratedNow: boolean;
}

/**
 * Writes the patch. When it finishes a match not yet rated, Elo is planned
 * from the stored-to-be match and committed in the same transaction.
 * Reads happen in `planElo`, so call this after every other read.
 */
async function commit(db: Firestore, tx: Transaction, matchId: string, l: Loaded, p: Patch): Promise<Committed> {
  let ratedNow = false;
  const ref = db.collection("matches").doc(matchId);
  // `disputeReason` (server-only) describes the current dispute; any other
  // outcome (resolved, resubmitted, finished) clears it.
  if (p.after.statusRaw !== "disputed" && l.match.disputeReason !== undefined) {
    p.delete("disputeReason");
  }
  if (p.after.statusRaw === "finished" && l.match.eloApplied !== true) {
    const plan = await planElo(db, tx, matchId, p.after);
    if (plan.markApplied) {
      p.set("eloApplied", true);
      ratedNow = true;
    }
    tx.update(ref, p.fields);
    plan.write(tx);
  } else {
    tx.update(ref, p.fields);
  }
  return { match: p.after, ratedNow };
}

async function afterFinish(db: Firestore, matchId: string, c: Committed): Promise<void> {
  // The onMatchFinished trigger skips matches this write rated, so the teams
  // hear about the result exactly once.
  if (c.ratedNow) await safely(`Result notification for ${matchId}`, () => notifyMatchFinished(db, matchId, c.match));
}

// ─── Callables ──────────────────────────────────────────

/**
 * `submitScore({ matchId, scoreA, scoreB, setScores?, cricket? })` →
 * `{ status }`. Organizer → finished; participant (scheduled match only) →
 * `scoreSubmitted` for the other side to confirm.
 *
 * Score forms: `setScores` (game by game); `scoreA`/`scoreB` (single-result
 * matches; a participant's is stored as one game, like the app); `cricket:
 * { resultData, playerOfMatchKey?, playerOfMatchName?, playerOfMatchTeamId?,
 * playerStatsData? }` for team events.
 */
export const submitScore = onCall(OPTIONS, async (req) => {
  const uid = requireUid(req);
  const data = input(req);
  const matchId = requireMatchId(data);
  const db = getFirestore();
  const playerIds = await playerIdsForUid(db, uid);

  let side: Side | null = null;
  const committed = await db.runTransaction(async (tx) => {
    const l = await load(db, tx, matchId);
    const score = parseScore(data, isTeamEvent(l.tournament));
    if (isOrganizer(l, uid)) {
      side = null;
      return commit(db, tx, matchId, l, await organizerFinal(db, tx, l, score, uid));
    }
    side = requireParticipant(l, uid, playerIds, "Only the players in this match or the organizer can enter its score.");
    if (l.match.statusRaw !== "scheduled") {
      fail("failed-precondition", "SCORE_LOCKED", "A score has already been entered for this match.");
    }
    const p = new Patch(l.match);
    if (score.kind === "cricket") {
      await applyCricket(db, tx, p, l, score, uid, false);
    } else {
      let sets: SetScore[];
      if (score.kind === "simple") {
        validateSimple(score.scoreA, score.scoreB, l);
        sets = [{ teamAPoints: score.scoreA, teamBPoints: score.scoreB }];
      } else {
        validateSets(score.sets, l);
        sets = score.sets;
      }
      applySetScores(p, sets, l.match).set("submittedBy", uid).set("statusRaw", "scoreSubmitted");
    }
    return commit(db, tx, matchId, l, p);
  });

  logger.info(`submitScore ${matchId}: ${committed.match.statusRaw} by ${side ? `side ${side}` : "organizer"}`);
  await afterFinish(db, matchId, committed);
  if (side && committed.match.statusRaw === "scoreSubmitted") {
    const s: Side = side;
    await safely(`Score notification for ${matchId}`, () => notifyScoreSubmitted(db, matchId, committed.match, s));
  }
  return { status: committed.match.statusRaw };
});

/** Pending score + caller on the side that didn't submit it. */
async function requireOpponent(
  db: Firestore,
  tx: Transaction,
  l: Loaded,
  uid: string,
  playerIds: Set<string>,
  action: string,
): Promise<Side> {
  if (l.match.statusRaw !== "scoreSubmitted") {
    fail("failed-precondition", "SCORE_LOCKED", `There's no submitted score to ${action}.`);
  }
  const side = requireParticipant(l, uid, playerIds, `Only the other team can ${action} this score.`);
  const submitted = await submitterSide(db, tx, l);
  if (submitted ? submitted === side : l.match.submittedBy === uid) {
    fail("permission-denied", "NOT_PARTICIPANT", `The other team has to ${action} the score you entered.`);
  }
  return side;
}

/** `confirmScore({ matchId })` → `{ status: "finished" }`. Opposing side only. */
export const confirmScore = onCall(OPTIONS, async (req) => {
  const uid = requireUid(req);
  const matchId = requireMatchId(input(req));
  const db = getFirestore();
  const playerIds = await playerIdsForUid(db, uid);

  const committed = await db.runTransaction(async (tx) => {
    const l = await load(db, tx, matchId);
    await requireOpponent(db, tx, l, uid, playerIds, "confirm");
    const p = new Patch(l.match).set("confirmedBy", uid).set("statusRaw", "finished");
    p.setOrDelete("winnerRegistrationId", matchWinnerId(p.after));
    return commit(db, tx, matchId, l, p);
  });

  logger.info(`confirmScore ${matchId}: finished`);
  await afterFinish(db, matchId, committed);
  return { status: committed.match.statusRaw };
});

/** `disputeScore({ matchId, reason? })` → `{ status: "disputed" }`. Opposing side only; the organizer is told. */
export const disputeScore = onCall(OPTIONS, async (req) => {
  const uid = requireUid(req);
  const data = input(req);
  const matchId = requireMatchId(data);
  const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 500) : "";
  const db = getFirestore();
  const playerIds = await playerIdsForUid(db, uid);

  let tournament: TournamentDoc | null = null;
  const committed = await db.runTransaction(async (tx) => {
    const l = await load(db, tx, matchId);
    tournament = l.tournament;
    await requireOpponent(db, tx, l, uid, playerIds, "dispute");
    return commit(db, tx, matchId, l, new Patch(l.match).set("statusRaw", "disputed").setOrDelete("disputeReason", reason || null));
  });

  logger.info(`disputeScore ${matchId}: disputed`);
  const t = tournament as TournamentDoc | null;
  if (t) {
    await safely(`Dispute notification for ${matchId}`,
      () => notifyScoreDisputed(db, matchId, committed.match, t, reason || undefined));
  }
  return { status: committed.match.statusRaw };
});

/**
 * `resolveDispute({ matchId, setScores | scoreA+scoreB | cricket })` →
 * `{ status: "finished" }`. Organizer only; any status (also "Edit score" on a
 * finished match). Set scores write what the app's `resolveDispute` writes; a
 * simple score or scorecard is the organizer's final score.
 */
export const resolveDispute = onCall(OPTIONS, async (req) => {
  const uid = requireUid(req);
  const data = input(req);
  const matchId = requireMatchId(data);
  const db = getFirestore();

  const committed = await db.runTransaction(async (tx) => {
    const l = await load(db, tx, matchId);
    if (!isOrganizer(l, uid)) fail("permission-denied", "NOT_ORGANIZER", "Only the organizer can set this score.");
    const score = parseScore(data, isTeamEvent(l.tournament));
    let p: Patch;
    if (score.kind === "sets") {
      validateSets(score.sets, l);
      p = applySetScores(new Patch(l.match), score.sets, l.match).set("statusRaw", "finished");
    } else {
      p = await organizerFinal(db, tx, l, score, uid);
    }
    return commit(db, tx, matchId, l, p);
  });

  logger.info(`resolveDispute ${matchId}: finished`);
  await afterFinish(db, matchId, committed);
  return { status: committed.match.statusRaw };
});
