/**
 * Emulator checks for live video streaming (callables/liveStream.ts,
 * services/liveStream.ts): the `config/sports.liveStreaming` switch, rights
 * (organizer only), input checks, one stream per match (resume / restart /
 * STREAM_ACTIVE / stale takeover), heartbeat counters and write volume,
 * idempotent end, the tournament's `liveStreams` / `liveStreamCount` with
 * concurrent streams, stale cleanup with an injected clock, orphan entries,
 * and the stream ending when the match finishes (organizer submit, confirm,
 * racket live finish, older apps' direct write via the match trigger).
 * Runs the handlers directly (`.run`) against the Firestore emulator.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-live-stream
 * which runs, under `firebase emulators:exec --only firestore --project demo-tournmate`:
 *   node lib/scripts/emulatorLiveStreamChecks.js
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp, Firestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore emulator and a demo-* project (use npm run test:emulator-live-stream).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });

/* eslint-disable @typescript-eslint/no-var-requires */
const ls = require("../callables/liveStream") as typeof import("../callables/liveStream");
const svc = require("../services/liveStream") as typeof import("../services/liveStream");
const racket = require("../callables/racketLive") as typeof import("../callables/racketLive");
const scores = require("../callables/scores") as typeof import("../callables/scores");
const trigger = require("../triggers/onMatchWritten") as typeof import("../triggers/onMatchWritten");

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
  org: { id: "EEEEEEEE-0000-0000-0000-000000000000", uid: "u-org", name: "Olga Organizer" },
  a1: { id: "EEEEEEEE-0000-0000-0000-0000000000A1", uid: "ua1", name: "Priya Shah" },
  a2: { id: "EEEEEEEE-0000-0000-0000-0000000000A2", uid: "ua2", name: "Arjun Rao" },
  b1: { id: "EEEEEEEE-0000-0000-0000-0000000000B1", uid: "ub1", name: "Maya Lee" },
  b2: { id: "EEEEEEEE-0000-0000-0000-0000000000B2", uid: "ub2", name: "Leo Park" },
  x: { id: "EEEEEEEE-0000-0000-0000-0000000000FF", uid: "ux", name: "Xavi" },
};
const TB = "T-STREAM"; // badminton, single elimination, best of 3 to 11
const TC = "T-CRICKET";
const TT = "T-TENNIS";
const VID = ["dQw4w9WgXcQ", "aBcDeFgHiJk", "Zz_-0123456", "QWERTYUIOP1", "mnbvcxzlkj2", "poiuytrewq3"];
const SCORING = JSON.stringify({ gamesPerMatch: 3, pointsToWin: 11, winBy: 2, pointCap: 15, scoringSystem: "rally" });

async function clear(db: Firestore): Promise<void> {
  for (const c of ["players", "tournaments", "registrations", "matches", "notifications", "ratings", "config", "standings"]) {
    const snap = await db.collection(c).get();
    for (const d of snap.docs) await db.recursiveDelete(d.ref);
  }
}

async function setSwitch(db: Firestore, liveStreaming: Record<string, boolean> | null): Promise<void> {
  await db.collection("config").doc("sports").set({
    schemaVersion: 1, live: ["pickleball", "badminton", "tennis"], categories: [], liveScoring: { badminton: true },
    ...(liveStreaming ? { liveStreaming } : {}),
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
  await t(TC, { sportType: "cricket", formatRaw: "team", scoringConfigData: null });
  await t(TT, { sportType: "tennis", formatRaw: "openSingles", scoringConfigData: null });
  for (const tid of [TB, TC, TT]) {
    await db.collection("registrations").doc(`${tid}-RA`).set({ tournamentId: tid, playerId: P.a1.id, partnerId: P.a2.id, createdAt: Timestamp.now() });
    await db.collection("registrations").doc(`${tid}-RB`).set({ tournamentId: tid, playerId: P.b1.id, partnerId: P.b2.id, createdAt: Timestamp.now() });
  }
}

async function newMatch(db: Firestore, id: string, tid = TB, extra: Record<string, unknown> = {}): Promise<void> {
  await db.collection("matches").doc(id).set({
    tournamentId: tid, teamAId: `${tid}-RA`, teamBId: `${tid}-RB`, round: 1, statusRaw: "scheduled", sportType: "badminton",
    teamAUids: [P.a1.uid, P.a2.uid], teamBUids: [P.b1.uid, P.b2.uid], createdAt: Timestamp.now(), ...extra,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function m(db: Firestore, id: string): Promise<any> {
  return (await db.collection("matches").doc(id).get()).data();
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function t(db: Firestore, id = TB): Promise<any> {
  return (await db.collection("tournaments").doc(id).get()).data();
}
async function tUpdateTime(db: Firestore, id = TB): Promise<string> {
  const snap = await db.collection("tournaments").doc(id).get();
  return snap.updateTime?.toDate().toISOString() ?? "";
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ids(list: any[] | undefined): string {
  return (list ?? []).map((e) => e.matchId).join(",");
}

async function switchAndInput(db: Firestore): Promise<void> {
  console.log("\n── config/sports.liveStreaming switch, sports, rights, input ──");
  await newMatch(db, "M-OFF");
  await setSwitch(db, null);
  await expectFail("switch absent: refused", ls.startStream, P.org.uid, { matchId: "M-OFF", provider: "youtube", videoId: VID[0] },
    "LIVE_STREAMING_DISABLED", "Live video isn't available for this sport yet.", "failed-precondition");
  await setSwitch(db, { badminton: false });
  await expectFail("switch false: refused", ls.startStream, P.org.uid, { matchId: "M-OFF", provider: "youtube", videoId: VID[0] },
    "LIVE_STREAMING_DISABLED");
  await setSwitch(db, { badminton: true });
  await newMatch(db, "M-CR", TC);
  await expectFail("cricket: not available", ls.startStream, P.org.uid, { matchId: "M-CR", provider: "youtube", videoId: VID[0] },
    "LIVE_STREAMING_DISABLED");
  await db.collection("config").doc("sports").update({ liveStreaming: { badminton: true, tennis: true } });
  await newMatch(db, "M-TN", TT);
  await expectFail("tennis switched on in config: still badminton only", ls.startStream, P.org.uid,
    { matchId: "M-TN", provider: "youtube", videoId: VID[0] }, "LIVE_STREAMING_DISABLED");
  await setSwitch(db, { badminton: true });

  await expectFail("signed out", ls.startStream, null, { matchId: "M-OFF", provider: "youtube", videoId: VID[0] }, "UNAUTHENTICATED");
  await expectFail("player in the match refused", ls.startStream, P.a1.uid, { matchId: "M-OFF", provider: "youtube", videoId: VID[0] },
    "NOT_ORGANIZER", "Only the organizer can stream this match.", "permission-denied");
  await expectFail("outsider refused", ls.startStream, P.x.uid, { matchId: "M-OFF", provider: "youtube", videoId: VID[0] }, "NOT_ORGANIZER");
  await expectFail("bad videoId (too short)", ls.startStream, P.org.uid, { matchId: "M-OFF", provider: "youtube", videoId: "abc" },
    "INVALID_ARGUMENT", "That YouTube stream isn't valid. Try going live again.", "invalid-argument");
  await expectFail("bad videoId (url)", ls.startStream, P.org.uid,
    { matchId: "M-OFF", provider: "youtube", videoId: "https://youtu.be/dQw4w9WgXcQ" }, "INVALID_ARGUMENT");
  await expectFail("unknown provider", ls.startStream, P.org.uid, { matchId: "M-OFF", provider: "twitch", videoId: VID[0] },
    "INVALID_ARGUMENT", "This video service isn't supported. Update the app and try again.");
  await expectFail("missing match", ls.startStream, P.org.uid, { provider: "youtube", videoId: VID[0] }, "INVALID_ARGUMENT", "Missing match.");
  await expectFail("unknown match", ls.startStream, P.org.uid, { matchId: "M-NOPE", provider: "youtube", videoId: VID[0] }, "NOT_FOUND");
  await newMatch(db, "M-DONE", TB, { statusRaw: "finished" });
  await expectFail("finished match", ls.startStream, P.org.uid, { matchId: "M-DONE", provider: "youtube", videoId: VID[0] },
    "MATCH_FINISHED", "This match is already finished.");
  await newMatch(db, "M-SUB", TB, { statusRaw: "scoreSubmitted" });
  await expectFail("score submitted", ls.startStream, P.org.uid, { matchId: "M-SUB", provider: "youtube", videoId: VID[0] }, "MATCH_FINISHED");
  check("nothing written by refusals", (await m(db, "M-OFF"))?.stream === undefined && (await t(db))?.liveStreams === undefined);
}

async function lifecycle(db: Firestore): Promise<void> {
  console.log("\n── start, two concurrent streams, resume / restart, heartbeat, end ──");
  const r1 = await ok<{ status: string; streamStatus: string; label: string }>("organizer starts M1 (label SF1, lower-case id)",
    ls.startStream, P.org.uid, { matchId: "m1", provider: "youtube", videoId: VID[0], label: "  SF1 " });
  let md = await m(db, "M1");
  const s = md?.stream;
  check("start result", r1?.status === "live" && r1?.streamStatus === "started" && r1?.label === "SF1");
  check("stream shape", s?.provider === "youtube" && s?.videoId === VID[0] && s?.status === "live" && s?.label === "SF1" &&
    s?.byUid === P.org.uid && s?.byName === "Olga Organizer" && s?.startedAt instanceof Timestamp &&
    s?.lastHeartbeatAt instanceof Timestamp && s?.viewers === 0 && s?.peakViewers === 0 && s?.reconnects === 0 &&
    s?.endedAt === undefined && s?.endedReason === undefined, JSON.stringify(s));
  let td = await t(db);
  const e = td?.liveStreams?.[0];
  check("tournament entry", td?.liveStreamCount === 1 && td?.liveStreams?.length === 1 && e?.matchId === "M1" &&
    e?.videoId === VID[0] && e?.label === "SF1" && e?.teamAName === "Priya & Arjun" && e?.teamBName === "Maya & Leo" &&
    e?.viewers === 0 && e?.startedAt instanceof Timestamp && Object.keys(e).length === 7, JSON.stringify(e));
  check("live scoring untouched", md?.live === undefined);

  await ok("organizer starts M2 (default label)", ls.startStream, P.org.uid, { matchId: "M2", provider: "youtube", videoId: VID[1] });
  td = await t(db);
  check("two concurrent streams, oldest first", td?.liveStreamCount === 2 && ids(td?.liveStreams) === "M1,M2" &&
    td?.liveStreams?.[1]?.label === "Round 1", ids(td?.liveStreams));
  await expectFail("second stream on M1 by someone else", ls.startStream, P.a1.uid,
    { matchId: "M1", provider: "youtube", videoId: VID[2] }, "NOT_ORGANIZER");

  const res = await ok<{ streamStatus: string }>("same organizer, same video = resume", ls.startStream, P.org.uid,
    { matchId: "M1", provider: "youtube", videoId: VID[0] });
  check("resumed, nothing reset", res?.streamStatus === "resumed" && (await m(db, "M1"))?.stream?.videoId === VID[0] &&
    (await t(db))?.liveStreamCount === 2);

  console.log("  heartbeat");
  const before = await tUpdateTime(db);
  const hb = await ok<{ viewers: number; peakViewers: number }>("heartbeat 5 viewers", ls.heartbeatStream, P.org.uid,
    { matchId: "M1", viewers: 5, bitrateKbps: 3200, reconnects: 2 });
  md = await m(db, "M1");
  td = await t(db);
  check("heartbeat counters", hb?.viewers === 5 && hb?.peakViewers === 5 && md?.stream?.viewers === 5 &&
    md?.stream?.peakViewers === 5 && md?.stream?.reconnects === 2 && md?.stream?.bitrateKbps === 3200 &&
    md?.stream?.lastHeartbeatAt instanceof Timestamp, JSON.stringify(md?.stream));
  check("tournament entry viewers updated", td?.liveStreams?.find((x: { matchId: string }) => x.matchId === "M1")?.viewers === 5 &&
    (await tUpdateTime(db)) !== before);
  const same = await tUpdateTime(db);
  await ok("heartbeat, same viewers, lower reconnects", ls.heartbeatStream, P.org.uid, { matchId: "M1", viewers: 5, reconnects: 1 });
  check("unchanged viewers: no tournament write", (await tUpdateTime(db)) === same);
  check("reconnects never go down", (await m(db, "M1"))?.stream?.reconnects === 2);
  await ok("heartbeat 3 viewers", ls.heartbeatStream, P.org.uid, { matchId: "M1", viewers: 3 });
  md = await m(db, "M1");
  check("peak kept", md?.stream?.viewers === 3 && md?.stream?.peakViewers === 5);
  await ok("heartbeat without counters", ls.heartbeatStream, P.org.uid, { matchId: "M1" });
  check("no counters keeps values", (await m(db, "M1"))?.stream?.viewers === 3);
  await expectFail("heartbeat by a player", ls.heartbeatStream, P.a1.uid, { matchId: "M1", viewers: 1 }, "NOT_ORGANIZER");
  await expectFail("heartbeat bad viewers", ls.heartbeatStream, P.org.uid, { matchId: "M1", viewers: -1 }, "INVALID_ARGUMENT",
    "viewers must be a number of 0 or more.");
  await expectFail("heartbeat on a match without a stream", ls.heartbeatStream, P.org.uid, { matchId: "M-OFF" }, "STREAM_ENDED",
    "This match isn't being streamed.");

  console.log("  restart with a new broadcast");
  const rs = await ok<{ streamStatus: string }>("same organizer, new video = restart", ls.startStream, P.org.uid,
    { matchId: "M1", provider: "youtube", videoId: VID[2] });
  md = await m(db, "M1");
  td = await t(db);
  check("restart replaces the video and resets counters", rs?.streamStatus === "restarted" && md?.stream?.videoId === VID[2] &&
    md?.stream?.viewers === 0 && md?.stream?.peakViewers === 0 && md?.stream?.status === "live" && md?.stream?.label === "SF1" &&
    md?.stream?.bitrateKbps === undefined);
  check("restart updates the entry, still 2 streams", td?.liveStreamCount === 2 &&
    td?.liveStreams?.find((x: { matchId: string }) => x.matchId === "M1")?.videoId === VID[2] && ids(td?.liveStreams) === "M2,M1",
  ids(td?.liveStreams));

  console.log("  end");
  await ok("heartbeat before end", ls.heartbeatStream, P.org.uid, { matchId: "M1", viewers: 9 });
  await expectFail("player can't end", ls.endStream, P.a1.uid, { matchId: "M1" }, "NOT_ORGANIZER");
  const end = await ok<{ status: string; alreadyEnded: boolean; endedReason: string; durationSec: number; peakViewers: number; reconnects: number }>(
    "organizer ends M1 (final reconnects 4)", ls.endStream, P.org.uid, { matchId: "M1", reconnects: 4 });
  md = await m(db, "M1");
  td = await t(db);
  check("end result", end?.status === "ended" && end?.alreadyEnded === false && end?.endedReason === "organizer" &&
    typeof end?.durationSec === "number" && end?.peakViewers === 9 && end?.reconnects === 4);
  check("stream kept for replay", md?.stream?.status === "ended" && md?.stream?.videoId === VID[2] &&
    md?.stream?.endedAt instanceof Timestamp && md?.stream?.endedReason === "organizer" && md?.stream?.peakViewers === 9);
  check("entry removed", td?.liveStreamCount === 1 && ids(td?.liveStreams) === "M2");
  const again = await ok<{ alreadyEnded: boolean; endedReason: string }>("end again = no-op", ls.endStream, P.org.uid, { matchId: "M1" });
  check("idempotent end", again?.alreadyEnded === true && again?.endedReason === "organizer" && (await t(db))?.liveStreamCount === 1);
  const none = await ok<{ alreadyEnded: boolean }>("end on a match never streamed", ls.endStream, P.org.uid, { matchId: "M-OFF" });
  check("no stream = no-op", none?.alreadyEnded === true && (await m(db, "M-OFF"))?.stream === undefined);
  await expectFail("heartbeat after end", ls.heartbeatStream, P.org.uid, { matchId: "M1", viewers: 1 }, "STREAM_ENDED",
    "This stream has ended.", "failed-precondition");
  await ok("a new stream on the same match after end", ls.startStream, P.org.uid, { matchId: "M1", provider: "youtube", videoId: VID[3] });
  check("new stream replaces the ended one", (await m(db, "M1"))?.stream?.status === "live" &&
    (await m(db, "M1"))?.stream?.videoId === VID[3] && (await t(db))?.liveStreamCount === 2);

  console.log("  switch off with streams running");
  await setSwitch(db, {});
  await ok("switch off: heartbeat still works", ls.heartbeatStream, P.org.uid, { matchId: "M1", viewers: 2 });
  await ok("switch off: resume still works", ls.startStream, P.org.uid, { matchId: "M1", provider: "youtube", videoId: VID[3] });
  await newMatch(db, "M-NEW");
  await expectFail("switch off: no new stream", ls.startStream, P.org.uid, { matchId: "M-NEW", provider: "youtube", videoId: VID[4] },
    "LIVE_STREAMING_DISABLED");
  await setSwitch(db, { badminton: true });
  await ok("end M1", ls.endStream, P.org.uid, { matchId: "M1" }, true);
  await ok("end M2", ls.endStream, P.org.uid, { matchId: "M2" }, true);
  td = await t(db);
  check("all ended: empty list, count 0", td?.liveStreamCount === 0 && Array.isArray(td?.liveStreams) && td.liveStreams.length === 0);
}

async function activeAndStale(db: Firestore): Promise<void> {
  console.log("\n── STREAM_ACTIVE, stale takeover, cleanup job (injected clock), orphan entries ──");
  await newMatch(db, "M-ACT");
  await ok("start", ls.startStream, P.org.uid, { matchId: "M-ACT", provider: "youtube", videoId: VID[0] });
  // Someone else's live stream (e.g. the tournament changed hands).
  await db.collection("matches").doc("M-ACT").update({ "stream.byUid": "someone-else", "stream.byName": "Sam" });
  await expectFail("another streamer's live stream", ls.startStream, P.org.uid, { matchId: "M-ACT", provider: "youtube", videoId: VID[1] },
    "STREAM_ACTIVE", "Sam is streaming this match.", "failed-precondition");
  await ok("organizer can still heartbeat / end it", ls.heartbeatStream, P.org.uid, { matchId: "M-ACT", viewers: 1 });
  await db.collection("matches").doc("M-ACT").update({ "stream.lastHeartbeatAt": Timestamp.fromMillis(Date.now() - 11 * 60_000) });
  const take = await ok<{ streamStatus: string }>("stale stream can be replaced", ls.startStream, P.org.uid,
    { matchId: "M-ACT", provider: "youtube", videoId: VID[1] });
  const md = await m(db, "M-ACT");
  check("replaced as a new stream", take?.streamStatus === "started" && md?.stream?.byUid === P.org.uid && md?.stream?.videoId === VID[1] &&
    (await t(db))?.liveStreamCount === 1);

  console.log("  cleanup job");
  await newMatch(db, "M-STALE");
  await newMatch(db, "M-FRESH");
  await ok("start stale-to-be", ls.startStream, P.org.uid, { matchId: "M-STALE", provider: "youtube", videoId: VID[2] }, true);
  await ok("start fresh", ls.startStream, P.org.uid, { matchId: "M-FRESH", provider: "youtube", videoId: VID[3] }, true);
  await db.collection("matches").doc("M-STALE").update({ "stream.lastHeartbeatAt": Timestamp.fromMillis(Date.now() - 10 * 60_000 - 5000) });
  let r = await svc.runStreamCleanup(db, new Date());
  check("9:59 and fresh streams stay, 10:05 ends", r.stale === 1 && (await m(db, "M-STALE"))?.stream?.endedReason === "stale" &&
    (await m(db, "M-STALE"))?.stream?.status === "ended" && (await m(db, "M-FRESH"))?.stream?.status === "live" &&
    (await m(db, "M-ACT"))?.stream?.status === "live", JSON.stringify(r));
  let td = await t(db);
  check("stale entry removed", td?.liveStreamCount === 2 && ids(td?.liveStreams) === "M-ACT,M-FRESH", ids(td?.liveStreams));
  r = await svc.runStreamCleanup(db, new Date(Date.now() + 9 * 60_000));
  check("clock +9 min: nothing ends", r.stale === 0 && (await t(db))?.liveStreamCount === 2, JSON.stringify(r));
  r = await svc.runStreamCleanup(db, new Date(Date.now() + 11 * 60_000));
  td = await t(db);
  check("clock +11 min: both end stale", r.stale === 2 && td?.liveStreamCount === 0 &&
    (await m(db, "M-FRESH"))?.stream?.endedReason === "stale", JSON.stringify(r));
  await expectFail("heartbeat after stale end tells the phone to stop", ls.heartbeatStream, P.org.uid, { matchId: "M-FRESH" }, "STREAM_ENDED");

  console.log("  orphan entries");
  await newMatch(db, "M-ORPH");
  await ok("start", ls.startStream, P.org.uid, { matchId: "M-ORPH", provider: "youtube", videoId: VID[4] }, true);
  const entries = (await t(db))?.liveStreams ?? [];
  await db.collection("tournaments").doc(TB).update({
    liveStreams: [...entries, { matchId: "M-GONE", videoId: VID[5], label: "QF", teamAName: "", teamBName: "", viewers: 0, startedAt: Timestamp.now() },
      { matchId: "M-STALE", videoId: VID[2], label: "x", teamAName: "", teamBName: "", viewers: 0, startedAt: Timestamp.now() }],
    liveStreamCount: entries.length + 2,
  });
  r = await svc.runStreamCleanup(db, new Date());
  td = await t(db);
  check("deleted-match and ended-stream entries dropped", r.dropped === 2 && td?.liveStreamCount === 1 && ids(td?.liveStreams) === "M-ORPH",
    JSON.stringify(r));
  await db.collection("matches").doc("M-ORPH").delete();
  await trigger.syncStream(db, "M-ORPH", { tournamentId: TB, stream: { status: "live", videoId: VID[4] } } as never, undefined);
  td = await t(db);
  check("trigger: deleted live match leaves the list", td?.liveStreamCount === 0 && ids(td?.liveStreams) === "");
}

async function finishEnds(db: Firestore): Promise<void> {
  console.log("\n── a finished match ends its stream (match_finished) ──");
  const start = async (id: string, v: string) => {
    await newMatch(db, id);
    await ok(`start ${id}`, ls.startStream, P.org.uid, { matchId: id, provider: "youtube", videoId: v }, true);
  };
  await start("F-ORG", VID[0]);
  await start("F-PLAYER", VID[1]);
  await start("F-RACKET", VID[2]);
  await start("F-OLD", VID[3]);
  await start("F-STATUS", VID[4]);
  check("five live", (await t(db))?.liveStreamCount === 5);

  await ok("organizer submitScore", scores.submitScore, P.org.uid,
    { matchId: "F-ORG", setScores: [{ teamAPoints: 11, teamBPoints: 3 }, { teamAPoints: 11, teamBPoints: 4 }] });
  let md = await m(db, "F-ORG");
  check("organizer finish ends the stream", md?.statusRaw === "finished" && md?.eloApplied === true &&
    md?.stream?.status === "ended" && md?.stream?.endedReason === "match_finished" && md?.stream?.videoId === VID[0]);
  check("entry removed", !ids((await t(db))?.liveStreams).includes("F-ORG") && (await t(db))?.liveStreamCount === 4);

  await ok("player submitScore", scores.submitScore, P.a1.uid,
    { matchId: "F-PLAYER", setScores: [{ teamAPoints: 11, teamBPoints: 3 }, { teamAPoints: 11, teamBPoints: 4 }] });
  check("score submitted: stream stays live", (await m(db, "F-PLAYER"))?.stream?.status === "live");
  await ok("other side confirms", scores.confirmScore, P.b1.uid, { matchId: "F-PLAYER" });
  md = await m(db, "F-PLAYER");
  check("confirm ends the stream", md?.statusRaw === "finished" && md?.stream?.endedReason === "match_finished" &&
    (await t(db))?.liveStreamCount === 3);

  await ok("racket live: organizer starts scoring", racket.startRacketScoring, P.org.uid, { matchId: "F-RACKET", firstServer: "A" });
  check("live scoring and streaming side by side", (await m(db, "F-RACKET"))?.live?.status === "inProgress" &&
    (await m(db, "F-RACKET"))?.stream?.status === "live");
  let n = 0;
  for (const w of "A".repeat(22)) await ok("point", racket.recordPoint, P.org.uid, { matchId: "F-RACKET", pointId: `fp${++n}`, winner: w }, true);
  await ok("heartbeat during live scoring", ls.heartbeatStream, P.org.uid, { matchId: "F-RACKET", viewers: 7 });
  await ok("racket live finish", racket.finishRacketMatch, P.org.uid, { matchId: "F-RACKET" });
  md = await m(db, "F-RACKET");
  check("racket finish ends the stream", md?.statusRaw === "finished" && md?.live?.status === "finished" &&
    md?.stream?.endedReason === "match_finished" && md?.stream?.peakViewers === 7 && (await t(db))?.liveStreamCount === 2);

  // Older apps finish by a direct write; the match trigger ends the stream.
  const beforeOld = await m(db, "F-OLD");
  await db.collection("matches").doc("F-OLD").update({ statusRaw: "finished", scoreA: 2, scoreB: 0 });
  await trigger.syncStream(db, "F-OLD", beforeOld, await m(db, "F-OLD"));
  md = await m(db, "F-OLD");
  check("direct finish: trigger ends the stream", md?.stream?.endedReason === "match_finished" && (await t(db))?.liveStreamCount === 1);

  // Missed trigger: the cleanup job catches a finished match with a live stream.
  await db.collection("matches").doc("F-STATUS").update({ statusRaw: "finished" });
  const r = await svc.runStreamCleanup(db, new Date());
  check("cleanup catches finished matches", r.finished === 1 && (await m(db, "F-STATUS"))?.stream?.endedReason === "match_finished" &&
    (await t(db))?.liveStreamCount === 0, JSON.stringify(r));
  await expectFail("no stream on a finished match", ls.startStream, P.org.uid, { matchId: "F-ORG", provider: "youtube", videoId: VID[5] },
    "MATCH_FINISHED");
  const fin = await ok<{ alreadyEnded: boolean }>("end on a finished match = no-op", ls.endStream, P.org.uid, { matchId: "F-ORG" });
  check("already ended by finish", fin?.alreadyEnded === true);
}

function triggerFilter(): void {
  console.log("\n── match trigger ignores stream-only writes ──");
  const base = { tournamentId: TB, teamAId: "A", teamBId: "B", statusRaw: "scheduled", createdAt: Timestamp.fromMillis(1) } as never;
  const withStream = { ...(base as object), stream: { status: "live", viewers: 3 } } as never;
  const moreViewers = { ...(base as object), stream: { status: "live", viewers: 4 } } as never;
  const finished = { ...(withStream as object), statusRaw: "finished" } as never;
  check("stream added: ignored", trigger.onlyLiveChanged(base, withStream));
  check("heartbeat: ignored", trigger.onlyLiveChanged(withStream, moreViewers));
  check("status change with a stream: handled", !trigger.onlyLiveChanged(withStream, finished));
}

async function main(): Promise<void> {
  const db = getFirestore();
  await clear(db);
  await seed(db);
  await newMatch(db, "M1");
  await newMatch(db, "M2");
  await switchAndInput(db);
  await lifecycle(db);
  await activeAndStale(db);
  await finishEnds(db);
  triggerFilter();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Emulator checks crashed:", err);
  process.exit(1);
});
