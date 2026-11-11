/**
 * Racket live scoring (point by point): the reference reducer (events → state).
 *
 * Badminton only for now; pickleball and tennis plug in later through
 * `RACKET_SPORTS` / the per-sport `apply` below, so names are `racket*`.
 *
 * The callables in `callables/racketLive.ts` validate every action by
 * applying it here; iOS and Android port it for instant feedback and must
 * reproduce `test-fixtures/racket-live-fixture.txt` exactly
 * (`npm run check:racket-live`). Contract: ~/Desktop/TournMate-PRs/racket-live-contract.md.
 *
 * Stored data (server-written only)
 * - matches/{id}/racketLive/state: { config, events, updatedAt }. `events`
 *   holds the effective events (undo removes them); `config` is frozen at start.
 * - matches/{id}.live: summary for cards (`racketLiveSummary`).
 * - matches/{id}/points/{pointId}: one doc per point (history; undo marks it
 *   `undone: true`).
 *
 * Badminton rules
 * - Rally scoring: every rally is a point to its winner, who serves next.
 * - A game ends at the first score that is a legal finished game for
 *   `validateGame` (services/scoring.ts): `pointsToWin` with a `winBy` lead,
 *   or `pointCap`. So the derived result always passes score validation.
 * - The match ends when a side has won `gamesToWin` games (status `ended`).
 * - Service court: server's points in the current game even → "R", odd → "L".
 * - First server of game 1 = `config.firstServer`; later games: the winner of
 *   the previous game serves first.
 * - Switch ends: after every game that doesn't end the match, and in the
 *   deciding game when the leader first reaches ceil(pointsToWin / 2).
 */

import { SetScore, ScoringConfig, gamesToWin, validateGame } from "./scoring";

// ─── Types ──────────────────────────────────────────────

export type RacketSport = "badminton";
export const RACKET_SPORTS: readonly RacketSport[] = ["badminton"];

export type RacketSide = "A" | "B";
export type RacketCourt = "R" | "L";

/** "sets": game-by-game score (`setScores`); "simple": one game (round robin and group stages). */
export type RacketFormat = "sets" | "simple";

/** Rules frozen at start. `gamesPerMatch` is 1 for the simple format. */
export interface RacketScoring {
  gamesPerMatch: number;
  pointsToWin: number;
  winBy: number;
  pointCap: number | null;
}

export interface RacketConfig {
  sport: RacketSport;
  format: RacketFormat;
  scoring: RacketScoring;
  firstServer: RacketSide;
}

export interface PointEvent {
  type: "point";
  id: string;
  winner: RacketSide;
}

export interface SetServerEvent {
  type: "setServer";
  id: string;
  side: RacketSide;
}

export type RacketEvent = PointEvent | SetServerEvent;

export interface GameScore {
  a: number;
  b: number;
}

export type RacketStatus = "inProgress" | "ended";

export interface RacketState {
  config: RacketConfig;
  /** Finished games, in order. */
  games: GameScore[];
  /** The game in play (0-0 right after a game ends, and once the match has ended). */
  current: GameScore;
  server: { side: RacketSide; court: RacketCourt };
  gamesWon: GameScore;
  status: RacketStatus;
  /** The latest effective event asks the players to switch ends. */
  switchEnds: boolean;
}

export type RacketReason = "INVALID_POINT";

export class RacketRuleError extends Error {
  /** `precondition`: refused because of the match state (HTTP failed-precondition). */
  constructor(readonly reason: RacketReason, message: string, readonly precondition = false) {
    super(message);
  }
}

export const BAD_POINT = "That point isn't valid. Update the app and try again.";
export const MATCH_OVER = "The match is over. Finish it, or undo the last point.";
export const NOTHING_TO_UNDO = "Nothing to undo.";

const bad = (message = BAD_POINT): never => {
  throw new RacketRuleError("INVALID_POINT", message);
};

// ─── Config ─────────────────────────────────────────────

export function isRacketSport(sport: string): sport is RacketSport {
  return (RACKET_SPORTS as readonly string[]).includes(sport);
}

/**
 * Live config from the tournament's resolved scoring config. Round robin,
 * group + knockout, Swiss and manual draws enter one game ("simple"); only
 * single / double elimination brackets enter games (`setScores`), like the
 * apps' Matches tab.
 */
export function racketConfig(
  sport: RacketSport, scoring: ScoringConfig, matchFormatRaw: unknown, firstServer: RacketSide,
): RacketConfig {
  const format: RacketFormat = racketFormat(matchFormatRaw);
  return {
    sport,
    format,
    scoring: {
      gamesPerMatch: format === "simple" ? 1 : scoring.gamesPerMatch,
      pointsToWin: scoring.pointsToWin,
      winBy: scoring.winBy,
      pointCap: scoring.pointCap,
    },
    firstServer,
  };
}

export function racketFormat(matchFormatRaw: unknown): RacketFormat {
  return matchFormatRaw === "singleElimination" || matchFormatRaw === "doubleElimination" ? "sets" : "simple";
}

/**
 * Whether a game under these rules always ends: a target, best of an odd
 * number of games (1..7), and a cap (if any) above the target, or equal to
 * it with win by 1.
 */
export function playable(s: RacketScoring): boolean {
  const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n);
  if (!ok(s.gamesPerMatch) || !ok(s.pointsToWin) || !ok(s.winBy)) return false;
  if (s.gamesPerMatch < 1 || s.gamesPerMatch > 7 || s.gamesPerMatch % 2 === 0) return false;
  if (s.pointsToWin < 1 || s.pointsToWin > 99) return false;
  if (s.pointCap === null) return true;
  if (!ok(s.pointCap)) return false;
  return s.pointCap > s.pointsToWin || (s.pointCap === s.pointsToWin && Math.max(s.winBy, 1) === 1);
}

function scoringConfig(s: RacketScoring): ScoringConfig {
  return { ...s, scoringSystem: "rally" };
}

// ─── Reducer ────────────────────────────────────────────

const courtFor = (points: number): RacketCourt => (points % 2 === 0 ? "R" : "L");
const pointsOf = (g: GameScore, side: RacketSide) => (side === "A" ? g.a : g.b);

export function initialRacketState(config: RacketConfig): RacketState {
  return {
    config,
    games: [],
    current: { a: 0, b: 0 },
    server: { side: config.firstServer, court: "R" },
    gamesWon: { a: 0, b: 0 },
    status: "inProgress",
    switchEnds: false,
  };
}

function clone(s: RacketState): RacketState {
  return {
    config: s.config,
    games: s.games.map((g) => ({ ...g })),
    current: { ...s.current },
    server: { ...s.server },
    gamesWon: { ...s.gamesWon },
    status: s.status,
    switchEnds: false,
  };
}

/** The game in play decides the match (both sides one game from winning). */
export function isDecidingGame(s: RacketState): boolean {
  const need = gamesToWin(scoringConfig(s.config.scoring)) - 1;
  return s.gamesWon.a === need && s.gamesWon.b === need;
}

function badmintonPoint(s: RacketState, winner: RacketSide): RacketState {
  const n = clone(s);
  const deciding = isDecidingGame(s);
  if (winner === "A") n.current.a += 1;
  else n.current.b += 1;
  const game = { ...n.current };
  if (validateGame({ teamAPoints: game.a, teamBPoints: game.b }, scoringConfig(s.config.scoring)) === null) {
    // Game over: the winner serves first in the next game.
    n.games.push(game);
    if (winner === "A") n.gamesWon.a += 1;
    else n.gamesWon.b += 1;
    n.current = { a: 0, b: 0 };
    n.server = { side: winner, court: "R" };
    const toWin = gamesToWin(scoringConfig(s.config.scoring));
    if (n.gamesWon.a === toWin || n.gamesWon.b === toWin) n.status = "ended";
    else n.switchEnds = true;
    return n;
  }
  n.server = { side: winner, court: courtFor(pointsOf(n.current, winner)) };
  const mid = Math.ceil(s.config.scoring.pointsToWin / 2);
  const mine = pointsOf(n.current, winner);
  const theirs = pointsOf(n.current, winner === "A" ? "B" : "A");
  if (deciding && mine === mid && theirs < mid) n.switchEnds = true;
  return n;
}

/** Applies one event; throws `RacketRuleError` (state unchanged) when refused. */
export function applyRacketEvent(s: RacketState, e: RacketEvent): RacketState {
  if (!e || typeof e !== "object" || typeof e.id !== "string" || e.id.length === 0) bad();
  if (s.status === "ended") throw new RacketRuleError("INVALID_POINT", MATCH_OVER, true);
  switch (e.type) {
    case "point":
      if (e.winner !== "A" && e.winner !== "B") bad();
      switch (s.config.sport) {
        case "badminton":
          return badmintonPoint(s, e.winner);
      }
      return bad();
    case "setServer": {
      if (e.side !== "A" && e.side !== "B") bad();
      const n = clone(s);
      n.server = { side: e.side, court: courtFor(pointsOf(n.current, e.side)) };
      return n;
    }
    default:
      return bad();
  }
}

export function replayRacket(config: RacketConfig, events: RacketEvent[]): RacketState {
  let s = initialRacketState(config);
  for (const e of events) s = applyRacketEvent(s, e);
  return s;
}

/**
 * Removes the last point and any `setServer` after it (those fixed the serve
 * of a state that no longer exists). Crosses game boundaries and reopens an
 * ended match. Throws "Nothing to undo." when no point is left.
 */
export function undoLastPoint(events: RacketEvent[]): { events: RacketEvent[]; pointId: string } {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "point") return { events: events.slice(0, i), pointId: events[i].id };
  }
  throw new RacketRuleError("INVALID_POINT", NOTHING_TO_UNDO);
}

/** 1-based game number of the next point (the last game once ended). */
export function gameNumber(s: RacketState): number {
  return s.status === "ended" ? s.games.length : s.games.length + 1;
}

// ─── Result ─────────────────────────────────────────────

export type RacketResult =
  | { kind: "sets"; sets: SetScore[] }
  | { kind: "simple"; scoreA: number; scoreB: number };

/** The score the manual path would receive. Only once the match has ended. */
export function toRacketResult(s: RacketState): RacketResult {
  if (s.status !== "ended") throw new RacketRuleError("INVALID_POINT", "The match isn't over yet.", true);
  if (s.config.format === "simple") {
    const g = s.games[0];
    return { kind: "simple", scoreA: g.a, scoreB: g.b };
  }
  return { kind: "sets", sets: s.games.map((g) => ({ teamAPoints: g.a, teamBPoints: g.b })) };
}

// ─── Summary (matches/{id}.live) ────────────────────────

export interface RacketSummaryFields {
  status: RacketStatus;
  games: GameScore[];
  current: GameScore;
  server: { side: RacketSide; court: RacketCourt };
  gamesWon: GameScore;
  switchEnds: boolean;
}

export function racketLiveSummary(s: RacketState): RacketSummaryFields {
  return {
    status: s.status,
    games: s.games.map((g) => ({ a: g.a, b: g.b })),
    current: { a: s.current.a, b: s.current.b },
    server: { side: s.server.side, court: s.server.court },
    gamesWon: { a: s.gamesWon.a, b: s.gamesWon.b },
    switchEnds: s.switchEnds,
  };
}

// ─── Parity fixture formatting ──────────────────────────

/** Sorted keys, compact, `/` escaped (same as cricketLive.sortedJson). */
export function racketSortedJson(value: unknown): string {
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

/**
 * One-line state for the parity fixture:
 * `st=<status> games=[<a>-<b>,...] cur=<a>-<b> won=<a>-<b> srv=<A|B><R|L> sw=<0|1> game=<n>`
 */
export function formatRacketStateLine(s: RacketState): string {
  const games = s.games.map((g) => `${g.a}-${g.b}`).join(",");
  return `st=${s.status} games=[${games}] cur=${s.current.a}-${s.current.b} won=${s.gamesWon.a}-${s.gamesWon.b} ` +
    `srv=${s.server.side}${s.server.court} sw=${s.switchEnds ? 1 : 0} game=${gameNumber(s)}`;
}
