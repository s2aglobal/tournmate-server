/**
 * Dependency-free checks for services/standings.ts against the iOS reference.
 *
 * - Group + Knockout cricket tables: replays the iOS DrawTests parity dump
 *   (`tools/standings/ios-gk-tables.txt`, copied from tournmate-ios
 *   Tools/DrawTests/parity-fixture.txt): same LCG, same random scorecards,
 *   same schedule; every table's order, points and NRR must match.
 * - DrawTests "level table" (all no results, duplicate names) and the
 *   Player of the Match tally cases.
 * - Hand cases for the other tie-breakers and inputs (head-to-head, games
 *   won, tennis set difference, legacy tie-breaker, custom points, doubles
 *   without a partner, elimination formats, id case, missing registrations).
 *
 * Usage (from tournmate-server/functions):
 *   npm run check:standings
 *
 * Exits non-zero if any case fails.
 */

import * as fs from "fs";
import * as path from "path";
import { MatchDoc, RegistrationDoc } from "../types";
import {
  CricketResult,
  CricketRules,
  DEFAULT_CRICKET_RULES,
  cricketOutcome,
  formatNetRunRate,
  maxWickets,
  validateCricketResult,
} from "../services/cricket";
import {
  StandingsMatch,
  StandingsRegistration,
  StandingsTournament,
  computeStandings,
  playerAwards,
} from "../services/standings";

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes += 1;
    return;
  }
  console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  failures += 1;
}

// ─── iOS DrawTests fixtures ─────────────────────────────

/** Same constants and ops as iOS/Android `Lcg`. */
class Lcg {
  private s: bigint;
  constructor(seed: number) {
    this.s = BigInt(seed);
  }
  next(): bigint {
    this.s = (this.s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return this.s >> 33n;
  }
  int(bound: number): number {
    return Number(this.next() % BigInt(bound));
  }
}

const uuid = (k: number) => `00000000-0000-0000-0000-${String(k).padStart(12, "0")}`;
const teamId = (i: number) => uuid(i + 1);
const label = (id: string) => `T${Number(id.slice(-12)) - 1}`;

/** iOS `randomScorecard`. */
function randomScorecard(rng: Lcg, r: CricketRules, a: string, b: string): CricketResult {
  if (rng.int(25) === 0) return { innings: [], noResult: true };
  const limit = r.overs * r.ballsPerOver;
  const wMax = maxWickets(r);
  const firstBat = rng.int(2) === 0 ? a : b;
  const secondBat = firstBat === a ? b : a;
  const w1 = rng.int(wMax + 2);
  const r1 = rng.int(250);
  const b1 = w1 >= wMax ? rng.int(limit + 1) : (rng.int(4) === 0 ? rng.int(limit + 1) : limit);
  let revised: { runs: number; overs: number } | undefined;
  if (rng.int(8) === 0) {
    const overs = 1 + rng.int(r.overs + 1);
    revised = { runs: rng.int(r1 + 2), overs };
  }
  const target = revised?.runs ?? r1 + 1;
  const secondLimit = (revised?.overs ?? r.overs) * r.ballsPerOver;
  let r2 = 0;
  let w2 = 0;
  let b2 = 0;
  switch (rng.int(4)) {
    case 0:
      r2 = target + rng.int(8); w2 = rng.int(wMax); b2 = rng.int(secondLimit + 1);
      break;
    case 1:
      r2 = Math.max(0, target - 1); w2 = rng.int(wMax + 1); b2 = secondLimit;
      break;
    case 2:
      r2 = Math.max(0, target - 2 - rng.int(60)); w2 = rng.int(wMax + 1);
      b2 = w2 === wMax ? rng.int(secondLimit + 1) : secondLimit;
      break;
    default:
      r2 = rng.int(300); w2 = rng.int(wMax + 2); b2 = rng.int(secondLimit + 3);
  }
  const res: CricketResult = {
    innings: [
      { battingRegistrationId: firstBat, runs: r1, wickets: w1, balls: b1 },
      { battingRegistrationId: secondBat, runs: r2, wickets: w2, balls: b2 },
    ],
  };
  if (revised) res.revisedTarget = revised;
  if (rng.int(3) === 0) res.superOverWinnerRegistrationId = rng.int(2) === 0 ? a : b;
  return res;
}

/** iOS `validScorecard` (needWinner false). */
function validScorecard(rng: Lcg, r: CricketRules, a: string, b: string): CricketResult {
  for (let i = 0; i < 500; i++) {
    const res = randomScorecard(rng, r, a, b);
    if (validateCricketResult(res, r, a, b).length === 0) return res;
  }
  throw new Error("no valid scorecard");
}

const cricketTournament = (matchFormatRaw: string): StandingsTournament => ({
  sportType: "cricket",
  formatRaw: "team",
  matchFormatRaw,
  // The DrawTests tables rank with head-to-head after NRR.
  formatConfigData: JSON.stringify({ tieBreakRulesVersion: 1, tieBreaker: "headToHead", groupTieBreaker: "headToHead" }),
});

/** iOS `makeTeams`: team i, roster of two, name "Team i". */
function makeTeams(n: number): StandingsRegistration[] {
  return Array.from({ length: n }, (_, i) => ({
    id: teamId(i),
    doc: {
      tournamentId: "t", playerId: uuid(1000 + i * 20), teamId: `team${i}`, teamName: `Team ${i}`,
      rosterIds: [uuid(1000 + i * 20), uuid(1000 + i * 20 + 1)],
    } as unknown as RegistrationDoc,
    playerName: `P${i}-0`,
    partnerName: null,
  }));
}

let matchSeq = 0;
function cricketMatch(a: string, b: string, res: CricketResult, r: CricketRules, extra: Partial<MatchDoc> = {}): StandingsMatch {
  const o = cricketOutcome(res, r);
  const doc: Record<string, unknown> = {
    tournamentId: "t", teamAId: a, teamBId: b, statusRaw: "finished",
    resultData: JSON.stringify(res), resultType: o.resultType, ...extra,
  };
  if (o.winnerRegistrationId) doc.winnerRegistrationId = o.winnerRegistrationId;
  matchSeq += 1;
  return { id: `m${matchSeq}`, doc: doc as unknown as MatchDoc };
}

// ─── 1. Group + Knockout tables (iOS parity dump) ───────

{
  const lines = fs.readFileSync(path.join(__dirname, "../../tools/standings/ios-gk-tables.txt"), "utf8").split("\n");
  let blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = /^GK n=(\d+) adv=(\d+):/.exec(lines[i]);
    if (!head) continue;
    blocks += 1;
    const n = Number(head[1]);
    const adv = Number(head[2]);
    const schedule = lines[i + 1].replace(/^ {2}matches: /, "").trim().split(" ").filter(Boolean).map((m) => {
      const x = /^([A-Z]+)(\d+):T(\d+)-T(\d+)$/.exec(m);
      if (!x) throw new Error(`bad match ${m}`);
      return { group: x[1], a: teamId(Number(x[3])), b: teamId(Number(x[4])) };
    });
    const expected = new Map<string, string>();
    for (let j = i + 2; j < lines.length && lines[j].startsWith("  table "); j++) {
      const t = /^ {2}table (\S+): (.*)$/.exec(lines[j])!;
      expected.set(t[1], t[2]);
    }
    const rules = DEFAULT_CRICKET_RULES;
    const rng = new Lcg(200_000 + n * 10 + adv);
    const matches = schedule.map((e) =>
      cricketMatch(e.a, e.b, validScorecard(rng, rules, e.a, e.b), rules, { groupLabel: e.group }));
    const data = computeStandings(cricketTournament("groupKnockout"), makeTeams(n), matches);
    check(`GK n=${n} adv=${adv}: group names`, data.groups.map((g) => g.name).join(",") === [...expected.keys()].join(","));
    for (const g of data.groups) {
      const got = g.rows.map((r) => `${label(r.registrationId)} ${r.points} ${formatNetRunRate(r.nrr ?? NaN)}`).join(", ");
      check(`GK n=${n} adv=${adv} table ${g.name}`, got === expected.get(g.name), `got ${got} want ${expected.get(g.name)}`);
      check(`GK n=${n} adv=${adv} table ${g.name} ranks`, g.rows.every((r, k) => r.rank === k + 1));
    }
  }
  check("GK fixture blocks read", blocks === 52, `${blocks}`);
}

// ─── 2. Level table: all no results, duplicate names ────

{
  const rules = DEFAULT_CRICKET_RULES;
  const teams = makeTeams(5);
  teams[3].doc.teamName = "Team 1";
  const nr: CricketResult = { innings: [], noResult: true };
  const matches: StandingsMatch[] = [];
  for (let x = 0; x < 5; x++) for (let y = x + 1; y < 5; y++) matches.push(cricketMatch(teamId(x), teamId(y), nr, rules));
  const table = computeStandings(cricketTournament("roundRobin"), teams, matches).groups[0].rows;
  check("level table: all NRR 0", table.every((r) => r.nrr === 0));
  check("level table: points = 2 × matches", table.reduce((s, r) => s + r.points, 0) === 2 * matches.length);
  check("level table: no results counted", table.every((r) => r.noResult === 4 && r.played === 4));
  check("level table: name then id", table.map((r) => r.registrationId).join() === [0, 1, 3, 2, 4].map(teamId).join());
  for (let k = 0; k < 10; k++) {
    const rng = new Lcg(k);
    const shuffled = [...teams];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const again = computeStandings(cricketTournament("roundRobin"), shuffled, [...matches].reverse()).groups[0].rows;
    check(`level table: shuffle ${k} deterministic`, again.map((r) => r.registrationId).join() === table.map((r) => r.registrationId).join());
  }
}

// ─── 3. Player of the Match tally (DrawTests "pom") ─────

{
  const x = teamId(0);
  const y = teamId(1);
  const p0 = uuid(1000);
  const yKey = uuid(1020);
  const pom = (key: string | null, name: string, team: string, finished = true): MatchDoc => ({
    tournamentId: "t", teamAId: x, teamBId: y, statusRaw: finished ? "finished" : "scoreSubmitted",
    ...(key ? { playerOfMatchKey: key, playerOfMatchName: name, playerOfMatchTeamId: team } : {}),
  } as unknown as MatchDoc);
  const ms = [pom(p0, "P0-0", x), pom(p0.toLowerCase(), "P0-0", x), pom(yKey, "P1-0", y), pom(yKey, "P1-0", y, false),
    pom(null, "", x), pom("guest:Ravi Kumar", "Ravi Kumar", x)];
  const tally = playerAwards(ms);
  check("pom: leader", tally[0]?.key === p0.toUpperCase() && tally[0]?.awards === 2);
  check("pom: pending ignored, ties by name", tally.map((t) => t.awards).join() === "2,1,1" &&
    tally[1].name === "P1-0" && tally[2].name === "Ravi Kumar");
  check("pom: no awards → empty", playerAwards([pom(null, "", x)]).length === 0);

  const data = computeStandings(cricketTournament("roundRobin"), makeTeams(2),
    ms.map((doc, i) => ({ id: `pom${i}`, doc })));
  check("pom: playerOfTournament", data.playerOfTournament?.key === p0.toUpperCase() &&
    data.playerOfTournament?.teamId === x && data.playerOfTournament?.awards === 2);
}

// ─── 4. Hand cases ──────────────────────────────────────

function racketTournament(o: Partial<StandingsTournament> & { config?: Record<string, unknown> } = {}): StandingsTournament {
  return {
    sportType: o.sportType ?? "badminton",
    formatRaw: o.formatRaw ?? "openSingles",
    matchFormatRaw: o.matchFormatRaw ?? "roundRobin",
    formatConfigData: o.config ? JSON.stringify(o.config) : o.formatConfigData,
  };
}

function players(n: number, names?: string[]): StandingsRegistration[] {
  return Array.from({ length: n }, (_, i) => ({
    id: teamId(i),
    doc: { tournamentId: "t", playerId: uuid(500 + i) } as unknown as RegistrationDoc,
    playerName: names?.[i] ?? `Player ${String.fromCharCode(65 + i)}`,
    partnerName: null,
  }));
}

function setMatch(a: number, b: number, sets: Array<[number, number]>, extra: Record<string, unknown> = {}): StandingsMatch {
  matchSeq += 1;
  return {
    id: `s${matchSeq}`,
    doc: {
      tournamentId: "t", teamAId: teamId(a), teamBId: teamId(b), statusRaw: "finished",
      setScores: sets.map(([x, y]) => ({ teamAPoints: x, teamBPoints: y })), ...extra,
    } as unknown as MatchDoc,
  };
}

function simpleMatch(a: number, b: number, sa: number, sb: number, extra: Record<string, unknown> = {}): StandingsMatch {
  matchSeq += 1;
  return {
    id: `p${matchSeq}`,
    doc: { tournamentId: "t", teamAId: teamId(a), teamBId: teamId(b), statusRaw: "finished", scoreA: sa, scoreB: sb, ...extra } as unknown as MatchDoc,
  };
}

const order = (t: StandingsTournament, regs: StandingsRegistration[], ms: StandingsMatch[]) =>
  (computeStandings(t, regs, ms).groups[0]?.rows ?? []).map((r) => label(r.registrationId)).join(" ");

{
  // Three-way tie on points: A beat B, B beat C, C beat A; D lost all.
  // Point differences: A +10 overall, B +2, C +6 — but H2H mini-table is level
  // on points, then H2H point difference decides.
  const ms = [
    simpleMatch(0, 1, 21, 19), // A beats B by 2
    simpleMatch(1, 2, 21, 10), // B beats C by 11
    simpleMatch(2, 0, 21, 15), // C beats A by 6
    simpleMatch(0, 3, 21, 0), simpleMatch(1, 3, 21, 20), simpleMatch(2, 3, 21, 18),
  ];
  // Overall diffs: A +2−6+21 = 17, B −2+11+1 = 10, C −11+6+3 = −2.
  // H2H diffs (A,B,C only): A −4, B +9, C −5.
  const v1 = (tb: string) => racketTournament({ config: { tieBreakRulesVersion: 1, tieBreaker: tb } });
  check("H2H: mini-table point difference", order(v1("headToHead"), players(4), ms) === "T1 T0 T2 T3",
    order(v1("headToHead"), players(4), ms));
  check("point diff: overall difference", order(v1("pointDiff"), players(4), ms) === "T0 T1 T2 T3");
  check("legacy config (no version) ignores H2H", order(racketTournament({ config: { tieBreaker: "headToHead" } }), players(4), ms) === "T0 T1 T2 T3");
  check("no config: legacy order", order(racketTournament(), players(4), ms) === "T0 T1 T2 T3");
  check("Swiss ignores the round robin tie-breaker",
    order({ ...v1("headToHead"), matchFormatRaw: "swiss" }, players(4), ms) === "T0 T1 T2 T3");
  check("unreadable config: legacy order", order(racketTournament({ formatConfigData: "{nope" }), players(4), ms) === "T0 T1 T2 T3");
  check("wrong-typed key: legacy order",
    order(racketTournament({ config: { tieBreakRulesVersion: 1, tieBreaker: "headToHead", pointsPerWin: "3" } }), players(4), ms) === "T0 T1 T2 T3");
}

{
  // Games won: A and B both 1 win; A won its games 2-1, B 2-0 / lost 1-2.
  const ms = [
    setMatch(0, 2, [[21, 10], [10, 21], [21, 5]]), // A beats C 2-1 (games won 2)
    setMatch(3, 0, [[21, 10], [21, 10]]),          // D beats A 2-0
    setMatch(1, 2, [[21, 19], [21, 19]]),          // B beats C 2-0
    setMatch(3, 1, [[21, 19], [19, 21], [21, 19]]),// D beats B 2-1 (B games 1)
  ];
  // A: games won 2, point diff 52−73 = ... ; B: games won 3.
  const t = racketTournament({ config: { tieBreakRulesVersion: 1, tieBreaker: "gamesWon" } });
  const rows = computeStandings(t, players(4), ms).groups[0].rows;
  check("games won: D first (2 wins)", label(rows[0].registrationId) === "T3");
  check("games won: B (3 games) before A (2 games)", order(t, players(4), ms).startsWith("T3 T1 T0"), order(t, players(4), ms));
  check("games won: sets counted", rows.find((r) => label(r.registrationId) === "T1")?.setsWon === 3);
  check("games: pointsFor sums set points", rows.find((r) => label(r.registrationId) === "T0")?.pointsFor === 52 + 20);
}

{
  // Tennis ranks by set difference, then game difference (its sets are scored in games).
  const t = racketTournament({ sportType: "tennis", config: { tieBreakRulesVersion: 1, tieBreaker: "pointDiff" } });
  const ms = [
    setMatch(0, 2, [[6, 0], [6, 0]]),            // A: sets +2, games +12
    setMatch(1, 2, [[7, 6], [7, 6]]),            // B: sets +2, games +2
    setMatch(0, 1, [[6, 4], [4, 6], [6, 4]]),    // A beats B: sets +1, games +2
    setMatch(1, 3, [[6, 0], [6, 0]]),
    setMatch(3, 0, [[6, 4], [6, 4]]),            // D beats A
    setMatch(2, 3, [[6, 4], [6, 4]]),            // C beats D
  ];
  // Wins: A 2, B 2, C 1, D 1. Set diff A +2+1−2 = +1, B +2−1+2 = +3 → B first despite fewer games.
  check("tennis: set difference first", order(t, players(4), ms).startsWith("T1 T0"), order(t, players(4), ms));
}

{
  // Custom points, draws and the iOS no-winner rules.
  const t = racketTournament({ config: { tieBreakRulesVersion: 1, tieBreaker: "pointDiff", pointsPerWin: 3, pointsPerDraw: 1, pointsPerLoss: 0 } });
  const ms = [simpleMatch(0, 1, 15, 15, { winnerRegistrationId: teamId(0) }), simpleMatch(2, 0, 21, 0)];
  const rows = computeStandings(t, players(3), ms).groups[0].rows;
  const r = (k: number) => rows.find((x) => x.registrationId === teamId(k))!;
  check("equal simple score is a draw (stale winner ignored)", r(0).tied === 1 && r(1).tied === 1 && r(1).points === 1);
  check("custom points per win", r(2).points === 3 && r(2).won === 1);
  check("draw + loss", r(0).points === 1 && r(0).lost === 1 && r(0).played === 2);
  check("non-cricket rows have no nrr", rows.every((x) => x.nrr === undefined));
}

{
  // Unfinished matches don't count; no finished match → no table.
  const pending = simpleMatch(0, 1, 21, 10, { statusRaw: "scoreSubmitted" });
  check("no finished match: no table", computeStandings(racketTournament(), players(2), [pending]).groups.length === 0);
  const data = computeStandings(racketTournament(), players(3), [pending, simpleMatch(0, 2, 21, 10)]);
  check("submitted score not counted", data.groups[0].rows.find((x) => x.registrationId === teamId(1))?.played === 0);
  check("teams without a match still listed", data.groups[0].rows.length === 3);
}

{
  // Elimination formats: no tables (the app shows bracket progress).
  for (const f of ["singleElimination", "doubleElimination", undefined, "bogus"]) {
    check(`elimination ${f}: no groups`, computeStandings({ ...racketTournament(), matchFormatRaw: f }, players(2), [simpleMatch(0, 1, 21, 10)]).groups.length === 0);
  }
}

{
  // Doubles: entries without a partner aren't in the table; names are "A & B".
  const regs = players(3);
  regs[0].partnerName = "Zed";
  regs[1].partnerName = "Yan";
  const t = racketTournament({ formatRaw: "mensDoubles" });
  const rows = computeStandings(t, regs, [simpleMatch(0, 1, 21, 10)]).groups[0].rows;
  check("doubles: unpaired entry left out", rows.length === 2);
  check("doubles: display name", rows[0].teamName === "Player A & Zed");
  // A registration whose player doc is gone (and its matches) are left out.
  const gone = players(3);
  gone[2].playerName = null;
  const rows2 = computeStandings(racketTournament(), gone, [simpleMatch(0, 1, 21, 10), simpleMatch(2, 0, 21, 10)]).groups[0].rows;
  check("missing player: entry and its matches dropped", rows2.length === 2 && rows2.every((x) => x.played === 1));
}

{
  // Ids in another case (web/server lower-case) still match; output uses the registration doc id.
  const regs = players(2).map((r) => ({ ...r, id: r.id.toLowerCase() }));
  const rows = computeStandings(racketTournament(), regs, [simpleMatch(0, 1, 10, 21)]).groups[0].rows;
  check("id case: matched", rows[0].registrationId === teamId(1).toLowerCase() && rows[0].won === 1);
}

{
  // Group + Knockout: knockout matches (no group label) don't count in group tables.
  const t = racketTournament({ matchFormatRaw: "groupKnockout" });
  const ms = [simpleMatch(0, 1, 21, 10, { groupLabel: "A" }), simpleMatch(2, 3, 21, 10, { groupLabel: "B" }),
    simpleMatch(1, 3, 21, 10)];
  const data = computeStandings(t, players(4), ms);
  check("GK: groups A, B", data.groups.map((g) => g.name).join() === "A,B");
  check("GK: knockout match ignored", data.groups[0].rows.find((x) => x.registrationId === teamId(1))?.played === 1);
}

{
  // Cricket Top performers: finished matches only, top 5, runs then strike rate.
  const rules = DEFAULT_CRICKET_RULES;
  const a = teamId(0);
  const b = teamId(1);
  const card: CricketResult = {
    innings: [{ battingRegistrationId: a, runs: 150, wickets: 10, balls: 110 }, { battingRegistrationId: b, runs: 151, wickets: 3, balls: 100 }],
  };
  const stats = JSON.stringify({
    batting: Array.from({ length: 7 }, (_, i) => ({ teamRegistrationId: a, key: uuid(900 + i), name: `Bat ${i}`, runs: 10 + i, balls: 10, out: true })),
    bowling: [{ teamRegistrationId: b, key: uuid(950), name: "Bowl", balls: 24, runs: 20, wickets: 3 }],
  });
  const done = cricketMatch(a, b, card, rules, { playerStatsData: stats });
  const pending = cricketMatch(a, b, card, rules, { playerStatsData: stats, statusRaw: "scoreSubmitted" });
  const data = computeStandings(cricketTournament("roundRobin"), makeTeams(2), [done, pending]);
  check("top performers: 5 batters", data.topPerformers?.batting.length === 5 && data.topPerformers.batting[0].name === "Bat 6");
  check("top performers: pending match ignored", data.topPerformers?.batting[0].innings === 1);
  check("top performers: bowling", data.topPerformers?.bowling[0].wickets === 3);
  check("cricket rows have nrr", data.groups[0].rows.every((r) => typeof r.nrr === "number"));
  check("non-cricket: no top performers", computeStandings(racketTournament(), players(2), [simpleMatch(0, 1, 21, 10)]).topPerformers === undefined);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
