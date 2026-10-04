/**
 * Dependency-free checks for services/scoring.ts (no test framework is set up).
 *
 * Usage (from tournmate-server/functions):
 *   npm run build && node lib/scripts/checkScoring.js
 *
 * Exits non-zero if any case fails.
 */

import type { SportType } from "../types";
import {
  SetScore,
  resolveScoring,
  validateMatchScores,
  validateSimpleScore,
  matchWinner,
} from "../services/scoring";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

function sets(...pairs: Array<[number, number]>): SetScore[] {
  return pairs.map(([teamAPoints, teamBPoints]) => ({ teamAPoints, teamBPoints }));
}

/**
 * Checks a match against a sport's rules. `configData` undefined = a
 * tournament with scoring settings using the sport defaults (enforced);
 * pass `null` for a legacy tournament with no scoringConfigData.
 */
function expectMatch(
  name: string,
  sport: SportType,
  scores: SetScore[],
  valid: boolean,
  configData: string | null | undefined = undefined,
  expectedMessage?: string,
): void {
  const scoring = configData === undefined
    ? { config: resolveScoring(undefined, sport).config, enforce: true } // sport defaults, enforced
    : resolveScoring(configData ?? undefined, sport);
  const issues = validateMatchScores(scores, scoring.config, scoring.enforce, sport);
  const detail = issues.map((i) => `${i.field}: ${i.message}`).join("; ");
  let ok = (issues.length === 0) === valid;
  if (ok && expectedMessage !== undefined) ok = issues.some((i) => i.message === expectedMessage);
  check(name, ok, detail || "valid");
}

const g = (a: number, b: number): SetScore[] => sets([a, b]);
// Single-game configs so per-game rules are checked in isolation.
const badminton1 = JSON.stringify({ gamesPerMatch: 1, pointsToWin: 21, winBy: 2, pointCap: 30, scoringSystem: "rally" });
const pickleball1 = JSON.stringify({ gamesPerMatch: 1, pointsToWin: 11, winBy: 2, scoringSystem: "sideOut" });
const tennis1 = JSON.stringify({ gamesPerMatch: 1, pointsToWin: 6, winBy: 2, pointCap: 7, scoringSystem: "rally" });

// Badminton
expectMatch("badminton 21-19 ok", "badminton", g(21, 19), true, badminton1);
expectMatch("badminton 21-20 rejected", "badminton", g(21, 20), false, badminton1, "Must win by 2");
expectMatch("badminton 30-29 ok at cap", "badminton", g(30, 29), true, badminton1);
expectMatch("badminton 23-21 ok (deuce)", "badminton", g(23, 21), true, badminton1);
expectMatch("badminton 31-29 rejected (over cap)", "badminton", g(31, 29), false, badminton1, "Max score is 30");
expectMatch("badminton 25-15 rejected (should have ended)", "badminton", g(25, 15), false, badminton1,
  "Game ends at 21 with a 2-point lead");
expectMatch("badminton default best of 3: 21-19, 21-15 ok", "badminton", sets([21, 19], [21, 15]), true);

// Pickleball
expectMatch("pickleball 11-9 ok", "pickleball", g(11, 9), true, pickleball1);
expectMatch("pickleball 11-10 rejected", "pickleball", g(11, 10), false, pickleball1);

// Tennis
expectMatch("tennis 6-4 ok", "tennis", g(6, 4), true, tennis1);
expectMatch("tennis 7-6 ok", "tennis", g(7, 6), true, tennis1);
expectMatch("tennis 7-5 ok", "tennis", g(7, 5), true, tennis1);
expectMatch("tennis 6-5 rejected", "tennis", g(6, 5), false, tennis1, "Must win by 2");
expectMatch("tennis default best of 3: 6-4, 3-6, 7-6 ok", "tennis", sets([6, 4], [3, 6], [7, 6]), true);
expectMatch("tennis default: 6-4 alone rejected (undecided)", "tennis", g(6, 4), false, undefined,
  "One side must win 2 sets");
expectMatch("tennis is no longer judged by badminton rules (6-4, 6-3)", "tennis", sets([6, 4], [6, 3]), true);

// Match decided early
expectMatch("best of 3 decided in 2, pointless 3rd game rejected", "badminton",
  sets([21, 15], [21, 18], [19, 21]), false, undefined, "Match was already won before the last game");
expectMatch("too many games rejected", "badminton",
  sets([21, 15], [19, 21], [21, 18], [21, 10]), false, undefined, "A match has at most 3 games");

// Legacy lenient tournament (no scoringConfigData)
expectMatch("legacy: 15-3 single game ok", "badminton", g(15, 3), true, null);
expectMatch("legacy: 5-3, 2-4, 9-1 ok", "badminton", sets([5, 3], [2, 4], [9, 1]), true, null);
expectMatch("legacy: tied game rejected", "badminton", g(10, 10), false, null);
expectMatch("legacy: 1-1 in games rejected (no winner)", "badminton", sets([21, 10], [10, 21]), false, null);
expectMatch("legacy: negative rejected", "badminton", g(-1, 5), false, null);

// Generic sport: single result, any non-tied score
expectMatch("generic soccer 3-2 ok", "soccer", g(3, 2), true);
expectMatch("generic basketball 101-99 ok", "basketball", g(101, 99), true);
expectMatch("generic bowling 1-0 ok", "bowling", g(1, 0), true);
expectMatch("generic tie rejected", "soccer", g(2, 2), false, undefined, "A half can't end in a tie");

// Config decoding
check("bad JSON -> sport defaults, still enforced", (() => {
  const r = resolveScoring("{not json", "tennis");
  return r.enforce && r.config.pointsToWin === 6 && r.config.pointCap === 7;
})());
check("missing keys -> 3/21/2/no cap/rally (iOS decoder fallback)", (() => {
  const r = resolveScoring("{}", "pickleball");
  return r.enforce && r.config.gamesPerMatch === 3 && r.config.pointsToWin === 21 &&
    r.config.winBy === 2 && r.config.pointCap === null && r.config.scoringSystem === "rally";
})());
check("unknown scoringSystem -> sport defaults", resolveScoring('{"scoringSystem":"x"}', "pickleball").config.pointsToWin === 11);
check("no scoringConfigData -> lenient", resolveScoring(undefined, "badminton").enforce === false);

// Simple (single-result) score
check("simple: tennis 6-4 ok", validateSimpleScore(6, 4, resolveScoring(undefined, "tennis").config, true, "tennis").length === 0);
check("simple: badminton 21-20 rejected", validateSimpleScore(21, 20, resolveScoring(undefined, "badminton").config, true, "badminton").length === 1);

// Winner agrees with the validator
check("winner of 19-21, 21-15, 21-18 is A", matchWinner(sets([19, 21], [21, 15], [21, 18])) === "A");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
