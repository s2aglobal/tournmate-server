/**
 * Dependency-free checks for services/cricketLive.ts (live ball-by-ball
 * scoring) plus the LIVE parity fixture the iOS and Android ports replay.
 *
 * Usage (from tournmate-server/functions):
 *   npm run check:cricket-live             # check, compare with the fixture
 *   npm run check:cricket-live -- --write  # regenerate the fixture after an intended change
 *
 * Fixture: test-fixtures/cricket-live-fixture.txt (format in
 * cricket-live-contract.md → "Parity fixture format"). Each scenario lists
 * its config and events as JSON, then the state line after every event (or
 * the refusal reason + message), the final scorecard lines, and for a
 * finished match the CricketResult / PlayerStats JSON and outcome.
 *
 * Exits non-zero if any case fails.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CricketRules, cricketOutcome, validateCricketResult } from "../services/cricket";
import { validatePlayerStats } from "../services/cricketPlayerStats";
import {
  BallEvent, Extras, LiveConfig, LiveEvent, LiveRuleError, LiveState, Wicket, applyEvent, ballCode, ballPosition,
  formatScorecardLines, formatStateLine, initialState, liveStatus, liveSummary, replay, sortedJson, toCricketResult,
  toPlayerStats, undoLastBall, validationPlayersPerSide, validationRules, inningsEndedEarly, effectiveRules,
} from "../services/cricketLive";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

// ─── Builders ───────────────────────────────────────────

function cfg(o: { overs: number; pps: number; lms?: boolean; a?: number; b?: number; maxOvers?: number | null }): LiveConfig {
  const rules: CricketRules = {
    eventTypeId: "custom", playersPerSide: o.pps, overs: o.overs, ballsPerOver: 6,
    lastManStands: o.lms ?? false, superOver: true,
  };
  const side = (p: string, n: number) => {
    const keys = Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
    if (p === "B") keys[n - 1] = "guest:Gus";
    return keys;
  };
  const a = side("A", o.a ?? o.pps);
  const b = side("B", o.b ?? o.pps);
  return {
    rules, maxOversPerBowler: o.maxOvers ?? null, battingFirstTeamId: "TA",
    teams: [
      { id: "TA", name: "Aces", players: a.map((k) => ({ key: k, name: k.toLowerCase() })), order: a },
      { id: "TB", name: "Bulls", players: b.map((k) => ({ key: k, name: k.startsWith("guest:") ? k.slice(6) : k.toLowerCase() })), order: b },
    ],
  };
}

let ballNo = 0;
type BallOpts = { x?: Extras; w?: Wicket; nb?: string; bw?: string; swap?: boolean };
function b(runs: number, o: BallOpts = {}): BallEvent {
  ballNo += 1;
  const e: BallEvent = { type: "ball", id: `b${ballNo}`, runs };
  if (o.x) e.extras = o.x;
  if (o.w) e.wicket = o.w;
  if (o.nb) e.nextBatterKey = o.nb;
  if (o.bw) e.nextBowlerKey = o.bw;
  if (o.swap) e.swapStrike = true;
  return e;
}
const wd = (runs = 0, o: BallOpts = {}) => b(0, { ...o, x: { type: "wide", runs } });
const nob = (bat = 0, byes = 0, o: BallOpts = {}) => b(bat, { ...o, x: { type: "noBall", runs: byes } });
const bye = (runs: number, o: BallOpts = {}) => b(0, { ...o, x: { type: "bye", runs } });
const lb = (runs: number, o: BallOpts = {}) => b(0, { ...o, x: { type: "legBye", runs } });
const out = (type: Wicket["type"], batterKey: string, o: BallOpts & { f?: string; runs?: number } = {}) =>
  b(o.runs ?? 0, { ...o, w: { type, batterKey, ...(o.f ? { fielderKey: o.f } : {}) } });
const start = (s: string, ns: string, bw: string): LiveEvent => ({ type: "startInnings", strikerKey: s, nonStrikerKey: ns, bowlerKey: bw });
const revise = (runs: number, overs: number): LiveEvent => ({ type: "revisedTarget", runs, overs });
const end = (reason: string): LiveEvent => ({ type: "endInnings", reason });
const UNDO = "undo" as const;

type Step = LiveEvent | typeof UNDO | [LiveEvent | typeof UNDO, string];

interface Scenario {
  name: string;
  config: LiveConfig;
  steps: Step[];
  /** Substrings expected among the scorecard lines. */
  card?: string[];
  outcome?: string;
  superOver?: string;
}

// ─── Runner ─────────────────────────────────────────────

const fixture: string[] = [];

function run(sc: Scenario): LiveState {
  const p = `LIVE ${sc.name}`;
  fixture.push(`${p} config ${sortedJson(sc.config)}`);
  let s = initialState(sc.config);
  let events: LiveEvent[] = [];
  sc.steps.forEach((step, i) => {
    const [ev, want] = Array.isArray(step) ? step : [step, undefined];
    fixture.push(ev === UNDO ? `${p} undo` : `${p} event ${sortedJson(ev)}`);
    let line: string;
    try {
      if (ev === UNDO) {
        const u = undoLastBall(events);
        events = u.events;
        s = replay(sc.config, events);
      } else {
        s = applyEvent(s, ev);
        events = [...events, ev];
      }
      line = `=> ${formatStateLine(s)}`;
    } catch (e) {
      if (!(e instanceof LiveRuleError)) throw e;
      line = `!! ${e.reason} ${e.message}`;
    }
    fixture.push(`${p} ${line}`);
    if (want !== undefined) {
      const ok = want.startsWith("!")
        ? line === `!! ${line.split(" ")[1]} ${want.slice(1)}`
        : line.startsWith("=> ") && want.split(" ").every((t) => ` ${line} `.includes(` ${t} `));
      check(`${sc.name} step ${i + 1}: ${want}`, ok, line);
    }
  });
  // Replaying the kept events gives the same state (what the server does on every call).
  check(`${sc.name}: replay matches`, JSON.stringify(replay(sc.config, events)) === JSON.stringify(s));

  const card = formatScorecardLines(s);
  for (const l of card) fixture.push(`${p} card ${l}`);
  for (const want of sc.card ?? []) check(`${sc.name} card: ${want}`, card.some((l) => l.includes(want)), card.join(" | "));

  if (liveStatus(s) === "ended") {
    const result = toCricketResult(s, sc.superOver ? { superOverWinnerRegistrationId: sc.superOver } : {});
    const stats = toPlayerStats(s);
    const rules = validationRules(s);
    const outcome = cricketOutcome(result, rules);
    fixture.push(`${p} result ${sortedJson(result)}`);
    fixture.push(`${p} stats ${sortedJson(stats)}`);
    fixture.push(`${p} outcome ${outcome.resultType} ${outcome.winnerRegistrationId ?? "-"} ${outcome.margin}`);
    const issues = validateCricketResult(result, rules, "TA", "TB", { endedEarly: inningsEndedEarly(s) });
    check(`${sc.name}: validateCricketResult accepts the derived result`, issues.length === 0, JSON.stringify(issues));
    const sIssues = validatePlayerStats(stats, result, "TA", "TB", (id) => id);
    check(`${sc.name}: validatePlayerStats accepts the derived figures`, sIssues.length === 0, JSON.stringify(sIssues));
    if (sc.outcome) check(`${sc.name}: outcome`, outcome.margin === sc.outcome, outcome.margin);
  }
  return s;
}

// ─── Scenarios ──────────────────────────────────────────

const scenarios: Scenario[] = [
  {
    name: "extras",
    config: cfg({ overs: 2, pps: 11 }),
    steps: [
      [start("A1", "A2", "B1"), "st=inProgress inn=1 0/0 (0) s=A1 ns=A2 b=B1"],
      [b(1), "1/0 (0.1) s=A2 ns=A1 over=[1]"],
      [b(0), "1/0 (0.2) s=A2"],
      [wd(), "2/0 (0.2) s=A2 over=[1,.,wd]"],
      [wd(1), "4/0 (0.2) s=A1 over=[1,.,wd,2wd]"],
      [nob(4), "9/0 (0.2) s=A1 fh=1"],
      [b(6), "15/0 (0.3) s=A1 fh=0"],
      [bye(1), "16/0 (0.4) s=A2"],
      [lb(2), "18/0 (0.5) s=A2"],
      [b(0, { swap: true }), "18/0 (1) s=A2 ns=A1 b=- lb=B1 over=[1,.,wd,2wd,4nb,6,1b,2lb,.]"],
      [b(1), "!Pick the bowler for the next over."],
      [b(1, { bw: "B1" }), "!That bowler bowled the last over."],
      [b(1, { bw: "A3" }), "!That bowler isn't in the fielding side."],
      [wd(0, { bw: "B2" }), "19/0 (1) b=B2 over=[wd]"],
      [b(0, { x: { type: "wide", runs: 0 } }), "20/0 (1) over=[wd,wd]"],
      [{ ...b(1), extras: { type: "wide", runs: 0 } }, "!Runs off the bat can't be added to a wide, bye or leg bye."],
      [bye(0), "!A bye or leg bye needs at least 1 run."],
      [b(8), "!Runs must be a whole number from 0 to 7."],
      [b(1, { x: { type: "bye", runs: 9 } }), "!Extra runs must be a whole number from 0 to 7."],
      [nob(0, 1), "22/0 (1) s=A1 ns=A2 fh=1 over=[wd,wd,1nb]"],
      [wd(), "23/0 (1) fh=1"],
      [b(2), "25/0 (1.1) fh=0"],
      [b(3), "28/0 (1.2) s=A2"],
      b(4), b(4), b(4),
      [b(4), "44/0 (2) st=inningsBreak end=overs lb=B2 b=-"],
      [b(1), "!This innings is over. Start the next innings."],
    ],
    card: ["1 bowl B1 1-0-15-0 wd=2 nb=1", "1 bowl B2 1-0-25-0 wd=3 nb=1", "1 extras 12 (wd 6, nb 2, b 2, lb 2)",
      "1 total TA 44/0 (2) end=overs", "1 bat A1 16(6) 4s=1 6s=1 notOut"],
  },
  {
    name: "dismissals",
    config: cfg({ overs: 5, pps: 11, maxOvers: 5 }),
    steps: [
      start("A1", "A2", "B1"),
      [out("bowled", "A1", { nb: "A3" }), "0/1 (0.1) s=A3 ns=A2 over=[W]"],
      [out("caught", "A3", { nb: "A4" }), "!Pick the fielder."],
      [out("caught", "A3", { f: "A5", nb: "A4" }), "!That fielder isn't in the fielding side."],
      [out("lbw", "A2", { nb: "A4" }), "!Only the striker can be out that way."],
      [out("bowled", "A3", { runs: 1, nb: "A4" }), "!That dismissal can't happen on this ball."],
      [out("bowled", "A9", { nb: "A4" }), "!The dismissed batter must be at the crease."],
      [out("caught", "A3", { f: "B3" }), "!Pick the next batter."],
      [out("caught", "A3", { f: "B3", nb: "A1" }), "!That batter has already batted."],
      [out("caught", "A3", { f: "B3", nb: "B2" }), "!That batter isn't in the batting side."],
      [out("caught", "A3", { f: "B3", nb: "A4" }), "0/2 (0.2) s=A4 ns=A2"],
      [b(1, { nb: "A5" }), "!No new batter is needed."],
      [b(1), "1/2 (0.3) s=A2 ns=A4"],
      [out("runOut", "A2", { runs: 1, f: "B4", nb: "A5" }), "2/3 (0.4) s=A4 ns=A5 over=[W,W,1,1W]"],
      [out("lbw", "A4", { nb: "A6" }), "2/4 (0.5) s=A6"],
      [nob(0, 0, { w: { type: "bowled", batterKey: "A6" }, nb: "A7" }), "!That dismissal can't happen on this ball."],
      [bye(1, { w: { type: "stumped", batterKey: "A6", fielderKey: "guest:Gus" }, nb: "A7" }), "!That dismissal can't happen on this ball."],
      [wd(0, { w: { type: "stumped", batterKey: "A6", fielderKey: "guest:Gus" }, nb: "A7" }), "3/5 (0.5) s=A7 ns=A5 over=[W,W,1,1W,W,wdW]"],
      [out("hitWicket", "A7", { nb: "A8" }), "3/6 (1) s=A5 ns=A8 b=- lb=B1"],
      [out("retiredHurt", "A5"), "!Pick the next batter."],
      [out("retiredHurt", "A5", { runs: 1, nb: "A9" }), "!Record the retirement on its own, without runs."],
      [out("retiredHurt", "A5", { nb: "A9" }), "3/6 (1) s=A9 ns=A8 b=- over=[RH]"],
      [b(4, { bw: "B2" }), "7/6 (1.1) s=A9 b=B2 over=[RH,4]"],
      [out("retiredOut", "A8", { nb: "A10" }), "7/7 (1.1) s=A9 ns=A10 over=[RH,4,RO]"],
      [out("bowled", "A9", { nb: "A5" }), "7/8 (1.2) s=A5 ns=A10"],
      [out("caught", "A5", { f: "B2", nb: "A11" }), "7/9 (1.3) s=A11"],
      [out("runOut", "A11", { nb: "A1" }), "!No new batter is needed."],
      [out("runOut", "A11", { f: "guest:Gus" }), "7/10 (1.4) st=inningsBreak end=allOut"],
    ],
    card: ["1 bowl B1 1-0-3-5 wd=1 nb=0", "1 bowl B2 0.4-0-4-2 wd=0 nb=0", "1 bat A5 0(1) 4s=0 6s=0 caught b=B2 f=B2",
      "1 bat A8 0(0) 4s=0 6s=0 retiredOut", "1 bat A2 1(1) 4s=0 6s=0 runOut f=B4", "1 bat A10 0(0) 4s=0 6s=0 notOut",
      "1 bat A6 0(0) 4s=0 6s=0 stumped b=B1 f=guest:Gus", "1 fow 1-0 A1 (0.1), 2-0 A3 (0.2), 3-2 A2 (0.4)"],
  },
  {
    name: "bowlers",
    config: cfg({ overs: 3, pps: 11 }),
    steps: [
      start("A1", "A2", "B1"),
      b(0), b(0), b(0), b(0), b(0),
      [b(0), "0/0 (1) s=A2 ns=A1 b=- lb=B1"],
      [b(0, { bw: "B2" }), "(1.1) b=B2"],
      [b(0, { bw: "B3" }), "!The bowler can't change in the middle of an over."],
      [b(1, { bw: "B2" }), "1/0 (1.2) s=A1"],
      b(0), b(0), b(0),
      [b(0), "1/0 (2) lb=B2 b=-"],
      [b(0, { bw: "B1" }), "!That bowler has no overs left."],
      [b(0, { bw: "B2" }), "!That bowler bowled the last over."],
      [b(1, { bw: "guest:Gus" }), "2/0 (2.1) b=guest:Gus s=A1"],
      [b(0, { swap: true }), "2/0 (2.2) s=A2 ns=A1"],
      [end("Rain"), "st=inningsBreak end=manual"],
      [end("Again"), "!This innings is over. Start the next innings."],
    ],
    card: ["1 bowl B1 1-1-0-0 wd=0 nb=0", "1 bowl B2 1-0-1-0 wd=0 nb=0", "1 bowl guest:Gus 0.2-0-1-0", "1 total TA 2/0 (2.2) end=manual"],
  },
  {
    name: "chase",
    config: cfg({ overs: 1, pps: 3 }),
    steps: [
      [b(1), "!Start the innings first."],
      [revise(10, 1), "!A revised target is set once the first innings is over."],
      [start("A1", "A1", "B1"), "!Pick two different batters."],
      [start("A1", "B2", "B1"), "!That batter isn't in the batting side."],
      [start("A1", "A2", "A3"), "!That bowler isn't in the fielding side."],
      [start("A1", "A2", "B1"), "st=inProgress"],
      [start("A1", "A2", "B1"), "!This innings has already started."],
      b(6), b(4), b(1), b(0), b(2),
      [b(1), "st=inningsBreak inn=1 14/0 (1) end=overs"],
      [start("B1", "B2", "B1"), "!That bowler isn't in the fielding side."],
      [start("B1", "B2", "A1"), "st=inProgress inn=2 0/0 (0) tgt=15 s=B1 ns=B2 b=A1"],
      b(4), b(6),
      [b(1), "11/0 (0.3) s=B2"],
      [wd(3), "15/0 (0.3) tgt=15 st=ended end=target s=B1"],
      [b(1), "!Both innings are over. Finish the match."],
      [start("A1", "A2", "B1"), "!Both innings have been played."],
      [revise(10, 1), "!Both innings have been played."],
    ],
    outcome: "won by 2 wickets (3 balls left)",
  },
  {
    name: "revised",
    config: cfg({ overs: 2, pps: 11 }),
    steps: [
      start("A1", "A2", "B1"),
      ...Array.from({ length: 6 }, () => b(1)),
      ...Array.from({ length: 6 }, (_, i) => b(1, i === 0 ? { bw: "B2" } : {})),
      [revise(10, 3), "!Revised overs must be between 1 and 2."],
      [revise(0, 1), "!Revised target must be at least 1 run."],
      [revise(10, 2), "st=inningsBreak inn=1"],
      [start("B1", "B2", "A1"), "inn=2 0/0 (0) tgt=10"],
      ...Array.from({ length: 6 }, () => b(1)),
      [b(1, { bw: "A2" }), "7/0 (1.1)"],
      [revise(9, 1), "!Revised overs can't be fewer than the overs already bowled."],
      [revise(8, 2), "7/0 (1.1) tgt=8 st=inProgress"],
      [b(1), "8/0 (1.2) tgt=8 st=ended end=target"],
    ],
    outcome: "won by 10 wickets (4 balls left) (revised target)",
  },
  {
    name: "rainEnd",
    config: cfg({ overs: 2, pps: 11 }),
    steps: [
      start("A1", "A2", "B1"),
      ...Array.from({ length: 6 }, () => b(2)),
      ...Array.from({ length: 6 }, (_, i) => b(2, i === 0 ? { bw: "B2" } : {})),
      start("B1", "B2", "A1"),
      ...Array.from({ length: 6 }, () => b(2)),
      [end("Rain"), "12/0 (1) tgt=25 st=ended end=manual"],
      [revise(15, 1), "12/0 (1) tgt=15 st=ended end=overs"],
    ],
    outcome: "won by 2 runs (revised target)",
  },
  {
    name: "undo",
    config: cfg({ overs: 2, pps: 3 }),
    steps: [
      start("A1", "A2", "B1"),
      [UNDO, "!Nothing to undo."],
      [b(1), "1/0 (0.1) s=A2"],
      [UNDO, "0/0 (0) s=A1 over=[]"],
      b(1), b(1), b(1), b(1), b(1),
      [b(1), "6/0 (1) s=A2 ns=A1 b=- lb=B1"],
      [UNDO, "5/0 (0.5) s=A2 ns=A1 b=B1 lb=-"],
      [b(1), "6/0 (1) s=A2 b=- lb=B1"],
      [out("bowled", "A2", { bw: "B2", nb: "A3" }), "6/1 (1.1) s=A3 ns=A1 b=B2"],
      [out("bowled", "A3"), "6/2 (1.2) st=inningsBreak end=allOut"],
      [UNDO, "6/1 (1.1) st=inProgress s=A3"],
      [end("Declared"), "st=inningsBreak end=manual"],
      [UNDO, "6/0 (1) st=inProgress s=A2 ns=A1 b=- lb=B1"],
      [end("Declared"), "st=inningsBreak"],
      [start("B1", "B2", "A1"), "inn=2 tgt=7"],
      [UNDO, "!Nothing to undo."],
      [b(4), "4/0 (0.1)"],
      [UNDO, "0/0 (0)"],
    ],
  },
  {
    name: "lastManStands",
    config: cfg({ overs: 2, pps: 3, lms: true }),
    steps: [
      start("A1", "A2", "B1"),
      [out("bowled", "A1", { nb: "A3" }), "0/1 (0.1) s=A3 ns=A2"],
      [out("bowled", "A3", { nb: "A1" }), "!That batter has already batted."],
      [out("bowled", "A3"), "0/2 (0.2) s=A2 ns=-"],
      [b(1), "1/2 (0.3) s=A2 ns=-"],
      [b(0, { swap: true }), "!That ball isn't valid. Update the app and try again."],
      b(0), b(0),
      [b(0), "1/2 (1) s=A2 ns=- b=- lb=B1"],
      [out("bowled", "A2", { bw: "B2" }), "1/3 (1.1) st=inningsBreak end=allOut"],
      start("B1", "B2", "A1"),
      [b(2), "2/0 (0.1) tgt=2 st=ended end=target"],
    ],
    outcome: "won by 3 wickets (11 balls left)",
  },
  {
    name: "shortXI",
    config: cfg({ overs: 2, pps: 11, a: 3, b: 3 }),
    steps: [
      start("A1", "A2", "B1"),
      [out("bowled", "A1", { nb: "A4" }), "!That batter isn't in the batting side."],
      out("bowled", "A1", { nb: "A3" }),
      [out("retiredHurt", "A3"), "0/1 (0.1) st=inningsBreak end=allOut"],
      [UNDO, "0/1 (0.1) st=inProgress s=A3 ns=A2"],
      [out("retiredHurt", "A3"), "0/1 (0.1) st=inningsBreak end=allOut"],
      start("B1", "B2", "A1"),
      [wd(), "1/0 (0) tgt=1 st=ended end=target"],
    ],
    card: ["1 bat A3 0(0) 4s=0 6s=0 retiredHurt"],
    outcome: "won by 1 wicket (12 balls left)",
  },
  {
    // Hands-on test: 6 a side, 3 overs, XIs of 3. Innings 1 ended by the scorer, innings 2 chased.
    name: "manualEndSmallXI",
    config: cfg({ overs: 3, pps: 6, a: 3, b: 3 }),
    steps: [
      start("A1", "A2", "B1"),
      b(4), b(1), b(2), b(1), b(0), b(4),
      [b(0, { bw: "B2" }), "12/0 (1.1) s=A2 ns=A1 b=B2"],
      [end("Time"), "12/0 (1.1) st=inningsBreak end=manual"],
      start("B1", "B2", "A1"),
      b(6), b(4),
      [b(6), "16/0 (0.3) tgt=13 st=ended end=target"],
    ],
    card: ["1 total TA 12/0 (1.1) end=manual"],
    outcome: "won by 2 wickets (15 balls left)",
  },
  {
    // The smaller XI (3) sets all out for the bigger side too: 2 wickets end Aces' innings.
    name: "unevenXI",
    config: cfg({ overs: 3, pps: 6, a: 6, b: 3 }),
    steps: [
      start("A1", "A2", "B1"),
      out("bowled", "A1", { nb: "A3" }),
      [out("bowled", "A3"), "0/2 (0.2) st=inningsBreak end=allOut"],
      start("B1", "B2", "A1"),
      [b(1), "1/0 (0.1) tgt=1 st=ended end=target"],
    ],
    card: ["1 total TA 0/2 (0.2) end=allOut"],
    outcome: "won by 2 wickets (17 balls left)",
  },
  {
    // The chase ended by the scorer: the side batting first wins on runs.
    name: "manualEndChase",
    config: cfg({ overs: 2, pps: 6, a: 3, b: 3, lms: true }),
    steps: [
      start("A1", "A2", "B1"),
      b(4), b(4),
      [end("Rain"), "8/0 (0.2) st=inningsBreak end=manual"],
      start("B1", "B2", "A1"),
      b(1),
      [end("Rain"), "1/0 (0.1) tgt=9 st=ended end=manual"],
    ],
    outcome: "won by 7 runs",
  },
  {
    name: "tie",
    config: cfg({ overs: 1, pps: 11 }),
    steps: [
      start("A1", "A2", "B1"),
      ...Array.from({ length: 6 }, () => b(1)),
      start("B1", "B2", "A1"),
      ...Array.from({ length: 5 }, () => b(1)),
      [b(1), "6/0 (1) tgt=7 st=ended end=overs"],
    ],
    superOver: "TB",
    outcome: "won the super over",
  },
];

for (const sc of scenarios) run(sc);

// ─── Unit checks ────────────────────────────────────────

check("code: dot", ballCode({ runs: 0 }) === ".");
check("code: wide + 2", ballCode({ runs: 0, extras: { type: "wide", runs: 2 } }) === "3wd");
check("code: no-ball 4", ballCode({ runs: 4, extras: { type: "noBall", runs: 0 } }) === "4nb");
check("code: run out on a bye", ballCode({ runs: 0, extras: { type: "bye", runs: 1 }, wicket: { type: "runOut", batterKey: "A1" } }) === "1bW");
check("code: retired hurt", ballCode({ runs: 0, wicket: { type: "retiredHurt", batterKey: "A1" } }) === "RH");

{
  const c = cfg({ overs: 2, pps: 11 });
  let s = applyEvent(initialState(c), start("A1", "A2", "B1"));
  for (let i = 0; i < 5; i++) s = applyEvent(s, b(0));
  const pos = (e: BallEvent) => ballPosition(s, e);
  check("position: 6th legal ball", JSON.stringify(pos(b(0))) === JSON.stringify({ innings: 1, over: 0, ballInOver: 6, legal: true }));
  check("position: wide", JSON.stringify(pos(wd())) === JSON.stringify({ innings: 1, over: 0, ballInOver: 5, legal: false }));
  s = applyEvent(s, b(0));
  check("position: first ball of over 2", pos(b(0, { bw: "B2" })).over === 1 && pos(b(0, { bw: "B2" })).ballInOver === 1);
  check("summary: thisOver kept after over end", liveSummary(s).thisOver.length === 6 && liveSummary(s).current.bowlerKey === null);
  const u = undoLastBall([start("A1", "A2", "B1"), { ...b(0), id: "x1" }, revise(5, 1), end("r")]);
  check("undo keeps revised target, drops end", u.ballId === "x1" && u.events.length === 2 && u.events[1].type === "revisedTarget");
}
{
  // Bowler limit from the rules setting, and ceil(overs / 5) with revised overs.
  const c = cfg({ overs: 10, pps: 11, maxOvers: 1 });
  let s = applyEvent(initialState(c), start("A1", "A2", "B1"));
  for (let i = 0; i < 6; i++) s = applyEvent(s, b(0));
  for (let i = 0; i < 6; i++) s = applyEvent(s, b(0, i === 0 ? { bw: "B2" } : {}));
  let msg = "";
  try { applyEvent(s, b(0, { bw: "B1" })); } catch (e) { msg = (e as Error).message; }
  check("explicit maxOversPerBowler 1", msg === "That bowler has no overs left.", msg);
  const d = cfg({ overs: 10, pps: 11 });
  let t = applyEvent(initialState(d), start("A1", "A2", "B1"));
  for (let o = 0; o < 4; o++) for (let i = 0; i < 6; i++) t = applyEvent(t, b(0, i === 0 && o > 0 ? { bw: o % 2 ? "B2" : "B1" } : {}));
  try { msg = ""; applyEvent(t, b(0, { bw: "B1" })); } catch (e) { msg = (e as Error).message; }
  check("ceil(10/5)=2 overs per bowler", msg === "That bowler has no overs left.", msg);
}

{
  // Per-ball writes of `live` skip the standings rebuild (triggers/onMatchWritten.ts).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { onlyLiveChanged } = require("../triggers/onMatchWritten") as typeof import("../triggers/onMatchWritten");
  const base = { tournamentId: "T", teamAId: "A", teamBId: "B", statusRaw: "scheduled" } as never;
  check("trigger: live-only write skipped", onlyLiveChanged({ ...(base as object), live: { seq: 1 } } as never,
    { ...(base as object), live: { seq: 2 }, lineups: {} } as never));
  check("trigger: score write rebuilds", !onlyLiveChanged({ ...(base as object), live: { seq: 1 } } as never,
    { ...(base as object), statusRaw: "finished", live: { seq: 1 } } as never));
}

{
  // Effective XI: the smaller lineup / roster, capped by the rules.
  check("effectiveRules: smaller XI", effectiveRules(cfg({ overs: 3, pps: 6, a: 3, b: 4 })).playersPerSide === 3);
  check("effectiveRules: XI bigger than the rules", effectiveRules(cfg({ overs: 3, pps: 4, a: 6, b: 5 })).playersPerSide === 4);
  // Manual "Enter Result" is unchanged: an unfinished first innings is still refused without the live flag.
  const r: CricketRules = { eventTypeId: "custom", playersPerSide: 6, overs: 3, ballsPerOver: 6, lastManStands: false, superOver: true };
  const res = { innings: [{ battingRegistrationId: "TA", runs: 12, wickets: 0, balls: 7 }, { battingRegistrationId: "TB", runs: 16, wickets: 0, balls: 3 }] };
  const manual = validateCricketResult(res, r, "TA", "TB");
  check("manual result: unfinished innings refused", manual[0]?.message ===
    "The first innings isn't finished. It ends when 5 wickets fall or 3 overs are bowled.", JSON.stringify(manual));
  check("live result: innings ended by the scorer accepted", validateCricketResult(res, r, "TA", "TB", { endedEarly: [true, false] }).length === 0);
}

// ─── Fixture ────────────────────────────────────────────

const fixturePath = join(__dirname, "..", "..", "test-fixtures", "cricket-live-fixture.txt");
const actual = fixture.join("\n") + "\n";
if (process.argv.includes("--write")) {
  writeFileSync(fixturePath, actual);
  console.log(`Wrote cricket-live-fixture.txt (${fixture.length} lines)`);
} else {
  let expected = "";
  try { expected = readFileSync(fixturePath, "utf8"); } catch { /* missing */ }
  if (expected !== actual) {
    const e = expected.split("\n");
    const a = actual.split("\n");
    const i = a.findIndex((l, j) => l !== e[j]);
    check("parity fixture", false, `first difference at line ${i + 1}:\n  fixture: ${e[i]}\n  actual:  ${a[i]}\n(run with --write after an intended change)`);
  } else {
    check("parity fixture", true);
    console.log(`PASS  parity: identical to cricket-live-fixture.txt (${fixture.length} lines)`);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
