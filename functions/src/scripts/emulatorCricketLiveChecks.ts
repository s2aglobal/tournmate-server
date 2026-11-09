/**
 * Emulator checks for the cricket live scoring callables
 * (callables/cricketLive.ts): lineups, scorer rights and takeover, toss,
 * innings, balls (idempotent ids), undo, revised target, end innings,
 * finish (captain → other side confirms; organizer → final, identical to a
 * manual submitScore), abandon, stop live scoring, and the manual-score lock.
 * Runs the handlers directly (`.run`) against the Firestore emulator.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-cricket-live
 * which runs, under `firebase emulators:exec --only firestore --project demo-tournmate`:
 *   node lib/scripts/emulatorCricketLiveChecks.js
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp, Firestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore emulator and a demo-* project (use npm run test:emulator-cricket-live).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });

/* eslint-disable @typescript-eslint/no-var-requires */
const live = require("../callables/cricketLive") as typeof import("../callables/cricketLive");
const scores = require("../callables/scores") as typeof import("../callables/scores");

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) passes++; else failures++;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = { run: (req: any) => any };
async function call<T>(fn: Fn, uid: string | null, data: unknown): Promise<T> {
  return await fn.run({ data, auth: uid ? { uid, token: {} } : undefined, rawRequest: {}, acceptsStreaming: false });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(name: string, fn: Fn, uid: string | null, data: unknown): Promise<T | null> {
  try {
    const r = await call<T>(fn, uid, data);
    check(name, true, JSON.stringify(r));
    return r;
  } catch (e) {
    const err = e as { message?: string; details?: { reason?: string } };
    check(name, false, `threw ${err.details?.reason ?? ""} ${err.message}`);
    return null;
  }
}
async function expectFail(name: string, fn: Fn, uid: string | null, data: unknown, reason: string, message?: string): Promise<void> {
  try {
    const r = await call(fn, uid, data);
    check(name, false, `expected ${reason}, got ${JSON.stringify(r)}`);
  } catch (e) {
    const err = e as { message?: string; details?: { reason?: string } };
    check(name, err.details?.reason === reason && (message === undefined || err.message === message),
      `${err.details?.reason}: ${err.message}`);
  }
}

const P = {
  org: { id: "CCCCCCCC-0000-0000-0000-000000000000", uid: "u-org", name: "Olga" },
  a1: { id: "CCCCCCCC-0000-0000-0000-0000000000A1", uid: "ua1", name: "Arun" },
  a2: { id: "CCCCCCCC-0000-0000-0000-0000000000A2", uid: "ua2", name: "Asha" },
  a3: { id: "CCCCCCCC-0000-0000-0000-0000000000A3", uid: "ua3", name: "Ajay" },
  b1: { id: "CCCCCCCC-0000-0000-0000-0000000000B1", uid: "ub1", name: "Bala" },
  b2: { id: "CCCCCCCC-0000-0000-0000-0000000000B2", uid: "ub2", name: "Bina" },
  b3: { id: "CCCCCCCC-0000-0000-0000-0000000000B3", uid: "ub3", name: "Bob" },
  x: { id: "CCCCCCCC-0000-0000-0000-0000000000FF", uid: "ux", name: "Xavi" },
};
const T = "T-LIVE";
const RA = "R-ACES";
const RB = "R-BULLS";
// Box cricket: 4 a side (3 wickets), 1 over.
const RULES = JSON.stringify({ eventTypeId: "custom", playersPerSide: 4, overs: 1, ballsPerOver: 6, lastManStands: false, superOver: true });

async function clear(db: Firestore): Promise<void> {
  for (const c of ["players", "tournaments", "registrations", "matches", "notifications", "ratings"]) {
    const snap = await db.collection(c).get();
    for (const d of snap.docs) await db.recursiveDelete(d.ref);
  }
}

async function seed(db: Firestore): Promise<void> {
  for (const p of Object.values(P)) {
    await db.collection("players").doc(p.id).set({
      name: p.name, phone: "", email: `${p.uid}@example.test`, genderRaw: "male", elo: 1200, streak: 0,
      firebaseUid: p.uid, avatarId: "a1", createdAt: Timestamp.now(),
    });
  }
  await db.collection("tournaments").doc(T).set({
    title: "Live Cup", date: Timestamp.now(), statusRaw: "scheduled", sportType: "cricket", formatRaw: "team",
    matchFormatRaw: "roundRobin", createdBy: P.org.uid, rulesData: RULES, location: "Ground", createdAt: Timestamp.now(),
    drawMade: true,
  });
  await db.collection("registrations").doc(RA).set({
    tournamentId: T, playerId: P.a1.id, teamName: "Aces", rosterIds: [P.a1.id, P.a2.id, P.a3.id], guestNames: ["Ali"],
    captainId: P.a1.id, createdAt: Timestamp.now(),
  });
  await db.collection("registrations").doc(RB).set({
    tournamentId: T, playerId: P.b1.id, teamName: "Bulls", rosterIds: [P.b1.id, P.b2.id, P.b3.id], guestNames: ["Gus"],
    captainId: P.b1.id, viceCaptainId: P.b2.id, createdAt: Timestamp.now(),
  });
}

async function newMatch(db: Firestore, id: string): Promise<void> {
  await db.collection("matches").doc(id).set({
    tournamentId: T, teamAId: RA, teamBId: RB, round: 1, statusRaw: "scheduled", sportType: "cricket",
    teamAUids: [P.a1.uid, P.a2.uid, P.a3.uid], teamBUids: [P.b1.uid, P.b2.uid, P.b3.uid], createdAt: Timestamp.now(),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function m(db: Firestore, id: string): Promise<any> {
  return (await db.collection("matches").doc(id).get()).data();
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function logDoc(db: Firestore, id: string): Promise<any> {
  return (await db.collection("matches").doc(id).collection("cricketLive").doc("state").get()).data();
}

const A1 = P.a1.id;
const A2 = P.a2.id;
const A3 = P.a3.id;
const B1 = P.b1.id;
const B2 = P.b2.id;
const B3 = P.b3.id;

async function captainFlow(db: Firestore): Promise<void> {
  console.log("\n── Captain scores: lineup, takeover, balls, undo, finish → confirm ──");
  const M = "M-CAP";
  await newMatch(db, M);
  const { setLineup, startScoring, setToss, startInnings, recordBall, undoBall, finishLiveMatch } = live;

  await expectFail("lineup: outsider", setLineup, P.x.uid, { matchId: M, teamId: RA, xi: [A1, A2], order: [A1, A2] }, "NOT_PARTICIPANT");
  await expectFail("lineup: plain player", setLineup, P.a2.uid, { matchId: M, teamId: RA, xi: [A1, A2], order: [A1, A2] }, "NOT_PARTICIPANT");
  await expectFail("lineup: other team's player", setLineup, P.a1.uid, { matchId: M, teamId: RA, xi: [A1, B1], order: [A1, B1] },
    "INVALID_ARGUMENT", "Pick players from the team sheet.");
  await expectFail("lineup: one player", setLineup, P.a1.uid, { matchId: M, teamId: RA, xi: [A1], order: [A1] },
    "INVALID_ARGUMENT", "Pick at least 2 players.");
  await expectFail("lineup: twice", setLineup, P.a1.uid, { matchId: M, teamId: RA, xi: [A1, A1.toLowerCase()], order: [A1, A1] },
    "INVALID_ARGUMENT", "Each player can be picked once.");
  await expectFail("lineup: order mismatch", setLineup, P.a1.uid, { matchId: M, teamId: RA, xi: [A1, A2, A3], order: [A1, A2] },
    "INVALID_ARGUMENT", "The batting order must list the same players as the XI.");
  await ok("lineup: captain sets XI + order (lower-case ids, guest)", setLineup, P.a1.uid,
    { matchId: M, teamId: RA.toLowerCase(), xi: [A1, A2, A3, "guest:Ali"], order: [A2.toLowerCase(), A1, "guest:Ali", A3] });
  await ok("lineup: vice-captain sets Bulls", setLineup, P.b2.uid, { matchId: M, teamId: RB, xi: [B1, B2, B3], order: [B1, B2, B3] });
  const lu = (await m(db, M)).lineups;
  check("lineups stored", JSON.stringify(lu?.[RA]?.order) === JSON.stringify([A2, A1, "guest:Ali", A3]) && lu?.[RA]?.setBy === P.a1.uid &&
    lu?.[RB]?.xi?.length === 3, JSON.stringify(lu));

  await expectFail("start: outsider", startScoring, P.x.uid, { matchId: M, battingFirstTeamId: RA }, "NOT_SCORER");
  await expectFail("start: plain player", startScoring, P.a2.uid, { matchId: M, battingFirstTeamId: RA }, "NOT_SCORER");
  await expectFail("start: who bats first", startScoring, P.a1.uid, { matchId: M }, "INVALID_ARGUMENT", "Choose who bats first.");
  await expectFail("start: toss disagrees", startScoring, P.a1.uid,
    { matchId: M, battingFirstTeamId: RB, toss: { winnerTeamId: RB, elected: "bowl" } }, "INVALID_ARGUMENT");
  await ok("start: captain with toss (Bulls win, bowl)", startScoring, P.a1.uid, { matchId: M, toss: { winnerTeamId: RB, elected: "bowl" } });
  let lv = (await m(db, M)).live;
  check("live setup", lv?.status === "setup" && lv?.scorerUid === P.a1.uid && lv?.scorerName === "Arun" && lv?.battingFirstTeamId === RA &&
    lv?.toss?.winnerTeamId === RB && lv?.inningsIndex === 0, JSON.stringify(lv));
  await ok("start again by the scorer = resume", startScoring, P.a1.uid, { matchId: M });
  await expectFail("start: other captain", startScoring, P.b1.uid, { matchId: M }, "SCORER_ACTIVE", "Arun is scoring this match.");
  await expectFail("takeover: captain within 10 minutes", startScoring, P.b1.uid, { matchId: M, takeover: true }, "SCORER_ACTIVE",
    "Arun is scoring this match. You can take over if no ball is recorded for 10 minutes.");
  await ok("takeover: organizer any time", startScoring, P.org.uid, { matchId: M, takeover: true });
  check("organizer is scorer", (await m(db, M)).live?.scorerUid === P.org.uid);
  await expectFail("old scorer can't record", recordBall, P.a1.uid, { matchId: M, ballId: "x", runs: 1 }, "NOT_SCORER");
  await db.collection("matches").doc(M).update({ "live.scorerSince": Timestamp.fromMillis(Date.now() - 11 * 60_000) });
  await ok("takeover: captain after 10 idle minutes", startScoring, P.a1.uid, { matchId: M, takeover: true });

  await expectFail("manual score locked (captain)", scores.submitScore, P.b1.uid, { matchId: M, cricket: { resultData: { innings: [] } } },
    "SCORER_ACTIVE", "This match is being scored live.");
  await expectFail("manual score locked (organizer)", scores.submitScore, P.org.uid, { matchId: M, cricket: { resultData: { innings: [] } } },
    "SCORER_ACTIVE", "This match is being scored live. Stop live scoring first.");

  await expectFail("toss: not scorer", setToss, P.b1.uid, { matchId: M, winnerTeamId: RA, elected: "bat" }, "NOT_SCORER");
  await ok("toss: scorer changes it (Aces bat)", setToss, P.a1.uid, { matchId: M, winnerTeamId: RA, elected: "bat" });
  check("bats first from toss", (await m(db, M)).live?.battingFirstTeamId === RA);

  await expectFail("ball before innings", recordBall, P.a1.uid, { matchId: M, ballId: "early", runs: 1 }, "INNINGS_OVER", "Start the innings first.");
  await expectFail("innings: bowler from batting side", startInnings, P.a1.uid, { matchId: M, strikerKey: A2, nonStrikerKey: A1, bowlerKey: A3 },
    "INVALID_BALL", "That bowler isn't in the fielding side.");
  await ok("innings 1", startInnings, P.a1.uid, { matchId: M, strikerKey: A2.toLowerCase(), nonStrikerKey: A1, bowlerKey: B1 });
  await ok("innings 1 retried = no-op", startInnings, P.a1.uid, { matchId: M, strikerKey: A2, nonStrikerKey: A1, bowlerKey: B1 });
  let lg = await logDoc(db, M);
  check("config frozen from lineups + names", lg?.events?.length === 1 && lg?.config?.teams?.[0]?.players?.[0]?.key === A2 &&
    lg?.config?.teams?.[0]?.players?.[0]?.name === "Asha" && lg?.config?.teams?.[0]?.players?.[2]?.name === "Ali" &&
    lg?.config?.rules?.playersPerSide === 4 && lg?.config?.maxOversPerBowler === null, JSON.stringify(lg?.config?.teams?.[0]));
  await expectFail("lineup locked", setLineup, P.a1.uid, { matchId: M, teamId: RA, xi: [A1, A2], order: [A1, A2] }, "LINEUP_LOCKED");

  await ok("ball u1: four", recordBall, P.a1.uid, { matchId: M, ballId: "u1", runs: 4 });
  const dup = await ok<{ duplicate: boolean }>("ball u1 again", recordBall, P.a1.uid, { matchId: M, ballId: "u1", runs: 4 });
  check("retry is a no-op", dup?.duplicate === true && (await m(db, M)).live?.innings?.[0]?.runs === 4);
  const u1 = (await db.collection("matches").doc(M).collection("balls").doc("u1").get()).data();
  check("ball doc", u1?.innings === 1 && u1?.seq === 1 && u1?.over === 0 && u1?.ballInOver === 1 && u1?.legal === true &&
    u1?.runs === 4 && u1?.code === "4" && u1?.strikerKey === A2 && u1?.bowlerKey === B1 && u1?.by === P.a1.uid &&
    u1?.createdAt instanceof Timestamp, JSON.stringify(u1));
  await ok("ball u2: wide", recordBall, P.a1.uid, { matchId: M, ballId: "u2", runs: 0, extras: { type: "wide", runs: 0 } });
  await expectFail("wicket without next batter", recordBall, P.a1.uid,
    { matchId: M, ballId: "u3x", runs: 0, wicket: { type: "bowled", batterKey: A2 } }, "INVALID_BALL", "Pick the next batter.");
  await ok("ball u3: bowled, guest in", recordBall, P.a1.uid,
    { matchId: M, ballId: "u3", runs: 0, wicket: { type: "bowled", batterKey: A2.toLowerCase() }, nextBatterKey: "guest:Ali" });
  for (const [id, runs] of [["u4", 1], ["u5", 0], ["u6", 0], ["u7", 0]] as const) {
    await ok(`ball ${id}`, recordBall, P.a1.uid, { matchId: M, ballId: id, runs });
  }
  lv = (await m(db, M)).live;
  check("innings break after 1 over", lv?.status === "inningsBreak" && lv?.innings?.[0]?.runs === 6 && lv?.innings?.[0]?.wickets === 1 &&
    lv?.innings?.[0]?.legalBalls === 6 && lv?.innings?.[0]?.endReason === "overs" && lv?.seq === 7 &&
    JSON.stringify(lv?.thisOver) === JSON.stringify(["4", "wd", "W", "1", ".", ".", "."]) && lv?.lastBallAt instanceof Timestamp,
  JSON.stringify(lv));
  const undone = await ok<{ undoneBallId: string | null }>("undo u7", undoBall, P.a1.uid, { matchId: M, ballId: "u7" });
  check("undo reopens the innings", undone?.undoneBallId === "u7" && (await m(db, M)).live?.status === "inProgress" &&
    (await db.collection("matches").doc(M).collection("balls").doc("u7").get()).get("undone") === true);
  const again = await ok<{ undoneBallId: string | null }>("undo u7 retried", undoBall, P.a1.uid, { matchId: M, ballId: "u7" });
  check("undo retry is a no-op", again?.undoneBallId === null && (await logDoc(db, M))?.events?.length === 7);
  const u7 = await ok<{ duplicate: boolean }>("undone ball id resent", recordBall, P.a1.uid, { matchId: M, ballId: "u7", runs: 0 });
  check("undone id stays a no-op", u7?.duplicate === true);
  await ok("ball u8: two", recordBall, P.a1.uid, { matchId: M, ballId: "u8", runs: 2 });
  await expectFail("ball in the break", recordBall, P.a1.uid, { matchId: M, ballId: "u9", runs: 1 }, "INNINGS_OVER",
    "This innings is over. Start the next innings.");
  await expectFail("finish too early", finishLiveMatch, P.a1.uid, { matchId: M }, "INVALID_SCORE", "Finish both innings first.");

  await ok("innings 2", startInnings, P.a1.uid, { matchId: M, strikerKey: B1, nonStrikerKey: B2, bowlerKey: A1 });
  check("target 9", (await m(db, M)).live?.innings?.[1]?.target === 9);
  await ok("ball v1: six", recordBall, P.a1.uid, { matchId: M, ballId: "v1", runs: 6 });
  await expectFail("bowler change mid-over", recordBall, P.a1.uid, { matchId: M, ballId: "v2x", runs: 1, nextBowlerKey: A2 },
    "INVALID_BALL", "The bowler can't change in the middle of an over.");
  await ok("ball v2: four wins it", recordBall, P.a1.uid, { matchId: M, ballId: "v2", runs: 4 });
  check("ended", (await m(db, M)).live?.status === "ended");
  await expectFail("POTM off both sides", finishLiveMatch, P.a1.uid, { matchId: M, playerOfMatchKey: P.x.id }, "INVALID_ARGUMENT");
  await expectFail("finish: not scorer", finishLiveMatch, P.b1.uid, { matchId: M }, "NOT_SCORER");
  const fin = await ok<{ status: string }>("finish by captain", finishLiveMatch, P.a1.uid,
    { matchId: M, playerOfMatchKey: B1.toLowerCase() });
  const md = await m(db, M);
  check("captain finish waits for the other side", fin?.status === "scoreSubmitted" && md?.statusRaw === "scoreSubmitted" &&
    md?.submittedBy === P.a1.uid && md?.confirmedBy === undefined && md?.live?.status === "finished", JSON.stringify(md?.live));
  check("result written like the manual path", md?.resultData ===
    `{"innings":[{"balls":6,"battingRegistrationId":"${RA}","runs":8,"wickets":1},{"balls":2,"battingRegistrationId":"${RB}","runs":10,"wickets":0}]}` &&
    md?.resultType === "win" && md?.winnerRegistrationId === RB && md?.summary === "Bulls won by 3 wickets (4 balls left)" &&
    md?.scoreA === 8 && md?.scoreB === 10 && md?.playerOfMatchKey === B1 && md?.playerOfMatchName === "Bala" &&
    md?.playerOfMatchTeamId === RB, `${md?.resultData} ${md?.summary}`);
  const stats = JSON.parse(md?.playerStatsData ?? "{}");
  check("player stats from the balls", stats.batting?.length === 5 && stats.batting[0].key === A2 && stats.batting[0].runs === 4 &&
    stats.batting[0].balls === 2 && stats.batting[0].out === true && stats.batting[2].key === "guest:Ali" &&
    stats.bowling?.[0]?.key === B1 && stats.bowling[0].runs === 8 && stats.bowling[0].wickets === 1 && stats.bowling[0].balls === 6,
  md?.playerStatsData);
  await expectFail("scorer's own side can't confirm", scores.confirmScore, P.a2.uid, { matchId: M }, "NOT_PARTICIPANT");
  await ok("other side confirms", scores.confirmScore, P.b2.uid, { matchId: M });
  const done = await m(db, M);
  check("finished + rated", done?.statusRaw === "finished" && done?.confirmedBy === P.b2.uid && done?.eloApplied === true);
  await expectFail("start after finish", startScoring, P.org.uid, { matchId: M, battingFirstTeamId: RA }, "MATCH_FINISHED");
  await expectFail("ball after finish", recordBall, P.a1.uid, { matchId: M, ballId: "late", runs: 1 }, "MATCH_FINISHED");
}

async function organizerFlow(db: Firestore): Promise<void> {
  console.log("\n── Organizer scores: revised target, final result = manual submitScore ──");
  const M = "M-ORG";
  await newMatch(db, M);
  const { startScoring, startInnings, recordBall, setRevisedTarget, finishLiveMatch } = live;
  await ok("organizer starts (no lineups: rosters)", startScoring, P.org.uid, { matchId: M, battingFirstTeamId: RB });
  await ok("innings 1", startInnings, P.org.uid, { matchId: M, strikerKey: B3, nonStrikerKey: "guest:Gus", bowlerKey: A3 });
  await expectFail("revised target in innings 1", setRevisedTarget, P.org.uid, { matchId: M, runs: 5, overs: 1 }, "INVALID_ARGUMENT",
    "A revised target is set once the first innings is over.");
  const balls: Array<Record<string, unknown>> = [
    { runs: 1 }, { runs: 0, extras: { type: "noBall", runs: 0 } }, { runs: 2 }, { runs: 0, extras: { type: "legBye", runs: 1 } },
    { runs: 0, wicket: { type: "caught", batterKey: B3, fielderKey: A1 }, nextBatterKey: B1 }, { runs: 3 }, { runs: 0 },
  ];
  let n = 0;
  for (const b of balls) await ok(`org ball ${++n}`, recordBall, P.org.uid, { matchId: M, ballId: `o${n}`, ...b });
  check("innings 1 over", (await m(db, M)).live?.status === "inningsBreak");
  await ok("innings 2", startInnings, P.org.uid, { matchId: M, strikerKey: A1, nonStrikerKey: A2, bowlerKey: B2 });
  await ok("ball", recordBall, P.org.uid, { matchId: M, ballId: "o20", runs: 1 });
  await expectFail("revised overs too high", setRevisedTarget, P.org.uid, { matchId: M, runs: 5, overs: 2 }, "INVALID_ARGUMENT",
    "Revised overs must be between 1 and 1.");
  await ok("revised target 2 in 1 over", setRevisedTarget, P.org.uid, { matchId: M, runs: 2, overs: 1 });
  await ok("winning run", recordBall, P.org.uid, { matchId: M, ballId: "o21", runs: 1 });
  check("ended on revised target", (await m(db, M)).live?.innings?.[1]?.target === 2 && (await m(db, M)).live?.status === "ended");
  await ok("organizer finishes", finishLiveMatch, P.org.uid, { matchId: M, playerOfMatchKey: A1 });
  const md = await m(db, M);
  check("organizer result is final", md?.statusRaw === "finished" && md?.confirmedBy === P.org.uid && md?.eloApplied === true &&
    md?.summary === "Aces won by 3 wickets (4 balls left) (revised target)", md?.summary);

  // Same result through the manual path on a twin match: identical fields.
  await newMatch(db, "M-TWIN");
  await ok("manual submitScore of the same scorecard", scores.submitScore, P.org.uid, {
    matchId: "M-TWIN", cricket: { resultData: md.resultData, playerStatsData: md.playerStatsData,
      playerOfMatchKey: md.playerOfMatchKey, playerOfMatchName: md.playerOfMatchName, playerOfMatchTeamId: md.playerOfMatchTeamId },
  });
  const twin = await m(db, "M-TWIN");
  const fields = ["resultData", "resultType", "summary", "winnerRegistrationId", "scoreA", "scoreB", "playerOfMatchKey",
    "playerOfMatchName", "playerOfMatchTeamId", "playerStatsData", "statusRaw", "submittedBy", "confirmedBy"];
  const diff = fields.filter((f) => JSON.stringify(twin?.[f]) !== JSON.stringify(md?.[f]));
  check("live finish == manual submitScore", diff.length === 0, diff.join(","));
}

async function abandonAndStop(db: Firestore): Promise<void> {
  console.log("\n── End innings, abandon, stop live scoring ──");
  const { startScoring, startInnings, recordBall, endInnings, abandonMatch, stopLiveScoring } = live;
  const M = "M-ABN";
  await newMatch(db, M);
  await ok("vice-captain starts", startScoring, P.b2.uid, { matchId: M, battingFirstTeamId: RA });
  await ok("innings 1", startInnings, P.b2.uid, { matchId: M, strikerKey: A1, nonStrikerKey: A2, bowlerKey: B3 });
  await ok("ball", recordBall, P.b2.uid, { matchId: M, ballId: "a1", runs: 4 });
  await ok("end innings (bad light)", endInnings, P.b2.uid, { matchId: M, reason: "Bad light" });
  const lv = (await m(db, M)).live;
  check("manual end", lv?.status === "inningsBreak" && lv?.innings?.[0]?.endReason === "manual" &&
    (await logDoc(db, M))?.scorecard?.innings?.[0]?.endNote === "Bad light");
  const r = await ok<{ status: string }>("abandon by vice-captain", abandonMatch, P.b2.uid, { matchId: M });
  const md = await m(db, M);
  check("no result, waits for the other side", r?.status === "scoreSubmitted" && md?.resultType === "noResult" &&
    md?.summary === "No result" && md?.live?.status === "finished" && md?.live?.result === "noResult" &&
    md?.resultData === `{"innings":[{"balls":1,"battingRegistrationId":"${RA}","runs":4,"wickets":0}],"noResult":true}` &&
    md?.playerOfMatchKey === undefined, md?.resultData);

  const S = "M-STOP";
  await newMatch(db, S);
  await ok("captain starts", startScoring, P.b1.uid, { matchId: S, battingFirstTeamId: RB });
  await ok("innings", startInnings, P.b1.uid, { matchId: S, strikerKey: B1, nonStrikerKey: B2, bowlerKey: A1 });
  await ok("ball", recordBall, P.b1.uid, { matchId: S, ballId: "s1", runs: 1 });
  await expectFail("captain can't stop", stopLiveScoring, P.b1.uid, { matchId: S }, "NOT_SCORER", "Only the organizer can stop live scoring.");
  await ok("organizer stops", stopLiveScoring, P.org.uid, { matchId: S });
  const sd = await m(db, S);
  check("live + log gone, balls undone", sd?.live === undefined && !(await logDoc(db, S)) &&
    (await db.collection("matches").doc(S).collection("balls").doc("s1").get()).get("undone") === true);
  await ok("manual result after stopping", scores.submitScore, P.org.uid, {
    matchId: S, cricket: { resultData: { innings: [], noResult: true } },
  });
  check("manual finished", (await m(db, S))?.statusRaw === "finished");
}

async function main(): Promise<void> {
  const db = getFirestore();
  await clear(db);
  await seed(db);
  await captainFlow(db);
  await organizerFlow(db);
  await abandonAndStop(db);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Emulator checks crashed:", err);
  process.exit(1);
});
