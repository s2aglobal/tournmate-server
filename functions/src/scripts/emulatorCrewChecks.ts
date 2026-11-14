/**
 * Emulator checks for Tournament crew (callables/crew.ts, services/crew.ts)
 * and the server-held YouTube connection (callables/youtubeServer.ts,
 * services/youtubeServer.ts): invite / join / add / remove / leave, rights,
 * finished and cancelled tournaments, crew size, crew members streaming
 * (startStream / heartbeatStream / endStream), the organizer ending a crew
 * stream, removal ending a stream, connect / disconnect / createCrewBroadcast
 * with Google stubbed (an injected fetch: nothing reaches Google), YouTube
 * error mapping, the rate limit and the server-broadcast sweep.
 * Runs the handlers directly (`.run`) against the Firestore emulator.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-crew
 * which runs, under `firebase emulators:exec --only firestore --project demo-tournmate`:
 *   node lib/scripts/emulatorCrewChecks.js
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp, Firestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore emulator and a demo-* project (use npm run test:emulator-crew).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });

/* eslint-disable @typescript-eslint/no-var-requires */
const crew = require("../callables/crew") as typeof import("../callables/crew");
const ytc = require("../callables/youtubeServer") as typeof import("../callables/youtubeServer");
const ls = require("../callables/liveStream") as typeof import("../callables/liveStream");
const lsvc = require("../services/liveStream") as typeof import("../services/liveStream");
const yts = require("../services/youtubeServer") as typeof import("../services/youtubeServer");
const crewSvc = require("../services/crew") as typeof import("../services/crew");

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

// ─── Fake Google ────────────────────────────────────────

interface Sent { method: string; url: string; headers: Record<string, string>; body?: string }
const sent: Sent[] = [];
const g = {
  refreshFails: false,
  insertBroadcastError: null as null | { status: number; reason: string },
  bindFails: false,
  transition: "ok" as "ok" | "invalid",
  lifeCycle: "ready",
  nextVideo: 0,
  refreshCounter: 0,
};
const VIDEO_IDS = ["SrvVideo001", "SrvVideo002", "SrvVideo003", "SrvVideo004", "SrvVideo005", "SrvVideo006", "SrvVideo007",
  "SrvVideo008", "SrvVideo009", "SrvVideo010", "SrvVideo011", "SrvVideo012", "SrvVideo013", "SrvVideo014"];

function res(status: number, body: unknown): import("../services/youtubeServer").HttpResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
}
function apiError(status: number, reason: string) {
  return { error: { code: status, message: reason, errors: [{ reason }] } };
}

const fakeFetch: import("../services/youtubeServer").FetchFn = async (url, init) => {
  sent.push({ method: init.method, url, headers: init.headers ?? {}, body: init.body });
  const u = new URL(url);
  const form = new URLSearchParams(init.body ?? "");
  if (u.href.startsWith("https://oauth2.googleapis.com/token")) {
    if (form.get("client_id") !== "cid" || form.get("client_secret") !== "csec") return res(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code");
      if (code === "good" || code === "good2") {
        return res(200, { access_token: "at-exchange", refresh_token: code === "good" ? "rt-secret-1" : "rt-secret-2",
          scope: `openid ${yts.YOUTUBE_SCOPE}`, expires_in: 3599 });
      }
      if (code === "noscope") return res(200, { access_token: "at-x", refresh_token: "rt-noscope", scope: "openid email" });
      if (code === "nochannel") return res(200, { access_token: "at-nochannel", refresh_token: "rt-nochannel", scope: yts.YOUTUBE_SCOPE });
      return res(400, { error: "invalid_grant" });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (g.refreshFails) return res(400, { error: "invalid_grant" });
      return res(200, { access_token: `at-${form.get("refresh_token")}-${++g.refreshCounter}`, expires_in: 3599 });
    }
  }
  if (u.href.startsWith("https://oauth2.googleapis.com/revoke")) return res(200, {});
  if (!u.href.startsWith("https://www.googleapis.com/youtube/v3/")) return res(404, {});
  const path = u.pathname.replace("/youtube/v3/", "");
  if (path === "channels") {
    if (init.headers?.Authorization === "Bearer at-nochannel") return res(200, { items: [] });
    return res(200, { items: [{ id: "UC_olga", snippet: { title: "Olga's Club" } }] });
  }
  if (path === "liveBroadcasts" && init.method === "POST") {
    if (g.insertBroadcastError) return res(g.insertBroadcastError.status, apiError(g.insertBroadcastError.status, g.insertBroadcastError.reason));
    return res(200, { id: VIDEO_IDS[g.nextVideo++] });
  }
  if (path === "liveStreams" && init.method === "POST") {
    return res(200, { id: `stream-${g.nextVideo}`, cdn: { ingestionInfo: { streamName: `key-${g.nextVideo}`,
      ingestionAddress: "rtmp://a.rtmp.youtube.com/live2", rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com:443/live2" } } });
  }
  if (path === "liveBroadcasts/bind") return g.bindFails ? res(403, apiError(403, "forbidden")) : res(200, { id: u.searchParams.get("id") });
  if (path === "liveBroadcasts/transition") {
    return g.transition === "ok" ? res(200, { id: u.searchParams.get("id"), status: { lifeCycleStatus: "complete" } }) :
      res(403, apiError(403, "invalidTransition"));
  }
  if (path === "liveBroadcasts" && init.method === "GET") return res(200, { items: [{ status: { lifeCycleStatus: g.lifeCycle } }] });
  if (path === "liveBroadcasts" && init.method === "DELETE") return res(204, undefined);
  return res(404, {});
};

const KEY = Buffer.alloc(32, 7).toString("base64");
yts.setYouTubeDepsForTests({ fetch: fakeFetch, clientId: () => "cid", clientSecret: () => "csec", tokenKey: () => KEY });

function sentTo(path: string, method?: string): Sent[] {
  return sent.filter((s) => s.url.includes(path) && (!method || s.method === method));
}

// ─── Data ───────────────────────────────────────────────

const P = {
  org: { id: "CCCCCCCC-0000-0000-0000-000000000000", uid: "c-org", name: "Olga Organizer" },
  a1: { id: "CCCCCCCC-0000-0000-0000-0000000000A1", uid: "ca1", name: "Priya Shah" },
  a2: { id: "CCCCCCCC-0000-0000-0000-0000000000A2", uid: "ca2", name: "Arjun Rao" },
  b1: { id: "CCCCCCCC-0000-0000-0000-0000000000B1", uid: "cb1", name: "Maya Lee" },
  b2: { id: "CCCCCCCC-0000-0000-0000-0000000000B2", uid: "cb2", name: "Leo Park" },
  h: { id: "CCCCCCCC-0000-0000-0000-0000000000F1", uid: "ch", name: "Hana Helper" },
  h2: { id: "CCCCCCCC-0000-0000-0000-0000000000F2", uid: "ch2", name: "Hugo Helper" },
  x: { id: "CCCCCCCC-0000-0000-0000-0000000000FF", uid: "cx", name: "Xavi Outsider" },
};
const T = "T-CREW";
const TF = "T-CREW-FIN";
const TX = "T-CREW-CXL";
const TT = "T-CREW-TEN";
const DEVICE_VID = "dQw4w9WgXcQ";
const SCORING = JSON.stringify({ gamesPerMatch: 3, pointsToWin: 11, winBy: 2, pointCap: 15, scoringSystem: "rally" });

async function clear(db: Firestore): Promise<void> {
  for (const c of ["players", "tournaments", "registrations", "matches", "notifications", "config", "crewInvites",
    "serverBroadcasts", "serverBroadcastRate", "private_youtube"]) {
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
  const t = async (id: string, extra: Record<string, unknown>) => db.collection("tournaments").doc(id).set({
    title: `Club Night ${id}`, date: Timestamp.now(), statusRaw: "scheduled", sportType: "badminton", formatRaw: "openDoubles",
    matchFormatRaw: "singleElimination", createdBy: P.org.uid, location: "Hall", createdAt: Timestamp.now(), drawMade: true,
    scoringConfigData: SCORING, ...extra,
  });
  await t(T, {});
  await t(TF, {});
  await t(TX, { statusRaw: "cancelled" });
  await t(TT, { sportType: "tennis", formatRaw: "openSingles", scoringConfigData: null });
  for (const tid of [T, TF, TX, TT]) {
    await db.collection("registrations").doc(`${tid}-RA`).set({ tournamentId: tid, playerId: P.a1.id, partnerId: P.a2.id, createdAt: Timestamp.now() });
    // lower-case id on this registration: the server compares ids case-insensitively.
    await db.collection("registrations").doc(`${tid}-RB`).set({ tournamentId: tid, playerId: P.b1.id.toLowerCase(), partnerId: P.b2.id, createdAt: Timestamp.now() });
  }
  await db.collection("config").doc("sports").set({
    schemaVersion: 1, live: ["badminton", "tennis"], categories: [], liveScoring: { badminton: true },
    liveStreaming: { badminton: true, tennis: true },
  });
}

async function newMatch(db: Firestore, id: string, tid = T, extra: Record<string, unknown> = {}): Promise<void> {
  await db.collection("matches").doc(id).set({
    tournamentId: tid, teamAId: `${tid}-RA`, teamBId: `${tid}-RB`, round: 1, statusRaw: "scheduled", sportType: "badminton",
    teamAUids: [P.a1.uid, P.a2.uid], teamBUids: [P.b1.uid, P.b2.uid], createdAt: Timestamp.now(), ...extra,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function doc(db: Firestore, path: string): Promise<any> {
  return (await db.doc(path).get()).data();
}

// ─── Sections ───────────────────────────────────────────

async function invites(db: Firestore): Promise<string> {
  console.log("\n── createCrewInvite / joinCrew by code ──");
  await expectFail("invite: signed out", crew.createCrewInvite, null, { tournamentId: T }, "UNAUTHENTICATED");
  await expectFail("invite: missing tournament", crew.createCrewInvite, P.org.uid, {}, "INVALID_ARGUMENT", "Missing tournament.");
  await expectFail("invite: unknown tournament", crew.createCrewInvite, P.org.uid, { tournamentId: "NOPE" }, "NOT_FOUND");
  await expectFail("invite: player refused", crew.createCrewInvite, P.a1.uid, { tournamentId: T }, "NOT_ORGANIZER",
    "Only the organizer can manage the crew.", "permission-denied");
  await expectFail("invite: cancelled tournament", crew.createCrewInvite, P.org.uid, { tournamentId: TX }, "TOURNAMENT_CLOSED",
    "This tournament was cancelled.", "failed-precondition");
  const inv = await ok<{ code: string; url: string; created: boolean }>("organizer creates an invite (lower-case id)",
    crew.createCrewInvite, P.org.uid, { tournamentId: T.toLowerCase() });
  const code = inv?.code ?? "";
  check("invite shape", /^[A-HJKMNP-Z2-9]{10}$/.test(code) && inv?.url === `https://www.tournmate.com/crew/${code}` && inv?.created === true,
    JSON.stringify(inv));
  const stored = await doc(db, `crewInvites/${code}`);
  check("crewInvites doc", stored?.tournamentId === T && stored?.createdBy === P.org.uid && stored?.role === "camera" &&
    stored?.createdAt instanceof Timestamp, JSON.stringify(stored));
  const again = await ok<{ code: string; created: boolean }>("invite again returns the same code", crew.createCrewInvite, P.org.uid, { tournamentId: T });
  check("same code, created false", again?.code === code && again?.created === false);
  const rot = await ok<{ code: string; created: boolean }>("rotate: new code", crew.createCrewInvite, P.org.uid, { tournamentId: T, rotate: true });
  check("rotated code differs, old deleted", !!rot && rot.code !== code && rot.created && !(await doc(db, `crewInvites/${code}`)) &&
    (await db.collection("crewInvites").where("tournamentId", "==", T).get()).size === 1);
  const fresh = rot?.code ?? "";
  await expectFail("join: old code refused", crew.joinCrew, P.h.uid, { code }, "INVITE_INVALID",
    "This crew invite isn't valid anymore. Ask the organizer for a new one.", "not-found");
  await expectFail("join: malformed code", crew.joinCrew, P.h.uid, { code: "abc" }, "INVITE_INVALID");
  await expectFail("join: signed out", crew.joinCrew, null, { code: fresh }, "UNAUTHENTICATED");
  await expectFail("join: no player profile", crew.joinCrew, "no-profile-uid", { code: fresh }, "NO_PROFILE");
  await expectFail("join: organizer refused", crew.joinCrew, P.org.uid, { code: fresh }, "IS_ORGANIZER",
    "You organize this tournament, so you can already stream it.");
  await expectFail("join: neither code nor tournament", crew.joinCrew, P.h.uid, {}, "INVALID_ARGUMENT", "Missing tournament.");
  const j = await ok<{ tournamentId: string; member: Record<string, unknown>; alreadyJoined: boolean }>(
    "helper joins by code (lower case, dashed)", crew.joinCrew, P.h.uid, { code: `${fresh.slice(0, 5).toLowerCase()}-${fresh.slice(5).toLowerCase()}` });
  check("join result", j?.tournamentId === T && j?.alreadyJoined === false && j?.member?.status === "joined" &&
    j?.member?.role === "camera" && j?.member?.via === "link" && j?.member?.uid === P.h.uid && typeof j?.member?.joinedAt === "number",
  JSON.stringify(j));
  const m = (await doc(db, `tournaments/${T}`))?.crew?.[P.h.uid];
  check("tournament crew entry", m?.role === "camera" && m?.status === "joined" && m?.name === "Hana Helper" && m?.playerId === P.h.id &&
    m?.invitedBy === P.h.uid && m?.invitedAt instanceof Timestamp && m?.joinedAt instanceof Timestamp && m?.via === "link", JSON.stringify(m));
  const j2 = await ok<{ alreadyJoined: boolean }>("join again = no-op", crew.joinCrew, P.h.uid, { code: fresh });
  check("alreadyJoined", j2?.alreadyJoined === true);
  await ok("second helper joins with the full URL", crew.joinCrew, P.h2.uid, { code: `https://www.tournmate.com/crew/${fresh}` });
  check("two link members", Object.keys((await doc(db, `tournaments/${T}`))?.crew ?? {}).length === 2);
  return fresh;
}

async function adding(db: Firestore): Promise<void> {
  console.log("\n── addCrewMember (registered players) / joinCrew by tournament ──");
  await expectFail("add: player refused", crew.addCrewMember, P.a1.uid, { tournamentId: T, uid: P.a2.uid }, "NOT_ORGANIZER");
  await expectFail("add: missing player", crew.addCrewMember, P.org.uid, { tournamentId: T }, "INVALID_ARGUMENT", "Missing player.");
  await expectFail("add: not registered", crew.addCrewMember, P.org.uid, { tournamentId: T, uid: P.x.uid }, "NOT_REGISTERED",
    "That player isn't registered in this tournament.");
  await expectFail("add: unknown uid", crew.addCrewMember, P.org.uid, { tournamentId: T, uid: "ghost" }, "NOT_REGISTERED",
    "That player doesn't have a TournMate account.");
  await expectFail("add: organizer self", crew.addCrewMember, P.org.uid, { tournamentId: T, uid: P.org.uid }, "IS_ORGANIZER");
  await expectFail("add: cancelled tournament", crew.addCrewMember, P.org.uid, { tournamentId: TX, uid: P.a1.uid }, "TOURNAMENT_CLOSED");
  const r = await ok<{ member: Record<string, unknown>; alreadyMember: boolean }>("organizer adds a registered player by uid",
    crew.addCrewMember, P.org.uid, { tournamentId: T, uid: P.a1.uid });
  check("added as invited", r?.alreadyMember === false && r?.member?.status === "invited" && r?.member?.via === "player" &&
    r?.member?.name === "Priya Shah" && r?.member?.invitedBy === P.org.uid && r?.member?.joinedAt === undefined, JSON.stringify(r));
  const notes = await db.collection("notifications").where("recipientId", "==", P.a1.uid).get();
  const n = notes.docs[0]?.data();
  check("crew_invite notification", notes.size === 1 && n?.type === "crew_invite" && n?.tournamentId === T && n?.role === "camera" &&
    n?.title === "Join the camera crew" && n?.body === `Olga Organizer asked you to stream matches at Club Night ${T}. Tap to join.`,
  JSON.stringify(n));
  const again = await ok<{ alreadyMember: boolean }>("add again = no-op", crew.addCrewMember, P.org.uid, { tournamentId: T, uid: P.a1.uid });
  check("no second notification", again?.alreadyMember === true &&
    (await db.collection("notifications").where("recipientId", "==", P.a1.uid).get()).size === 1);
  await ok("add by playerId (registered with a lower-case id)", crew.addCrewMember, P.org.uid, { tournamentId: T, playerId: P.b1.id });
  check("b1 invited", (await doc(db, `tournaments/${T}`))?.crew?.[P.b1.uid]?.status === "invited");

  await expectFail("join by tournament: not invited", crew.joinCrew, P.a2.uid, { tournamentId: T }, "NOT_INVITED",
    "You haven't been invited to this crew.", "failed-precondition");
  const j = await ok<{ member: Record<string, unknown>; alreadyJoined: boolean }>("invited player joins with one tap",
    crew.joinCrew, P.a1.uid, { tournamentId: T });
  const m = (await doc(db, `tournaments/${T}`))?.crew?.[P.a1.uid];
  check("invite accepted", j?.alreadyJoined === false && m?.status === "joined" && m?.via === "player" && m?.invitedBy === P.org.uid &&
    m?.joinedAt instanceof Timestamp, JSON.stringify(m));

  console.log("  finished tournament");
  const inv = await ok<{ code: string }>("invite on TF while open", crew.createCrewInvite, P.org.uid, { tournamentId: TF }, true);
  await ok("add a1 to TF while open", crew.addCrewMember, P.org.uid, { tournamentId: TF, uid: P.a1.uid }, true);
  await ok("a1 joins TF", crew.joinCrew, P.a1.uid, { tournamentId: TF }, true);
  await newMatch(db, "MF1", TF);
  await db.collection("tournaments").doc(TF).update({ finished: true });
  await expectFail("finished: invite refused", crew.createCrewInvite, P.org.uid, { tournamentId: TF }, "TOURNAMENT_CLOSED",
    "This tournament has finished.");
  await expectFail("finished: add refused", crew.addCrewMember, P.org.uid, { tournamentId: TF, uid: P.b1.uid }, "TOURNAMENT_CLOSED");
  await expectFail("finished: join by code refused", crew.joinCrew, P.h.uid, { code: inv?.code }, "TOURNAMENT_CLOSED");
  await expectFail("finished: crew member can't stream", ls.startStream, P.a1.uid,
    { matchId: "MF1", provider: "youtube", videoId: DEVICE_VID, playersAgreed: true }, "TOURNAMENT_CLOSED",
    "This tournament has ended, so the crew can't stream anymore.");
  await expectFail("finished: crew member can't create a broadcast", ytc.createCrewBroadcast, P.a1.uid, { matchId: "MF1" }, "TOURNAMENT_CLOSED");
  check("hasCrewRole false once finished", !crewSvc.hasCrewRole(await doc(db, `tournaments/${TF}`), P.a1.uid, "camera"));
  const left = await ok<{ left: boolean }>("leave still works on a finished tournament", crew.leaveCrew, P.a1.uid, { tournamentId: TF });
  check("left", left?.left === true);

  console.log("  crew size");
  const full: Record<string, unknown> = {};
  for (let i = 0; i < crewSvc.MAX_CREW; i++) {
    full[`fill-${i}`] = { role: "camera", status: "joined", name: `F${i}`, playerId: `P${i}`, invitedBy: "x", invitedAt: Timestamp.now(), via: "link" };
  }
  await db.collection("tournaments").doc(TT).update({ crew: full });
  await expectFail("crew full: add refused", crew.addCrewMember, P.org.uid, { tournamentId: TT, uid: P.a1.uid }, "CREW_FULL",
    "The crew is full (20 people).");
  const ti = await ok<{ code: string }>("invite on full crew", crew.createCrewInvite, P.org.uid, { tournamentId: TT }, true);
  await expectFail("crew full: join by code refused", crew.joinCrew, P.h.uid, { code: ti?.code }, "CREW_FULL");
  await db.collection("tournaments").doc(TT).update({ crew: {} });
}

async function youtubeConnect(db: Firestore): Promise<void> {
  console.log("\n── connectYouTubeServer / getYouTubeConnection (Google stubbed) ──");
  await newMatch(db, "M1");
  await expectFail("crew broadcast before the organizer connects", ytc.createCrewBroadcast, P.a1.uid, { matchId: "M1" },
    "YOUTUBE_NOT_CONNECTED", "Ask the organizer to connect YouTube in TournMate.", "failed-precondition");
  await expectFail("organizer broadcast before connecting", ytc.createCrewBroadcast, P.org.uid, { matchId: "M1" },
    "YOUTUBE_NOT_CONNECTED", "Connect YouTube in TournMate first.");
  const st0 = await ok<{ connected: boolean }>("status: not connected", ytc.getYouTubeConnection, P.org.uid, {});
  check("not connected", st0?.connected === false);
  await expectFail("connect: signed out", ytc.connectYouTubeServer, null, { authCode: "good" }, "UNAUTHENTICATED");
  await expectFail("connect: missing code", ytc.connectYouTubeServer, P.org.uid, {}, "INVALID_ARGUMENT", "Missing authCode.");
  await expectFail("connect: Google refuses the code", ytc.connectYouTubeServer, P.org.uid, { authCode: "bad" }, "YOUTUBE_CODE_INVALID",
    "Couldn't connect YouTube. Try connecting again.", "invalid-argument");
  await expectFail("connect: YouTube scope not granted", ytc.connectYouTubeServer, P.org.uid, { authCode: "noscope" },
    "YOUTUBE_SCOPE_MISSING");
  sent.length = 0;
  await expectFail("connect: account without a channel", ytc.connectYouTubeServer, P.org.uid, { authCode: "nochannel" },
    "YOUTUBE_NO_CHANNEL", "This Google account has no YouTube channel. Create one at youtube.com, then connect again.");
  check("no-channel token revoked, nothing stored", sentTo("oauth2.googleapis.com/revoke").length === 1 && !(await doc(db, `private_youtube/${P.org.uid}`)));

  sent.length = 0;
  const c = await ok<{ connected: boolean; channelId: string; channelTitle: string }>("organizer connects", ytc.connectYouTubeServer,
    P.org.uid, { authCode: "good" });
  check("connect result", c?.connected === true && c?.channelId === "UC_olga" && c?.channelTitle === "Olga's Club");
  const tok = sentTo("oauth2.googleapis.com/token")[0];
  const f = new URLSearchParams(tok?.body ?? "");
  check("token exchange request", tok?.method === "POST" && f.get("grant_type") === "authorization_code" && f.get("code") === "good" &&
    f.get("client_id") === "cid" && f.get("client_secret") === "csec" && f.get("redirect_uri") === "" &&
    tok?.headers["Content-Type"] === "application/x-www-form-urlencoded", tok?.body);
  const ch = sentTo("/channels")[0];
  check("channels.list mine=true with the exchanged token", ch?.url === "https://www.googleapis.com/youtube/v3/channels?mine=true&part=snippet" &&
    ch?.headers.Authorization === "Bearer at-exchange", ch?.url);
  const pd = await doc(db, `private_youtube/${P.org.uid}`);
  check("stored encrypted", typeof pd?.enc === "string" && typeof pd?.iv === "string" && typeof pd?.tag === "string" &&
    pd?.channelId === "UC_olga" && pd?.channelTitle === "Olga's Club" && pd?.connectedAt instanceof Timestamp &&
    !JSON.stringify(pd).includes("rt-secret"), JSON.stringify(pd));
  const key = yts.tokenKey(KEY);
  check("decrypts with the key + uid", yts.unseal(pd, key, P.org.uid) === "rt-secret-1");
  let wrongUid = false;
  try {
    yts.unseal(pd, key, P.a1.uid);
  } catch {
    wrongUid = true;
  }
  check("another uid can't decrypt (AAD)", wrongUid);
  check("non-base64 key derives 32 bytes", yts.tokenKey("not a base64 key").length === 32);

  const st = await ok<{ connected: boolean; channelTitle: string; needsReconnect: boolean; connectedAt: number }>("status: connected",
    ytc.getYouTubeConnection, P.org.uid, {});
  check("own status", st?.connected === true && st?.channelTitle === "Olga's Club" && st?.needsReconnect === false && typeof st?.connectedAt === "number");
  const cs = await ok<{ connected: boolean; channelTitle: string }>("crew member sees the organizer's connection",
    ytc.getYouTubeConnection, P.a1.uid, { tournamentId: T });
  check("crew status", cs?.connected === true && cs?.channelTitle === "Olga's Club");
  await expectFail("outsider can't see the organizer's connection", ytc.getYouTubeConnection, P.x.uid, { tournamentId: T }, "NOT_ORGANIZER");
  const own = await ok<{ connected: boolean }>("crew member's own status", ytc.getYouTubeConnection, P.a1.uid, {});
  check("crew member not connected themselves", own?.connected === false);

  sent.length = 0;
  await ok("reconnect with a new code", ytc.connectYouTubeServer, P.org.uid, { authCode: "good2" }, true);
  const rv = sentTo("oauth2.googleapis.com/revoke")[0];
  check("old refresh token revoked on reconnect", new URLSearchParams(rv?.body ?? "").get("token") === "rt-secret-1" &&
    yts.unseal(await doc(db, `private_youtube/${P.org.uid}`), key, P.org.uid) === "rt-secret-2");
}

async function crewStreaming(db: Firestore): Promise<void> {
  console.log("\n── createCrewBroadcast + crew member streams ──");
  await expectFail("invited (not joined) member refused", ytc.createCrewBroadcast, P.b1.uid, { matchId: "M1" }, "NOT_ORGANIZER",
    "Only the organizer or the tournament's camera crew can stream this match.", "permission-denied");
  await expectFail("outsider refused", ytc.createCrewBroadcast, P.x.uid, { matchId: "M1" }, "NOT_ORGANIZER");
  await expectFail("bad court", ytc.createCrewBroadcast, P.a1.uid, { matchId: "M1", court: 0 }, "INVALID_ARGUMENT", "Pick a court from 1 to 20.");
  await newMatch(db, "M-TEN", TT);
  const was = lsvc.LIVE_STREAM_SPORTS.slice();
  await expectFail("sport not in LIVE_STREAM_SPORTS (config on)", ytc.createCrewBroadcast, P.org.uid, { matchId: "M-TEN" },
    "LIVE_STREAMING_DISABLED");
  check("list untouched", lsvc.LIVE_STREAM_SPORTS.join() === was.join());
  await newMatch(db, "M-DONE", T, { statusRaw: "finished" });
  await expectFail("finished match", ytc.createCrewBroadcast, P.a1.uid, { matchId: "M-DONE" }, "MATCH_FINISHED");

  await expectFail("crew member: device videoId refused", ls.startStream, P.a1.uid,
    { matchId: "M1", provider: "youtube", videoId: DEVICE_VID, playersAgreed: true }, "INVALID_ARGUMENT",
    "Go live from TournMate so the video goes to the organizer's channel.");
  await expectFail("invited member: startStream refused", ls.startStream, P.b1.uid,
    { matchId: "M1", provider: "youtube", videoId: DEVICE_VID, playersAgreed: true }, "NOT_ORGANIZER");
  await expectFail("outsider: startStream refused", ls.startStream, P.x.uid,
    { matchId: "M1", provider: "youtube", videoId: DEVICE_VID, playersAgreed: true }, "NOT_ORGANIZER");

  sent.length = 0;
  const b = await ok<{ broadcastId: string; streamId: string; videoId: string; rtmpUrl: string; streamKey: string; channelTitle: string }>(
    "crew member creates a broadcast on the organizer's channel", ytc.createCrewBroadcast, P.a1.uid, { matchId: "m1", court: 2, label: "SF1" });
  check("broadcast result", b?.broadcastId === "SrvVideo001" && b?.videoId === "SrvVideo001" && b?.streamId === "stream-1" &&
    b?.rtmpUrl === "rtmps://a.rtmps.youtube.com:443/live2" && b?.streamKey === "key-1" && b?.channelTitle === "Olga's Club", JSON.stringify(b));
  const refresh = new URLSearchParams(sentTo("oauth2.googleapis.com/token")[0]?.body ?? "");
  check("refreshes the ORGANIZER's token", refresh.get("grant_type") === "refresh_token" && refresh.get("refresh_token") === "rt-secret-2");
  const ins = sentTo("/liveBroadcasts?", "POST")[0];
  const body = JSON.parse(ins?.body ?? "{}");
  const sched = body?.snippet?.scheduledStartTime;
  delete body?.snippet?.scheduledStartTime;
  check("liveBroadcasts.insert URL", ins?.url === "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id%2Csnippet%2CcontentDetails%2Cstatus",
    ins?.url);
  check("liveBroadcasts.insert body (as iOS)", JSON.stringify(body) === JSON.stringify({
    snippet: { title: "Court 2 · SF1 · Priya & Arjun vs Maya & Leo · Club Night T-CREW",
      description: "Club Night T-CREW — streamed live with TournMate. The live score is on the video and in the TournMate app." },
    status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
    contentDetails: { enableAutoStart: true, enableAutoStop: false, latencyPreference: "ultraLow", enableDvr: true, recordFromStart: true, enableEmbed: true },
  }) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(sched) && ins?.headers.Authorization?.startsWith("Bearer at-rt-secret-2") &&
    ins?.headers["Content-Type"] === "application/json", `${ins?.body}`);
  const si = sentTo("/liveStreams?", "POST")[0];
  check("liveStreams.insert (rtmp, variable, not reusable)", si?.url === "https://www.googleapis.com/youtube/v3/liveStreams?part=id%2Csnippet%2Ccdn%2CcontentDetails%2Cstatus" &&
    si?.body === JSON.stringify({ snippet: { title: "TournMate SrvVideo001" }, cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
      contentDetails: { isReusable: false } }), si?.body);
  const bd = sentTo("/liveBroadcasts/bind")[0];
  check("bind", bd?.method === "POST" && bd?.url === "https://www.googleapis.com/youtube/v3/liveBroadcasts/bind?id=SrvVideo001&part=id%2CcontentDetails&streamId=stream-1" &&
    bd?.body === undefined, bd?.url);
  const sb = await doc(db, "serverBroadcasts/SrvVideo001");
  check("serverBroadcasts record (no stream key)", sb?.matchId === "M1" && sb?.tournamentId === T && sb?.organizerUid === P.org.uid &&
    sb?.createdByUid === P.a1.uid && sb?.open === true && sb?.streamId === "stream-1" && !JSON.stringify(sb).includes("key-1"), JSON.stringify(sb));

  await expectFail("another crew member can't use someone else's broadcast", ls.startStream, P.h.uid,
    { matchId: "M1", provider: "youtube", videoId: "SrvVideo001", playersAgreed: true }, "INVALID_ARGUMENT");
  await newMatch(db, "M2");
  await expectFail("broadcast is for its own match only", ls.startStream, P.a1.uid,
    { matchId: "M2", provider: "youtube", videoId: "SrvVideo001", playersAgreed: true }, "INVALID_ARGUMENT");
  const st = await ok<{ streamStatus: string }>("crew member starts the stream", ls.startStream, P.a1.uid,
    { matchId: "M1", provider: "youtube", videoId: "SrvVideo001", playersAgreed: true, label: "SF1", court: 2 });
  const s = (await doc(db, "matches/M1"))?.stream;
  check("stream by the crew member, server broadcast", st?.streamStatus === "started" && s?.byUid === P.a1.uid && s?.byName === "Priya Shah" &&
    s?.createdBy === "server" && s?.broadcastId === "SrvVideo001" && s?.videoId === "SrvVideo001" && s?.court === 2, JSON.stringify(s));
  check("tournament entry", (await doc(db, `tournaments/${T}`))?.liveStreamCount === 1);
  await expectFail("organizer can't start over a crew stream", ls.startStream, P.org.uid,
    { matchId: "M1", provider: "youtube", videoId: DEVICE_VID, playersAgreed: true }, "STREAM_ACTIVE", "Priya Shah is streaming this match.");
  sent.length = 0;
  await expectFail("createCrewBroadcast on a streamed match: STREAM_ACTIVE before any Google call", ytc.createCrewBroadcast, P.h.uid,
    { matchId: "M1" }, "STREAM_ACTIVE");
  check("no Google calls for a refused broadcast", sent.length === 0);
  const res1 = await ok<{ streamStatus: string }>("crew member resumes", ls.startStream, P.a1.uid,
    { matchId: "M1", provider: "youtube", videoId: "SrvVideo001", playersAgreed: true });
  check("resumed", res1?.streamStatus === "resumed");
  await expectFail("crew member restart with a device video refused", ls.startStream, P.a1.uid,
    { matchId: "M1", provider: "youtube", videoId: DEVICE_VID, playersAgreed: true }, "INVALID_ARGUMENT");
  await ok("crew member heartbeat", ls.heartbeatStream, P.a1.uid, { matchId: "M1", viewers: 4 });
  await expectFail("outsider heartbeat refused", ls.heartbeatStream, P.x.uid, { matchId: "M1" }, "NOT_ORGANIZER");
  await expectFail("outsider end refused", ls.endStream, P.x.uid, { matchId: "M1" }, "NOT_ORGANIZER");
  await expectFail("another crew member can't end it", ls.endStream, P.h.uid, { matchId: "M1" }, "NOT_ORGANIZER");

  sent.length = 0;
  const end = await ok<{ status: string; youtubeEnded: boolean; endedReason: string; peakViewers: number }>("crew member ends the stream",
    ls.endStream, P.a1.uid, { matchId: "M1" });
  const tr = sentTo("/liveBroadcasts/transition")[0];
  check("end result + YouTube completed", end?.status === "ended" && end?.youtubeEnded === true && end?.endedReason === "organizer" &&
    end?.peakViewers === 4 && tr?.url === "https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=complete&id=SrvVideo001&part=id%2Cstatus",
  JSON.stringify(end));
  const sb2 = await doc(db, "serverBroadcasts/SrvVideo001");
  check("record closed", sb2?.open === false && sb2?.closeResult === "completed" && sb2?.closedAt instanceof Timestamp);
  check("endedByUid = crew member", (await doc(db, "matches/M1"))?.stream?.endedByUid === P.a1.uid);
  sent.length = 0;
  const again = await ok<{ alreadyEnded: boolean; youtubeEnded: boolean }>("end again", ls.endStream, P.a1.uid, { matchId: "M1" });
  check("idempotent, YouTube not called twice", again?.alreadyEnded === true && again?.youtubeEnded === true && sentTo("/transition").length === 0);

  console.log("  organizer ends a crew stream");
  const b2 = await ok<{ videoId: string }>("crew member broadcast on M2", ytc.createCrewBroadcast, P.a1.uid, { matchId: "M2" }, true);
  await ok("crew member starts M2", ls.startStream, P.a1.uid, { matchId: "M2", provider: "youtube", videoId: b2?.videoId, playersAgreed: true }, true);
  const oe = await ok<{ youtubeEnded: boolean }>("organizer ends the crew stream", ls.endStream, P.org.uid, { matchId: "M2" });
  const s2 = (await doc(db, "matches/M2"))?.stream;
  check("ended by the organizer, YouTube completed", oe?.youtubeEnded === true && s2?.status === "ended" && s2?.endedByUid === P.org.uid);

  console.log("  organizer's own device broadcast unchanged");
  await newMatch(db, "M-ORG");
  await ok("organizer streams with a device broadcast", ls.startStream, P.org.uid,
    { matchId: "M-ORG", provider: "youtube", videoId: DEVICE_VID, playersAgreed: true }, true);
  const os = (await doc(db, "matches/M-ORG"))?.stream;
  check("device stream has no server fields", os?.createdBy === undefined && os?.broadcastId === undefined && os?.byName === "Olga Organizer");
  const oend = await ok<Record<string, unknown>>("organizer ends own device stream", ls.endStream, P.org.uid, { matchId: "M-ORG" });
  check("no youtubeEnded for device streams", !!oend && !("youtubeEnded" in oend));
  await newMatch(db, "M-ORG2");
  const ob = await ok<{ videoId: string }>("organizer can use a server broadcast too", ytc.createCrewBroadcast, P.org.uid, { matchId: "M-ORG2" }, true);
  await ok("organizer starts with it", ls.startStream, P.org.uid, { matchId: "M-ORG2", provider: "youtube", videoId: ob?.videoId, playersAgreed: true }, true);
  check("organizer server stream marked", (await doc(db, "matches/M-ORG2"))?.stream?.createdBy === "server");
  const oe2 = await ok<{ youtubeEnded: boolean }>("organizer ends it", ls.endStream, P.org.uid, { matchId: "M-ORG2" }, true);
  check("completed on YouTube", oe2?.youtubeEnded === true);
}

async function removal(db: Firestore): Promise<void> {
  console.log("\n── removeCrewMember / leaveCrew end the member's streams ──");
  await newMatch(db, "M3");
  await newMatch(db, "M4");
  await newMatch(db, "M5");
  const b = await ok<{ videoId: string }>("a1 broadcast on M3", ytc.createCrewBroadcast, P.a1.uid, { matchId: "M3" }, true);
  await ok("a1 streams M3", ls.startStream, P.a1.uid, { matchId: "M3", provider: "youtube", videoId: b?.videoId, playersAgreed: true }, true);
  await ok("organizer streams M5 (device)", ls.startStream, P.org.uid, { matchId: "M5", provider: "youtube", videoId: DEVICE_VID, playersAgreed: true }, true);
  await expectFail("remove: player refused", crew.removeCrewMember, P.h.uid, { tournamentId: T, uid: P.a1.uid }, "NOT_ORGANIZER");
  await expectFail("remove: missing member", crew.removeCrewMember, P.org.uid, { tournamentId: T }, "INVALID_ARGUMENT", "Missing member.");
  sent.length = 0;
  const r = await ok<{ removed: boolean; endedStreams: number }>("organizer removes the streaming member", crew.removeCrewMember, P.org.uid,
    { tournamentId: T, uid: P.a1.uid });
  const s = (await doc(db, "matches/M3"))?.stream;
  const td = await doc(db, `tournaments/${T}`);
  check("removed, stream ended crew_removed", r?.removed === true && r?.endedStreams === 1 && s?.status === "ended" &&
    s?.endedReason === "crew_removed" && td?.crew?.[P.a1.uid] === undefined, JSON.stringify(s));
  check("entry removed, organizer's stream kept", td?.liveStreamCount === 1 && td?.liveStreams?.[0]?.matchId === "M5");
  check("server broadcast completed on YouTube", sentTo("/liveBroadcasts/transition").length === 1 &&
    (await doc(db, `serverBroadcasts/${b?.videoId}`))?.closeResult === "completed");
  await expectFail("removed member's heartbeat: STREAM_ENDED", ls.heartbeatStream, P.a1.uid, { matchId: "M3" }, "STREAM_ENDED");
  await expectFail("removed member can't stream", ytc.createCrewBroadcast, P.a1.uid, { matchId: "M4" }, "NOT_ORGANIZER");
  const r2 = await ok<{ removed: boolean }>("remove again = no-op", crew.removeCrewMember, P.org.uid, { tournamentId: T, uid: P.a1.uid });
  check("removed false", r2?.removed === false);

  const hb = await ok<{ videoId: string }>("helper broadcast on M4", ytc.createCrewBroadcast, P.h.uid, { matchId: "M4" }, true);
  await ok("helper streams M4", ls.startStream, P.h.uid, { matchId: "M4", provider: "youtube", videoId: hb?.videoId, playersAgreed: true }, true);
  check("helper byName from profile", (await doc(db, "matches/M4"))?.stream?.byName === "Hana Helper");
  const l = await ok<{ left: boolean; endedStreams: number }>("helper leaves while streaming", crew.leaveCrew, P.h.uid, { tournamentId: T });
  check("left, stream ended", l?.left === true && l?.endedStreams === 1 && (await doc(db, "matches/M4"))?.stream?.endedReason === "crew_removed" &&
    (await doc(db, `tournaments/${T}`))?.crew?.[P.h.uid] === undefined);
  const l2 = await ok<{ left: boolean }>("leave again = no-op", crew.leaveCrew, P.h.uid, { tournamentId: T });
  check("left false", l2?.left === false);
  const ol = await ok<{ left: boolean; endedStreams: number }>("organizer leaveCrew = no-op", crew.leaveCrew, P.org.uid, { tournamentId: T });
  check("organizer's own stream untouched", ol?.left === false && ol?.endedStreams === 0 && (await doc(db, "matches/M5"))?.stream?.status === "live");
  await ok("end M5", ls.endStream, P.org.uid, { matchId: "M5" }, true);
}

async function youtubeErrors(db: Firestore): Promise<void> {
  console.log("\n── YouTube errors, rate limit, sweep, disconnect ──");
  await ok("h2 still a member", crew.joinCrew, P.h2.uid, { tournamentId: T }, true);
  await newMatch(db, "M6");
  g.insertBroadcastError = { status: 403, reason: "liveStreamingNotEnabled" };
  await expectFail("live streaming not enabled on the channel (crew message)", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M6" },
    "YOUTUBE_LIVE_NOT_ENABLED",
    "Live streaming isn't turned on for the organizer's YouTube channel yet. Ask the organizer to turn it on at youtube.com/features.");
  g.insertBroadcastError = { status: 403, reason: "quotaExceeded" };
  await expectFail("quota", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M6" }, "YOUTUBE_QUOTA",
    "TournMate has reached its YouTube limit for today. Try again tomorrow.", "resource-exhausted");
  g.insertBroadcastError = { status: 500, reason: "backendError" };
  await expectFail("other YouTube error", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M6" }, "YOUTUBE_ERROR", undefined, "unavailable");
  g.insertBroadcastError = null;
  g.bindFails = true;
  sent.length = 0;
  await expectFail("bind fails", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M6" }, "YOUTUBE_ERROR");
  const del = sentTo("/liveBroadcasts?", "DELETE")[0];
  check("half-made broadcast deleted, no record", !!del && del.url.includes("id=SrvVideo") &&
    (await db.collection("serverBroadcasts").where("matchId", "==", "M6").get()).empty);
  g.bindFails = false;

  g.refreshFails = true;
  await expectFail("organizer's token revoked at Google", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M6" }, "YOUTUBE_AUTH_EXPIRED",
    "The organizer's YouTube connection has expired. Ask the organizer to connect YouTube again in TournMate.");
  const st = await ok<{ needsReconnect: boolean }>("status says reconnect", ytc.getYouTubeConnection, P.org.uid, {});
  check("needsReconnect", st?.needsReconnect === true);
  g.refreshFails = false;
  await ok("organizer reconnects", ytc.connectYouTubeServer, P.org.uid, { authCode: "good2" }, true);
  const st2 = await ok<{ needsReconnect: boolean }>("status after reconnect", ytc.getYouTubeConnection, P.org.uid, {});
  check("reconnect clears needsReconnect", st2?.needsReconnect === false);

  await db.collection("serverBroadcastRate").doc(P.h2.uid).set({ stamps: Array.from({ length: 10 }, () => Date.now() - 60_000) });
  await expectFail("rate limit: 10 per hour", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M6" }, "RATE_LIMITED", undefined, "resource-exhausted");
  await db.collection("serverBroadcastRate").doc(P.h2.uid).set({ stamps: Array.from({ length: 10 }, () => Date.now() - 3_700_000) });
  const okAgain = await ok<{ videoId: string }>("older stamps expire", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M6" }, true);
  check("rate doc trimmed", (await doc(db, `serverBroadcastRate/${P.h2.uid}`))?.stamps?.length === 1);

  console.log("  sweep");
  const unstarted = okAgain?.videoId ?? "";
  sent.length = 0;
  let n = await yts.sweepServerBroadcasts(db, new Date());
  check("fresh unstarted broadcast left alone", n === 0 && (await doc(db, `serverBroadcasts/${unstarted}`))?.open === true);
  g.transition = "invalid";
  g.lifeCycle = "ready";
  n = await yts.sweepServerBroadcasts(db, new Date(Date.now() + 31 * 60_000));
  check("unstarted after 30 min: deleted on YouTube", n === 1 && (await doc(db, `serverBroadcasts/${unstarted}`))?.closeResult === "deleted" &&
    sentTo("/liveBroadcasts?", "DELETE").length === 1);
  g.transition = "ok";

  await newMatch(db, "M7");
  const b7 = await ok<{ videoId: string }>("h2 broadcast on M7", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M7" }, true);
  await ok("h2 streams M7", ls.startStream, P.h2.uid, { matchId: "M7", provider: "youtube", videoId: b7?.videoId, playersAgreed: true }, true);
  n = await yts.sweepServerBroadcasts(db, new Date(Date.now() + 60 * 60_000));
  check("live server stream is not swept", n === 0 && (await doc(db, `serverBroadcasts/${b7?.videoId}`))?.open === true);
  const c = await lsvc.runStreamCleanup(db, new Date(Date.now() + 11 * 60_000));
  check("stale cleanup ends the crew stream", c.stale >= 1 && (await doc(db, "matches/M7"))?.stream?.endedReason === "stale");
  sent.length = 0;
  n = await yts.sweepServerBroadcasts(db, new Date());
  check("stale server stream completed by the sweep", n === 1 && (await doc(db, `serverBroadcasts/${b7?.videoId}`))?.closeResult === "completed" &&
    sentTo("/transition").length === 1);
  const late = await ok<{ alreadyEnded: boolean; youtubeEnded: boolean }>("endStream after the sweep", ls.endStream, P.h2.uid, { matchId: "M7" });
  check("already ended, YouTube already done", late?.alreadyEnded === true && late?.youtubeEnded === true);

  console.log("  transition fails: retried, then given up");
  await newMatch(db, "M8");
  const b8 = await ok<{ videoId: string }>("h2 broadcast on M8", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M8" }, true);
  g.transition = "invalid";
  g.lifeCycle = "live";
  for (let i = 0; i < yts.MAX_CLOSE_ATTEMPTS; i++) await yts.sweepServerBroadcasts(db, new Date(Date.now() + 31 * 60_000));
  const r8 = await doc(db, `serverBroadcasts/${b8?.videoId}`);
  check("gives up after MAX_CLOSE_ATTEMPTS", r8?.open === false && r8?.closeResult === "failed" && r8?.closeAttempts === yts.MAX_CLOSE_ATTEMPTS,
    JSON.stringify(r8));
  g.transition = "ok";

  console.log("  disconnect");
  await newMatch(db, "M9");
  const b9 = await ok<{ videoId: string }>("h2 broadcast on M9", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M9" }, true);
  await ok("h2 streams M9", ls.startStream, P.h2.uid, { matchId: "M9", provider: "youtube", videoId: b9?.videoId, playersAgreed: true }, true);
  sent.length = 0;
  const d = await ok<{ disconnected: boolean; revoked: boolean }>("organizer disconnects", ytc.disconnectYouTubeServer, P.org.uid, {});
  check("disconnected + revoked at Google", d?.disconnected === true && d?.revoked === true &&
    new URLSearchParams(sentTo("oauth2.googleapis.com/revoke")[0]?.body ?? "").get("token") === "rt-secret-2" &&
    !(await doc(db, `private_youtube/${P.org.uid}`)));
  const d2 = await ok<{ disconnected: boolean }>("disconnect again", ytc.disconnectYouTubeServer, P.org.uid, {});
  check("nothing to disconnect", d2?.disconnected === false);
  const e9 = await ok<{ youtubeEnded: boolean }>("ending a crew stream after disconnect", ls.endStream, P.h2.uid, { matchId: "M9" });
  check("youtubeEnded false (not connected)", e9?.youtubeEnded === false && (await doc(db, `serverBroadcasts/${b9?.videoId}`))?.closeResult === "not_connected");
  await expectFail("crew broadcast after disconnect", ytc.createCrewBroadcast, P.h2.uid, { matchId: "M9" }, "YOUTUBE_NOT_CONNECTED");

  yts.setYouTubeDepsForTests({ fetch: fakeFetch, clientId: () => "", clientSecret: () => "", tokenKey: () => "" });
  await expectFail("secrets missing", ytc.connectYouTubeServer, P.org.uid, { authCode: "good" }, "YOUTUBE_NOT_CONFIGURED",
    "YouTube live streaming isn't set up on the server yet.");
  yts.setYouTubeDepsForTests({ fetch: fakeFetch, clientId: () => "cid", clientSecret: () => "csec", tokenKey: () => KEY });
}

function units(): void {
  console.log("\n── units ──");
  check("invite code normalization", crewSvc.normalizeInviteCode(" abcde-fghjk ") === "ABCDEFGHJK" &&
    crewSvc.normalizeInviteCode("https://www.tournmate.com/crew/ABCDEFGHJK/") === "ABCDEFGHJK" &&
    crewSvc.normalizeInviteCode("ABCDEFGHJ0") === null && crewSvc.normalizeInviteCode(42) === null);
  const codes = new Set(Array.from({ length: 200 }, () => crewSvc.newInviteCode()));
  check("codes are random", codes.size === 200);
  check("title strips <> and caps at 100", yts.broadcastTitle("SF1", "A<b>", "C", "x".repeat(200)).length === 100 &&
    !yts.broadcastTitle("SF1", "A<b>", "C", "T").includes("<"));
  check("error kinds", yts.errorKind(401, {}) === "authExpired" &&
    yts.errorKind(403, { error: { errors: [{ reason: "insufficientLivePermissions" }] } }) === "liveNotEnabled" &&
    yts.errorKind(403, { error: { details: [{ reason: "SERVICE_DISABLED" }] } }) === "apiNotEnabled" &&
    yts.errorKind(400, { error: { errors: [{ reason: "redundantTransition" }] } }) === "invalidTransition");
  check("roles enum ready for later roles", crewSvc.CREW_ROLES.join() === "camera,scorer,referee,coOrganizer" &&
    crewSvc.ACCEPTED_CREW_ROLES.join() === "camera");
}

async function main(): Promise<void> {
  const db = getFirestore();
  await clear(db);
  await seed(db);
  units();
  await invites(db);
  await adding(db);
  await youtubeConnect(db);
  await crewStreaming(db);
  await removal(db);
  await youtubeErrors(db);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Emulator checks crashed:", err);
  process.exit(1);
});
