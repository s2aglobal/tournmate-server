import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { DocumentReference, FieldValue, Firestore, Timestamp, Transaction, getFirestore } from "firebase-admin/firestore";
import { fail } from "./errors";
import { CALLABLE_OPTS, Data, dataOf, requireUid } from "./shared";
import {
  Committed, Loaded, Patch, Side, afterFinish, applyGames, commit, isOrganizer, load, playerIdsForUid,
  requireParticipant, sideOf,
} from "./scores";
import { PlayerRef, playerForUid, resolveDocId } from "../services/identity";
import { resolveScoring } from "../services/scoring";
import { parseSportType } from "../types";
import { SPORTS_CONFIG_COLLECTION, SPORTS_CONFIG_DOC_ID } from "../config/sportsCatalog";
import {
  RacketConfig, RacketEvent, RacketRuleError, RacketSide, RacketSport, RacketState, applyRacketEvent, gameNumber,
  isRacketSport, playable, racketConfig, racketLiveSummary, replayRacket, toRacketResult, undoLastPoint, BAD_POINT,
} from "../services/racketLive";
import { notifyScoreSubmitted, safely } from "../services/matchNotifications";

/**
 * Racket live scoring callables, badminton first (contract: racket-live-contract.md).
 * Every action is applied to the reference reducer (`services/racketLive.ts`)
 * replayed from the event log in `matches/{id}/racketLive/state`; the match's
 * `live` summary and the `points/{pointId}` docs are projections written in
 * the same transaction. Finishing writes the result through the score
 * callables' own code (`applyGames` + `commit`), so it is identical to a
 * manual entry. Mirrors callables/cricketLive.ts (kept separate so cricket is
 * untouched); `stopLiveScoring` there hands racket matches to `stopRacketLive`.
 */

export const RACKET_TAKEOVER_MS = 3 * 60 * 1000;
const ACTIVE = ["inProgress", "ended"];
const DISABLED = "Live scoring isn't available for this sport yet.";
const NOT_SCORER = "Only the scorer can do this. Take over scoring first.";

type Live = Record<string, unknown> & {
  kind: "racket";
  status: string;
  scorerUid: string;
  scorerName: string;
  scorerSince?: Timestamp;
  lastPointAt?: Timestamp;
  seq?: number;
};

interface LogDoc {
  config: RacketConfig;
  events: RacketEvent[];
}

interface Ctx {
  db: Firestore;
  tx: Transaction;
  matchId: string;
  ref: DocumentReference;
  stateRef: DocumentReference;
  l: Loaded;
  sport: RacketSport;
  live: Live | null;
  log: LogDoc | null;
  uid: string;
}

/** Firestore-safe copy (drops undefined). */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Keeps Timestamps (plain() would flatten them). */
function plainLive(live: Record<string, unknown>): Live {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(live)) {
    if (v === undefined) continue;
    out[k] = v instanceof Timestamp ? v : plain(v);
  }
  return out as Live;
}

function requireMatchId(d: Data): string {
  const id = d.matchId;
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || id.includes("/")) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Missing match.");
  }
  return id;
}

function requireEventId(d: Data, key: string): string {
  const id = d[key];
  if (typeof id !== "string" || id.length === 0 || id.length > 64 || id.includes("/")) {
    fail("invalid-argument", "INVALID_ARGUMENT", `Missing ${key}.`);
  }
  return id;
}

function sideArg(v: unknown): RacketSide {
  if (v !== "A" && v !== "B") fail("invalid-argument", "INVALID_POINT", BAD_POINT);
  return v;
}

/** The racket sports switched on in `config/sports.liveScoring` (absent = off). */
async function liveScoringEnabled(db: Firestore, tx: Transaction, sport: RacketSport): Promise<boolean> {
  const snap = await tx.get(db.collection(SPORTS_CONFIG_COLLECTION).doc(SPORTS_CONFIG_DOC_ID));
  const map = snap.exists ? snap.get("liveScoring") : undefined;
  return !!map && typeof map === "object" && (map as Record<string, unknown>)[sport] === true;
}

async function open(db: Firestore, tx: Transaction, matchId: string, uid: string): Promise<Ctx> {
  const ref = db.collection("matches").doc(matchId);
  const stateRef = ref.collection("racketLive").doc("state");
  const l = await load(db, tx, matchId);
  const stateSnap = await tx.get(stateRef);
  const sport = parseSportType(l.tournament.sportType);
  if (!isRacketSport(sport)) fail("failed-precondition", "LIVE_SCORING_DISABLED", DISABLED);
  const raw = l.match.live as Live | undefined;
  return {
    db, tx, matchId, ref, stateRef, l, sport, uid,
    live: raw && typeof raw.status === "string" && raw.kind === "racket" ? raw : null,
    log: stateSnap.exists ? (stateSnap.data() as LogDoc) : null,
  };
}

async function canScore(c: Ctx): Promise<boolean> {
  if (isOrganizer(c.l, c.uid)) return true;
  return sideOf(c.l, c.uid, await playerIdsForUid(c.db, c.uid, c.tx)) !== null;
}

function requireNotFinished(c: Ctx): void {
  if (c.live?.status === "finished" || c.l.match.statusRaw !== "scheduled") {
    fail("failed-precondition", "MATCH_FINISHED", "This match is already finished.");
  }
}

/** Active live session with the caller as scorer. */
function requireScorer(c: Ctx): { live: Live; log: LogDoc } {
  if (c.live?.status === "finished") fail("failed-precondition", "MATCH_FINISHED", "This match is already finished.");
  if (!c.live || !c.log || !ACTIVE.includes(c.live.status)) fail("failed-precondition", "NOT_SCORER", NOT_SCORER);
  if (c.live.scorerUid !== c.uid) fail("permission-denied", "NOT_SCORER", NOT_SCORER);
  return { live: c.live, log: c.log };
}

function rethrow(e: unknown): never {
  if (e instanceof RacketRuleError) {
    fail(e.precondition ? "failed-precondition" : "invalid-argument", e.reason, e.message);
  }
  throw e;
}

function replayLog(log: LogDoc): RacketState {
  try {
    return replayRacket(log.config, log.events ?? []);
  } catch (e) {
    logger.error("racketLive: stored events don't replay", e);
    return rethrow(e);
  }
}

function apply(s: RacketState, e: RacketEvent): RacketState {
  try {
    return applyRacketEvent(s, e);
  } catch (err) {
    return rethrow(err);
  }
}

/** New `live` map for a state. */
function liveFor(live: Live, s: RacketState, extra: Record<string, unknown> = {}): Live {
  return plainLive({ ...live, ...racketLiveSummary(s), ...extra });
}

function writeState(c: Ctx, log: LogDoc): void {
  c.tx.set(c.stateRef, { ...plain({ config: log.config, events: log.events }), updatedAt: Timestamp.now() });
}

// ─── startRacketScoring ─────────────────────────────────

/**
 * startRacketScoring({ matchId, firstServer, takeover? }) → { status }.
 * Organizer or any player in the match. Same scorer → resume. A new session
 * needs the sport switched on in `config/sports.liveScoring`.
 */
export const startRacketScoring = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const takeover = d.takeover === true;

  const status = await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    requireNotFinished(c);
    if (!(await canScore(c))) {
      fail("permission-denied", "NOT_SCORER", "Only the organizer or a player in this match can score it.");
    }
    if (!c.l.match.teamAId || !c.l.match.teamBId || !c.l.regA || !c.l.regB) {
      fail("failed-precondition", "INVALID_ARGUMENT", "Both sides must be known before scoring.");
    }
    const me: PlayerRef | null = await playerForUid(db, uid, tx);
    const now = Timestamp.now();
    const scorerName = me?.data.name || "The organizer";
    if (c.live && c.log && ACTIVE.includes(c.live.status)) {
      const live = c.live;
      if (live.scorerUid === uid) return live.status;
      if (!takeover) fail("failed-precondition", "SCORER_ACTIVE", `${live.scorerName} is scoring this match.`);
      const last = (live.lastPointAt ?? live.scorerSince)?.toMillis() ?? 0;
      if (!isOrganizer(c.l, uid) && now.toMillis() - last < RACKET_TAKEOVER_MS) {
        fail("failed-precondition", "SCORER_ACTIVE",
          `${live.scorerName} is scoring this match. You can take over if no point is recorded for 3 minutes.`);
      }
      tx.update(c.ref, { live: plainLive({ ...live, scorerUid: uid, scorerName, scorerSince: now }) });
      return live.status;
    }

    if (!(await liveScoringEnabled(db, tx, c.sport))) fail("failed-precondition", "LIVE_SCORING_DISABLED", DISABLED);
    if (d.firstServer !== "A" && d.firstServer !== "B") fail("invalid-argument", "INVALID_ARGUMENT", "Choose who serves first.");
    const { config: scoring } = resolveScoring(c.l.tournament.scoringConfigData, c.sport);
    const config = racketConfig(c.sport, scoring, c.l.tournament.matchFormatRaw, d.firstServer);
    if (!playable(config.scoring)) {
      fail("failed-precondition", "INVALID_ARGUMENT", "Live scoring can't be used with this tournament's scoring settings.");
    }
    const s = replayRacket(config, []);
    const live: Live = plainLive({
      kind: "racket", sport: c.sport, format: config.format, gamesPerMatch: config.scoring.gamesPerMatch,
      pointsToWin: config.scoring.pointsToWin, scorerUid: uid, scorerName, scorerSince: now, startedAt: now,
      ...racketLiveSummary(s), seq: 0,
    });
    tx.update(c.ref, { live });
    writeState(c, { config, events: [] });
    return s.status;
  });
  logger.info(`startRacketScoring ${matchId}: ${status}${takeover ? " (takeover)" : ""}`);
  return { status };
});

// ─── recordPoint ────────────────────────────────────────

/**
 * recordPoint({ matchId, pointId, winner }) → { status, duplicate }. A
 * pointId seen before (even undone) is a no-op.
 */
export const recordPoint = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const pointId = requireEventId(d, "pointId");
  const winner = sideArg(d.winner);
  const event: RacketEvent = { type: "point", id: pointId, winner };

  return db.runTransaction(async (tx) => {
    const pointRef = db.collection("matches").doc(matchId).collection("points").doc(pointId);
    const pointSnap = await tx.get(pointRef);
    const c = await open(db, tx, matchId, uid);
    if (pointSnap.exists) return { status: c.live?.status ?? "inProgress", duplicate: true };
    const { live, log } = requireScorer(c);
    const before = replayLog(log);
    const after = apply(before, event);
    const now = Timestamp.now();
    const seq = (live.seq ?? 0) + 1;
    const game = after.games.length > before.games.length ? after.games[after.games.length - 1] : after.current;
    tx.set(pointRef, {
      seq, game: gameNumber(before), winner, server: before.server.side, scoreA: game.a, scoreB: game.b,
      by: uid, createdAt: now,
    });
    tx.update(c.ref, { live: liveFor(live, after, { lastPointAt: now, seq }) });
    writeState(c, { config: log.config, events: [...log.events, event] });
    return { status: after.status, duplicate: false };
  });
});

// ─── undoPoint ──────────────────────────────────────────

/** undoPoint({ matchId, pointId? }) → { status, undonePointId }. */
export const undoPoint = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const expected = typeof d.pointId === "string" && d.pointId ? d.pointId : undefined;
  return db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    const { live, log } = requireScorer(c);
    replayLog(log);
    let undone: { events: RacketEvent[]; pointId: string };
    try {
      undone = undoLastPoint(log.events ?? []);
    } catch (e) {
      if (expected) return { status: live.status, undonePointId: null }; // already undone
      return rethrow(e);
    }
    if (expected && undone.pointId !== expected) return { status: live.status, undonePointId: null };
    const after = replayLog({ config: log.config, events: undone.events });
    tx.update(c.ref, { live: liveFor(live, after) });
    writeState(c, { config: log.config, events: undone.events });
    tx.set(c.ref.collection("points").doc(undone.pointId), { undone: true }, { merge: true });
    return { status: after.status, undonePointId: undone.pointId };
  });
});

// ─── setServer ──────────────────────────────────────────

/**
 * setServer({ matchId, eventId, side }) → { status, duplicate }. "Fix
 * server": corrects the serving side; never changes the score. An eventId
 * already in the log is a no-op.
 */
export const setServer = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const eventId = requireEventId(d, "eventId");
  const event: RacketEvent = { type: "setServer", id: eventId, side: sideArg(d.side) };
  return db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    const { live, log } = requireScorer(c);
    if ((log.events ?? []).some((e) => e.id === eventId)) return { status: live.status, duplicate: true };
    const after = apply(replayLog(log), event);
    tx.update(c.ref, { live: liveFor(live, after) });
    writeState(c, { config: log.config, events: [...log.events, event] });
    return { status: after.status, duplicate: false };
  });
});

// ─── finishRacketMatch ──────────────────────────────────

/**
 * finishRacketMatch({ matchId }) → { status }. Only once the match is decided
 * (`ended`). Writes the result through `applyGames`, exactly like
 * `submitScore`: organizer scorer → finished; player scorer → scoreSubmitted,
 * the other side confirms.
 */
export const finishRacketMatch = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const playerIds = await playerIdsForUid(db, uid);
  let side: Side | null = null;
  const committed: Committed = await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    const { live, log } = requireScorer(c);
    requireNotFinished(c);
    const s = replayLog(log);
    if (s.status !== "ended") fail("failed-precondition", "INVALID_SCORE", "The match isn't over yet.");
    const result = toRacketResult(s);
    const final = isOrganizer(c.l, uid);
    if (!final) side = requireParticipant(c.l, uid, playerIds, "Only the players in this match or the organizer can enter its score.");
    const p = new Patch(c.l.match);
    applyGames(p, c.l, result, uid, final);
    p.set("live", liveFor(live, s, { status: "finished" }));
    return commit(db, tx, matchId, c.l, p);
  });
  logger.info(`racket live result ${matchId}: ${committed.match.statusRaw}`);
  await afterFinish(db, matchId, committed);
  if (side && committed.match.statusRaw === "scoreSubmitted") {
    const sd: Side = side;
    await safely(`Score notification for ${matchId}`, () => notifyScoreSubmitted(db, matchId, committed.match, sd));
  }
  return { status: committed.match.statusRaw };
});

// ─── stopLiveScoring (racket) ───────────────────────────

/** The match belongs to a racket-sport tournament (routes `stopLiveScoring`). */
export async function isRacketMatch(db: Firestore, matchId: string): Promise<boolean> {
  const match = await db.collection("matches").doc(matchId).get();
  const tournamentId = match.get("tournamentId");
  if (!match.exists || typeof tournamentId !== "string" || !tournamentId) return false;
  const t = await db.collection("tournaments").doc(await resolveDocId(db, "tournaments", tournamentId)).get();
  return t.exists && isRacketSport(parseSportType(t.get("sportType")));
}

/**
 * Racket half of `stopLiveScoring` (callables/cricketLive.ts): organizer only;
 * deletes `live` and the event log (points are kept, marked undone) so the
 * result can be entered by hand.
 */
export async function stopRacketLive(db: Firestore, matchId: string, uid: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    if (!isOrganizer(c.l, uid)) fail("permission-denied", "NOT_SCORER", "Only the organizer can stop live scoring.");
    if (c.live?.status === "finished") fail("failed-precondition", "MATCH_FINISHED", "This match is already finished.");
    if (!c.live && !c.log) return;
    tx.update(c.ref, { live: FieldValue.delete() });
    tx.delete(c.stateRef);
  });
  const points = await db.collection("matches").doc(matchId).collection("points").get();
  const live = points.docs.filter((p) => p.get("undone") !== true);
  for (let i = 0; i < live.length; i += 400) {
    const batch = db.batch();
    for (const p of live.slice(i, i + 400)) batch.update(p.ref, { undone: true });
    await batch.commit();
  }
  logger.info(`stopLiveScoring (racket) ${matchId}`);
}
