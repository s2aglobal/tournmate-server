/**
 * Cricket player stats: optional batting and bowling figures per player for
 * one match, stored on the match as `playerStatsData` (JSON, sorted keys),
 * plus the tournament leaderboards and a player's career totals built from
 * them. This is the reference; iOS (`CricketPlayerStats.swift`) and Android
 * (`CricketPlayerStats.kt`) port it exactly, including the messages and the
 * integer rounding of strike rate, economy and average.
 *
 * Players are keyed like team roles: upper-cased player id, or
 * `guest:<name>` for guests. `teamRegistrationId` is the team the player
 * plays for, so a bowler's figures belong to the team that bowled.
 *
 * The figures must fit the scorecard: a team's batters can't score more runs,
 * face more balls or lose more wickets than its innings shows (extras and run
 * outs make up the difference), and its bowlers can't bowl more balls,
 * concede more runs or take more wickets than the other innings shows.
 */

import { CricketResult, CricketRules, formatOvers } from "./cricket";

export interface BattingFigures {
  teamRegistrationId: string;
  key: string;
  name: string;
  runs: number;
  /** Balls faced. */
  balls: number;
  /** false = not out. */
  out: boolean;
}

export interface BowlingFigures {
  teamRegistrationId: string;
  key: string;
  name: string;
  /** Legal balls bowled. */
  balls: number;
  /** Runs conceded. */
  runs: number;
  wickets: number;
}

export interface PlayerStats {
  batting: BattingFigures[];
  bowling: BowlingFigures[];
}

export interface StatsIssue {
  field: string;
  message: string;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * Checks the figures against the match scorecard. Returns every problem; an
 * empty list means they can be saved. `names` gives the team names for the
 * messages.
 */
export function validatePlayerStats(
  stats: PlayerStats,
  result: CricketResult,
  teamA: string,
  teamB: string,
  names: (registrationId: string) => string,
): StatsIssue[] {
  const issues: StatsIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  const teams = [teamA, teamB];
  const other = (t: string) => (t === teamA ? teamB : teamA);
  const inningsOf = (t: string) => result.innings.find((i) => i.battingRegistrationId === t);

  for (const [kind, list] of [["batting", stats.batting], ["bowling", stats.bowling]] as const) {
    const seen = new Set<string>();
    for (const f of list) {
      if (!teams.includes(f.teamRegistrationId)) {
        add(kind, `${f.name} isn't in either team.`);
        continue;
      }
      const id = `${f.teamRegistrationId}|${f.key.startsWith("guest:") ? f.key : f.key.toUpperCase()}`;
      if (seen.has(id)) add(kind, `${f.name} is listed twice.`);
      seen.add(id);
      const numbers = kind === "batting"
        ? [(f as BattingFigures).runs, (f as BattingFigures).balls]
        : [(f as BowlingFigures).balls, (f as BowlingFigures).runs, (f as BowlingFigures).wickets];
      if (!numbers.every(isCount)) add(kind, `${f.name}'s figures must be whole numbers, 0 or more.`);
    }
  }
  if (issues.length > 0) return issues;

  for (const team of teams) {
    const batting = stats.batting.filter((f) => f.teamRegistrationId === team);
    const own = inningsOf(team);
    if (batting.length > 0) {
      if (!own) {
        add("batting", `${names(team)} didn't bat.`);
      } else {
        const runs = batting.reduce((s, f) => s + f.runs, 0);
        const balls = batting.reduce((s, f) => s + f.balls, 0);
        const outs = batting.filter((f) => f.out).length;
        if (runs > own.runs) add("batting", `${names(team)}'s batters scored ${runs} runs, more than the team's ${own.runs}.`);
        if (balls > own.balls) add("batting", `${names(team)}'s batters faced ${balls} balls, more than the innings' ${own.balls}.`);
        if (outs > own.wickets) add("batting", `${outs} ${names(team)} batters are out, but the team lost ${own.wickets} wickets.`);
      }
    }
    const bowling = stats.bowling.filter((f) => f.teamRegistrationId === team);
    const faced = inningsOf(other(team));
    if (bowling.length > 0) {
      if (!faced) {
        add("bowling", `${names(team)} didn't bowl.`);
      } else {
        const balls = bowling.reduce((s, f) => s + f.balls, 0);
        const runs = bowling.reduce((s, f) => s + f.runs, 0);
        const wickets = bowling.reduce((s, f) => s + f.wickets, 0);
        if (balls > faced.balls) add("bowling", `${names(team)}'s bowlers bowled ${balls} balls, more than the innings' ${faced.balls}.`);
        if (runs > faced.runs) add("bowling", `${names(team)}'s bowlers conceded ${runs} runs, more than the ${faced.runs} scored.`);
        if (wickets > faced.wickets) add("bowling", `${names(team)}'s bowlers took ${wickets} wickets, more than the ${faced.wickets} that fell.`);
      }
    }
  }
  return issues;
}

// ─── Rates (integer rounding, half up, identical on every platform) ──────

/** Strike rate in tenths: runs × 100 / balls, rounded half up. Null without balls. */
export function strikeRateTenths(runs: number, balls: number): number | null {
  return balls > 0 ? Math.floor((2 * runs * 1000 + balls) / (2 * balls)) : null;
}

/** Economy in hundredths: runs per 6 balls, rounded half up. Null without balls. */
export function economyHundredths(runs: number, balls: number): number | null {
  return balls > 0 ? Math.floor((2 * runs * 600 + balls) / (2 * balls)) : null;
}

/** Batting average in hundredths: runs / times out, rounded half up. Null if never out. */
export function averageHundredths(runs: number, outs: number): number | null {
  return outs > 0 ? Math.floor((2 * runs * 100 + outs) / (2 * outs)) : null;
}

/** 1425 → "142.5"; null → "–". */
export function formatTenths(v: number | null): string {
  return v === null ? "–" : `${Math.floor(v / 10)}.${v % 10}`;
}

/** 625 → "6.25"; null → "–". */
export function formatHundredths(v: number | null): string {
  return v === null ? "–" : `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}`;
}

// ─── Leaderboards ────────────────────────────────────────

export interface BattingLeader {
  teamRegistrationId: string;
  key: string;
  name: string;
  innings: number;
  runs: number;
  balls: number;
  notOuts: number;
  highest: number;
  highestNotOut: boolean;
}

export interface BowlingLeader {
  teamRegistrationId: string;
  key: string;
  name: string;
  innings: number;
  balls: number;
  runs: number;
  wickets: number;
  bestWickets: number;
  bestRuns: number;
}

const normKey = (k: string) => (k.startsWith("guest:") ? k : k.toUpperCase());

/** Batting totals per player (most runs first; then strike rate, then name, team and key). */
export function battingLeaders(matches: PlayerStats[]): BattingLeader[] {
  const map = new Map<string, BattingLeader>();
  for (const m of matches) {
    for (const f of m.batting) {
      const id = `${f.teamRegistrationId}|${normKey(f.key)}`;
      const e = map.get(id) ?? {
        teamRegistrationId: f.teamRegistrationId, key: normKey(f.key), name: f.name,
        innings: 0, runs: 0, balls: 0, notOuts: 0, highest: 0, highestNotOut: false,
      };
      e.innings += 1;
      e.runs += f.runs;
      e.balls += f.balls;
      if (!f.out) e.notOuts += 1;
      if (f.runs > e.highest || (f.runs === e.highest && !f.out && !e.highestNotOut)) {
        e.highest = f.runs;
        e.highestNotOut = !f.out;
      }
      map.set(id, e);
    }
  }
  return [...map.values()].sort((a, b) =>
    b.runs - a.runs ||
    (strikeRateTenths(b.runs, b.balls) ?? -1) - (strikeRateTenths(a.runs, a.balls) ?? -1) ||
    compareText(a.name, b.name) || compareText(a.teamRegistrationId, b.teamRegistrationId) || compareText(a.key, b.key));
}

/** Bowling totals per player (most wickets first; then economy, then name, team and key). */
export function bowlingLeaders(matches: PlayerStats[]): BowlingLeader[] {
  const map = new Map<string, BowlingLeader>();
  for (const m of matches) {
    for (const f of m.bowling) {
      const id = `${f.teamRegistrationId}|${normKey(f.key)}`;
      const e = map.get(id) ?? {
        teamRegistrationId: f.teamRegistrationId, key: normKey(f.key), name: f.name,
        innings: 0, balls: 0, runs: 0, wickets: 0, bestWickets: 0, bestRuns: 0,
      };
      e.innings += 1;
      e.balls += f.balls;
      e.runs += f.runs;
      e.wickets += f.wickets;
      if (e.innings === 1 || f.wickets > e.bestWickets || (f.wickets === e.bestWickets && f.runs < e.bestRuns)) {
        e.bestWickets = f.wickets;
        e.bestRuns = f.runs;
      }
      map.set(id, e);
    }
  }
  const econ = (e: BowlingLeader) => economyHundredths(e.runs, e.balls) ?? Number.MAX_SAFE_INTEGER;
  return [...map.values()].sort((a, b) =>
    b.wickets - a.wickets || econ(a) - econ(b) ||
    compareText(a.name, b.name) || compareText(a.teamRegistrationId, b.teamRegistrationId) || compareText(a.key, b.key));
}

/** Plain code-point order (same on every platform, unlike locale compares). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** "54*" / "54". */
export function formatHighest(e: BattingLeader): string {
  return `${e.highest}${e.highestNotOut ? "*" : ""}`;
}

/** "3/21". */
export function formatBest(e: BowlingLeader): string {
  return `${e.bestWickets}/${e.bestRuns}`;
}

/** "3.4" overs from balls. */
export function formatBowlingOvers(balls: number, r: CricketRules): string {
  return formatOvers(balls, r.ballsPerOver);
}

// ─── Stored JSON ─────────────────────────────────────────

/** Decodes `matches.playerStatsData`; null when missing or malformed. */
export function decodePlayerStats(json: unknown): PlayerStats | null {
  if (typeof json !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { batting?: unknown; bowling?: unknown };
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  const batting = Array.isArray(o.batting) ? o.batting : [];
  const bowling = Array.isArray(o.bowling) ? o.bowling : [];
  const okBat = batting.every((f) => f && str(f.teamRegistrationId) && str(f.key) && str(f.name) &&
    isCount(f.runs) && isCount(f.balls) && typeof f.out === "boolean");
  const okBowl = bowling.every((f) => f && str(f.teamRegistrationId) && str(f.key) && str(f.name) &&
    isCount(f.balls) && isCount(f.runs) && isCount(f.wickets));
  if (!okBat || !okBowl) return null;
  return { batting: batting as BattingFigures[], bowling: bowling as BowlingFigures[] };
}
