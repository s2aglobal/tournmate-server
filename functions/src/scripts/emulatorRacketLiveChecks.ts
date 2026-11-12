/**
 * Emulator checks for the racket live scoring callables
 * (callables/racketLive.ts, badminton): the `config/sports.liveScoring`
 * switch, scorer rights and takeover after 3 minutes, idempotent points,
 * undo (across games, after the end), fix server, finish (organizer → final,
 * identical to a manual submitScore on a twin match for bracket and round
 * robin; player → scoreSubmitted, the other side confirms), stop live scoring
 * + manual entry, the manual-score lock and the `live` shape older apps read.
 * Runs the handlers directly (`.run`) against the Firestore emulator.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-racket-live
 * which runs, under `firebase emulators:exec --only firestore --project demo-tournmate`:
 *   node lib/scripts/emulatorRacketLiveChecks.js
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp, Firestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore emulator and a demo-* project (use npm run test:emulator-racket-live).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });

/* eslint-disable @typescript-eslint/no-var-requires */
const live = require("../callables/racketLive") as typeof import("../callables/racketLive");
const cricketLive = require("../callables/cricketLive") as typeof import("../callables/cricketLive");
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
async function ok<T = any>(name: string, fn: Fn, uid: string | null, data: unknown, quiet = false): Promise<T | null> {
  try {
    const r = await call<T>(fn, uid, data);
    if (!quiet) check(name, true, JSON.stringify(r));
    return r;
  } catch (e) {
    const err = e as { message?: string; details?: { reason?: string } };
    check(name, false, `threw ${err.details?.reason ?? ""} ${err.message}`);
    return null;
  }
}
async function expectFail(name: string, fn: Fn, uid: string | null, data: unknown, reason: string, message?: string, code?: string): Promise<void> {
  try {
    const r = await call(fn, uid, data);
    check(name, false, `expected ${reason}, got ${JSON.stringify(r)}`);
  } catch (e) {
    const err = e as { message?: string; code?: string; details?: { reason?: string } };
    check(name, err.details?.reason === reason && (message === undefined || err.message === message) &&
      (code === undefined || err.code === code), `${err.code} ${err.details?.reason}: ${err.message}`);
  }
}

const P = {
  org: { id: "DDDDDDDD-0000-0000-0000-000000000000", uid: "u-org", name: "Olga" },
  a1: { id: "DDDDDDDD-0000-0000-0000-0000000000A1", uid: "ua1", name: "Arun" },
  a2: { id: "DDDDDDDD-0000-0000-0000-0000000000A2", uid: "ua2", name: "Asha" },
  b1: { id: "DDDDDDDD-0000-0000-0000-0000000000B1", uid: "ub1", name: "Bala" },
  b2: { id: "DDDDDDDD-0000-0000-0000-0000000000B2", uid: "ub2", name: "Bina" },
  x: { id: "DDDDDDDD-0000-0000-0000-0000000000FF", uid: "ux", name: "Xavi" },
};
const TB = "T-BRACKET"; // single elimination, best of 3 to 11 (cap 15)
const TR = "T-RR"; // round robin, best of 3 to 11 in the config → one game live
const TU = "T-ODD"; // unplayable config (best of 2)
const TC = "T-CRICKET";
const TT = "T-TENNIS";
const SCORING = JSON.stringify({ gamesPerMatch: 3, pointsToWin: 11, winBy: 2, pointCap: 15, scoringSystem: "rally" });
const OLD_STATUSES = ["setup", "inProgress", "inningsBreak", "ended", "finished"];

async function clear(db: Firestore): Promise<void> {
  for (const c of ["players", "tournaments", "registrations", "matches", "notifications", "ratings", "config"]) {
    const snap = await db.collection(c).get();
    for (const d of snap.docs) await db.recursiveDelete(d.ref);
  }
}

async function setSwitch(db: Firestore, liveScoring: Record<string, boolean> | null): Promise<void> {
  await db.collection("config").doc("sports").set({
    schemaVersion: 1, live: ["pickleball", "badminton", "tennis"], categories: [],
    ...(liveScoring ? { liveScoring } : {}),
  });
}

async function seed(db: Firestore): Promise<void> {
  for (const p of Object.values(P)) {
    await db.collection("players").doc(p.id).set({
      name: p.name, phone: "", email: `${p.uid}@example.test`, genderRaw: "male", elo: 1200, streak: 0,
      firebaseUid: p.uid, avatarId: "a1", createdAt: Timestamp.now(),
    });
  }
  const t = async (id: string, extra: Record<string, unknown>) => db.collection("tournaments").doc(id).set({
    title: id, date: Timestamp.now(), statusRaw: "scheduled", sportType: "badminton", formatRaw: "openDoubles",
    matchFormatRaw: "singleElimination", createdBy: P.org.uid, location: "Hall", createdAt: Timestamp.now(), drawMade: true,
    scoringConfigData: SCORING, ...extra,
  });
  await t(TB, {});
  await t(TR, { matchFormatRaw: "roundRobin" });
  await t(TU, { scoringConfigData: JSON.stringify({ gamesPerMatch: 2, pointsToWin: 21, winBy: 2, pointCap: 30 }) });
  await t(TC, { sportType: "cricket", formatRaw: "team", scoringConfigData: null });
  await t(TT, { sportType: "tennis", formatRaw: "openSingles", scoringConfigData: null });
  for (const tid of [TB, TR, TU, TC, TT]) {
    await db.collection("registrations").doc(`${tid}-RA`).set({ tournamentId: tid, playerId: P.a1.id, partnerId: P.a2.id, createdAt: Timestamp.now() });
    await db.collection("registrations").doc(`${tid}-RB`).set({ tournamentId: tid, playerId: P.b1.id, partnerId: P.b2.id, createdAt: Timestamp.now() });
  }
}

/** A scheduled match; `uids` false = no teamAUids/teamBUids (rights from the registrations). */
async function newMatch(db: Firestore, id: string, tid: string, uids = true): Promise<void> {
  await db.collection("matches").doc(id).set({
    tournamentId: tid, teamAId: `${tid}-RA`, teamBId: `${tid}-RB`, round: 1, statusRaw: "scheduled", sportType: "badminton",
    ...(uids ? { teamAUids: [P.a1.uid, P.a2.uid], teamBUids: [P.b1.uid, P.b2.uid] } : {}), createdAt: Timestamp.now(),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function m(db: Firestore, id: string): Promise<any> {
  return (await db.collection("matches").doc(id).get()).data();
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function logDoc(db: Firestore, id: string): Promise<any> {
  return (await db.collection("matches").doc(id).collection("racketLive").doc("state").get()).data();
}

let pid = 0;
/** Records points "AAB…" for `uid`. */
async function play(matchId: string, uid: string, seq: string): Promise<void> {
  for (const c of seq) await ok(`point ${c}`, live.recordPoint, uid, { matchId, pointId: `pt${++pid}`, winner: c }, true);
}
const repeat = (s: string, n: number) => s.repeat(n);

const FIELDS = ["setScores", "scoreA", "scoreB", "winnerRegistrationId", "statusRaw", "submittedBy", "confirmedBy"];
function sameFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return FIELDS.filter((f) => JSON.stringify(a?.[f]) !== JSON.stringify(b?.[f]));
}

async function switchAndSports(db: Firestore): Promise<void> {
  console.log("\n── config/sports.liveScoring switch, other sports, settings ──");
  await newMatch(db, "M-OFF", TB);
  await setSwitch(db, null);
  await expectFail("switch absent: refused", live.startRacketScoring, P.org.uid, { matchId: "M-OFF", firstServer: "A" },
    "LIVE_SCORING_DISABLED", "Live scoring isn't available for this sport yet.", "failed-precondition");
  await setSwitch(db, { badminton: false, pickleball: true });
  await expectFail("switch false: refused", live.startRacketScoring, P.org.uid, { matchId: "M-OFF", firstServer: "A" }, "LIVE_SCORING_DISABLED");
  await setSwitch(db, { badminton: true });
  await newMatch(db, "M-CR", TC);
  await expectFail("cricket match: not a racket sport", live.startRacketScoring, P.org.uid, { matchId: "M-CR", firstServer: "A" }, "LIVE_SCORING_DISABLED");
  await newMatch(db, "M-TN", TT);
  await expectFail("tennis: not yet", live.startRacketScoring, P.org.uid, { matchId: "M-TN", firstServer: "A" }, "LIVE_SCORING_DISABLED");
  await expectFail("cricket startScoring on badminton unchanged", cricketLive.startScoring, P.org.uid,
    { matchId: "M-OFF", battingFirstTeamId: `${TB}-RA` }, "INVALID_ARGUMENT", "Live scoring is for cricket matches.");
  await newMatch(db, "M-ODD", TU);
  await expectFail("unplayable settings (best of 2)", live.startRacketScoring, P.org.uid, { matchId: "M-ODD", firstServer: "A" },
    "INVALID_ARGUMENT", "Live scoring can't be used with this tournament's scoring settings.");
  await expectFail("first server required", live.startRacketScoring, P.org.uid, { matchId: "M-OFF" }, "INVALID_ARGUMENT", "Choose who serves first.");
  await expectFail("signed out", live.startRacketScoring, null, { matchId: "M-OFF", firstServer: "A" }, "UNAUTHENTICATED");
  await db.collection("matches").doc("M-OFF").update({ statusRaw: "finished" });
  await expectFail("finished match", live.startRacketScoring, P.org.uid, { matchId: "M-OFF", firstServer: "A" }, "MATCH_FINISHED");
}

async function playerFlow(db: Firestore): Promise<void> {
  console.log("\n── Player scores (bracket, no uid lists): rights, takeover, points, undo, fix server, finish → confirm ──");
  const M = "M-PLAYER";
  await newMatch(db, M, TB, false);
  const { startRacketScoring, recordPoint, undoPoint, setServer, finishRacketMatch } = live;

  await expectFail("outsider can't score", startRacketScoring, P.x.uid, { matchId: M, firstServer: "A" }, "NOT_SCORER",
    "Only the organizer or a player in this match can score it.");
  await ok("partner starts (B serves first)", startRacketScoring, P.a2.uid, { matchId: M.toLowerCase(), firstServer: "B" });
  let md = await m(db, M);
  const lv = md?.live;
  check("live shape", lv?.kind === "racket" && lv?.sport === "badminton" && lv?.status === "inProgress" && lv?.scorerUid === P.a2.uid &&
    lv?.scorerName === "Asha" && lv?.scorerSince instanceof Timestamp && lv?.startedAt instanceof Timestamp &&
    JSON.stringify(lv?.games) === "[]" && JSON.stringify(lv?.current) === '{"a":0,"b":0}' &&
    JSON.stringify(lv?.server) === '{"side":"B","court":"R"}' && JSON.stringify(lv?.gamesWon) === '{"a":0,"b":0}' &&
    lv?.switchEnds === false && lv?.seq === 0 && lv?.format === "sets" && lv?.gamesPerMatch === 3 && lv?.pointsToWin === 11 &&
    lv?.lastPointAt === undefined, JSON.stringify(lv));
  check("old apps: status is a known live status", OLD_STATUSES.includes(lv?.status));
  const lg = await logDoc(db, M);
  check("state doc: frozen config, no events", JSON.stringify(lg?.config) ===
    '{"sport":"badminton","format":"sets","scoring":{"gamesPerMatch":3,"pointsToWin":11,"winBy":2,"pointCap":15},"firstServer":"B"}' &&
    Array.isArray(lg?.events) && lg.events.length === 0 && lg?.updatedAt instanceof Timestamp, JSON.stringify(lg));

  await ok("same scorer again = resume", startRacketScoring, P.a2.uid, { matchId: M });
  await expectFail("other player without takeover", startRacketScoring, P.b1.uid, { matchId: M, firstServer: "A" }, "SCORER_ACTIVE",
    "Asha is scoring this match.");
  await expectFail("player takeover within 3 minutes", startRacketScoring, P.b1.uid, { matchId: M, takeover: true }, "SCORER_ACTIVE",
    "Asha is scoring this match. You can take over if no point is recorded for 3 minutes.");

  await ok("point A", recordPoint, P.a2.uid, { matchId: M, pointId: "x1", winner: "A" });
  const dup = await ok<{ duplicate: boolean }>("point x1 again", recordPoint, P.a2.uid, { matchId: M, pointId: "x1", winner: "A" });
  check("retry is a no-op", dup?.duplicate === true && (await m(db, M)).live?.current?.a === 1 && (await m(db, M)).live?.seq === 1);
  const x1 = (await db.collection("matches").doc(M).collection("points").doc("x1").get()).data();
  check("point doc", x1?.seq === 1 && x1?.game === 1 && x1?.winner === "A" && x1?.server === "B" && x1?.scoreA === 1 &&
    x1?.scoreB === 0 && x1?.by === P.a2.uid && x1?.createdAt instanceof Timestamp && x1?.undone === undefined, JSON.stringify(x1));
  md = await m(db, M);
  check("live after a point", JSON.stringify(md?.live?.server) === '{"side":"A","court":"L"}' && md?.live?.lastPointAt instanceof Timestamp);
  await expectFail("bad winner", recordPoint, P.a2.uid, { matchId: M, pointId: "x2", winner: "C" }, "INVALID_POINT",
    "That point isn't valid. Update the app and try again.", "invalid-argument");
  await expectFail("missing pointId", recordPoint, P.a2.uid, { matchId: M, winner: "A" }, "INVALID_ARGUMENT", "Missing pointId.");
  await expectFail("non-scorer can't record", recordPoint, P.b1.uid, { matchId: M, pointId: "x3", winner: "B" }, "NOT_SCORER",
    "Only the scorer can do this. Take over scoring first.");

  console.log("  manual score locked while live");
  await expectFail("submitScore by a player", scores.submitScore, P.b1.uid, { matchId: M, setScores: [{ teamAPoints: 11, teamBPoints: 3 }] },
    "SCORER_ACTIVE", "This match is being scored live.");
  await expectFail("submitScore by the organizer", scores.submitScore, P.org.uid, { matchId: M, setScores: [{ teamAPoints: 11, teamBPoints: 3 }] },
    "SCORER_ACTIVE", "This match is being scored live. Stop live scoring first.");
  await expectFail("resolveDispute by the organizer", scores.resolveDispute, P.org.uid,
    { matchId: M, setScores: [{ teamAPoints: 11, teamBPoints: 3 }, { teamAPoints: 11, teamBPoints: 3 }] },
    "SCORER_ACTIVE", "This match is being scored live. Stop live scoring first.");

  console.log("  takeover after 3 idle minutes");
  await db.collection("matches").doc(M).update({ "live.lastPointAt": Timestamp.fromMillis(Date.now() - 4 * 60_000) });
  await ok("opponent takes over after 3 idle minutes", startRacketScoring, P.b1.uid, { matchId: M, takeover: true });
  md = await m(db, M);
  check("takeover changes the scorer only", md?.live?.scorerUid === P.b1.uid && md?.live?.scorerName === "Bala" &&
    md?.live?.current?.a === 1 && md?.live?.seq === 1);
  await expectFail("old scorer can't record", recordPoint, P.a2.uid, { matchId: M, pointId: "x4", winner: "A" }, "NOT_SCORER");
  await ok("organizer takes over any time", startRacketScoring, P.org.uid, { matchId: M, takeover: true });
  await db.collection("matches").doc(M).update({ "live.lastPointAt": Timestamp.fromMillis(Date.now() - 4 * 60_000) });
  await ok("partner takes it back", startRacketScoring, P.a2.uid, { matchId: M, takeover: true });

  console.log("  undo and fix server");
  await ok("point B", recordPoint, P.a2.uid, { matchId: M, pointId: "x5", winner: "B" });
  const u = await ok<{ undonePointId: string | null }>("undo x5", undoPoint, P.a2.uid, { matchId: M, pointId: "x5" });
  check("undo marks the point doc", u?.undonePointId === "x5" && (await m(db, M)).live?.current?.b === 0 &&
    (await db.collection("matches").doc(M).collection("points").doc("x5").get()).get("undone") === true);
  const again = await ok<{ undonePointId: string | null }>("undo x5 retried", undoPoint, P.a2.uid, { matchId: M, pointId: "x5" });
  check("undo retry is a no-op", again?.undonePointId === null && (await logDoc(db, M))?.events?.length === 1);
  const resent = await ok<{ duplicate: boolean }>("undone point id resent", recordPoint, P.a2.uid, { matchId: M, pointId: "x5", winner: "B" });
  check("undone id stays a no-op", resent?.duplicate === true && (await m(db, M)).live?.current?.b === 0);
  await ok("fix server → B", setServer, P.a2.uid, { matchId: M, eventId: "f1", side: "B" });
  md = await m(db, M);
  check("fix server keeps the score", JSON.stringify(md?.live?.server) === '{"side":"B","court":"R"}' && md?.live?.current?.a === 1);
  const fdup = await ok<{ duplicate: boolean }>("fix server retried", setServer, P.a2.uid, { matchId: M, eventId: "f1", side: "B" });
  check("fix server retry is a no-op", fdup?.duplicate === true && (await logDoc(db, M))?.events?.length === 2);
  await expectFail("fix server: bad side", setServer, P.a2.uid, { matchId: M, eventId: "f2", side: "X" }, "INVALID_POINT");

  console.log("  play game 1 (A 11-0), undo across the boundary, game 2, finish");
  await play(M, P.a2.uid, repeat("A", 10));
  md = await m(db, M);
  check("game 1 won, switch ends", JSON.stringify(md?.live?.games) === '[{"a":11,"b":0}]' && md?.live?.switchEnds === true &&
    JSON.stringify(md?.live?.gamesWon) === '{"a":1,"b":0}' && JSON.stringify(md?.live?.server) === '{"side":"A","court":"R"}');
  await ok("undo across the game boundary", undoPoint, P.a2.uid, { matchId: M });
  md = await m(db, M);
  check("back in game 1 at 10-0", JSON.stringify(md?.live?.games) === "[]" && md?.live?.current?.a === 10);
  await expectFail("finish before the end", finishRacketMatch, P.a2.uid, { matchId: M }, "INVALID_SCORE", "The match isn't over yet.");
  await play(M, P.a2.uid, "A" + repeat("BA", 5) + "AAAAAA");
  md = await m(db, M);
  check("ended 11-0, 11-5", md?.live?.status === "ended" && JSON.stringify(md?.live?.games) === '[{"a":11,"b":0},{"a":11,"b":5}]' &&
    OLD_STATUSES.includes(md?.live?.status), JSON.stringify(md?.live?.games));
  await expectFail("point after the end", recordPoint, P.a2.uid, { matchId: M, pointId: "late1", winner: "B" }, "INVALID_POINT",
    "The match is over. Finish it, or undo the last point.", "failed-precondition");
  await expectFail("fix server after the end", setServer, P.a2.uid, { matchId: M, eventId: "late2", side: "B" }, "INVALID_POINT");
  await ok("undo after the end reopens", undoPoint, P.a2.uid, { matchId: M });
  check("reopened", (await m(db, M)).live?.status === "inProgress");
  await play(M, P.a2.uid, "A");
  await expectFail("finish: not the scorer", finishRacketMatch, P.b1.uid, { matchId: M }, "NOT_SCORER");
  const fin = await ok<{ status: string }>("player finishes", finishRacketMatch, P.a2.uid, { matchId: M });
  md = await m(db, M);
  check("player finish waits for the other side", fin?.status === "scoreSubmitted" && md?.statusRaw === "scoreSubmitted" &&
    md?.submittedBy === P.a2.uid && md?.confirmedBy === undefined && md?.live?.status === "finished" &&
    JSON.stringify(md?.setScores) === '[{"teamAPoints":11,"teamBPoints":0},{"teamAPoints":11,"teamBPoints":5}]' &&
    md?.scoreA === 2 && md?.scoreB === 0 && md?.winnerRegistrationId === `${TB}-RA`, JSON.stringify(md));

  await newMatch(db, "M-PLAYER-TWIN", TB, false);
  await ok("twin: same score by hand (player)", scores.submitScore, P.a2.uid, { matchId: "M-PLAYER-TWIN", setScores: md.setScores });
  const twin = await m(db, "M-PLAYER-TWIN");
  const diff = sameFields(md, twin);
  check("player live finish == manual submitScore", diff.length === 0, diff.join(","));

  await expectFail("own side can't confirm", scores.confirmScore, P.a1.uid, { matchId: M }, "NOT_PARTICIPANT");
  await ok("other side confirms", scores.confirmScore, P.b2.uid, { matchId: M });
  md = await m(db, M);
  check("finished + rated", md?.statusRaw === "finished" && md?.confirmedBy === P.b2.uid && md?.eloApplied === true);
  await expectFail("start after finish", startRacketScoring, P.org.uid, { matchId: M, firstServer: "A" }, "MATCH_FINISHED");
  await expectFail("point after finish", recordPoint, P.a2.uid, { matchId: M, pointId: "late3", winner: "A" }, "MATCH_FINISHED");
  await expectFail("stop after finish", cricketLive.stopLiveScoring, P.org.uid, { matchId: M }, "MATCH_FINISHED");
}

async function organizerBracket(db: Firestore): Promise<void> {
  console.log("\n── Organizer scores a bracket match: three games, final = manual submitScore ──");
  const M = "M-ORG";
  await newMatch(db, M, TB);
  await ok("organizer starts", live.startRacketScoring, P.org.uid, { matchId: M, firstServer: "A" });
  check("organizer scorer name", (await m(db, M)).live?.scorerName === "Olga");
  await play(M, P.org.uid, repeat("AB", 10) + "AA"); // 12-10 (cap 15, win by 2)
  await play(M, P.org.uid, repeat("B", 11)); // 0-11
  await play(M, P.org.uid, repeat("AB", 5) + "A"); // 6-5 in the decider: switch at 6
  check("decider switch at 6", (await m(db, M)).live?.switchEnds === true);
  await play(M, P.org.uid, "B" + repeat("AB", 8) + "A"); // 6-6 … 14-14 → 15-14
  let md = await m(db, M);
  check("ended at the cap 15-14", md?.live?.status === "ended" &&
    JSON.stringify(md?.live?.games) === '[{"a":12,"b":10},{"a":0,"b":11},{"a":15,"b":14}]', JSON.stringify(md?.live?.games));
  const fin = await ok<{ status: string }>("organizer finishes", live.finishRacketMatch, P.org.uid, { matchId: M });
  md = await m(db, M);
  check("organizer result is final", fin?.status === "finished" && md?.statusRaw === "finished" && md?.confirmedBy === P.org.uid &&
    md?.eloApplied === true && md?.live?.status === "finished" && md?.scoreA === 2 && md?.scoreB === 1);
  await newMatch(db, "M-ORG-TWIN", TB);
  await ok("twin: same score by hand (organizer)", scores.submitScore, P.org.uid, { matchId: "M-ORG-TWIN", setScores: md.setScores });
  const twin = await m(db, "M-ORG-TWIN");
  const diff = sameFields(md, twin);
  check("organizer live finish == manual submitScore (bracket)", diff.length === 0 && twin?.eloApplied === true, diff.join(","));
}

async function roundRobin(db: Firestore): Promise<void> {
  console.log("\n── Round robin: one game; organizer = simple final score, player = one game for confirmation ──");
  const M = "M-RR-ORG";
  await newMatch(db, M, TR);
  await ok("organizer starts", live.startRacketScoring, P.org.uid, { matchId: M, firstServer: "B" });
  const lv = (await m(db, M)).live;
  check("one game frozen", lv?.format === "simple" && lv?.gamesPerMatch === 1 &&
    (await logDoc(db, M))?.config?.scoring?.gamesPerMatch === 1);
  await play(M, P.org.uid, repeat("B", 8) + repeat("A", 11)); // 11-8 for A
  check("ended after one game", (await m(db, M)).live?.status === "ended");
  await ok("organizer finishes", live.finishRacketMatch, P.org.uid, { matchId: M });
  let md = await m(db, M);
  check("simple score: points, no setScores", md?.statusRaw === "finished" && md?.scoreA === 11 && md?.scoreB === 8 &&
    md?.setScores === undefined && md?.winnerRegistrationId === `${TR}-RA`, JSON.stringify(md));
  await newMatch(db, "M-RR-ORG-TWIN", TR);
  await ok("twin: simple score by hand (organizer)", scores.submitScore, P.org.uid, { matchId: "M-RR-ORG-TWIN", scoreA: 11, scoreB: 8 });
  let diff = sameFields(md, await m(db, "M-RR-ORG-TWIN"));
  check("organizer live finish == manual submitScore (round robin)", diff.length === 0, diff.join(","));

  const N = "M-RR-PLAYER";
  await newMatch(db, N, TR);
  await ok("player starts", live.startRacketScoring, P.b1.uid, { matchId: N, firstServer: "A" });
  await play(N, P.b1.uid, repeat("B", 11));
  await ok("player finishes", live.finishRacketMatch, P.b1.uid, { matchId: N });
  md = await m(db, N);
  check("player simple score: one game, scoreSubmitted", md?.statusRaw === "scoreSubmitted" &&
    JSON.stringify(md?.setScores) === '[{"teamAPoints":0,"teamBPoints":11}]' && md?.scoreA === 0 && md?.scoreB === 1, JSON.stringify(md));
  await newMatch(db, "M-RR-PLAYER-TWIN", TR);
  await ok("twin: simple score by hand (player)", scores.submitScore, P.b1.uid, { matchId: "M-RR-PLAYER-TWIN", scoreA: 0, scoreB: 11 });
  diff = sameFields(md, await m(db, "M-RR-PLAYER-TWIN"));
  check("player live finish == manual submitScore (round robin)", diff.length === 0, diff.join(","));
  await ok("other side confirms", scores.confirmScore, P.a1.uid, { matchId: N });
  check("confirmed", (await m(db, N))?.statusRaw === "finished");
}

async function stopAndSwitchOff(db: Firestore): Promise<void> {
  console.log("\n── Stop live scoring, manual entry, switch off mid-match ──");
  const S = "M-STOP";
  await newMatch(db, S, TB);
  await ok("player starts", live.startRacketScoring, P.a1.uid, { matchId: S, firstServer: "A" });
  await play(S, P.a1.uid, "AB");
  await expectFail("player can't stop", cricketLive.stopLiveScoring, P.a1.uid, { matchId: S }, "NOT_SCORER",
    "Only the organizer can stop live scoring.");
  await ok("organizer stops", cricketLive.stopLiveScoring, P.org.uid, { matchId: S });
  const sd = await m(db, S);
  const points = await db.collection("matches").doc(S).collection("points").get();
  check("live + log gone, points undone", sd?.live === undefined && !(await logDoc(db, S)) && points.size === 2 &&
    points.docs.every((p) => p.get("undone") === true));
  await ok("stop again = no-op", cricketLive.stopLiveScoring, P.org.uid, { matchId: S });
  await ok("manual score after stopping", scores.submitScore, P.org.uid,
    { matchId: S, setScores: [{ teamAPoints: 11, teamBPoints: 2 }, { teamAPoints: 11, teamBPoints: 4 }] });
  check("manual finished", (await m(db, S))?.statusRaw === "finished");

  const W = "M-SWITCH";
  await newMatch(db, W, TB);
  const W2 = "M-SWITCH-2";
  await newMatch(db, W2, TB);
  await ok("start", live.startRacketScoring, P.org.uid, { matchId: W, firstServer: "A" });
  await setSwitch(db, {});
  await ok("switch off: the running match resumes", live.startRacketScoring, P.org.uid, { matchId: W });
  await ok("switch off: points still record", live.recordPoint, P.org.uid, { matchId: W, pointId: "sw1", winner: "A" });
  await expectFail("switch off: no new session", live.startRacketScoring, P.org.uid, { matchId: W2, firstServer: "A" }, "LIVE_SCORING_DISABLED");
  await setSwitch(db, { badminton: true });
}

async function main(): Promise<void> {
  const db = getFirestore();
  await clear(db);
  await seed(db);
  await switchAndSports(db);
  await playerFlow(db);
  await organizerBracket(db);
  await roundRobin(db);
  await stopAndSwitchOff(db);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Emulator checks crashed:", err);
  process.exit(1);
});
