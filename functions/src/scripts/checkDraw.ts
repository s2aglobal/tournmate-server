/**
 * Draw parity check: prints the same "parity dump" as the iOS harness
 * (tournmate-ios Tools/DrawTests/main.swift, section "Parity dump" plus the
 * SEED and PSTATS lines) and asserts it is byte-identical to
 * `test-fixtures/draw-parity-fixture.txt` (a copy of iOS
 * `Tools/DrawTests/parity-fixture.txt`; Android's DrawParityTest uses the
 * same file). Covers round robin, knockout brackets and advancement, Group +
 * Knockout groups / cricket tables / qualification, Swiss rounds, random
 * seeding, cricket outcomes and player-stat rates.
 *
 * Usage (from tournmate-server/functions):
 *   npm run check:draw   # exits non-zero on any difference
 *
 * After an intended draw change on iOS, copy the new iOS fixture here.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  CRICKET_EVENT_TYPES,
  CricketResult,
  CricketRules,
  DEFAULT_CRICKET_RULES,
  addToRunRate,
  cricketOutcome,
  formatNetRunRate,
  formatOvers,
  netRunRate,
  validateCricketResult,
} from "../services/cricket";
import {
  PlayerStats,
  averageHundredths,
  battingLeaders,
  bowlingLeaders,
  economyHundredths,
  formatBest,
  formatHighest,
  formatHundredths,
  formatTenths,
  strikeRateTenths,
} from "../services/cricketPlayerStats";
import {
  DrawTeam,
  SwissMatch,
  fnv1a64,
  generateBracketFirstRound,
  generateGroupStageSchedule,
  generateRoundRobinSchedule,
  generateSwissPairings,
  knockoutByeTeams,
  knockoutSeedingFromGroups,
  nextRoundPairs,
  seeded,
  seededByRating,
} from "../services/draw/pairing";
import { StandingsEntry, StandingsResult, entryNetRunRate, newEntry, ranked, tally } from "../services/draw/standings";

// ─── Deterministic RNG (same constants/ops as iOS/Android Lcg) ───

const MASK = (1n << 64n) - 1n;
class Lcg {
  private s: bigint;
  constructor(seed: number) { this.s = BigInt(seed) & MASK; }
  next(): bigint {
    this.s = (this.s * 6364136223846793005n + 1442695040888963407n) & MASK;
    return this.s >> 33n;
  }
  int(bound: number): number { return Number(this.next() % BigInt(bound)); }
}

// ─── Fixtures ───

interface Team extends DrawTeam { name: string }

const uuid = (k: number) => `00000000-0000-0000-0000-${String(k).padStart(12, "0")}`;
const rating = (i: number, tied: boolean) => (tied ? 1000 : 1000 + ((i * 37) % 400));

function makeTeams(n: number, tied = false): Team[] {
  return Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1), name: `Team ${i}`, rating: rating(i, tied) }));
}

const label = (t: DrawTeam) => `T${Number(t.id.slice(-12)) - 1}`;
const labels = (ts: DrawTeam[]) => "[" + ts.map(label).join(" ") + "]";

function randomScorecard(rng: Lcg, r: CricketRules, a: string, b: string): CricketResult {
  if (rng.int(25) === 0) return { innings: [], noResult: true };
  const limit = r.overs * r.ballsPerOver;
  const wMax = r.lastManStands ? r.playersPerSide : r.playersPerSide - 1;
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

function validScorecard(rng: Lcg, rules: CricketRules, a: string, b: string, needWinner: boolean): CricketResult {
  for (let k = 0; k < 500; k++) {
    const res = randomScorecard(rng, rules, a, b);
    if (validateCricketResult(res, rules, a, b).length > 0) continue;
    if (needWinner && cricketOutcome(res, rules).winnerRegistrationId === null) continue;
    return res;
  }
  throw new Error("no valid scorecard");
}

function standingsResult(teamA: string, teamB: string, res: CricketResult, rules: CricketRules): StandingsResult {
  const o = cricketOutcome(res, rules);
  return {
    teamAId: teamA, teamBId: teamB, winnerId: o.winnerRegistrationId,
    scoreA: 0, scoreB: 0, setsA: 0, setsB: 0, cricket: res, noResult: o.resultType === "noResult",
  };
}

const POINTS = { win: 2, draw: 1, loss: 0 };

function cricketTable(teams: Team[], results: StandingsResult[], rules: CricketRules): StandingsEntry[] {
  const entries = new Map<string, StandingsEntry>();
  for (const t of teams) entries.set(t.id, newEntry(t.id, t.name));
  tally(results, entries, POINTS, rules);
  return ranked([...entries.values()], results, "cricket", "headToHead", POINTS);
}

function playKnockout(seededTeams: Team[], winner: (a: Team, b: Team) => Team) {
  const first = generateBracketFirstRound(seededTeams);
  const rounds: Array<Array<[Team, Team]>> = [first.matches.map((m) => [m.teamA, m.teamB])];
  let champion: Team | undefined;
  for (;;) {
    const current = rounds[rounds.length - 1];
    let winners = current.map(([a, b]) => winner(a, b));
    if (rounds.length === 1) {
      const r1 = current.flatMap(([a, b]) => [a.id, b.id]);
      winners = knockoutByeTeams(seededTeams, r1).concat(winners);
    }
    if (winners.length < 2) { champion = winners[0]; break; }
    rounds.push(nextRoundPairs(winners).map((p) => [p.teamA, p.teamB]));
    if (rounds.length > 12) break;
  }
  return { rounds, champion };
}

// ─── Dump ───

const dump: string[] = [];

for (let n = 0; n <= 12; n++) {
  const teams = makeTeams(n);
  for (const d of [false, true]) {
    const s = generateRoundRobinSchedule(teams, d);
    dump.push(`RR n=${n} double=${d}: ` + s.map((e) => `${e.round}:${label(e.teamA)}-${label(e.teamB)}`).join(" "));
  }
}

for (let n = 0; n <= 12; n++) {
  for (const tied of [false, true]) {
    const teams = makeTeams(n, tied);
    const seededTeams = seededByRating(teams);
    const first = generateBracketFirstRound(seededTeams);
    dump.push(`KO n=${n} tied=${tied}: rounds=${first.totalRounds} byes=${labels(first.byeTeams)} r1=` +
      first.matches.map((m) => `${m.bracketPosition}:${label(m.teamA)}-${label(m.teamB)}`).join(" "));
    if (n < 2) continue;
    const rng = new Lcg(100_000 + n * 10 + (tied ? 1 : 0));
    const ko = playKnockout(seededTeams, (a, b) => (rng.int(2) === 0 ? a : b));
    ko.rounds.forEach((round, ri) => {
      if (ri > 0) dump.push(`  round ${ri + 1}: ` + round.map(([a, b]) => `${label(a)}-${label(b)}`).join(" "));
    });
    dump.push(`  champion=${ko.champion ? label(ko.champion) : "-"}`);
  }
}

{
  const rules = DEFAULT_CRICKET_RULES;
  for (let n = 4; n <= 16; n++) {
    for (let adv = 1; adv <= 4; adv++) {
      const teams = makeTeams(n);
      const s = generateGroupStageSchedule(teams, 2, adv);
      const members = new Map<string, Team[]>();
      for (const e of s) {
        for (const x of [e.teamA, e.teamB]) {
          const list = members.get(e.group) ?? [];
          if (!list.some((t) => t.id === x.id)) list.push(x);
          members.set(e.group, list);
        }
      }
      const groupLabels = [...members.keys()].sort();
      dump.push(`GK n=${n} adv=${adv}: ` + groupLabels.map((g) => `${g}=${labels(members.get(g)!)}`).join(" "));
      dump.push("  matches: " + s.map((e) => `${e.group}${e.round}:${label(e.teamA)}-${label(e.teamB)}`).join(" "));
      const rng = new Lcg(200_000 + n * 10 + adv);
      const results = s.map((e) => {
        const res = validScorecard(rng, rules, e.teamA.id, e.teamB.id, false);
        return { group: e.group, result: standingsResult(e.teamA.id, e.teamB.id, res, rules) };
      });
      const byId = new Map(teams.map((t) => [t.id, t]));
      const tables: Team[][] = [];
      for (const g of groupLabels) {
        const table = cricketTable(members.get(g)!, results.filter((r) => r.group === g).map((r) => r.result), rules);
        dump.push(`  table ${g}: ` + table.map((e) =>
          `${label(byId.get(e.registrationId)!)} ${e.points} ${formatNetRunRate(entryNetRunRate(e))}`).join(", "));
        tables.push(table.map((e) => byId.get(e.registrationId)!));
      }
      const seededTeams = knockoutSeedingFromGroups(tables, adv);
      const first = generateBracketFirstRound(seededTeams);
      dump.push(`  seeds=${labels(seededTeams)} byes=${labels(first.byeTeams)} r1=` +
        first.matches.map((m) => `${label(m.teamA)}-${label(m.teamB)}`).join(" "));
    }
  }
}

for (let n = 2; n <= 12; n++) {
  const teams = makeTeams(n);
  const played: SwissMatch[] = [];
  const rng = new Lcg(300_000 + n);
  for (let r = 1; r <= n; r++) {
    const pairs = generateSwissPairings(teams, played, r);
    dump.push(`SW n=${n} r=${r}: ` + pairs.map((p) => `${label(p.teamA)}-${label(p.teamB)}`).join(" "));
    for (const p of pairs) {
      const k = rng.int(3);
      const winnerId = k === 0 ? p.teamA.id : k === 1 ? p.teamB.id : null;
      played.push({ teamAId: p.teamA.id, teamBId: p.teamB.id, winnerId, finished: true, round: r });
    }
  }
}

{
  const ruleSets: CricketRules[] = [
    ...CRICKET_EVENT_TYPES.map((e) => e.rules),
    { eventTypeId: "custom", playersPerSide: 8, overs: 5, ballsPerOver: 8, lastManStands: false, superOver: true },
    { eventTypeId: "custom", playersPerSide: 6, overs: 10, ballsPerOver: 4, lastManStands: true, superOver: true },
  ];
  const rng = new Lcg(400_000);
  const a = uuid(1);
  const b = uuid(2);
  const side = (id: string | null) => (id === null ? "-" : id === a ? "A" : "B");
  for (let k = 0; k < 400; k++) {
    const rules: CricketRules = { ...ruleSets[k % ruleSets.length] };
    rules.superOver = rng.int(2) === 0;
    const card = randomScorecard(rng, rules, a, b);
    const issues = validateCricketResult(card, rules, a, b);
    let line = `C${k} ${rules.eventTypeId}/${rules.overs}x${rules.ballsPerOver}/so=${rules.superOver}: `;
    if (issues.length > 0) {
      line += `invalid ${issues[0].field}: ${issues[0].message}`;
    } else {
      const o = cricketOutcome(card, rules);
      const nrr = addToRunRate({ runsFor: 0, ballsFaced: 0, runsAgainst: 0, ballsBowled: 0 }, a, card, rules);
      line += `${o.resultType} ${side(o.winnerRegistrationId)} ${o.margin} nrrA=${formatNetRunRate(netRunRate(nrr, rules.ballsPerOver))}`;
    }
    dump.push(line);
  }
}

{
  const salt = "00000000-0000-0000-0000-000000000777";
  for (const n of [2, 3, 5, 8, 13, 16]) {
    dump.push(`SEED random n=${n}: ` + labels(seeded(makeTeams(n), "random", salt)));
  }
}

{
  const A = "regA";
  const B = "regB";
  const bat = (t: string, k: string, r: number, b: number, out = true) =>
    ({ teamRegistrationId: t, key: k, name: k, runs: r, balls: b, out });
  const bowl = (t: string, k: string, b: number, r: number, w: number) =>
    ({ teamRegistrationId: t, key: k, name: k, balls: b, runs: r, wickets: w });
  const good: PlayerStats = {
    batting: [bat(A, "P1", 60, 40), bat(A, "P2", 45, 30, false), bat(B, "Q1", 80, 50), bat(B, "guest:Ravi", 70, 55, false)],
    bowling: [bowl(B, "Q2", 24, 30, 3), bowl(A, "P3", 24, 41, 2), bowl(A, "guest:Sam", 20, 35, 1)],
  };
  const m2: PlayerStats = {
    batting: [bat(A, "P1", 20, 10), bat(B, "guest:Ravi", 75, 40), bat(A, "P2", 105, 60, true)],
    bowling: [bowl(A, "P3", 24, 18, 3), bowl(B, "Q2", 24, 25, 3), bowl(B, "Q9", 12, 9, 0)],
  };
  const grid: string[] = [];
  for (const runs of [0, 1, 7, 33, 99, 150]) {
    for (const balls of [0, 1, 6, 16, 23, 61]) {
      grid.push(`${runs}/${balls} sr=${formatTenths(strikeRateTenths(runs, balls))} ` +
        `econ=${formatHundredths(economyHundredths(runs, balls))} avg=${formatHundredths(averageHundredths(runs, balls))}`);
    }
  }
  dump.push("PSTATS rates " + grid.join("; "));
  dump.push("PSTATS batting " + battingLeaders([good, m2]).map((e) =>
    `${e.key} ${e.runs} ${formatHighest(e)} ${formatTenths(strikeRateTenths(e.runs, e.balls))} ` +
    `${formatHundredths(averageHundredths(e.runs, e.innings - e.notOuts))}`).join(" | "));
  dump.push("PSTATS bowling " + bowlingLeaders([good, m2]).map((e) =>
    `${e.key} ${e.wickets} ${formatBest(e)} ${formatHundredths(economyHundredths(e.runs, e.balls))} ${formatOvers(e.balls, 6)}`)
    .join(" | "));
}

// ─── Compare ───

let failures = 0;
const fail = (msg: string) => { console.log(`FAIL  ${msg}`); failures += 1; };
if (fnv1a64("") !== 0xcbf29ce484222325n) fail("fnv1a64 empty");
if (fnv1a64("a") !== 0xaf63dc4c8601ec8cn) fail("fnv1a64 'a'");

const fixturePath = join(__dirname, "..", "..", "test-fixtures", "draw-parity-fixture.txt");
const expected = readFileSync(fixturePath, "utf8");
const actual = dump.map((l) => l + "\n").join("");
if (actual !== expected) {
  const e = expected.split("\n");
  const a = actual.split("\n");
  let shown = 0;
  for (let i = 0; i < Math.max(e.length, a.length) && shown < 10; i++) {
    if (e[i] !== a[i]) {
      console.log(`line ${i + 1}\n  expected: ${e[i]}\n  actual:   ${a[i]}`);
      shown += 1;
    }
  }
  fail(`parity dump differs from ${fixturePath}`);
} else {
  console.log(`PASS  parity: identical to draw-parity-fixture.txt (${dump.length} lines)`);
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("All draw checks passed.");
