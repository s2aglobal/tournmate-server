import { CallableRequest, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { DocumentReference, FieldPath, FieldValue, Firestore, Timestamp, Transaction, getFirestore } from "firebase-admin/firestore";
import { fail, FailReason } from "./errors";
import { CALLABLE_OPTS, Data, dataOf, requireUid } from "./shared";
import {
  Committed, Loaded, Patch, PlayerOfMatchInput, Score, Side, afterFinish, applyCricket, commit, isOrganizer, load,
  playerIdsForUid, requireParticipant,
} from "./scores";
import { PlayerRef, playerById, playerForUid, resolveDocId, sameId } from "../services/identity";
import { knockoutRules, resolveCricketRules } from "../services/cricket";
import { rolesFromFirestore, roleKey, rosterKeys } from "../services/teamRoles";
import {
  BallEvent, ExtrasType, LiveConfig, LiveEvent, LiveRuleError, LiveState, LiveTeam, applyEvent, ballCode,
  ballPosition, initialState, liveStatus, liveSummary, replay, scorecard, toCricketResult, toPlayerStats, undoLastBall,
  validationPlayersPerSide,
  inningsEndedEarly,
} from "../services/cricketLive";
import { RegistrationDoc, parseSportType } from "../types";
import { notifyScoreSubmitted, safely } from "../services/matchNotifications";

/**
 * Cricket live scoring callables (contract: cricket-live-contract.md).
 * Every action is applied to the reference reducer (`services/cricketLive.ts`)
 * replayed from the event log in `matches/{id}/cricketLive/state`; the match's
 * `live` summary and the `balls/{ballId}` docs are projections written in the
 * same transaction. Finishing writes the result through the score callables'
 * own code (`applyCricket` + `commit`), so it is identical to a manual entry.
 */

const TAKEOVER_MS = 10 * 60 * 1000;
const ACTIVE = ["setup", "inProgress", "inningsBreak", "ended"];

type Live = Record<string, unknown> & {
  status: string;
  scorerUid: string;
  scorerName: string;
  scorerSince?: Timestamp;
  lastBallAt?: Timestamp;
  battingFirstTeamId: string;
  seq?: number;
};

interface LogDoc {
  config: LiveConfig | null;
  events: LiveEvent[];
}

interface Ctx {
  db: Firestore;
  tx: Transaction;
  matchId: string;
  ref: DocumentReference;
  stateRef: DocumentReference;
  l: Loaded;
  live: Live | null;
  log: LogDoc | null;
  me: PlayerRef | null;
  uid: string;
}

/** Firestore-safe copy (drops undefined). */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function requireMatchId(d: Data): string {
  const id = d.matchId;
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || id.includes("/")) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Missing match.");
  }
  return id;
}

function keyArg(d: Data, key: string, required: boolean): string | undefined {
  const v = d[key];
  if (v === undefined || v === null) {
    if (required) fail("invalid-argument", "INVALID_ARGUMENT", `Missing ${key}.`);
    return undefined;
  }
  if (typeof v !== "string" || v.length === 0 || v.length > 200) fail("invalid-argument", "INVALID_ARGUMENT", `${key} must be a player.`);
  return roleKey(v);
}

async function open(db: Firestore, tx: Transaction, matchId: string, uid: string): Promise<Ctx> {
  const ref = db.collection("matches").doc(matchId);
  const stateRef = ref.collection("cricketLive").doc("state");
  const l = await load(db, tx, matchId);
  const stateSnap = await tx.get(stateRef);
  const me = await playerForUid(db, uid, tx);
  if (parseSportType(l.tournament.sportType) !== "cricket") {
    fail("invalid-argument", "INVALID_ARGUMENT", "Live scoring is for cricket matches.");
  }
  const raw = l.match.live as Live | undefined;
  return {
    db, tx, matchId, ref, stateRef, l, me, uid,
    live: raw && typeof raw.status === "string" ? raw : null,
    log: stateSnap.exists ? (stateSnap.data() as LogDoc) : null,
  };
}

function isLeader(reg: RegistrationDoc | null, me: PlayerRef | null): boolean {
  if (!reg || !me) return false;
  const roles = rolesFromFirestore(reg as unknown as Record<string, unknown>);
  const mine = roleKey(me.id);
  return roles.captain === mine || roles.viceCaptain === mine;
}

function canScore(c: Ctx): boolean {
  return isOrganizer(c.l, c.uid) || isLeader(c.l.regA, c.me) || isLeader(c.l.regB, c.me);
}

function requireNotFinished(c: Ctx): void {
  if (c.live?.status === "finished" || c.l.match.statusRaw !== "scheduled") {
    fail("failed-precondition", "MATCH_FINISHED", "This match is already finished.");
  }
}

/** Active live session with the caller as scorer. */
function requireScorer(c: Ctx): { live: Live; log: LogDoc } {
  if (c.live?.status === "finished") fail("failed-precondition", "MATCH_FINISHED", "This match is already finished.");
  if (!c.live || !c.log || !ACTIVE.includes(c.live.status)) {
    fail("failed-precondition", "NOT_SCORER", "Only the scorer can do this. Take over scoring first.");
  }
  if (c.live.scorerUid !== c.uid) fail("permission-denied", "NOT_SCORER", "Only the scorer can do this. Take over scoring first.");
  return { live: c.live, log: c.log };
}

function teamIdArg(c: Ctx, raw: unknown, key: string): string {
  if (typeof raw !== "string" || !raw) fail("invalid-argument", "INVALID_ARGUMENT", `Missing ${key}.`);
  if (sameId(raw, c.l.match.teamAId)) return c.l.match.teamAId;
  if (sameId(raw, c.l.match.teamBId)) return c.l.match.teamBId;
  fail("invalid-argument", "INVALID_ARGUMENT", "Pick one of the two teams.");
}

function rethrow(e: unknown): never {
  if (e instanceof LiveRuleError) {
    fail(e.reason === "INNINGS_OVER" ? "failed-precondition" : "invalid-argument", e.reason as FailReason, e.message);
  }
  throw e;
}

function replayLog(log: LogDoc): LiveState {
  if (!log.config) fail("failed-precondition", "INNINGS_OVER", "Start the innings first.");
  try {
    return replay(log.config, log.events ?? []);
  } catch (e) {
    logger.error("cricketLive: stored events don't replay", e);
    return rethrow(e);
  }
}

function apply(s: LiveState, e: LiveEvent): LiveState {
  try {
    return applyEvent(s, e);
  } catch (err) {
    return rethrow(err);
  }
}

/** New `live` map for a state. */
function liveFor(live: Live, s: LiveState | null, extra: Record<string, unknown> = {}): Live {
  const summary = s ? liveSummary(s) : null;
  return plainLive({ ...live, ...(summary ?? {}), ...extra });
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

function writeState(c: Ctx, log: LogDoc, s: LiveState | null): void {
  c.tx.set(c.stateRef, {
    ...plain({ config: log.config, events: log.events, scorecard: s ? scorecard(s) : { innings: [] } }),
    updatedAt: Timestamp.now(),
  });
}

// ─── Config (frozen when the first innings starts) ──────

function maxOversSetting(rulesData: unknown): number | null {
  if (typeof rulesData !== "string") return null;
  try {
    const v = (JSON.parse(rulesData) as Record<string, unknown>).maxOversPerBowler;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
  } catch {
    return null;
  }
}

async function buildConfig(c: Ctx, battingFirstTeamId: string): Promise<LiveConfig> {
  const { match, tournament } = c.l;
  const rules = knockoutRules(resolveCricketRules(tournament.rulesData), tournament.matchFormatRaw, match.groupLabel);
  const teams: LiveTeam[] = [];
  for (const [id, reg] of [[match.teamAId, c.l.regA], [match.teamBId, c.l.regB]] as const) {
    const rosterIds = reg?.rosterIds ?? [];
    const guests = reg?.guestNames ?? [];
    const names = new Map<string, string>();
    for (const pid of rosterIds) {
      const p = await playerById(c.db, pid, c.tx);
      names.set(roleKey(pid), p?.data.name || "Player");
    }
    for (const g of guests) names.set(`guest:${g}`, g);
    const roster = rosterKeys(rosterIds, guests);
    const lineup = match.lineups?.[id];
    const order = lineup && Array.isArray(lineup.order) && lineup.order.length >= 2 ? lineup.order.map(roleKey) : roster;
    teams.push({
      id,
      name: reg?.teamName ?? "",
      players: order.map((key) => ({ key, name: names.get(key) ?? (key.startsWith("guest:") ? key.slice(6) : "Player") })),
      order,
    });
  }
  return { rules, maxOversPerBowler: maxOversSetting(tournament.rulesData), battingFirstTeamId, teams };
}

// ─── setLineup ──────────────────────────────────────────

/**
 * setLineup({ matchId, teamId, xi, order }) → { ok: true }. Captain,
 * vice-captain or registrant of that team, or the organizer; until the first
 * innings starts (LINEUP_LOCKED).
 */
export const setLineup = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const keys = (key: string): string[] => {
    const v = d[key];
    if (!Array.isArray(v) || v.length > 30 || v.some((x) => typeof x !== "string" || !x)) {
      fail("invalid-argument", "INVALID_ARGUMENT", `${key} must be a list of players.`);
    }
    return (v as string[]).map(roleKey);
  };
  const xi = keys("xi");
  const order = keys("order");

  await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    const teamId = teamIdArg(c, d.teamId, "teamId");
    const reg = teamId === c.l.match.teamAId ? c.l.regA : c.l.regB;
    const allowed = isOrganizer(c.l, uid) || (!!c.me && !!reg && (sameId(reg.playerId, c.me.id) || isLeader(reg, c.me)));
    if (!allowed) {
      fail("permission-denied", "NOT_PARTICIPANT",
        "Only the captain, vice-captain, whoever entered the team, or the organizer can set the lineup.");
    }
    requireNotFinished(c);
    if (c.live && c.live.status !== "setup") fail("failed-precondition", "LINEUP_LOCKED", "The lineup locks once the first innings starts.");
    const max = resolveCricketRules(c.l.tournament.rulesData).playersPerSide;
    if (xi.length < 2) fail("invalid-argument", "INVALID_ARGUMENT", "Pick at least 2 players.");
    if (xi.length > max) fail("invalid-argument", "INVALID_ARGUMENT", `Pick at most ${max} players.`);
    const roster = rosterKeys(reg?.rosterIds ?? [], reg?.guestNames ?? []);
    if (xi.some((k) => !roster.includes(k))) fail("invalid-argument", "INVALID_ARGUMENT", "Pick players from the team sheet.");
    if (new Set(xi).size !== xi.length) fail("invalid-argument", "INVALID_ARGUMENT", "Each player can be picked once.");
    if (order.length !== xi.length || new Set(order).size !== order.length || order.some((k) => !xi.includes(k))) {
      fail("invalid-argument", "INVALID_ARGUMENT", "The batting order must list the same players as the XI.");
    }
    tx.update(c.ref, new FieldPath("lineups", teamId), { xi, order, setBy: uid, setAt: Timestamp.now() });
  });
  logger.info(`setLineup ${matchId}`);
  return { ok: true };
});

// ─── startScoring / setToss ─────────────────────────────

function parseToss(c: Ctx, raw: unknown): { winnerTeamId: string; elected: "bat" | "bowl" } {
  if (!raw || typeof raw !== "object") fail("invalid-argument", "INVALID_ARGUMENT", "Missing toss.");
  const t = raw as Record<string, unknown>;
  const winnerTeamId = teamIdArg(c, t.winnerTeamId, "winnerTeamId");
  if (t.elected !== "bat" && t.elected !== "bowl") fail("invalid-argument", "INVALID_ARGUMENT", "Choose bat or bowl.");
  return { winnerTeamId, elected: t.elected };
}

function tossBatsFirst(c: Ctx, toss: { winnerTeamId: string; elected: "bat" | "bowl" }): string {
  if (toss.elected === "bat") return toss.winnerTeamId;
  return toss.winnerTeamId === c.l.match.teamAId ? c.l.match.teamBId : c.l.match.teamAId;
}

/**
 * startScoring({ matchId, battingFirstTeamId?, toss?, takeover? }) → { status }.
 * Organizer or captain / vice-captain of either team. Same scorer → resume.
 */
export const startScoring = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const takeover = d.takeover === true;

  const status = await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    requireNotFinished(c);
    if (!canScore(c)) {
      fail("permission-denied", "NOT_SCORER", "Only the organizer or a captain or vice-captain of either team can score this match.");
    }
    if (!c.l.match.teamAId || !c.l.match.teamBId || !c.l.regA || !c.l.regB) {
      fail("failed-precondition", "INVALID_ARGUMENT", "Both teams must be known before scoring.");
    }
    const now = Timestamp.now();
    const scorerName = c.me?.data.name || "The organizer";
    if (c.live && c.log && ACTIVE.includes(c.live.status)) {
      const live = c.live;
      if (live.scorerUid === uid) return live.status;
      if (!takeover) fail("failed-precondition", "SCORER_ACTIVE", `${live.scorerName} is scoring this match.`);
      const last = (live.lastBallAt ?? live.scorerSince)?.toMillis() ?? 0;
      if (!isOrganizer(c.l, uid) && now.toMillis() - last < TAKEOVER_MS) {
        fail("failed-precondition", "SCORER_ACTIVE",
          `${live.scorerName} is scoring this match. You can take over if no ball is recorded for 10 minutes.`);
      }
      tx.update(c.ref, { live: plainLive({ ...live, scorerUid: uid, scorerName, scorerSince: now }) });
      return live.status;
    }

    const toss = d.toss !== undefined && d.toss !== null ? parseToss(c, d.toss) : undefined;
    const picked = d.battingFirstTeamId !== undefined && d.battingFirstTeamId !== null
      ? teamIdArg(c, d.battingFirstTeamId, "battingFirstTeamId") : undefined;
    if (toss && picked && tossBatsFirst(c, toss) !== picked) {
      fail("invalid-argument", "INVALID_ARGUMENT", "The toss result and the team batting first don't match.");
    }
    const battingFirstTeamId = toss ? tossBatsFirst(c, toss) : picked;
    if (!battingFirstTeamId) fail("invalid-argument", "INVALID_ARGUMENT", "Choose who bats first.");
    const live: Live = plainLive({
      status: "setup", scorerUid: uid, scorerName, scorerSince: now, startedAt: now, battingFirstTeamId,
      ...(toss ? { toss } : {}),
      inningsIndex: 0, innings: [],
      current: { strikerKey: null, nonStrikerKey: null, bowlerKey: null, lastOverBowlerKey: null },
      thisOver: [], freeHit: false, seq: 0,
    });
    tx.update(c.ref, { live });
    writeState(c, { config: null, events: [] }, null);
    return "setup";
  });
  logger.info(`startScoring ${matchId}: ${status}${takeover ? " (takeover)" : ""}`);
  return { status };
});

/** setToss({ matchId, winnerTeamId, elected }) → { status }. Scorer, before the first innings. */
export const setToss = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    const { live } = requireScorer(c);
    if (live.status !== "setup") fail("failed-precondition", "LINEUP_LOCKED", "The toss can't change once the first innings starts.");
    const toss = parseToss(c, { winnerTeamId: d.winnerTeamId, elected: d.elected });
    tx.update(c.ref, { live: plainLive({ ...live, toss, battingFirstTeamId: tossBatsFirst(c, toss) }) });
  });
  return { status: "setup" };
});

// ─── startInnings ───────────────────────────────────────

/** startInnings({ matchId, strikerKey, nonStrikerKey, bowlerKey }) → { status }. */
export const startInnings = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const event: LiveEvent = {
    type: "startInnings",
    strikerKey: keyArg(d, "strikerKey", true)!,
    nonStrikerKey: keyArg(d, "nonStrikerKey", true)!,
    bowlerKey: keyArg(d, "bowlerKey", true)!,
  };
  const status = await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    const { live, log } = requireScorer(c);
    let config = log.config;
    if (!config) config = await buildConfig(c, live.battingFirstTeamId);
    const before = log.config ? replayLog(log) : initialState(config);
    if (liveStatus(before) === "inProgress") {
      const last = [...log.events].reverse().find((e) => e.type === "startInnings");
      const same = last?.type === "startInnings" && event.type === "startInnings" && last.strikerKey === event.strikerKey &&
        last.nonStrikerKey === event.nonStrikerKey && last.bowlerKey === event.bowlerKey;
      if (same) return "inProgress"; // retried
    }
    const after = apply(before, event);
    const next: LogDoc = { config, events: [...log.events, event] };
    tx.update(c.ref, { live: liveFor(live, after) });
    writeState(c, next, after);
    return liveStatus(after);
  });
  logger.info(`startInnings ${matchId}`);
  return { status };
});

// ─── recordBall ─────────────────────────────────────────

function parseBall(d: Data, ballId: string): BallEvent {
  const e: BallEvent = { type: "ball", id: ballId, runs: d.runs as number };
  if (d.runs === undefined || d.runs === null) e.runs = 0;
  if (d.extras !== undefined && d.extras !== null) {
    const x = d.extras as Record<string, unknown>;
    if (typeof x !== "object") fail("invalid-argument", "INVALID_BALL", "That ball isn't valid. Update the app and try again.");
    e.extras = { type: x.type as ExtrasType, runs: (x.runs ?? 0) as number };
  }
  if (d.wicket !== undefined && d.wicket !== null) {
    const w = d.wicket as Record<string, unknown>;
    if (typeof w !== "object") fail("invalid-argument", "INVALID_BALL", "That ball isn't valid. Update the app and try again.");
    e.wicket = {
      type: w.type as NonNullable<BallEvent["wicket"]>["type"],
      batterKey: typeof w.batterKey === "string" ? roleKey(w.batterKey) : (w.batterKey as string),
    };
    if (w.fielderKey !== undefined && w.fielderKey !== null) {
      e.wicket.fielderKey = typeof w.fielderKey === "string" ? roleKey(w.fielderKey) : (w.fielderKey as string);
    }
  }
  const nb = keyArg(d, "nextBatterKey", false);
  if (nb) e.nextBatterKey = nb;
  const nw = keyArg(d, "nextBowlerKey", false);
  if (nw) e.nextBowlerKey = nw;
  if (d.swapStrike === true) e.swapStrike = true;
  return e;
}

/**
 * recordBall({ matchId, ballId, runs, extras?, wicket?, nextBatterKey?,
 * nextBowlerKey?, swapStrike? }) → { status, duplicate }. A ballId seen
 * before (even undone) is a no-op.
 */
export const recordBall = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const ballId = d.ballId;
  if (typeof ballId !== "string" || ballId.length === 0 || ballId.length > 64 || ballId.includes("/")) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Missing ballId.");
  }
  const event = parseBall(d, ballId);

  const res = await db.runTransaction(async (tx) => {
    const ballRef = db.collection("matches").doc(matchId).collection("balls").doc(ballId);
    const ballSnap = await tx.get(ballRef);
    const c = await open(db, tx, matchId, uid);
    if (ballSnap.exists) return { status: c.live?.status ?? "setup", duplicate: true };
    const { live, log } = requireScorer(c);
    const before = replayLog(log);
    const after = apply(before, event);
    const pos = ballPosition(before, event);
    const inn = before.innings[before.innings.length - 1];
    let striker = inn.strikerKey;
    let nonStriker = inn.nonStrikerKey;
    if (event.swapStrike) [striker, nonStriker] = [nonStriker, striker];
    const now = Timestamp.now();
    const seq = (live.seq ?? 0) + 1;
    tx.set(ballRef, { ...plain({
      innings: pos.innings, seq, over: pos.over, ballInOver: pos.ballInOver, legal: pos.legal, runs: event.runs,
      extras: event.extras, wicket: event.wicket, strikerKey: striker, nonStrikerKey: nonStriker,
      bowlerKey: inn.bowlerKey ?? event.nextBowlerKey ?? null, nextBatterKey: event.nextBatterKey,
      nextBowlerKey: event.nextBowlerKey, swapStrike: event.swapStrike, code: ballCode(event), by: uid,
    }), createdAt: now });
    tx.update(c.ref, { live: liveFor(live, after, { lastBallAt: now, seq }) });
    writeState(c, { config: log.config, events: [...log.events, event] }, after);
    return { status: liveStatus(after), duplicate: false };
  });
  return res;
});

// ─── undoBall ───────────────────────────────────────────

/** undoBall({ matchId, ballId? }) → { status, undoneBallId }. */
export const undoBall = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const expected = typeof d.ballId === "string" && d.ballId ? d.ballId : undefined;
  return db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    const { live, log } = requireScorer(c);
    replayLog(log);
    let undone: { events: LiveEvent[]; ballId: string };
    try {
      undone = undoLastBall(log.events);
    } catch (e) {
      if (expected) return { status: live.status, undoneBallId: null }; // already undone
      return rethrow(e);
    }
    if (expected && undone.ballId !== expected) return { status: live.status, undoneBallId: null };
    const after = replay(log.config!, undone.events);
    tx.update(c.ref, { live: liveFor(live, after) });
    writeState(c, { config: log.config, events: undone.events }, after);
    tx.set(c.ref.collection("balls").doc(undone.ballId), { undone: true }, { merge: true });
    return { status: liveStatus(after), undoneBallId: undone.ballId };
  });
});

// ─── setRevisedTarget / endInnings ─────────────────────

async function simpleEvent(req: CallableRequest, d: Data, event: LiveEvent): Promise<{ status: string }> {
  const uid = requireUid(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const status = await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    const { live, log } = requireScorer(c);
    const after = apply(replayLog(log), event);
    tx.update(c.ref, { live: liveFor(live, after) });
    writeState(c, { config: log.config, events: [...log.events, event] }, after);
    return liveStatus(after);
  });
  return { status };
}

/** setRevisedTarget({ matchId, runs, overs }) → { status }. */
export const setRevisedTarget = onCall(CALLABLE_OPTS, async (req) => {
  const d = dataOf(req);
  return simpleEvent(req, d, { type: "revisedTarget", runs: d.runs as number, overs: d.overs as number });
});

/** endInnings({ matchId, reason }) → { status }. */
export const endInnings = onCall(CALLABLE_OPTS, async (req) => {
  const d = dataOf(req);
  const reason = typeof d.reason === "string" ? d.reason.trim().slice(0, 100) : "";
  return simpleEvent(req, d, { type: "endInnings", reason });
});

// ─── finishLiveMatch / abandonMatch ────────────────────

/**
 * Writes the result through the score callables' code. Organizer scorer →
 * finished; captain / vice-captain scorer → scoreSubmitted for the other side.
 */
async function finalize(
  uid: string,
  matchId: string,
  build: (c: Ctx, s: LiveState | null) => { score: Extract<Score, { kind: "cricket" }>; noResult: boolean; playersPerSide?: number; endedEarly?: boolean[] },
): Promise<{ status: string }> {
  const db = getFirestore();
  const playerIds = await playerIdsForUid(db, uid);
  let side: Side | null = null;
  const committed: Committed = await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    const { live, log } = requireScorer(c);
    requireNotFinished(c);
    const s = log.config ? replayLog(log) : null;
    const { score, noResult, playersPerSide, endedEarly } = build(c, s);
    const final = isOrganizer(c.l, uid);
    if (!final) side = requireParticipant(c.l, uid, playerIds, "Only the players in this match or the organizer can enter its score.");
    const p = new Patch(c.l.match);
    await applyCricket(db, tx, p, c.l, score, uid, final, { playersPerSide, endedEarly });
    p.set("live", liveFor(live, s, { status: "finished", ...(noResult ? { result: "noResult" } : {}) }));
    return commit(db, tx, matchId, c.l, p);
  });
  logger.info(`live result ${matchId}: ${committed.match.statusRaw}`);
  await afterFinish(db, matchId, committed);
  if (side && committed.match.statusRaw === "scoreSubmitted") {
    const sd: Side = side;
    await safely(`Score notification for ${matchId}`, () => notifyScoreSubmitted(db, matchId, committed.match, sd));
  }
  return { status: committed.match.statusRaw };
}

/** finishLiveMatch({ matchId, playerOfMatchKey?, superOverWinnerTeamId? }) → { status }. */
export const finishLiveMatch = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const potmKey = keyArg(d, "playerOfMatchKey", false);
  return finalize(uid, matchId, (c, s) => {
    if (!s || liveStatus(s) !== "ended") fail("failed-precondition", "INVALID_SCORE", "Finish both innings first.");
    const superOver = d.superOverWinnerTeamId !== undefined && d.superOverWinnerTeamId !== null
      ? teamIdArg(c, d.superOverWinnerTeamId, "superOverWinnerTeamId") : undefined;
    let playerOfMatch: PlayerOfMatchInput | null = null;
    if (potmKey) {
      const t = s.config.teams.find((x) => x.players.some((p) => p.key === potmKey));
      if (!t) fail("invalid-argument", "INVALID_ARGUMENT", "The Player of the Match must play for one of the two teams.");
      playerOfMatch = { key: potmKey, name: t.players.find((p) => p.key === potmKey)!.name, teamRegistrationId: t.id };
    }
    return {
      score: {
        kind: "cricket",
        result: toCricketResult(s, { superOverWinnerRegistrationId: superOver }),
        playerOfMatch,
        stats: toPlayerStats(s),
      },
      noResult: false,
      playersPerSide: validationPlayersPerSide(s),
      endedEarly: inningsEndedEarly(s),
    };
  });
});

/** abandonMatch({ matchId }) → { status }. No result, with the innings played so far. */
export const abandonMatch = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  return finalize(uid, matchId, (_c, s) => {
    const stats = s ? toPlayerStats(s) : null;
    return {
      score: {
        kind: "cricket",
        result: s ? toCricketResult(s, { noResult: true }) : { innings: [], noResult: true },
        playerOfMatch: null,
        stats: stats && (stats.batting.length > 0 || stats.bowling.length > 0) ? stats : null,
      },
      noResult: true,
    };
  });
});

// ─── stopLiveScoring ────────────────────────────────────

/**
 * stopLiveScoring({ matchId }) → { ok: true }. Organizer only: drops the live
 * session (live summary + event log; balls are kept, marked undone) so the
 * result can be entered by hand.
 */
export const stopLiveScoring = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  await db.runTransaction(async (tx) => {
    const c = await open(db, tx, matchId, uid);
    if (!isOrganizer(c.l, uid)) fail("permission-denied", "NOT_SCORER", "Only the organizer can stop live scoring.");
    if (c.live?.status === "finished") fail("failed-precondition", "MATCH_FINISHED", "This match is already finished.");
    if (!c.live && !c.log) return;
    tx.update(c.ref, { live: FieldValue.delete() });
    tx.delete(c.stateRef);
  });
  const balls = await db.collection("matches").doc(matchId).collection("balls").get();
  const live = balls.docs.filter((b) => b.get("undone") !== true);
  for (let i = 0; i < live.length; i += 400) {
    const batch = db.batch();
    for (const b of live.slice(i, i + 400)) batch.update(b.ref, { undone: true });
    await batch.commit();
  }
  logger.info(`stopLiveScoring ${matchId}`);
  return { ok: true };
});
