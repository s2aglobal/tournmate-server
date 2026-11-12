/**
 * Dependency-free checks for services/racketLive.ts (racket live point-by-point
 * scoring, badminton first) plus the RLIVE parity fixture the iOS and Android
 * ports replay.
 *
 * Usage (from tournmate-server/functions):
 *   npm run check:racket-live             # check, compare with the fixture
 *   npm run check:racket-live -- --write  # regenerate the fixture after an intended change
 *
 * Fixture: test-fixtures/racket-live-fixture.txt (format in
 * racket-live-contract.md → "Parity fixture"). Each scenario lists its config
 * and events as JSON, the state line after every event / undo (or the refusal
 * reason + message), and at the end the `live` summary and, for a decided
 * match, the result handed to the manual score path.
 *
 * Exits non-zero if any case fails.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ScoringConfig, resolveScoring, validateMatchScores, validateSimpleScore } from "../services/scoring";
import {
  RacketConfig, RacketEvent, RacketRuleError, RacketState, applyRacketEvent, formatRacketStateLine, initialRacketState,
  playable, racketConfig, racketFormat, racketLiveSummary, racketSortedJson, replayRacket, toRacketResult, undoLastPoint,
  BAD_POINT, MATCH_OVER, NOTHING_TO_UNDO,
} from "../services/racketLive";

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

function cfg(o: { games?: number; to?: number; winBy?: number; cap?: number | null; format?: "sets" | "simple"; first?: "A" | "B" }): RacketConfig {
  return {
    sport: "badminton",
    format: o.format ?? "sets",
    scoring: { gamesPerMatch: o.games ?? 3, pointsToWin: o.to ?? 21, winBy: o.winBy ?? 2, pointCap: o.cap === undefined ? 30 : o.cap },
    firstServer: o.first ?? "A",
  };
}

let pointNo = 0;
let serverNo = 0;
const pt = (winner: "A" | "B"): RacketEvent => ({ type: "point", id: `p${++pointNo}`, winner });
const srv = (side: "A" | "B"): RacketEvent => ({ type: "setServer", id: `s${++serverNo}`, side });
/** "AAB" → three point events. */
const pts = (seq: string): RacketEvent[] => [...seq].map((c) => pt(c as "A" | "B"));
/** Alternating points from 0-0 to n-n (A first). */
const level = (n: number): RacketEvent[] => pts("AB".repeat(n));
/** Points for a straight score from 0-0: winner's points first is fine for scripted games. */
const game = (a: number, b: number): RacketEvent[] => {
  const out: RacketEvent[] = [];
  const lo = Math.min(a, b);
  out.push(...level(lo));
  const lead = a > b ? "A" : "B";
  out.push(...pts(lead.repeat(Math.max(a, b) - lo)));
  return out;
};

type Step = RacketEvent | "undo";

// ─── Fixture ────────────────────────────────────────────

const fixture: string[] = [];

function scenario(name: string, config: RacketConfig, steps: Step[], expectFinal?: string): RacketState {
  const line = (s: string) => fixture.push(`RLIVE ${name} ${s}`);
  line(`config ${racketSortedJson(config)}`);
  let events: RacketEvent[] = [];
  let s = initialRacketState(config);
  for (const step of steps) {
    if (step === "undo") {
      line("undo");
      try {
        events = undoLastPoint(events).events;
        s = replayRacket(config, events);
        line(`=> ${formatRacketStateLine(s)}`);
      } catch (e) {
        if (!(e instanceof RacketRuleError)) throw e;
        line(`!! ${e.reason} ${e.message}`);
      }
      continue;
    }
    line(`event ${racketSortedJson(step)}`);
    try {
      s = applyRacketEvent(s, step);
      events = [...events, step];
      line(`=> ${formatRacketStateLine(s)}`);
    } catch (e) {
      if (!(e instanceof RacketRuleError)) throw e;
      line(`!! ${e.reason} ${e.message}`);
    }
  }
  // Replaying the effective log gives the same state (what the server does per call).
  check(`${name}: replay == incremental`, formatRacketStateLine(replayRacket(config, events)) === formatRacketStateLine(s));
  line(`live ${racketSortedJson(racketLiveSummary(s))}`);
  if (s.status === "ended") {
    const r = toRacketResult(s);
    line(`result ${racketSortedJson(r)}`);
    const sc: ScoringConfig = { ...config.scoring, scoringSystem: "rally" };
    const issues = r.kind === "sets"
      ? validateMatchScores(r.sets, sc, true, "badminton")
      : validateSimpleScore(r.scoreA, r.scoreB, sc, true, "badminton");
    check(`${name}: result passes validation`, issues.length === 0, JSON.stringify(issues));
  }
  if (expectFinal !== undefined) check(`${name}: final state`, formatRacketStateLine(s) === expectFinal, formatRacketStateLine(s));
  return s;
}

// Best of 3 to 21, straight games: 21-19, 21-15; a point after the end is refused.
scenario("straight21", cfg({}), [
  ...game(21, 19), ...game(21, 15), pt("B"), srv("B"),
], "st=ended games=[21-19,21-15] cur=0-0 won=2-0 srv=AR sw=0 game=2");

// Deuce to 22-20, then 10-21, then a deciding game with the switch at 11 (B serves first in game 3).
scenario("deuceDecider", cfg({}), [
  ...level(20), ...pts("AA"),
  ...game(10, 21),
  ...level(10), ...pts("B"), ...pts("A"), ...pts("AAAAAAAAAB"), pt("A"), pt("B"),
]);

// Cap: best of 1 bracket game, 29-29 then 30-29.
scenario("cap30", cfg({ games: 1 }), [...level(29), pt("A")], "st=ended games=[30-29] cur=0-0 won=1-0 srv=AR sw=0 game=1");

// 15-point games (cap 21), best of 3: 15-13, then 20-20 → 21-20 at the cap.
scenario("to15", cfg({ to: 15, cap: 21 }), [...game(15, 13), ...level(20), pt("A")]);

// 11-point games (cap 15), best of 5: A, B, A, B, then a decider to the cap 15-14 for B (switch at 6).
scenario("to11bo5", cfg({ games: 5, to: 11, cap: 15 }), [
  ...game(11, 7), ...game(4, 11), ...game(12, 10), ...game(9, 11), ...level(14), pt("B"),
], "st=ended games=[11-7,4-11,12-10,9-11,14-15] cur=0-0 won=2-3 srv=BR sw=0 game=5");

// Round robin: one game ("simple"), the switch at 11 in that (deciding) game; B serves first.
scenario("roundRobin", racketConfig("badminton", resolveScoring(undefined, "badminton").config, "roundRobin", "B"), [
  ...pts("BBBBBBBBBB"), ...pts("AAAAAAAAAAA"), ...pts("B"), ...pts("BBBBBBBBBB"),
]);

// Undo across a game boundary (unlimited), then play on.
scenario("undoBoundary", cfg({}), [
  ...game(21, 5), "undo", "undo", pt("B"), pt("A"), pt("A"), pt("A"), pt("B"), "undo", "undo", "undo",
]);

// Undo after the match ended reopens it.
scenario("undoAfterEnd", cfg({ format: "simple", games: 1, to: 11, cap: 15 }), [
  ...game(11, 3), pt("A"), "undo", pt("B"), pt("A"),
], "st=ended games=[11-4] cur=0-0 won=1-0 srv=AR sw=0 game=1");

// Fix server: never changes the score; undo also drops a fix recorded after the undone point.
scenario("setServer", cfg({ first: "B" }), [
  "undo", srv("A"), "undo", pt("A"), pt("A"), pt("B"), srv("A"), srv("A"), pt("A"), "undo", "undo",
  { type: "point", id: "bad1", winner: "C" } as unknown as RacketEvent,
  { type: "serve", id: "bad2", side: "A" } as unknown as RacketEvent,
]);

// Win by 1 with the cap at the target (legal config): 21-20 ends the game.
scenario("winBy1", cfg({ games: 1, winBy: 1, cap: 21 }), [...level(20), pt("B")],
  "st=ended games=[20-21] cur=0-0 won=0-1 srv=BR sw=0 game=1");

// ─── Unit checks ────────────────────────────────────────

{
  const s0 = initialRacketState(cfg({ first: "B" }));
  check("initial: first server, court R", formatRacketStateLine(s0) === "st=inProgress games=[] cur=0-0 won=0-0 srv=BR sw=0 game=1");
  let s = applyRacketEvent(s0, pt("A"));
  check("rally: winner serves, odd → L", s.server.side === "A" && s.server.court === "L");
  s = applyRacketEvent(s, pt("A"));
  check("even → R", s.server.court === "R");
  s = applyRacketEvent(s, pt("B"));
  check("server's own score decides the court", s.server.side === "B" && s.server.court === "L");
  const fixed = applyRacketEvent(s, srv("A"));
  check("setServer keeps the score", fixed.current.a === 2 && fixed.current.b === 1 && fixed.server.side === "A" && fixed.server.court === "R");
  let msg = "";
  try { applyRacketEvent(s, { type: "point", id: "", winner: "A" }); } catch (e) { msg = (e as Error).message; }
  check("empty id refused", msg === BAD_POINT, msg);
  try { msg = ""; undoLastPoint([srv("A")]); } catch (e) { msg = (e as Error).message; }
  check("undo with no point", msg === NOTHING_TO_UNDO, msg);
  const u = undoLastPoint([pt("A"), srv("B"), pt("B"), srv("A")]);
  check("undo drops the point and later fixes", u.events.length === 2 && u.events[1].type === "setServer");
  const ended = replayRacket(cfg({ games: 1, to: 11, cap: 15 }), game(11, 0));
  let err: RacketRuleError | null = null;
  try { applyRacketEvent(ended, pt("A")); } catch (e) { err = e as RacketRuleError; }
  check("point after end: precondition", err?.message === MATCH_OVER && err.precondition === true && err.reason === "INVALID_POINT");
  try { err = null; toRacketResult(initialRacketState(cfg({}))); } catch (e) { err = e as RacketRuleError; }
  check("no result before the end", err?.message === "The match isn't over yet.");
}
{
  check("format: bracket = sets", racketFormat("singleElimination") === "sets" && racketFormat("doubleElimination") === "sets");
  check("format: others = simple", ["roundRobin", "groupKnockout", "swiss", "manualDraw", undefined, "x"].every((f) => racketFormat(f) === "simple"));
  const legacy = racketConfig("badminton", resolveScoring(undefined, "badminton").config, "singleElimination", "A");
  check("legacy tournament: badminton defaults", racketSortedJson(legacy.scoring) === '{"gamesPerMatch":3,"pointCap":30,"pointsToWin":21,"winBy":2}');
  const rr = racketConfig("badminton", resolveScoring('{"gamesPerMatch":3,"pointsToWin":15,"winBy":2,"pointCap":21}', "badminton").config, "groupKnockout", "A");
  check("simple format freezes 1 game", rr.scoring.gamesPerMatch === 1 && rr.scoring.pointsToWin === 15 && rr.format === "simple");
  const base = { gamesPerMatch: 3, pointsToWin: 21, winBy: 2, pointCap: 30 as number | null };
  check("playable: defaults", playable(base));
  check("playable: no cap", playable({ ...base, pointCap: null }));
  check("not playable: even games", !playable({ ...base, gamesPerMatch: 2 }));
  check("not playable: no target", !playable({ ...base, pointsToWin: 0 }));
  check("not playable: cap below target", !playable({ ...base, pointCap: 20 }));
  check("not playable: cap = target, win by 2", !playable({ ...base, pointCap: 21 }));
  check("playable: cap = target, win by 1", playable({ ...base, pointCap: 21, winBy: 1 }));
}
{
  // Property: random rallies under several configs always end in a result validation accepts.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const configs = [cfg({}), cfg({ to: 15, cap: 21 }), cfg({ to: 11, cap: 15, games: 5 }), cfg({ cap: null }),
    cfg({ format: "simple", games: 1 }), cfg({ games: 1, winBy: 1, cap: 21 }), cfg({ games: 7, to: 5, cap: 7 })];
  let bad = 0;
  for (const c of configs) {
    for (let run = 0; run < 300; run++) {
      let s = initialRacketState(c);
      let n = 0;
      while (s.status !== "ended" && n < 5000) { s = applyRacketEvent(s, { type: "point", id: `r${n++}`, winner: rnd() < 0.5 ? "A" : "B" }); }
      const r = toRacketResult(s);
      const sc: ScoringConfig = { ...c.scoring, scoringSystem: "rally" };
      const issues = r.kind === "sets" ? validateMatchScores(r.sets, sc, true, "badminton") : validateSimpleScore(r.scoreA, r.scoreB, sc, true, "badminton");
      if (issues.length > 0) bad++;
    }
  }
  check("random matches always validate (2100 runs)", bad === 0, `${bad} invalid`);
}
{
  // Per-point writes of `live` skip the standings rebuild (triggers/onMatchWritten.ts).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { onlyLiveChanged } = require("../triggers/onMatchWritten") as typeof import("../triggers/onMatchWritten");
  const base = { tournamentId: "T", teamAId: "A", teamBId: "B", statusRaw: "scheduled" } as never;
  const live = (seq: number) => ({ kind: "racket", status: "inProgress", seq, current: { a: seq, b: 0 } });
  check("trigger: racket live-only write skipped", onlyLiveChanged({ ...(base as object), live: live(1) } as never,
    { ...(base as object), live: live(2) } as never));
  check("trigger: finish write rebuilds", !onlyLiveChanged({ ...(base as object), live: live(1) } as never,
    { ...(base as object), statusRaw: "finished", live: { ...live(1), status: "finished" } } as never));
}

// ─── Fixture compare ────────────────────────────────────

const fixturePath = join(__dirname, "..", "..", "test-fixtures", "racket-live-fixture.txt");
const actual = fixture.join("\n") + "\n";
if (process.argv.includes("--write")) {
  writeFileSync(fixturePath, actual);
  console.log(`Wrote racket-live-fixture.txt (${fixture.length} lines)`);
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
    console.log(`PASS  parity: identical to racket-live-fixture.txt (${fixture.length} lines)`);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
