/**
 * Cricket live scoring: the reference reducer (events → state + scorecard).
 *
 * The callables in `callables/cricketLive.ts` validate every action by
 * applying it here; iOS (`CricketLive.swift`) and Android (`CricketLive.kt`)
 * port it for instant feedback and must reproduce
 * `test-fixtures/cricket-live-fixture.txt` exactly (`npm run check:cricket-live`).
 * Contract: ~/Desktop/TournMate-PRs/cricket-live-contract.md.
 *
 * Stored data (server-written only)
 * - matches/{id}/cricketLive/state: { config, events, scorecard, updatedAt }
 *   `events` holds the effective events (undo removes them), `config` is
 *   frozen when the first innings starts.
 * - matches/{id}.live: summary for cards (`liveSummary`).
 * - matches/{id}/balls/{ballId}: one doc per ball event (history; undo marks
 *   it `undone: true`).
 *
 * Conventions
 * - Batters' balls faced count legal deliveries only (no-balls and wides
 *   aren't counted), so the figures always fit `validatePlayerStats`.
 * - A dismissed batter is replaced in place by the next batter, after the
 *   strike change for runs and before the over-end change.
 * - Retirements are recorded as non-deliveries (`legal: false`, no runs).
 */

import { CricketResult, CricketRules, formatOvers, maxWickets } from "./cricket";
import { PlayerStats } from "./cricketPlayerStats";

// ─── Types ──────────────────────────────────────────────

export type ExtrasType = "wide" | "noBall" | "bye" | "legBye";
export const EXTRAS_TYPES: readonly ExtrasType[] = ["wide", "noBall", "bye", "legBye"];

export type WicketType =
  | "bowled" | "caught" | "lbw" | "runOut" | "stumped" | "hitWicket" | "retiredHurt" | "retiredOut";
export const WICKET_TYPES: readonly WicketType[] =
  ["bowled", "caught", "lbw", "runOut", "stumped", "hitWicket", "retiredHurt", "retiredOut"];

/** Dismissals credited to the bowler. */
const BOWLER_WICKETS: readonly WicketType[] = ["bowled", "caught", "lbw", "stumped", "hitWicket"];
const RETIREMENTS: readonly WicketType[] = ["retiredHurt", "retiredOut"];

export interface LivePlayer {
  key: string;
  name: string;
}

export interface LiveTeam {
  /** Registration id. */
  id: string;
  name: string;
  /** Lineup XI (in batting order) when set, else the roster. */
  players: LivePlayer[];
  /** Planned batting order (keys). */
  order: string[];
}

export interface LiveConfig {
  /** Tournament rules with knockout rules applied. */
  rules: CricketRules;
  /** From rulesData; null = ceil(innings overs / 5). */
  maxOversPerBowler: number | null;
  battingFirstTeamId: string;
  teams: LiveTeam[];
}

export interface Extras {
  type: ExtrasType;
  runs: number;
}

export interface Wicket {
  type: WicketType;
  batterKey: string;
  fielderKey?: string;
}

export interface StartInningsEvent {
  type: "startInnings";
  strikerKey: string;
  nonStrikerKey: string;
  bowlerKey: string;
}

export interface BallEvent {
  type: "ball";
  id: string;
  runs: number;
  extras?: Extras;
  wicket?: Wicket;
  nextBatterKey?: string;
  nextBowlerKey?: string;
  swapStrike?: boolean;
}

export interface RevisedTargetEvent {
  type: "revisedTarget";
  runs: number;
  overs: number;
}

export interface EndInningsEvent {
  type: "endInnings";
  reason: string;
}

export type LiveEvent = StartInningsEvent | BallEvent | RevisedTargetEvent | EndInningsEvent;

export type LiveReason = "INVALID_BALL" | "INNINGS_OVER" | "INVALID_ARGUMENT";

/** A refused event; `message` is user-facing. */
export class LiveRuleError extends Error {
  constructor(readonly reason: LiveReason, message: string) {
    super(message);
  }
}

export interface HowOut {
  type: WicketType;
  bowlerKey?: string;
  fielderKey?: string;
}

export interface BatterLine {
  key: string;
  name: string;
  runs: number;
  /** Legal balls faced. */
  balls: number;
  fours: number;
  sixes: number;
  out: boolean;
  /** Retired hurt and not (yet) back. */
  retiredHurt: boolean;
  howOut?: HowOut;
}

export interface BowlerLine {
  key: string;
  name: string;
  legalBalls: number;
  maidens: number;
  runs: number;
  wickets: number;
  wides: number;
  noBalls: number;
}

export interface FallOfWicket {
  wicket: number;
  runs: number;
  legalBalls: number;
  batterKey: string;
}

export interface OverLine {
  /** 0-based. */
  index: number;
  bowlerKey: string | null;
  /** Team runs in the over. */
  runs: number;
  wickets: number;
  codes: string[];
}

export interface ExtrasTotals {
  wides: number;
  noBalls: number;
  byes: number;
  legByes: number;
  total: number;
}

export type EndReason = "allOut" | "overs" | "target" | "manual";

export interface InningsState {
  battingTeamId: string;
  bowlingTeamId: string;
  runs: number;
  wickets: number;
  legalBalls: number;
  extras: ExtrasTotals;
  batting: BatterLine[];
  bowling: BowlerLine[];
  fallOfWickets: FallOfWicket[];
  overs: OverLine[];
  target?: number;
  revisedOvers?: number;
  complete: boolean;
  endReason?: EndReason;
  endNote?: string;
  strikerKey: string | null;
  nonStrikerKey: string | null;
  bowlerKey: string | null;
  lastOverBowlerKey: string | null;
  /** Runs the current bowler has conceded in the current over (maidens). */
  overConceded: number;
  freeHit: boolean;
  /** Index into `overs` of the latest event's over; -1 before the first ball. */
  lastOver: number;
}

export type LiveStatus = "setup" | "inProgress" | "inningsBreak" | "ended";

export interface LiveState {
  config: LiveConfig;
  innings: InningsState[];
  revisedTarget?: { runs: number; overs: number };
}

// ─── Helpers ────────────────────────────────────────────

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const invalid = (message: string): never => {
  throw new LiveRuleError("INVALID_BALL", message);
};
const BAD_BALL = "That ball isn't valid. Update the app and try again.";

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function initialState(config: LiveConfig): LiveState {
  return { config: clone(config), innings: [] };
}

export function liveStatus(s: LiveState): LiveStatus {
  if (s.innings.length === 0) return "setup";
  const cur = s.innings[s.innings.length - 1];
  if (!cur.complete) return "inProgress";
  return s.innings.length === 1 ? "inningsBreak" : "ended";
}

function team(s: LiveState, id: string): LiveTeam {
  return s.config.teams.find((t) => t.id === id) ?? s.config.teams[0];
}

function otherTeamId(s: LiveState, id: string): string {
  return s.config.teams.find((t) => t.id !== id)?.id ?? id;
}

function inPool(s: LiveState, teamId: string, key: string | undefined): boolean {
  return typeof key === "string" && team(s, teamId).players.some((p) => p.key === key);
}

export function playerName(s: LiveState, key: string): string {
  for (const t of s.config.teams) {
    const p = t.players.find((x) => x.key === key);
    if (p) return p.name;
  }
  return key.startsWith("guest:") ? key.slice(6) : key;
}

/** Overs available to an innings (revised overs for a revised chase). */
function oversLimit(s: LiveState, inn: InningsState): number {
  return inn.revisedOvers ?? s.config.rules.overs;
}

export function maxOversFor(s: LiveState, inn: InningsState): number {
  return s.config.maxOversPerBowler ?? Math.ceil(oversLimit(s, inn) / 5);
}

function current(s: LiveState): InningsState | undefined {
  return s.innings[s.innings.length - 1];
}

/** The innings in progress, or the reason no ball can be recorded. */
function requirePlaying(s: LiveState): InningsState {
  switch (liveStatus(s)) {
    case "setup": throw new LiveRuleError("INNINGS_OVER", "Start the innings first.");
    case "inningsBreak": throw new LiveRuleError("INNINGS_OVER", "This innings is over. Start the next innings.");
    case "ended": throw new LiveRuleError("INNINGS_OVER", "Both innings are over. Finish the match.");
    case "inProgress": return current(s)!;
  }
}

function batterLine(s: LiveState, inn: InningsState, key: string): BatterLine {
  let line = inn.batting.find((b) => b.key === key);
  if (!line) {
    line = { key, name: playerName(s, key), runs: 0, balls: 0, fours: 0, sixes: 0, out: false, retiredHurt: false };
    inn.batting.push(line);
  }
  return line;
}

function bowlerLine(s: LiveState, inn: InningsState, key: string): BowlerLine {
  let line = inn.bowling.find((b) => b.key === key);
  if (!line) {
    line = { key, name: playerName(s, key), legalBalls: 0, maidens: 0, runs: 0, wickets: 0, wides: 0, noBalls: 0 };
    inn.bowling.push(line);
  }
  return line;
}

function recomputeExtras(e: ExtrasTotals): void {
  e.total = e.wides + e.noBalls + e.byes + e.legByes;
}

function swap(inn: InningsState): void {
  [inn.strikerKey, inn.nonStrikerKey] = [inn.nonStrikerKey, inn.strikerKey];
  normalizeLone(inn);
}

/** A batter alone at the crease (last man stands) always has the strike. */
function normalizeLone(inn: InningsState): void {
  if (inn.strikerKey === null && inn.nonStrikerKey !== null) {
    inn.strikerKey = inn.nonStrikerKey;
    inn.nonStrikerKey = null;
  }
}

/** Short code for the over display: ".", "4", "wd", "3wd", "nb", "4nb", "1b", "2lb", "W", "1W", "RH", "RO". */
export function ballCode(e: Pick<BallEvent, "runs" | "extras" | "wicket">): string {
  if (e.wicket?.type === "retiredHurt") return "RH";
  if (e.wicket?.type === "retiredOut") return "RO";
  let base: string;
  const x = e.extras;
  if (!x) base = e.runs === 0 ? "." : `${e.runs}`;
  else if (x.type === "wide") base = x.runs > 0 ? `${1 + x.runs}wd` : "wd";
  else if (x.type === "noBall") base = e.runs + x.runs > 0 ? `${e.runs + x.runs}nb` : "nb";
  else if (x.type === "bye") base = `${x.runs}b`;
  else base = `${x.runs}lb`;
  if (!e.wicket) return base;
  return base === "." ? "W" : `${base}W`;
}

function overFor(inn: InningsState, bpo: number): OverLine {
  const index = Math.floor(inn.legalBalls / bpo);
  let line = inn.overs.find((o) => o.index === index);
  if (!line) {
    line = { index, bowlerKey: inn.bowlerKey, runs: 0, wickets: 0, codes: [] };
    inn.overs.push(line);
  }
  inn.lastOver = inn.overs.indexOf(line);
  return line;
}

/** Checks the end of the innings; returns true when it just ended. */
function checkEnd(s: LiveState, inn: InningsState, idx: number): boolean {
  if (inn.complete) return false;
  const r = s.config.rules;
  let reason: EndReason | null = null;
  if (idx === 1 && inn.target !== undefined && inn.runs >= inn.target) reason = "target";
  else if (inn.wickets >= maxWickets(r)) reason = "allOut";
  else if (inn.legalBalls >= oversLimit(s, inn) * r.ballsPerOver) reason = "overs";
  if (!reason) return false;
  inn.complete = true;
  inn.endReason = reason;
  return true;
}

/** Keys that can still come in: in the side, not at the crease, not dismissed. */
export function availableBatters(s: LiveState, inn: InningsState, except?: string): string[] {
  return team(s, inn.battingTeamId).players.map((p) => p.key).filter((k) =>
    k !== except && k !== inn.strikerKey && k !== inn.nonStrikerKey && !inn.batting.some((b) => b.key === k && b.out));
}

/**
 * After a wicket or retirement: fills the empty end or ends the innings. A
 * batter retiring hurt can't replace themself on the same event.
 */
function replaceBatter(s: LiveState, inn: InningsState, next: string | undefined, except?: string): void {
  if (inn.complete) {
    if (next !== undefined) invalid("No new batter is needed.");
    return;
  }
  const available = availableBatters(s, inn, except);
  if (available.length === 0) {
    if (next !== undefined) {
      if (!inPool(s, inn.battingTeamId, next)) invalid("That batter isn't in the batting side.");
      invalid("That batter has already batted.");
    }
    if (s.config.rules.lastManStands && (inn.strikerKey !== null || inn.nonStrikerKey !== null)) {
      normalizeLone(inn);
      return;
    }
    inn.complete = true;
    inn.endReason = "allOut";
    return;
  }
  if (next === undefined) invalid("Pick the next batter.");
  if (!inPool(s, inn.battingTeamId, next)) invalid("That batter isn't in the batting side.");
  if (!available.includes(next!)) invalid("That batter has already batted.");
  const line = batterLine(s, inn, next!);
  line.retiredHurt = false;
  if (inn.strikerKey === null) inn.strikerKey = next!;
  else inn.nonStrikerKey = next!;
}

// ─── Events ─────────────────────────────────────────────

function startInnings(s: LiveState, e: StartInningsEvent): void {
  const status = liveStatus(s);
  if (status === "inProgress") invalid("This innings has already started.");
  if (status === "ended") throw new LiveRuleError("INNINGS_OVER", "Both innings have been played.");
  const idx = s.innings.length;
  const battingTeamId = idx === 0 ? s.config.battingFirstTeamId : otherTeamId(s, s.innings[0].battingTeamId);
  const bowlingTeamId = otherTeamId(s, battingTeamId);
  if (typeof e.strikerKey !== "string" || typeof e.nonStrikerKey !== "string" || typeof e.bowlerKey !== "string") invalid(BAD_BALL);
  if (e.strikerKey === e.nonStrikerKey) invalid("Pick two different batters.");
  if (!inPool(s, battingTeamId, e.strikerKey) || !inPool(s, battingTeamId, e.nonStrikerKey)) {
    invalid("That batter isn't in the batting side.");
  }
  if (!inPool(s, bowlingTeamId, e.bowlerKey)) invalid("That bowler isn't in the fielding side.");
  const inn: InningsState = {
    battingTeamId, bowlingTeamId, runs: 0, wickets: 0, legalBalls: 0,
    extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, total: 0 },
    batting: [], bowling: [], fallOfWickets: [], overs: [], complete: false,
    strikerKey: e.strikerKey, nonStrikerKey: e.nonStrikerKey, bowlerKey: e.bowlerKey, lastOverBowlerKey: null,
    overConceded: 0, freeHit: false, lastOver: -1,
  };
  if (idx === 1) {
    inn.target = s.revisedTarget?.runs ?? s.innings[0].runs + 1;
    if (s.revisedTarget) inn.revisedOvers = s.revisedTarget.overs;
  }
  batterLine(s, inn, e.strikerKey);
  batterLine(s, inn, e.nonStrikerKey);
  s.innings.push(inn);
  // A revised chase of 0 remaining overs can't happen (overs ≥ 1), so no end check.
}

function checkShape(e: BallEvent): void {
  if (!isInt(e.runs) || e.runs < 0 || e.runs > 7) invalid("Runs must be a whole number from 0 to 7.");
  if (e.extras !== undefined) {
    if (!e.extras || !EXTRAS_TYPES.includes(e.extras.type)) invalid(BAD_BALL);
    if (!isInt(e.extras.runs) || e.extras.runs < 0 || e.extras.runs > 7) invalid("Extra runs must be a whole number from 0 to 7.");
  }
  if (e.wicket !== undefined) {
    if (!e.wicket || !WICKET_TYPES.includes(e.wicket.type) || typeof e.wicket.batterKey !== "string") invalid(BAD_BALL);
    if (e.wicket.fielderKey !== undefined && typeof e.wicket.fielderKey !== "string") invalid(BAD_BALL);
  }
  for (const k of [e.nextBatterKey, e.nextBowlerKey]) {
    if (k !== undefined && typeof k !== "string") invalid(BAD_BALL);
  }
  if (e.swapStrike !== undefined && typeof e.swapStrike !== "boolean") invalid(BAD_BALL);
}

function chooseBowler(s: LiveState, inn: InningsState, next: string | undefined, required: boolean): void {
  if (inn.bowlerKey === null) {
    if (next === undefined) {
      if (required) invalid("Pick the bowler for the next over.");
      return;
    }
    if (!inPool(s, inn.bowlingTeamId, next)) invalid("That bowler isn't in the fielding side.");
    if (next === inn.lastOverBowlerKey) invalid("That bowler bowled the last over.");
    const bowled = inn.bowling.find((b) => b.key === next)?.legalBalls ?? 0;
    if (Math.floor(bowled / s.config.rules.ballsPerOver) >= maxOversFor(s, inn)) invalid("That bowler has no overs left.");
    inn.bowlerKey = next;
    inn.overConceded = 0;
    const line = inn.overs.find((o) => o.index === Math.floor(inn.legalBalls / s.config.rules.ballsPerOver));
    if (line && line.bowlerKey === null) line.bowlerKey = next;
  } else if (next !== undefined && next !== inn.bowlerKey) {
    invalid("The bowler can't change in the middle of an over.");
  }
}

function ball(s: LiveState, e: BallEvent): void {
  checkShape(e);
  const inn = requirePlaying(s);
  const idx = s.innings.length - 1;
  const r = s.config.rules;
  const w = e.wicket;
  const x = e.extras;

  if (e.swapStrike) {
    if (inn.nonStrikerKey === null) invalid(BAD_BALL);
    swap(inn);
  }

  // Retirement: not a delivery.
  if (w && RETIREMENTS.includes(w.type)) {
    if (e.runs !== 0 || x) invalid("Record the retirement on its own, without runs.");
    if (w.fielderKey !== undefined) invalid(BAD_BALL);
    chooseBowler(s, inn, e.nextBowlerKey, false);
    if (w.batterKey !== inn.strikerKey && w.batterKey !== inn.nonStrikerKey) invalid("The dismissed batter must be at the crease.");
    const over = overFor(inn, r.ballsPerOver);
    const line = batterLine(s, inn, w.batterKey);
    if (w.type === "retiredHurt") {
      line.retiredHurt = true;
    } else {
      line.out = true;
      line.howOut = { type: "retiredOut" };
      inn.wickets += 1;
      over.wickets += 1;
      inn.fallOfWickets.push({ wicket: inn.wickets, runs: inn.runs, legalBalls: inn.legalBalls, batterKey: w.batterKey });
    }
    over.codes.push(ballCode(e));
    if (inn.strikerKey === w.batterKey) inn.strikerKey = null;
    else inn.nonStrikerKey = null;
    checkEnd(s, inn, idx);
    replaceBatter(s, inn, e.nextBatterKey, w.batterKey);
    return;
  }

  chooseBowler(s, inn, e.nextBowlerKey, true);
  const bowler = inn.bowlerKey!;

  if (x && x.type !== "noBall" && e.runs !== 0) invalid("Runs off the bat can't be added to a wide, bye or leg bye.");
  if (x && (x.type === "bye" || x.type === "legBye") && x.runs < 1) invalid("A bye or leg bye needs at least 1 run.");
  if (w) {
    const allowed: readonly WicketType[] = !x ? ["bowled", "caught", "lbw", "runOut", "stumped", "hitWicket"]
      : x.type === "wide" ? ["runOut", "stumped", "hitWicket"] : ["runOut"];
    if (!allowed.includes(w.type)) invalid("That dismissal can't happen on this ball.");
    if (w.batterKey !== inn.strikerKey && w.batterKey !== inn.nonStrikerKey) invalid("The dismissed batter must be at the crease.");
    if (w.type !== "runOut") {
      if (w.batterKey !== inn.strikerKey) invalid("Only the striker can be out that way.");
      if (e.runs !== 0 || (x && x.runs !== 0)) invalid("That dismissal can't happen on this ball.");
    }
    if (w.type === "caught" || w.type === "stumped") {
      if (w.fielderKey === undefined) invalid("Pick the fielder.");
    } else if (w.type !== "runOut" && w.fielderKey !== undefined) {
      invalid(BAD_BALL);
    }
    if (w.fielderKey !== undefined && !inPool(s, inn.bowlingTeamId, w.fielderKey)) invalid("That fielder isn't in the fielding side.");
  }
  if (e.nextBatterKey !== undefined && !w) invalid("No new batter is needed.");

  const over = overFor(inn, r.ballsPerOver);
  if (over.bowlerKey === null) over.bowlerKey = bowler;
  const legal = !x || x.type === "bye" || x.type === "legBye";
  const xr = x?.runs ?? 0;
  const penalty = x && (x.type === "wide" || x.type === "noBall") ? 1 : 0;
  const total = e.runs + xr + penalty;
  inn.runs += total;
  over.runs += total;
  if (x?.type === "wide") inn.extras.wides += 1 + xr;
  if (x?.type === "noBall") {
    inn.extras.noBalls += 1;
    inn.extras.byes += xr;
  }
  if (x?.type === "bye") inn.extras.byes += xr;
  if (x?.type === "legBye") inn.extras.legByes += xr;
  recomputeExtras(inn.extras);

  const striker = batterLine(s, inn, inn.strikerKey!);
  if (!x || x.type === "noBall") {
    striker.runs += e.runs;
    if (e.runs === 4) striker.fours += 1;
    if (e.runs === 6) striker.sixes += 1;
  }
  if (legal) striker.balls += 1;

  const bl = bowlerLine(s, inn, bowler);
  const conceded = !x ? e.runs : x.type === "wide" ? 1 + xr : x.type === "noBall" ? 1 + e.runs : 0;
  bl.runs += conceded;
  inn.overConceded += conceded;
  if (legal) bl.legalBalls += 1;
  if (x?.type === "wide") bl.wides += 1;
  if (x?.type === "noBall") bl.noBalls += 1;
  if (legal) inn.legalBalls += 1;

  if (x?.type === "noBall") inn.freeHit = true;
  else if (legal) inn.freeHit = false;

  const ran = !x ? e.runs : x.type === "noBall" ? e.runs + xr : xr;
  if (ran % 2 === 1 && inn.nonStrikerKey !== null) swap(inn);

  if (w) {
    const line = batterLine(s, inn, w.batterKey);
    line.out = true;
    line.retiredHurt = false;
    const credited = BOWLER_WICKETS.includes(w.type);
    line.howOut = { type: w.type, ...(credited ? { bowlerKey: bowler } : {}), ...(w.fielderKey ? { fielderKey: w.fielderKey } : {}) };
    if (credited) bl.wickets += 1;
    inn.wickets += 1;
    over.wickets += 1;
    inn.fallOfWickets.push({ wicket: inn.wickets, runs: inn.runs, legalBalls: inn.legalBalls, batterKey: w.batterKey });
    if (inn.strikerKey === w.batterKey) inn.strikerKey = null;
    else inn.nonStrikerKey = null;
  }
  over.codes.push(ballCode(e));

  const overDone = legal && inn.legalBalls % r.ballsPerOver === 0;
  if (overDone && inn.overConceded === 0) bl.maidens += 1;
  checkEnd(s, inn, idx);
  if (w) replaceBatter(s, inn, e.nextBatterKey);
  if (overDone) {
    if (!inn.complete) swap(inn);
    inn.lastOverBowlerKey = bowler;
    inn.bowlerKey = null;
    inn.overConceded = 0;
  }
}

function revisedTarget(s: LiveState, e: RevisedTargetEvent): void {
  const r = s.config.rules;
  if (s.innings.length === 0 || !s.innings[0].complete) {
    throw new LiveRuleError("INVALID_ARGUMENT", "A revised target is set once the first innings is over.");
  }
  const second = s.innings[1];
  if (second?.complete && second.endReason !== "manual") {
    throw new LiveRuleError("INNINGS_OVER", "Both innings have been played.");
  }
  if (!isInt(e.runs) || e.runs < 1) throw new LiveRuleError("INVALID_ARGUMENT", "Revised target must be at least 1 run.");
  if (!isInt(e.overs) || e.overs < 1 || e.overs > r.overs) {
    throw new LiveRuleError("INVALID_ARGUMENT", `Revised overs must be between 1 and ${r.overs}.`);
  }
  if (second && e.overs * r.ballsPerOver < second.legalBalls) {
    throw new LiveRuleError("INVALID_ARGUMENT", "Revised overs can't be fewer than the overs already bowled.");
  }
  s.revisedTarget = { runs: e.runs, overs: e.overs };
  if (!second) return;
  second.target = e.runs;
  second.revisedOvers = e.overs;
  if (second.complete) {
    // Ended by hand: the revised target decides how it ended.
    second.complete = false;
    const note = second.endNote;
    delete second.endReason;
    if (!checkEnd(s, second, 1)) {
      second.complete = true;
      second.endReason = "manual";
    }
    if (note !== undefined) second.endNote = note;
  } else {
    checkEnd(s, second, 1);
  }
}

function endInnings(s: LiveState, e: EndInningsEvent): void {
  const inn = requirePlaying(s);
  inn.complete = true;
  inn.endReason = "manual";
  const note = typeof e.reason === "string" ? e.reason.trim().slice(0, 100) : "";
  if (note) inn.endNote = note;
}

/** Applies one event to a copy of `s`. Throws `LiveRuleError` when the event is refused. */
export function applyEvent(s: LiveState, e: LiveEvent): LiveState {
  const next = clone(s);
  switch (e?.type) {
    case "startInnings": startInnings(next, e); break;
    case "ball": ball(next, e); break;
    case "revisedTarget": revisedTarget(next, e); break;
    case "endInnings": endInnings(next, e); break;
    default: invalid(BAD_BALL);
  }
  return next;
}

/** State after every event; throws if one is refused. */
export function replay(config: LiveConfig, events: LiveEvent[]): LiveState {
  let s = initialState(config);
  for (const e of events) s = applyEvent(s, e);
  return s;
}

/**
 * Events after "Undo last ball": the last ball and any end of innings after
 * it are removed (revised targets stay). Never crosses the start of an
 * innings. Throws "Nothing to undo." when there is no ball to undo.
 */
export function undoLastBall(events: LiveEvent[]): { events: LiveEvent[]; ballId: string } {
  let i = events.length - 1;
  while (i >= 0 && events[i].type !== "ball") {
    if (events[i].type === "startInnings") invalid("Nothing to undo.");
    i--;
  }
  if (i < 0) invalid("Nothing to undo.");
  const ballId = (events[i] as BallEvent).id;
  const kept = events.filter((e, j) => j < i || (j > i && e.type !== "endInnings"));
  return { events: kept, ballId };
}

// ─── Outputs ────────────────────────────────────────────

export interface InningsSummary {
  battingTeamId: string;
  runs: number;
  wickets: number;
  legalBalls: number;
  target?: number;
  revisedOvers?: number;
  complete: boolean;
  endReason?: EndReason;
}

export interface LiveSummaryFields {
  status: LiveStatus;
  inningsIndex: number;
  innings: InningsSummary[];
  current: { strikerKey: string | null; nonStrikerKey: string | null; bowlerKey: string | null; lastOverBowlerKey: string | null };
  thisOver: string[];
  freeHit: boolean;
}

/** The reducer's part of `matches.live`. */
export function liveSummary(s: LiveState): LiveSummaryFields {
  const cur = current(s);
  return {
    status: liveStatus(s),
    inningsIndex: s.innings.length,
    innings: s.innings.map((i) => ({
      battingTeamId: i.battingTeamId, runs: i.runs, wickets: i.wickets, legalBalls: i.legalBalls,
      ...(i.target !== undefined ? { target: i.target } : {}),
      ...(i.revisedOvers !== undefined ? { revisedOvers: i.revisedOvers } : {}),
      complete: i.complete,
      ...(i.endReason ? { endReason: i.endReason } : {}),
    })),
    current: {
      strikerKey: cur?.strikerKey ?? null,
      nonStrikerKey: cur?.nonStrikerKey ?? null,
      bowlerKey: cur && !cur.complete ? cur.bowlerKey : null,
      lastOverBowlerKey: cur?.lastOverBowlerKey ?? null,
    },
    thisOver: cur && cur.lastOver >= 0 ? [...cur.overs[cur.lastOver].codes] : [],
    freeHit: !!cur && !cur.complete && cur.freeHit,
  };
}

export interface InningsScorecard {
  battingTeamId: string;
  bowlingTeamId: string;
  runs: number;
  wickets: number;
  legalBalls: number;
  extras: ExtrasTotals;
  batting: BatterLine[];
  bowling: BowlerLine[];
  fallOfWickets: FallOfWicket[];
  overs: OverLine[];
  target?: number;
  revisedOvers?: number;
  complete: boolean;
  endReason?: EndReason;
  endNote?: string;
}

/** Full scorecard per innings (batting order as batted). */
export function scorecard(s: LiveState): { innings: InningsScorecard[] } {
  return {
    innings: s.innings.map((i) => {
      const c: InningsScorecard = {
        battingTeamId: i.battingTeamId, bowlingTeamId: i.bowlingTeamId, runs: i.runs, wickets: i.wickets,
        legalBalls: i.legalBalls, extras: { ...i.extras }, batting: clone(i.batting), bowling: clone(i.bowling),
        fallOfWickets: clone(i.fallOfWickets), overs: clone(i.overs), complete: i.complete,
      };
      if (i.target !== undefined) c.target = i.target;
      if (i.revisedOvers !== undefined) c.revisedOvers = i.revisedOvers;
      if (i.endReason) c.endReason = i.endReason;
      if (i.endNote) c.endNote = i.endNote;
      return c;
    }),
  };
}

/** The manual path's `CricketResult` for this state. */
export function toCricketResult(
  s: LiveState,
  opts: { noResult?: boolean; superOverWinnerRegistrationId?: string } = {},
): CricketResult {
  const result: CricketResult = {
    innings: s.innings.map((i) => ({ battingRegistrationId: i.battingTeamId, runs: i.runs, wickets: i.wickets, balls: i.legalBalls })),
  };
  if (s.revisedTarget && s.innings.length === 2) result.revisedTarget = { ...s.revisedTarget };
  if (opts.superOverWinnerRegistrationId) result.superOverWinnerRegistrationId = opts.superOverWinnerRegistrationId;
  if (opts.noResult) result.noResult = true;
  return result;
}

/** The manual path's `PlayerStats` (batting order, then bowling order). */
export function toPlayerStats(s: LiveState): PlayerStats {
  const stats: PlayerStats = { batting: [], bowling: [] };
  for (const i of s.innings) {
    for (const b of i.batting) {
      stats.batting.push({ teamRegistrationId: i.battingTeamId, key: b.key, name: b.name, runs: b.runs, balls: b.balls, out: b.out });
    }
  }
  for (const i of s.innings) {
    for (const b of i.bowling) {
      stats.bowling.push({ teamRegistrationId: i.bowlingTeamId, key: b.key, name: b.name, balls: b.legalBalls, runs: b.runs, wickets: b.wickets });
    }
  }
  return stats;
}

/** Ball doc numbering for a ball event applied to `before`: over (0-based) and ball in over. */
export function ballPosition(before: LiveState, e: BallEvent): { innings: number; over: number; ballInOver: number; legal: boolean } {
  const inn = current(before)!;
  const bpo = before.config.rules.ballsPerOver;
  const retired = !!e.wicket && RETIREMENTS.includes(e.wicket.type);
  const legal = !retired && (!e.extras || e.extras.type === "bye" || e.extras.type === "legBye");
  const over = Math.floor(inn.legalBalls / bpo);
  const inOver = inn.legalBalls % bpo;
  return { innings: before.innings.length, over, ballInOver: legal ? inOver + 1 : inOver, legal };
}

/**
 * Players per side for validating the result with `validateCricketResult`:
 * undefined normally; when an innings ran out of batters (an XI smaller than
 * the rules' side), the smallest such XI, so "all out" matches.
 */
export function validationPlayersPerSide(s: LiveState): number | undefined {
  const r = s.config.rules;
  const lms = r.lastManStands ? 0 : 1;
  const short = s.innings.filter((i) => i.complete && i.endReason === "allOut" && i.wickets < maxWickets(r));
  if (short.length === 0) return undefined;
  return Math.max(2, Math.min(r.playersPerSide, ...short.map((i) => i.wickets + lms)));
}

// ─── Fixture formatting (parity) ───────────────────────

/** Sorted keys, compact, `/` escaped (same as the score callables' `encodeSorted`). */
export function sortedJson(value: unknown): string {
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

/** One-line state for the parity fixture. */
export function formatStateLine(s: LiveState): string {
  const sum = liveSummary(s);
  const cur = current(s);
  const bpo = s.config.rules.ballsPerOver;
  const parts = [`st=${sum.status}`, `inn=${sum.inningsIndex}`];
  if (cur) {
    parts.push(`${cur.runs}/${cur.wickets}`, `(${formatOvers(cur.legalBalls, bpo)})`);
    if (cur.target !== undefined) parts.push(`tgt=${cur.target}`);
  }
  const k = (v: string | null) => v ?? "-";
  parts.push(`s=${k(sum.current.strikerKey)}`, `ns=${k(sum.current.nonStrikerKey)}`, `b=${k(sum.current.bowlerKey)}`,
    `lb=${k(sum.current.lastOverBowlerKey)}`, `fh=${sum.freeHit ? 1 : 0}`, `over=[${sum.thisOver.join(",")}]`);
  if (cur?.complete && cur.endReason) parts.push(`end=${cur.endReason}`);
  return parts.join(" ");
}

/** Scorecard lines for the parity fixture (one per batter, bowler, extras, fall of wickets, overs). */
export function formatScorecardLines(s: LiveState): string[] {
  const out: string[] = [];
  const bpo = s.config.rules.ballsPerOver;
  s.innings.forEach((i, n) => {
    const p = `${n + 1}`;
    out.push(`${p} total ${i.battingTeamId} ${i.runs}/${i.wickets} (${formatOvers(i.legalBalls, bpo)})` +
      `${i.target !== undefined ? ` tgt=${i.target}` : ""}${i.revisedOvers !== undefined ? ` rov=${i.revisedOvers}` : ""}` +
      ` end=${i.complete ? i.endReason : "-"}`);
    for (const b of i.batting) {
      const how = b.howOut
        ? `${b.howOut.type}${b.howOut.bowlerKey ? ` b=${b.howOut.bowlerKey}` : ""}${b.howOut.fielderKey ? ` f=${b.howOut.fielderKey}` : ""}`
        : b.retiredHurt ? "retiredHurt" : "notOut";
      out.push(`${p} bat ${b.key} ${b.runs}(${b.balls}) 4s=${b.fours} 6s=${b.sixes} ${how}`);
    }
    for (const b of i.bowling) {
      out.push(`${p} bowl ${b.key} ${formatOvers(b.legalBalls, bpo)}-${b.maidens}-${b.runs}-${b.wickets} wd=${b.wides} nb=${b.noBalls}`);
    }
    const x = i.extras;
    out.push(`${p} extras ${x.total} (wd ${x.wides}, nb ${x.noBalls}, b ${x.byes}, lb ${x.legByes})`);
    out.push(`${p} fow ${i.fallOfWickets.map((f) => `${f.wicket}-${f.runs} ${f.batterKey} (${formatOvers(f.legalBalls, bpo)})`).join(", ")}`);
    for (const o of i.overs) {
      out.push(`${p} over ${o.index + 1} ${o.bowlerKey ?? "-"} ${o.runs}r ${o.wickets}w [${o.codes.join(",")}]`);
    }
  });
  return out;
}
