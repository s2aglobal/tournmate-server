/**
 * Dependency-free checks for services/cricket.ts. The iOS and Android ports
 * mirror these cases in their unit tests, so keep the expected messages and
 * margins identical across platforms.
 *
 * Usage (from tournmate-server/functions):
 *   npm run check:cricket
 *
 * Exits non-zero if any case fails.
 */

import {
  CricketResult,
  CricketRules,
  CRICKET_EVENT_TYPES,
  DEFAULT_CRICKET_RULES,
  addToRunRate,
  cricketOutcome,
  decodeCricketResult,
  decodeCricketRules,
  formatNetRunRate,
  formatOvers,
  netRunRate,
  parseOvers,
  validateCricketResult,
} from "../services/cricket";
import { applyTeamResult } from "../services/elo";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const A = "regA";
const B = "regB";
const T20 = DEFAULT_CRICKET_RULES;
const BOX6 = CRICKET_EVENT_TYPES.find((e) => e.id === "box6")!.rules;

function inn(side: string, runs: number, wickets: number, overs: string, bpo = 6) {
  const balls = parseOvers(overs, bpo);
  if (balls === null) throw new Error(`bad overs ${overs}`);
  return { battingRegistrationId: side, runs, wickets, balls };
}

function expectValid(name: string, result: CricketResult, r: CricketRules, margin: string, winner: string | null): void {
  const issues = validateCricketResult(result, r, A, B);
  if (issues.length > 0) {
    check(name, false, issues.map((i) => `${i.field}: ${i.message}`).join("; "));
    return;
  }
  const o = cricketOutcome(result, r);
  check(name, o.margin === margin && o.winnerRegistrationId === winner,
    `${o.winnerRegistrationId ?? "-"} ${o.margin}`);
}

function expectInvalid(name: string, result: CricketResult, r: CricketRules, message: string): void {
  const issues = validateCricketResult(result, r, A, B);
  check(name, issues.some((i) => i.message === message),
    issues.map((i) => i.message).join("; ") || "no issues");
}

// ─── Overs notation ─────────────────────────────────────
check("parse 18.2", parseOvers("18.2") === 110);
check("parse 20", parseOvers("20") === 120);
check("parse 0.5", parseOvers("0.5") === 5);
check("reject 18.6", parseOvers("18.6") === null);
check("reject text", parseOvers("abc") === null);
check("8-ball over 3.7", parseOvers("3.7", 8) === 31);
check("format 110", formatOvers(110) === "18.2");
check("format 120", formatOvers(120) === "20");

// ─── Rules ──────────────────────────────────────────────
check("rules default", JSON.stringify(decodeCricketRules("{}")) === JSON.stringify(T20));
check("rules box6", decodeCricketRules('{"eventTypeId":"box6"}')?.lastManStands === true);
check("rules custom overs", decodeCricketRules('{"eventTypeId":"t20","overs":15}')?.overs === 15);
check("rules reject 0 overs", decodeCricketRules('{"overs":0}') === null);
check("rules reject bad json", decodeCricketRules("{") === null);

// ─── Outcomes ───────────────────────────────────────────
expectValid("chase won by wickets",
  { innings: [inn(A, 158, 7, "20"), inn(B, 159, 4, "18.2")] }, T20,
  "won by 6 wickets (10 balls left)", B);
expectValid("chase on last ball",
  { innings: [inn(A, 140, 9, "20"), inn(B, 141, 8, "20")] }, T20,
  "won by 2 wickets", B);
expectValid("defended by runs",
  { innings: [inn(A, 180, 5, "20"), inn(B, 157, 10, "19.1")] }, T20,
  "won by 23 runs", A);
expectValid("defended, overs ran out",
  { innings: [inn(A, 150, 8, "20"), inn(B, 149, 6, "20")] }, T20,
  "won by 1 run", A);
expectValid("tie",
  { innings: [inn(A, 150, 8, "20"), inn(B, 150, 6, "20")] }, T20,
  "Match tied", null);
expectValid("tie decided by super over",
  { innings: [inn(A, 150, 8, "20"), inn(B, 150, 6, "20")], superOverWinnerRegistrationId: A }, T20,
  "won the super over", A);
expectValid("no result",
  { innings: [inn(A, 80, 2, "9.3")], noResult: true }, T20,
  "No result", null);
expectValid("revised target chased",
  { innings: [inn(A, 160, 6, "20"), inn(B, 125, 3, "13.4")], revisedTarget: { runs: 124, overs: 15 } }, T20,
  "won by 7 wickets (8 balls left) (revised target)", B);
expectValid("revised target defended",
  { innings: [inn(A, 160, 6, "20"), inn(B, 110, 5, "15")], revisedTarget: { runs: 124, overs: 15 } }, T20,
  "won by 13 runs (revised target)", A);
expectValid("box6 last man stands all out",
  { innings: [inn(A, 70, 6, "5.3"), inn(B, 71, 5, "5.5")] }, BOX6,
  "won by 1 wicket (1 ball left)", B);
expectValid("single run margin wording",
  { innings: [inn(A, 100, 3, "20"), inn(B, 101, 9, "19.5")] }, T20,
  "won by 1 wicket (1 ball left)", B);

// ─── Validation ─────────────────────────────────────────
expectInvalid("one innings only",
  { innings: [inn(A, 100, 3, "20")] }, T20,
  "Enter both innings, or mark the match as no result.");
expectInvalid("same side bats twice",
  { innings: [inn(A, 100, 3, "20"), inn(A, 90, 3, "20")] }, T20,
  "Each team bats once.");
expectInvalid("too many wickets",
  { innings: [inn(A, 100, 11, "20"), inn(B, 90, 3, "20")] }, T20,
  "Wickets must be between 0 and 10.");
expectInvalid("too many overs",
  { innings: [inn(A, 100, 3, "21"), inn(B, 90, 3, "20")] }, T20,
  "An innings is at most 20 overs.");
expectInvalid("first innings unfinished",
  { innings: [inn(A, 100, 3, "15"), inn(B, 90, 3, "20")] }, T20,
  "The first innings isn't finished. It ends when 10 wickets fall or 20 overs are bowled.");
expectInvalid("chase unfinished",
  { innings: [inn(A, 150, 3, "20"), inn(B, 90, 3, "12")] }, T20,
  "The chase isn't finished. It ends when the target of 151 is reached, 10 wickets fall, or the overs run out.");
expectInvalid("chased and all out",
  { innings: [inn(A, 150, 3, "20"), inn(B, 151, 10, "19")] }, T20,
  "The chasing team reached the target, so it can't also be all out.");
expectInvalid("huge overshoot",
  { innings: [inn(A, 150, 3, "20"), inn(B, 175, 3, "19")] }, T20,
  "The chase passed the target of 151 by 24. The match ends as soon as the target is reached.");
expectInvalid("super over without tie",
  { innings: [inn(A, 150, 3, "20"), inn(B, 140, 3, "20")], superOverWinnerRegistrationId: A }, T20,
  "A super over is only played when the scores are level.");
expectInvalid("outsider bats",
  { innings: [inn(A, 150, 3, "20"), inn("regC", 140, 3, "20")] }, T20,
  "Each innings must be batted by one of the two teams.");

// ─── Net run rate (worked example from the design doc) ──
let t = { runsFor: 0, ballsFaced: 0, runsAgainst: 0, ballsBowled: 0 };
t = addToRunRate(t, A, { innings: [inn(A, 160, 4, "20"), inn(B, 150, 7, "20")] }, T20);
t = addToRunRate(t, A, { innings: [inn(B, 144, 9, "20"), inn(A, 145, 4, "17.2")] }, T20);
check("NRR worked example", formatNetRunRate(netRunRate(t)) === "+0.820", formatNetRunRate(netRunRate(t)));
let u = { runsFor: 0, ballsFaced: 0, runsAgainst: 0, ballsBowled: 0 };
u = addToRunRate(u, B, { innings: [inn(A, 160, 4, "20"), inn(B, 98, 10, "15.4")] }, T20);
check("NRR all out counts full overs", Math.abs(netRunRate(u) - (98 / 20 - 160 / 20)) < 1e-9, formatNetRunRate(netRunRate(u)));
check("NRR excludes no result",
  addToRunRate(u, B, { innings: [inn(A, 50, 1, "5")], noResult: true }, T20).runsFor === u.runsFor);

// ─── Stored JSON round trip ─────────────────────────────
const stored = JSON.stringify({ innings: [inn(A, 158, 7, "20"), inn(B, 159, 4, "18.2")] });
check("decode result", decodeCricketResult(stored)?.innings[1].balls === 110);
check("decode rejects junk", decodeCricketResult('{"innings":[{"runs":"x"}]}') === null);

// ─── Team ratings ───────────────────────────────────────
const side = (n: number, rating: number) => Array.from({ length: n }, () => ({ cricket: rating }));
let a11 = side(11, 1200), b11 = side(11, 1200);
applyTeamResult(a11, b11, "cricket", 1);
check("team win between equals: +12 each", a11.every((r) => r.cricket === 1212) && b11.every((r) => r.cricket === 1188));
a11 = side(11, 1300); b11 = side(11, 1100);
applyTeamResult(a11, b11, "cricket", 0.5);
check("tie moves the stronger side down", a11[0].cricket < 1300 && b11[0].cricket > 1100 &&
  Math.abs((1300 - a11[0].cricket) - (b11[0].cricket - 1100)) < 1e-9, `${a11[0].cricket.toFixed(2)}`);
const fresh = [{} as Record<string, number>];
applyTeamResult(fresh, side(1, 1200), "cricket", 1);
check("unrated player starts at 1200", fresh[0].cricket === 1212);

console.log(failures === 0 ? "\nAll cricket checks passed." : `\n${failures} cricket check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
