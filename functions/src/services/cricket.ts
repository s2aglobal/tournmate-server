/**
 * Cricket rules: innings validation, match outcome and net run rate.
 *
 * This file is the reference for the cricket "innings" archetype. The iOS
 * (`CricketRules.swift`) and Android (`CricketRules.kt`) ports must produce
 * the same validation messages, outcomes and NRR; `scripts/checkCricket.ts`
 * holds the shared cases.
 *
 * Stored data
 * Event types are limited-overs only (T20, One Day, T10, box cricket).
 * Multi-day / Test cricket (four innings, declarations, draws) is not
 * supported yet.
 *
 * - tournaments.rulesData: JSON string, see `CricketRules`
 *     {"eventTypeId":"t20","playersPerSide":11,"overs":20,"ballsPerOver":6,
 *      "lastManStands":false,"superOver":true}
 * - matches.resultData: JSON string, see `CricketResult`
 *     {"innings":[{"battingRegistrationId":"A","runs":158,"wickets":7,"balls":120},
 *                 {"battingRegistrationId":"B","runs":159,"wickets":4,"balls":110}]}
 * - matches.resultType: "win" | "tie" | "noResult"
 *
 * v1 records a scorecard per innings (runs, wickets, legal balls). There is
 * no ball-by-ball data and no Duckworth–Lewis–Stern calculation: for a
 * shortened chase the organizer enters the revised target and overs.
 */

// ─── Rules ──────────────────────────────────────────────

export type CricketEventTypeId = "t20" | "odi" | "t10" | "box8" | "box6" | "custom";

export interface CricketRules {
  eventTypeId: CricketEventTypeId;
  /** Players on the field per side. */
  playersPerSide: number;
  /** Overs per innings. */
  overs: number;
  ballsPerOver: number;
  /** The last batter may bat alone, so all `playersPerSide` wickets can fall. */
  lastManStands: boolean;
  /** A tie is decided by a super over (the result records who won it). */
  superOver: boolean;
}

export interface CricketEventType {
  id: CricketEventTypeId;
  label: string;
  rules: CricketRules;
}

function rules(
  eventTypeId: CricketEventTypeId,
  playersPerSide: number,
  overs: number,
  lastManStands = false,
): CricketRules {
  return { eventTypeId, playersPerSide, overs, ballsPerOver: 6, lastManStands, superOver: true };
}

/** Event types offered in the tournament wizard, in display order. */
export const CRICKET_EVENT_TYPES: readonly CricketEventType[] = [
  { id: "t20", label: "T20", rules: rules("t20", 11, 20) },
  { id: "odi", label: "One Day (50 overs)", rules: rules("odi", 11, 50) },
  { id: "t10", label: "T10", rules: rules("t10", 11, 10) },
  { id: "box8", label: "Box cricket (8-a-side)", rules: rules("box8", 8, 8) },
  { id: "box6", label: "Box cricket (6-a-side)", rules: rules("box6", 6, 6, true) },
];

export const DEFAULT_CRICKET_RULES: CricketRules = CRICKET_EVENT_TYPES[0].rules;

/** Limits the wizard enforces on custom values. */
export const CRICKET_LIMITS = {
  playersPerSide: { min: 2, max: 11 },
  overs: { min: 1, max: 50 },
  ballsPerOver: { min: 4, max: 8 },
} as const;

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function inRange(v: number, r: { min: number; max: number }): boolean {
  return v >= r.min && v <= r.max;
}

/**
 * Decodes `rulesData`. Missing keys fall back to the event type's defaults
 * (T20 when the event type is missing or unknown). Returns null for JSON that
 * can't be decoded or values outside `CRICKET_LIMITS`.
 */
export function decodeCricketRules(json: unknown): CricketRules | null {
  if (typeof json !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const preset = CRICKET_EVENT_TYPES.find((e) => e.id === o.eventTypeId)?.rules ?? DEFAULT_CRICKET_RULES;
  const eventTypeId: CricketEventTypeId =
    o.eventTypeId === "custom" ? "custom" : preset.eventTypeId;

  const int = (key: string, fallback: number): number | null => {
    const v = o[key];
    if (v === undefined || v === null) return fallback;
    return isInt(v) ? v : null;
  };
  const bool = (key: string, fallback: boolean): boolean | null => {
    const v = o[key];
    if (v === undefined || v === null) return fallback;
    return typeof v === "boolean" ? v : null;
  };

  const playersPerSide = int("playersPerSide", preset.playersPerSide);
  const overs = int("overs", preset.overs);
  const ballsPerOver = int("ballsPerOver", preset.ballsPerOver);
  const lastManStands = bool("lastManStands", preset.lastManStands);
  const superOver = bool("superOver", preset.superOver);
  if (playersPerSide === null || overs === null || ballsPerOver === null ||
      lastManStands === null || superOver === null) return null;
  if (!inRange(playersPerSide, CRICKET_LIMITS.playersPerSide) ||
      !inRange(overs, CRICKET_LIMITS.overs) ||
      !inRange(ballsPerOver, CRICKET_LIMITS.ballsPerOver)) return null;

  return { eventTypeId, playersPerSide, overs, ballsPerOver, lastManStands, superOver };
}

/** Rules for a tournament: its `rulesData`, or T20 defaults. */
export function resolveCricketRules(rulesData: unknown): CricketRules {
  return decodeCricketRules(rulesData) ?? DEFAULT_CRICKET_RULES;
}

/** Wickets that end an innings (all out). */
export function maxWickets(r: CricketRules): number {
  return r.lastManStands ? r.playersPerSide : r.playersPerSide - 1;
}

// ─── Overs notation ─────────────────────────────────────

/** Legal balls → overs notation, e.g. 110 balls (6 per over) → "18.2". */
export function formatOvers(balls: number, ballsPerOver = 6): string {
  const full = Math.floor(balls / ballsPerOver);
  const rest = balls % ballsPerOver;
  return rest === 0 ? `${full}` : `${full}.${rest}`;
}

/**
 * Overs notation → legal balls, e.g. "18.2" → 110. Returns null when the
 * text isn't overs notation or the ball digit is ≥ balls per over ("18.6").
 */
export function parseOvers(text: string, ballsPerOver = 6): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d))?\s*$/.exec(text);
  if (!m) return null;
  const full = Number(m[1]);
  const rest = m[2] === undefined ? 0 : Number(m[2]);
  if (rest >= ballsPerOver) return null;
  return full * ballsPerOver + rest;
}

/** Overs as a decimal for rates: 110 balls → 18.333… */
export function oversDecimal(balls: number, ballsPerOver = 6): number {
  return balls / ballsPerOver;
}

// ─── Result ─────────────────────────────────────────────

export interface Innings {
  battingRegistrationId: string;
  runs: number;
  wickets: number;
  /** Legal balls faced. */
  balls: number;
}

export interface RevisedTarget {
  /** Runs the side batting second needs to win. */
  runs: number;
  /** Overs available to the side batting second. */
  overs: number;
}

export interface CricketResult {
  /** Two innings in batting order. Empty for a no result before a ball was bowled. */
  innings: Innings[];
  /** Rain-affected chase: target and overs announced by the umpires (DLS or local rule). */
  revisedTarget?: RevisedTarget;
  /** Registration that won the super over, for a tie. */
  superOverWinnerRegistrationId?: string;
  /** Match abandoned without a result (weather, light, ground). */
  noResult?: boolean;
}

export type CricketResultType = "win" | "tie" | "noResult";

export interface CricketOutcome {
  resultType: CricketResultType;
  winnerRegistrationId: string | null;
  /** "won by 6 wickets (10 balls left)", "won by 23 runs", "Match tied", "No result". */
  margin: string;
}

export interface CricketIssue {
  field: string;
  message: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Validates a scorecard for a match between `teamAId` and `teamBId`.
 * Returns every problem found; an empty list means the result can be saved.
 */
export function validateCricketResult(
  result: CricketResult,
  r: CricketRules,
  teamAId: string,
  teamBId: string,
): CricketIssue[] {
  const issues: CricketIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  const limit = r.overs * r.ballsPerOver;
  const wMax = maxWickets(r);

  if (result.noResult) {
    // An abandoned match may carry a partial scorecard; only its shape is checked.
    if (result.innings.length > 2) add("innings", "A match has at most two innings.");
  } else if (result.innings.length !== 2) {
    add("innings", "Enter both innings, or mark the match as no result.");
    return issues;
  }

  const sides = result.innings.map((i) => i.battingRegistrationId);
  if (sides.some((s) => s !== teamAId && s !== teamBId)) {
    add("innings", "Each innings must be batted by one of the two teams.");
  }
  if (sides.length === 2 && sides[0] === sides[1]) {
    add("innings", "Each team bats once.");
  }

  result.innings.forEach((inn, idx) => {
    const f = `innings[${idx}]`;
    if (!isInt(inn.runs) || inn.runs < 0) add(`${f}.runs`, "Runs must be 0 or more.");
    if (!isInt(inn.wickets) || inn.wickets < 0 || inn.wickets > wMax) {
      add(`${f}.wickets`, `Wickets must be between 0 and ${wMax}.`);
    }
    const ballLimit = idx === 1 && result.revisedTarget
      ? result.revisedTarget.overs * r.ballsPerOver
      : limit;
    if (!isInt(inn.balls) || inn.balls < 0) {
      add(`${f}.balls`, "Overs must be 0 or more.");
    } else if (inn.balls > ballLimit) {
      add(`${f}.balls`, `An innings is at most ${plural(ballLimit / r.ballsPerOver, "over", "overs")}.`);
    }
  });
  if (issues.length > 0 || result.noResult) return issues;

  const [first, second] = result.innings;

  if (result.revisedTarget) {
    const rt = result.revisedTarget;
    if (!isInt(rt.runs) || rt.runs < 1) add("revisedTarget.runs", "Revised target must be at least 1 run.");
    if (!isInt(rt.overs) || rt.overs < 1 || rt.overs > r.overs) {
      add("revisedTarget.overs", `Revised overs must be between 1 and ${r.overs}.`);
    }
    if (issues.length > 0) return issues;
  }
  const target = result.revisedTarget?.runs ?? first.runs + 1;
  const secondLimit = result.revisedTarget ? result.revisedTarget.overs * r.ballsPerOver : limit;

  // First innings ends all out or when its overs run out (or early in a
  // reduced match, which the revised target covers).
  const firstDone = first.wickets === wMax || first.balls === limit || result.revisedTarget !== undefined;
  if (!firstDone) {
    add("innings[0]", `The first innings isn't finished. It ends when ${wMax} wickets fall or ${r.overs} overs are bowled.`);
  }

  const chased = second.runs >= target;
  const secondDone = chased || second.wickets === wMax || second.balls === secondLimit;
  if (!secondDone) {
    add("innings[1]", `The chase isn't finished. It ends when the target of ${target} is reached, ${wMax} wickets fall, or the overs run out.`);
  }
  if (chased && second.wickets === wMax) {
    // The winning run can't come after the last wicket.
    add("innings[1].wickets", "The chasing team reached the target, so it can't also be all out.");
  }
  // The match ends on the ball the target is reached, and one ball adds at
  // most a six plus a few extras or overthrows. More than 10 past the target
  // is a typo.
  if (chased && second.runs > target + 10) {
    add("innings[1].runs", `The chase passed the target of ${target} by ${second.runs - target}. The match ends as soon as the target is reached.`);
  }

  if (result.superOverWinnerRegistrationId !== undefined) {
    // Level scores: one run short of the target (a revised target included).
    const tied = second.runs === target - 1;
    if (!tied) add("superOver", "A super over is only played when the scores are level.");
    else if (!r.superOver) add("superOver", "This tournament doesn't use super overs.");
    else if (result.superOverWinnerRegistrationId !== teamAId && result.superOverWinnerRegistrationId !== teamBId) {
      add("superOver", "The super over winner must be one of the two teams.");
    }
  }
  return issues;
}

/**
 * Outcome of a valid result. Call `validateCricketResult` first; the outcome
 * of an invalid scorecard is unspecified.
 */
export function cricketOutcome(result: CricketResult, r: CricketRules): CricketOutcome {
  if (result.noResult || result.innings.length < 2) {
    return { resultType: "noResult", winnerRegistrationId: null, margin: "No result" };
  }
  const [first, second] = result.innings;
  const target = result.revisedTarget?.runs ?? first.runs + 1;
  const secondLimit = (result.revisedTarget?.overs ?? r.overs) * r.ballsPerOver;

  if (second.runs >= target) {
    const wicketsLeft = maxWickets(r) - second.wickets;
    const ballsLeft = secondLimit - second.balls;
    const balls = ballsLeft > 0 ? ` (${plural(ballsLeft, "ball", "balls")} left)` : "";
    const dls = result.revisedTarget ? " (revised target)" : "";
    return {
      resultType: "win",
      winnerRegistrationId: second.battingRegistrationId,
      margin: `won by ${plural(wicketsLeft, "wicket", "wickets")}${balls}${dls}`,
    };
  }
  const tied = result.revisedTarget ? second.runs === target - 1 : second.runs === first.runs;
  if (tied) {
    if (result.superOverWinnerRegistrationId) {
      return {
        resultType: "win",
        winnerRegistrationId: result.superOverWinnerRegistrationId,
        margin: "won the super over",
      };
    }
    return { resultType: "tie", winnerRegistrationId: null, margin: "Match tied" };
  }
  const runs = (result.revisedTarget ? target - 1 : first.runs) - second.runs;
  const dls = result.revisedTarget ? " (revised target)" : "";
  return {
    resultType: "win",
    winnerRegistrationId: first.battingRegistrationId,
    margin: `won by ${plural(runs, "run", "runs")}${dls}`,
  };
}

/** "Dallas Royals won by 6 wickets (10 balls left)" / "Match tied" / "No result". */
export function outcomeSummary(o: CricketOutcome, teamName: (registrationId: string) => string): string {
  return o.winnerRegistrationId ? `${teamName(o.winnerRegistrationId)} ${o.margin}` : o.margin;
}

// ─── Standings ──────────────────────────────────────────

export const CRICKET_POINTS = { win: 2, tie: 1, noResult: 1, loss: 0 } as const;

export interface RunRateTotals {
  runsFor: number;
  ballsFaced: number;
  runsAgainst: number;
  ballsBowled: number;
}

/**
 * Adds one match to a team's run-rate totals. A side bowled out counts its
 * full quota of overs as faced (and the bowling side as bowled). No-result
 * matches are excluded from NRR.
 */
export function addToRunRate(
  totals: RunRateTotals,
  registrationId: string,
  result: CricketResult,
  r: CricketRules,
): RunRateTotals {
  if (result.noResult || result.innings.length !== 2) return totals;
  const wMax = maxWickets(r);
  const quota = (idx: number) => {
    const inn = result.innings[idx];
    const limit = idx === 1 && result.revisedTarget
      ? result.revisedTarget.overs * r.ballsPerOver
      : r.overs * r.ballsPerOver;
    return inn.wickets === wMax ? limit : inn.balls;
  };
  const next = { ...totals };
  result.innings.forEach((inn, idx) => {
    if (inn.battingRegistrationId === registrationId) {
      next.runsFor += inn.runs;
      next.ballsFaced += quota(idx);
    } else {
      next.runsAgainst += inn.runs;
      next.ballsBowled += quota(idx);
    }
  });
  return next;
}

/** Net run rate from totals; 0 until the team has batted and bowled. */
export function netRunRate(t: RunRateTotals, ballsPerOver = 6): number {
  if (t.ballsFaced === 0 || t.ballsBowled === 0) return 0;
  return t.runsFor / oversDecimal(t.ballsFaced, ballsPerOver) -
    t.runsAgainst / oversDecimal(t.ballsBowled, ballsPerOver);
}

/** NRR for display: always signed, three decimals ("+0.820", "-1.125"). */
export function formatNetRunRate(nrr: number): string {
  const v = Math.round(nrr * 1000) / 1000;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`;
}

// ─── Stored JSON ────────────────────────────────────────

/** Decodes `matches.resultData`. Returns null when it isn't a cricket result. */
export function decodeCricketResult(json: unknown): CricketResult | null {
  if (typeof json !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.innings)) return null;
  const innings: Innings[] = [];
  for (const i of o.innings) {
    if (i === null || typeof i !== "object") return null;
    const x = i as Record<string, unknown>;
    if (typeof x.battingRegistrationId !== "string" || !isInt(x.runs) ||
        !isInt(x.wickets) || !isInt(x.balls)) return null;
    innings.push({ battingRegistrationId: x.battingRegistrationId, runs: x.runs, wickets: x.wickets, balls: x.balls });
  }
  const result: CricketResult = { innings };
  if (o.revisedTarget !== undefined && o.revisedTarget !== null) {
    const rt = o.revisedTarget as Record<string, unknown>;
    if (!isInt(rt.runs) || !isInt(rt.overs)) return null;
    result.revisedTarget = { runs: rt.runs, overs: rt.overs };
  }
  if (typeof o.superOverWinnerRegistrationId === "string") {
    result.superOverWinnerRegistrationId = o.superOverWinnerRegistrationId;
  }
  if (o.noResult === true) result.noResult = true;
  return result;
}
