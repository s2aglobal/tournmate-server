/**
 * Emulator checks for the server-core callables (Open Play, setGender,
 * registrations) and the memberUids sync. Runs the callable handlers
 * directly (`.run`) against the Firestore emulator; never a real project.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-core
 * which runs, under `firebase emulators:exec --only firestore,auth,storage --project demo-tournmate`:
 *   node lib/scripts/emulatorCoreChecks.js
 *
 * Exits non-zero if any case fails.
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp, Firestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
// Storage too: deleteAccount deletes the caller's profile photos.
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore + Storage emulators and a demo-* project (use npm run test:emulator-core).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` });

// Imported after initializeApp so getFirestore() in the handlers hits the emulator.
/* eslint-disable @typescript-eslint/no-var-requires */
const openPlay = require("../callables/openPlay") as typeof import("../callables/openPlay");
const profile = require("../callables/profile") as typeof import("../callables/profile");
const regs = require("../callables/registrations") as typeof import("../callables/registrations");
const member = require("../services/memberUids") as typeof import("../services/memberUids");
const svc = require("../services/openPlay") as typeof import("../services/openPlay");
const account = require("../callables/account") as typeof import("../callables/account");
const autoClose = require("../triggers/autoCloseSessions") as typeof import("../triggers/autoCloseSessions");
const awardsFn = require("../callables/awards") as typeof import("../callables/awards");
const awardsSvc = require("../services/tournamentAwards") as typeof import("../services/tournamentAwards");

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) passes++; else failures++;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = { run: (req: any) => any };
async function call<T = Record<string, unknown>>(fn: Fn, uid: string | null, data: unknown): Promise<T> {
  return await fn.run({
    data,
    auth: uid ? { uid, token: {} } : undefined,
    rawRequest: {},
    acceptsStreaming: false,
  });
}
async function ok<T = Record<string, unknown>>(name: string, fn: Fn, uid: string | null, data: unknown): Promise<T | null> {
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

const HOUR = 3600_000;
const base = Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR; // tomorrow, on the hour
const at = (hours: number) => base + hours * HOUR;

const P = {
  host: { id: "AAAAAAAA-0000-0000-0000-000000000001", uid: "u-host", g: "male" },
  p1: { id: "aaaaaaaa-0000-0000-0000-000000000002", uid: "u1", g: "male" }, // lower-case doc id (web)
  p2: { id: "AAAAAAAA-0000-0000-0000-000000000003", uid: "u2", g: "female" },
  p3: { id: "AAAAAAAA-0000-0000-0000-000000000004", uid: "u3", g: "female" },
  p4: { id: "AAAAAAAA-0000-0000-0000-000000000005", uid: "u4", g: "male" },
  p5: { id: "AAAAAAAA-0000-0000-0000-000000000006", uid: "u5", g: "male" },
  p6: { id: "AAAAAAAA-0000-0000-0000-000000000007", uid: "u6", g: "preferNotToSay" },
  p7: { id: "AAAAAAAA-0000-0000-0000-000000000008", uid: "u7", g: "female" },
  org: { id: "AAAAAAAA-0000-0000-0000-000000000009", uid: "u-org", g: "male" },
  p8: { id: "AAAAAAAA-0000-0000-0000-00000000000A", uid: "u8", g: "female" },
  q1: { id: "AAAAAAAA-0000-0000-0000-0000000000B1", uid: "uq1", g: "male" },
  q2: { id: "AAAAAAAA-0000-0000-0000-0000000000B2", uid: "uq2", g: "female" },
  q3: { id: "AAAAAAAA-0000-0000-0000-0000000000B3", uid: "uq3", g: "male" },
  q4: { id: "AAAAAAAA-0000-0000-0000-0000000000B4", uid: "uq4", g: "female" },
  q5: { id: "AAAAAAAA-0000-0000-0000-0000000000B5", uid: "uq5", g: "male" },
  q6: { id: "AAAAAAAA-0000-0000-0000-0000000000B6", uid: "uq6", g: "female" },
};
const up = (id: string) => id.toUpperCase();

async function clear(db: Firestore): Promise<void> {
  for (const c of ["players", "playSessions", "tournaments", "registrations", "matches", "teamEntries", "teams", "notifications"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function seed(db: Firestore): Promise<void> {
  for (const [key, p] of Object.entries(P)) {
    await db.collection("players").doc(p.id).set({
      name: key.toUpperCase(), phone: "", email: `${key}@example.test`, genderRaw: p.g,
      elo: 1200, streak: 0, firebaseUid: p.uid, avatarId: "a1", createdAt: Timestamp.now(),
    });
  }
  const deadline = Timestamp.fromMillis(Date.now() + 7 * 24 * HOUR);
  const date = Timestamp.fromMillis(Date.now() + 8 * 24 * HOUR);
  const t = (id: string, extra: Record<string, unknown>) => db.collection("tournaments").doc(id).set({
    title: id, date, registrationDeadline: deadline, statusRaw: "scheduled", formatRaw: "openSingles",
    matchFormatRaw: "roundRobin", randomPairing: false, createdBy: P.org.uid, participantsCount: 0,
    currency: "USD", location: "Hall", locationAddress: "", createdAt: Timestamp.now(), ...extra,
  });
  await t("T-SINGLES", { formatConfigData: JSON.stringify({ maxParticipants: 3 }) });
  await t("T-DOUBLES", { formatRaw: "openDoubles" });
  await t("T-MIXED", { formatRaw: "mixedDoubles" });
  await t("T-CRICKET", { sportType: "cricket", formatRaw: "openSingles" });
  await t("T-CLOSED", { registrationDeadline: Timestamp.fromMillis(Date.now() - HOUR) });
  await t("T-DRAWN", { formatRaw: "openDoubles" });
  await t("T-CC", { sportType: "cricket", formatRaw: "team", title: "Cricket Cup" });
  await t("T-MD", { sportType: "cricket", formatRaw: "team", matchFormatRaw: "manualDraw", title: "Manual Cup" });
  await t("T-LOCK", { sportType: "cricket", formatRaw: "team", title: "Lock Cup" });
  await db.collection("registrations").doc("R-DRAWN").set({
    tournamentId: "T-DRAWN", playerId: up(P.p7.id), createdAt: Timestamp.now(),
  });
  await db.collection("matches").doc("M-DRAWN").set({
    tournamentId: "T-DRAWN", teamAId: "R-DRAWN", teamBId: "R-X", statusRaw: "scheduled", createdAt: Timestamp.now(),
  });
}

async function session(db: Firestore, id: string) {
  return (await db.collection("playSessions").doc(id).get()).data() ?? {};
}
async function notifiedCount(db: Firestore, uid: string, type: string): Promise<number> {
  return (await db.collection("notifications").where("recipientId", "==", uid).where("type", "==", type).get()).size;
}
async function notified(db: Firestore, uid: string, type: string): Promise<boolean> {
  const s = await db.collection("notifications").where("recipientId", "==", uid).where("type", "==", type).get();
  return !s.empty;
}

async function openPlayChecks(db: Firestore): Promise<void> {
  console.log("\n── Open Play ──");
  const { createSession, updateSession, joinSession, leaveSession, cancelSession, finishSession, deleteSession } = openPlay;
  const base1 = { venue: "Court A", title: "Morning", gameType: "doubles", sportType: "badminton", timeZone: "America/Chicago" };

  await expectFail("create unauthenticated", createSession, null, { ...base1, date: at(10) }, "UNAUTHENTICATED");
  await expectFail("create without profile", createSession, "u-none", { ...base1, date: at(10) }, "NO_PROFILE");
  await expectFail("create cricket", createSession, P.host.uid, { ...base1, sportType: "cricket", date: at(10) }, "SPORT_NOT_ALLOWED");
  await expectFail("create in the past", createSession, P.host.uid, { ...base1, date: Date.now() - HOUR }, "INVALID_ARGUMENT");
  await expectFail("create 300 min", createSession, P.host.uid, { ...base1, date: at(10), durationMinutes: 300 }, "INVALID_ARGUMENT");

  const s1 = (await ok<{ sessionId: string }>("create S1 doubles (ISO date, default 90 min)", createSession, P.host.uid,
    { ...base1, date: new Date(at(10)).toISOString() }))!.sessionId;
  const d1 = await session(db, s1);
  check("S1 server fields (1 court + bench)", d1.maxPlayers === 6 && d1.courts === 1 && d1.durationMinutes === 90
    && (d1.endsAt as Timestamp).toMillis() === at(10) + 90 * 60_000
    && JSON.stringify(d1.attendeeIds) === JSON.stringify([P.host.id])
    && JSON.stringify(d1.attendeeUids) === JSON.stringify([P.host.uid])
    && Array.isArray(d1.waitlistIds) && d1.waitlistIds.length === 0
    && d1.hostId === P.host.uid && d1.status === "active" && d1.gameType === "doubles", JSON.stringify(d1));
  check("sessionWindow uses endsAt", svc.sessionWindow(d1).end.getTime() === at(10) + 90 * 60_000);
  check("capacityFor legacy (no courts)", svc.capacityFor("singles") === 2 && svc.capacityFor("mixed") === 4 && svc.capacityFor(undefined) === 4);

  await expectFail("host overlapping own session", createSession, P.host.uid, { ...base1, date: at(11) }, "SESSION_CLASH");
  const s2 = (await ok<{ sessionId: string }>("create S2 (+1 day)", createSession, P.host.uid, { ...base1, date: at(34) }))!.sessionId;
  await ok("create S3 (+2 days, epoch ms)", createSession, P.host.uid, { ...base1, date: at(58), durationMinutes: 60 });
  await expectFail("4th upcoming session", createSession, P.host.uid, { ...base1, date: at(82) }, "HOST_LIMIT");
  await expectFail("mixed host without gender", createSession, P.p6.uid, { ...base1, gameType: "mixed", date: at(100) }, "GENDER_REQUIRED");

  // Join, full → waitlist.
  const j1 = await ok<{ status: string }>("p1 joins S1 (lower-case player doc)", joinSession, P.p1.uid, { sessionId: s1 });
  check("p1 joined", j1?.status === "joined");
  check("attendee id stored upper case", ((await session(db, s1)).attendeeIds as string[]).includes(up(P.p1.id)));
  await ok("p2 joins S1", joinSession, P.p2.uid, { sessionId: s1 });
  await ok("p3 joins S1", joinSession, P.p3.uid, { sessionId: s1 });
  await ok("q1 joins S1 (5th, court full)", joinSession, P.q1.uid, { sessionId: s1 });
  await ok("q2 joins S1 (6th, bench)", joinSession, P.q2.uid, { sessionId: s1 });
  const j4 = await ok<{ status: string }>("p4 joins full S1", joinSession, P.p4.uid, { sessionId: s1 });
  check("p4 waitlisted", j4?.status === "waitlisted");
  const j5 = await ok<{ status: string }>("p5 joins full S1", joinSession, P.p5.uid, { sessionId: s1 });
  check("p5 waitlisted", j5?.status === "waitlisted");
  const again = await ok<{ status: string }>("p1 joins again (idempotent)", joinSession, P.p1.uid, { sessionId: s1 });
  check("still joined", again?.status === "joined" && ((await session(db, s1)).attendeeIds as string[]).length === 6);
  check("attendeeUids tracked", JSON.stringify((await session(db, s1)).attendeeUids) === JSON.stringify(["u-host", "u1", "u2", "u3", "uq1", "uq2"]));

  // Update.
  await expectFail("update locked field after joins", updateSession, P.host.uid, { sessionId: s1, date: at(12) }, "FIELDS_LOCKED");
  await expectFail("update venue after joins", updateSession, P.host.uid, { sessionId: s1, venue: "Court B" }, "FIELDS_LOCKED");
  await ok("update notes after joins", updateSession, P.host.uid, { sessionId: s1, notes: "Bring shuttles", venue: "Court A" });
  check("notes saved", (await session(db, s1)).notes === "Bring shuttles");
  await expectFail("non-host update", updateSession, P.p1.uid, { sessionId: s1, notes: "x" }, "NOT_HOST");
  await ok("update S3 date + duration (no joins)", updateSession, P.host.uid,
    { sessionId: (await db.collection("playSessions").where("date", "==", Timestamp.fromMillis(at(58))).get()).docs[0].id,
      date: at(59), durationMinutes: 120 });

  // Clash on join / create.
  await expectFail("p2 hosts overlapping S1", createSession, P.p2.uid, { ...base1, date: at(10.5) }, "SESSION_CLASH");
  const s6 = (await ok<{ sessionId: string }>("p7 hosts S6 overlapping S1", createSession, P.p7.uid,
    { ...base1, venue: "Court Z", date: at(10.5) }))!.sessionId;
  await expectFail("p7 joins S1 (clash with own S6)", joinSession, P.p7.uid, { sessionId: s1 }, "SESSION_CLASH");
  try {
    await call(joinSession, P.p7.uid, { sessionId: s1 });
  } catch (e) {
    const m = (e as Error).message;
    check("clash message names venue + time", m.includes("Court Z") && /\d:\d\d/.test(m), m);
  }

  // Leave + promotion.
  const l3 = await ok<{ status: string; promotedPlayerId?: string }>("p3 leaves S1", leaveSession, P.p3.uid, { sessionId: s1 });
  check("p4 promoted", l3?.promotedPlayerId === P.p4.id);
  const after3 = await session(db, s1);
  check("S1 after promotion", (after3.attendeeIds as string[]).includes(P.p4.id) && !(after3.attendeeIds as string[]).includes(P.p3.id)
    && JSON.stringify(after3.waitlistIds) === JSON.stringify([P.p5.id])
    && (after3.attendeeUids as string[]).includes("u4") && !(after3.attendeeUids as string[]).includes("u3"), JSON.stringify(after3));
  check("p4 notified of promotion", await notified(db, "u4", "session_waitlist_promoted"));

  await ok("p5 (waitlisted on S1) joins overlapping S6", joinSession, P.p5.uid, { sessionId: s6 });
  const l2 = await ok<{ promotedPlayerId?: string }>("p2 leaves S1", leaveSession, P.p2.uid, { sessionId: s1 });
  check("p5 not promoted (clash with S6)", !l2?.promotedPlayerId
    && JSON.stringify((await session(db, s1)).waitlistIds) === JSON.stringify([P.p5.id]));
  await ok("p5 leaves S1 waitlist", leaveSession, P.p5.uid, { sessionId: s1 });
  check("waitlist empty", ((await session(db, s1)).waitlistIds as string[]).length === 0);
  await expectFail("host leaves", leaveSession, P.host.uid, { sessionId: s1 }, "INVALID_ARGUMENT");
  await expectFail("non-participant leaves", leaveSession, P.p8.uid, { sessionId: s1 }, "NOT_PARTICIPANT");

  // Mixed.
  await ok("S2 → mixed (host only so far)", updateSession, P.host.uid, { sessionId: s2, gameTypeRaw: "mixed" });
  check("S2 mixed, cap 6 (3 men, 3 women)", (await session(db, s2)).gameType === "mixed" && (await session(db, s2)).maxPlayers === 6);
  await expectFail("mixed join without gender", joinSession, P.p6.uid, { sessionId: s2 }, "GENDER_REQUIRED");
  await ok("p1 (male) joins mixed", joinSession, P.p1.uid, { sessionId: s2 });
  const mq1 = await ok<{ status: string }>("q1 (3rd male, bench) joins mixed", joinSession, P.q1.uid, { sessionId: s2 });
  check("3rd male joined", mq1?.status === "joined");
  const m4 = await ok<{ status: string }>("p4 (4th male) joins mixed", joinSession, P.p4.uid, { sessionId: s2 });
  check("4th male waitlisted (men full, room left)", m4?.status === "waitlisted");
  await ok("p2 (female) joins mixed", joinSession, P.p2.uid, { sessionId: s2 });
  const m8 = await ok<{ status: string }>("p8 (female) joins mixed", joinSession, P.p8.uid, { sessionId: s2 });
  check("2nd female joined", m8?.status === "joined");
  await ok("q2 (3rd female) joins mixed", joinSession, P.q2.uid, { sessionId: s2 });
  const m3 = await ok<{ status: string }>("p3 (female) joins full mixed", joinSession, P.p3.uid, { sessionId: s2 });
  check("4th female waitlisted", m3?.status === "waitlisted");
  const lm = await ok<{ promotedPlayerId?: string }>("p8 (female) leaves mixed", leaveSession, P.p8.uid, { sessionId: s2 });
  check("female slot → p3 promoted, not p4 (male first in line)", lm?.promotedPlayerId === P.p3.id);

  // Cancel.
  await expectFail("non-host cancel", cancelSession, P.p1.uid, { sessionId: s2 }, "NOT_HOST");
  await ok("host cancels S2", cancelSession, P.host.uid, { sessionId: s2 });
  check("S2 cancelled", (await session(db, s2)).status === "cancelled");
  check("attendees + waitlist notified", await notified(db, "u1", "session_cancelled")
    && await notified(db, "u3", "session_cancelled") && await notified(db, "u4", "session_cancelled")
    && !(await notified(db, "u-host", "session_cancelled")));
  await expectFail("join cancelled session", joinSession, P.p5.uid, { sessionId: s2 }, "SESSION_CLOSED");
  await ok("cancel again (idempotent)", cancelSession, P.host.uid, { sessionId: s2 });
  await expectFail("finish cancelled session", finishSession, P.host.uid, { sessionId: s2 }, "SESSION_CLOSED");

  // Lower-case legacy doc id, addressed with the UPPER case id; finish + delete.
  const lowerId = "bbbbbbbb-0000-0000-0000-00000000000f";
  await db.collection("playSessions").doc(lowerId).set({
    venue: "Lower Court", date: Timestamp.fromMillis(at(30)), status: "active", gameType: "doubles",
    hostId: "u-other", attendeeIds: [], createdAt: Timestamp.now(),
  });
  const lowerJoin = await ok<{ status: string }>("join lower-case session by UPPER id", joinSession, P.p4.uid, { sessionId: up(lowerId) });
  check("joined the lower-case doc", lowerJoin?.status === "joined"
    && JSON.stringify((await session(db, lowerId)).attendeeIds) === JSON.stringify([up(P.p4.id)])
    && !(await db.collection("playSessions").doc(up(lowerId)).get()).exists);
  await expectFail("non-host finish", finishSession, P.p4.uid, { sessionId: up(lowerId) }, "NOT_HOST");
  const fin = await ok<{ status: string }>("host finishes (UPPER id)", finishSession, "u-other", { sessionId: up(lowerId) });
  check("finish shape + status completed", JSON.stringify(fin) === JSON.stringify({ status: "completed" })
    && (await session(db, lowerId)).status === "completed");
  await ok("finish again (idempotent)", finishSession, "u-other", { sessionId: lowerId });
  await expectFail("join completed session", joinSession, P.p5.uid, { sessionId: lowerId }, "SESSION_CLOSED");
  await expectFail("non-host delete", deleteSession, P.p4.uid, { sessionId: up(lowerId) }, "NOT_HOST");
  const del = await ok<{ status: string }>("host deletes (UPPER id)", deleteSession, "u-other", { sessionId: up(lowerId) });
  check("delete shape + doc gone", JSON.stringify(del) === JSON.stringify({ status: "deleted" })
    && !(await db.collection("playSessions").doc(lowerId).get()).exists);
  await ok("delete again (idempotent)", deleteSession, "u-other", { sessionId: lowerId });
  await expectFail("finish missing session", finishSession, "u-other", { sessionId: lowerId }, "NOT_FOUND");

  // Old-app docs: no maxPlayers / endsAt / durationMinutes.
  await db.collection("playSessions").doc("LEGACY-STARTED").set({
    venue: "Old Court", date: Timestamp.fromMillis(Date.now() - HOUR), status: "active", gameType: "doubles",
    hostId: "u-other", attendeeIds: [], createdAt: Timestamp.now(),
  });
  await expectFail("join started session", joinSession, P.p5.uid, { sessionId: "LEGACY-STARTED" }, "SESSION_CLOSED");
  await db.collection("playSessions").doc("LEGACY-SINGLES").set({
    venue: "Old Court", date: Timestamp.fromMillis(at(4)), status: "active", gameType: "singles",
    hostId: "u-other", attendeeIds: [], createdAt: Timestamp.now(),
  });
  check("legacy window = 120 min", svc.sessionWindow(await session(db, "LEGACY-SINGLES")).end.getTime() === at(6));
  await ok("p7 joins legacy singles", joinSession, P.p7.uid, { sessionId: "LEGACY-SINGLES" });
  await ok("p8 joins legacy singles", joinSession, P.p8.uid, { sessionId: "LEGACY-SINGLES" });
  const lj = await ok<{ status: string }>("3rd player on legacy singles", joinSession, P.p5.uid, { sessionId: "LEGACY-SINGLES" });
  check("legacy singles cap 2 → waitlisted", lj?.status === "waitlisted");
  await expectFail("p7 hosts inside legacy 120-min window", createSession, P.p7.uid, { ...base1, date: at(5.5) }, "SESSION_CLASH");
  const clashes = await svc.findClashingSessions(db, P.p7.id.toLowerCase(), new Date(at(5)), new Date(at(5.5)), null);
  check("findClashingSessions matches either id case", clashes.length === 1 && clashes[0].id === "LEGACY-SINGLES");
}

async function courtsChecks(db: Firestore): Promise<void> {
  console.log("\n── Open Play courts ──");
  const { createSession, updateSession, joinSession, leaveSession } = openPlay;
  const base = { venue: "Court C", title: "Courts", gameType: "doubles", sportType: "badminton" };

  check("capacityFor doubles 1/3/4 courts = 6/14/18", svc.capacityFor("doubles", 1) === 6
    && svc.capacityFor("doubles", 3) === 14 && svc.capacityFor("doubles", 4) === 18);
  check("capacityFor singles 1/4 courts = 4/10", svc.capacityFor("singles", 1) === 4 && svc.capacityFor("singles", 4) === 10);
  check("capacityFor mixed/any 2 courts = 10", svc.capacityFor("mixed", 2) === 10 && svc.capacityFor("any", 2) === 10);
  check("mixedSlotsPerGender 1/3 courts = 3/7, legacy 2", svc.mixedSlotsPerGender(1) === 3
    && svc.mixedSlotsPerGender(3) === 7 && svc.mixedSlotsPerGender(undefined) === 2);
  check("sessionCapacity / sessionMixedCap legacy", svc.sessionCapacity({ gameType: "singles" }) === 2
    && svc.sessionCapacity({ gameType: "doubles", maxPlayers: 4 }) === 4 && svc.sessionMixedCap({ gameType: "mixed" }) === 2);

  const COURTS_MSG = "Pick between 1 and 4 courts.";
  for (const bad of [0, 5, 2.5, "2", -1]) {
    await expectFail(`create courts ${JSON.stringify(bad)}`, createSession, P.q3.uid, { ...base, date: at(200), courts: bad }, "INVALID_ARGUMENT");
  }
  try {
    await call(createSession, P.q3.uid, { ...base, date: at(200), courts: 5 });
  } catch (e) {
    check("courts error message", (e as Error).message === COURTS_MSG, (e as Error).message);
  }
  const mk = async (name: string, uid: string, data: Record<string, unknown>) =>
    (await ok<{ sessionId: string }>(name, createSession, uid, { ...base, ...data }))!.sessionId;
  const d3 = await session(db, await mk("doubles 3 courts", P.q4.uid, { date: at(210), courts: 3 }));
  check("doubles 3 courts → 14", d3.courts === 3 && d3.maxPlayers === 14, JSON.stringify({ c: d3.courts, m: d3.maxPlayers }));
  const d4 = await session(db, await mk("doubles 4 courts", P.q4.uid, { date: at(214), courts: 4 }));
  check("doubles 4 courts → 18", d4.courts === 4 && d4.maxPlayers === 18);
  const s4 = await session(db, await mk("singles 4 courts", P.q6.uid, { gameType: "singles", date: at(220), courts: 4 }));
  check("singles 4 courts → 10", s4.courts === 4 && s4.maxPlayers === 10);
  const s1c = await session(db, await mk("singles default courts", P.q6.uid, { gameType: "singles", date: at(224) }));
  check("singles default 1 court → 4", s1c.courts === 1 && s1c.maxPlayers === 4);

  // Increase promotes the waitlist (up to the new room); decrease guarded.
  const k = await mk("K doubles 1 court", P.q3.uid, { date: at(300) });
  for (const p of [P.p1, P.p2, P.p3, P.p4, P.p5]) await call(joinSession, p.uid, { sessionId: k });
  for (const p of [P.p7, P.p8, P.org, P.q1, P.q2]) await call(joinSession, p.uid, { sessionId: k });
  let kd = await session(db, k);
  check("K full at 6, 5 waitlisted", (kd.attendeeIds as string[]).length === 6 && (kd.waitlistIds as string[]).length === 5);
  await expectFail("courts 5 on update", updateSession, P.q3.uid, { sessionId: k, courts: 5 }, "INVALID_ARGUMENT");
  await expectFail("non-host courts change", updateSession, P.p1.uid, { sessionId: k, courts: 2 }, "NOT_HOST");
  const echo = await ok<{ promotedPlayerIds?: string[] }>("echo courts 1 (no change)", updateSession, P.q3.uid, { sessionId: k, courts: 1, notes: "hi" });
  check("echo: no promotion", !echo?.promotedPlayerIds && (await session(db, k)).maxPlayers === 6);
  const inc = await ok<{ promotedPlayerIds?: string[] }>("K → 2 courts", updateSession, P.q3.uid, { sessionId: k, courts: 2 });
  kd = await session(db, k);
  check("K courts 2, maxPlayers 10", kd.courts === 2 && kd.maxPlayers === 10);
  check("4 promoted in waitlist order", JSON.stringify(inc?.promotedPlayerIds) === JSON.stringify([P.p7.id, P.p8.id, P.org.id, P.q1.id]),
    JSON.stringify(inc?.promotedPlayerIds));
  check("K 10 attendees, q2 still waitlisted", (kd.attendeeIds as string[]).length === 10
    && JSON.stringify(kd.waitlistIds) === JSON.stringify([P.q2.id])
    && (kd.attendeeUids as string[]).includes("uq1") && (kd.attendeeUids as string[]).includes("u-org"));
  check("promoted players notified", await notified(db, "u7", "session_waitlist_promoted") && await notified(db, "uq1", "session_waitlist_promoted"));
  await expectFail("K → 1 court with 10 joined", updateSession, P.q3.uid, { sessionId: k, courts: 1 }, "FIELDS_LOCKED",
    "That's fewer spots than players already joined.");
  check("K unchanged after refused decrease", (await session(db, k)).maxPlayers === 10);
  const lk = await ok<{ promotedPlayerId?: string }>("p1 leaves K", leaveSession, P.p1.uid, { sessionId: k });
  check("q2 promoted on leave (cap from maxPlayers 10)", lk?.promotedPlayerId === P.q2.id);
  for (const p of [P.p2, P.p3, P.p4, P.p5]) await call(leaveSession, p.uid, { sessionId: k });
  await ok("K → 1 court with 6 joined", updateSession, P.q3.uid, { sessionId: k, courts: 1 });
  check("K back to 6", (await session(db, k)).maxPlayers === 6 && (await session(db, k)).courts === 1);

  // Mixed: per-gender cap courts × 2 + 1.
  const m = await mk("M mixed 1 court", P.q5.uid, { gameType: "mixed", date: at(400) });
  for (const p of [P.p4, P.p5, P.p2]) await call(joinSession, p.uid, { sessionId: m });
  const mj = await ok<{ status: string }>("p1 (4th male) joins M", joinSession, P.p1.uid, { sessionId: m });
  check("4th male waitlisted (3 per gender)", mj?.status === "waitlisted");
  const mi = await ok<{ promotedPlayerIds?: string[] }>("M → 2 courts", updateSession, P.q5.uid, { sessionId: m, courts: 2 });
  check("p1 promoted (5 per gender)", JSON.stringify(mi?.promotedPlayerIds) === JSON.stringify([up(P.p1.id)]));
  await expectFail("M → 1 court with 4 men", updateSession, P.q5.uid, { sessionId: m, courts: 1 }, "FIELDS_LOCKED",
    "That's fewer spots than players already joined.");

  // Started session: courts can't change.
  await db.collection("playSessions").doc("COURTS-STARTED").set({
    venue: "Old", date: Timestamp.fromMillis(Date.now() - HOUR), durationMinutes: 120, status: "active",
    gameType: "doubles", courts: 1, maxPlayers: 6, hostId: P.q6.uid, attendeeIds: [up(P.q6.id)], createdAt: Timestamp.now(),
  });
  await expectFail("courts change after start", updateSession, P.q6.uid, { sessionId: "COURTS-STARTED", courts: 2 }, "SESSION_CLOSED");

  // Legacy docs (no courts): 1 court, no bench, untouched by an echoed courts: 1.
  await db.collection("playSessions").doc("LEGACY-DOUBLES").set({
    venue: "Old", date: Timestamp.fromMillis(at(500)), status: "active", gameType: "doubles",
    hostId: P.q6.uid, attendeeIds: [up(P.q6.id)], createdAt: Timestamp.now(),
  });
  for (const p of [P.p1, P.p2, P.p3]) await call(joinSession, p.uid, { sessionId: "LEGACY-DOUBLES" });
  const lj = await ok<{ status: string }>("5th on legacy doubles", joinSession, P.p4.uid, { sessionId: "LEGACY-DOUBLES" });
  check("legacy doubles cap 4 → waitlisted", lj?.status === "waitlisted");
  await ok("legacy: notes + echoed courts 1", updateSession, P.q6.uid, { sessionId: "LEGACY-DOUBLES", courts: 1, notes: "x" });
  const ld = await session(db, "LEGACY-DOUBLES");
  check("legacy doc not rewritten (no courts / maxPlayers)", ld.courts === undefined && ld.maxPlayers === undefined && ld.notes === "x");
  await db.collection("playSessions").doc("LEGACY-MIXED").set({
    venue: "Old", date: Timestamp.fromMillis(at(510)), status: "active", gameType: "mixed", maxPlayers: 4,
    hostId: P.q5.uid, attendeeIds: [up(P.q5.id)], createdAt: Timestamp.now(),
  });
  await call(joinSession, P.p5.uid, { sessionId: "LEGACY-MIXED" });
  const lm = await ok<{ status: string }>("3rd male on legacy mixed", joinSession, P.q1.uid, { sessionId: "LEGACY-MIXED" });
  check("legacy mixed 2 per gender → waitlisted", lm?.status === "waitlisted");
  const lup = await ok<{ promotedPlayerIds?: string[] }>("legacy mixed → 2 courts", updateSession, P.q5.uid,
    { sessionId: "LEGACY-MIXED", courts: 2 });
  const lmd = await session(db, "LEGACY-MIXED");
  check("legacy mixed → 2 courts: courts/maxPlayers set, q1 promoted", lmd.courts === 2 && lmd.maxPlayers === 10
    && JSON.stringify(lup?.promotedPlayerIds) === JSON.stringify([P.q1.id]));
}

async function profileChecks(): Promise<void> {
  console.log("\n── setGender ──");
  await expectFail("invalid gender", profile.setGender, P.p6.uid, { gender: "other" }, "INVALID_ARGUMENT");
  await ok("preferNotToSay → female", profile.setGender, P.p6.uid, { gender: "female" });
  await ok("same value again (no-op)", profile.setGender, P.p6.uid, { gender: "female" });
  await expectFail("change after set", profile.setGender, P.p6.uid, { gender: "male" }, "GENDER_LOCKED");
  await expectFail("male → female", profile.setGender, P.p1.uid, { gender: "female" }, "GENDER_LOCKED");
  await expectFail("no profile", profile.setGender, "u-none", { gender: "male" }, "NO_PROFILE");
}

async function registrationChecks(db: Firestore): Promise<void> {
  console.log("\n── Registration ──");
  const { register, withdraw, joinAsPartner, changePartner, updateRoster, setRoles } = regs;
  const reg = async (id: string) => (await db.collection("registrations").doc(id).get()).data();

  // Singles + capacity.
  const r1 = (await ok<{ registrationId: string }>("p1 registers singles", register, P.p1.uid, { tournamentId: "T-SINGLES" }))!.registrationId;
  const d1 = await reg(r1);
  check("singles doc shape", JSON.stringify(Object.keys(d1 ?? {}).sort()) === JSON.stringify(["createdAt", "memberUids", "playerId", "tournamentId"])
    && d1?.playerId === up(P.p1.id) && d1?.tournamentId === "T-SINGLES" && d1?.createdAt instanceof Timestamp
    && JSON.stringify(d1?.memberUids) === JSON.stringify(["u1"]), JSON.stringify(d1));
  await expectFail("register twice", register, P.p1.uid, { tournamentId: "T-SINGLES" }, "ALREADY_REGISTERED");
  await expectFail("singles with partner", register, P.p2.uid, { tournamentId: "T-SINGLES", partnerId: P.p3.id }, "INVALID_ARGUMENT");
  await ok("p2 registers singles", register, P.p2.uid, { tournamentId: "T-SINGLES" });
  await ok("p3 registers singles", register, P.p3.uid, { tournamentId: "T-SINGLES" });
  await expectFail("4th entry, max 3", register, P.p4.uid, { tournamentId: "T-SINGLES" }, "REG_FULL");
  await expectFail("past deadline", register, P.p1.uid, { tournamentId: "T-CLOSED" }, "REG_CLOSED");
  await expectFail("after draw", register, P.p1.uid, { tournamentId: "T-DRAWN" }, "REG_CLOSED",
    "Registration closed: the draw has already been made.");
  await expectFail("join as partner after draw", joinAsPartner, P.p8.uid, { registrationId: "R-DRAWN" }, "DRAW_EXISTS",
    "Registration closed: the draw has already been made.");
  await expectFail("unknown tournament", register, P.p1.uid, { tournamentId: "NOPE" }, "NOT_FOUND");
  await expectFail("cricket without team", register, P.p1.uid, { tournamentId: "T-CRICKET" }, "SPORT_NOT_ALLOWED");
  await expectFail("team on badminton", register, P.p4.uid, { tournamentId: "T-DOUBLES", team: { teamName: "X", rosterIds: [] } }, "SPORT_NOT_ALLOWED");

  // Doubles.
  const rd = (await ok<{ registrationId: string }>("p1 + p2 doubles", register, P.p1.uid, { tournamentId: "T-DOUBLES", partnerId: P.p2.id }))!.registrationId;
  const dd = await reg(rd);
  check("doubles doc", dd?.partnerId === P.p2.id && JSON.stringify(dd?.memberUids) === JSON.stringify(["u1", "u2"]), JSON.stringify(dd));
  await expectFail("partner already registered", register, P.p3.uid, { tournamentId: "T-DOUBLES", partnerId: P.p2.id }, "ALREADY_REGISTERED");
  const r3 = (await ok<{ registrationId: string }>("p3 solo doubles", register, P.p3.uid, { tournamentId: "T-DOUBLES" }))!.registrationId;
  await ok("p4 joins p3 as partner", joinAsPartner, P.p4.uid, { registrationId: r3 });
  check("p3 reg partner = p4", (await reg(r3))?.partnerId === P.p4.id && JSON.stringify((await reg(r3))?.memberUids) === JSON.stringify(["u3", "u4"]));
  await expectFail("p5 joins taken registration", joinAsPartner, P.p5.uid, { registrationId: r3 }, "REG_FULL");
  const r5 = (await ok<{ registrationId: string }>("p5 solo doubles", register, P.p5.uid, { tournamentId: "T-DOUBLES" }))!.registrationId;
  const r6 = (await ok<{ registrationId: string }>("p6 solo doubles", register, P.p6.uid, { tournamentId: "T-DOUBLES" }))!.registrationId;
  await ok("p6 joins p5 (merges p6's solo entry)", joinAsPartner, P.p6.uid, { registrationId: r5 });
  check("p6 solo entry removed", !(await reg(r6)) && (await reg(r5))?.partnerId === P.p6.id);
  await expectFail("p1 (has partner) joins as partner", joinAsPartner, P.p1.uid, { registrationId: r5 }, "REG_FULL");

  // Mixed.
  await expectFail("mixed: two men", register, P.p1.uid, { tournamentId: "T-MIXED", partnerId: P.p4.id }, "INVALID_ARGUMENT");
  await ok("mixed: man + woman", register, P.p1.uid, { tournamentId: "T-MIXED", partnerId: P.p2.id });

  // Change partner (registration addressed in lower case).
  await expectFail("stranger changes partner", changePartner, P.p7.uid, { registrationId: rd, partnerId: P.p8.id }, "NOT_PARTICIPANT");
  await expectFail("new partner already registered", changePartner, P.p1.uid, { registrationId: rd, partnerId: P.p3.id }, "ALREADY_REGISTERED");
  await expectFail("partner self", changePartner, P.p1.uid, { registrationId: rd, partnerId: P.p1.id }, "INVALID_ARGUMENT");
  const cp = await ok<{ registrationId: string }>("registrant swaps p2 → p7", changePartner, P.p1.uid,
    { registrationId: rd.toLowerCase(), partnerId: P.p7.id.toLowerCase() });
  const dcp = await reg(rd);
  check("changePartner shape + partner/memberUids", JSON.stringify(cp) === JSON.stringify({ registrationId: rd })
    && dcp?.partnerId === P.p7.id && JSON.stringify(dcp?.memberUids) === JSON.stringify(["u1", "u7"]), JSON.stringify(dcp));
  check("new partner + old partner notified", await notified(db, "u7", "partner_added") && await notified(db, "u2", "partner_removed"));
  await ok("organizer swaps back to p2", changePartner, P.org.uid, { registrationId: rd, partnerId: P.p2.id });
  check("partner back to p2", (await reg(rd))?.partnerId === P.p2.id && await notified(db, "u7", "partner_removed"));
  // Picking a partner who has a solo entry merges it (apps' "pick partner" from the solo list).
  const r8 = (await ok<{ registrationId: string }>("p8 solo doubles", register, P.p8.uid, { tournamentId: "T-DOUBLES" }))!.registrationId;
  await db.collection("teamEntries").doc(`t-doubles_${P.p8.id.toLowerCase()}`).set({ tournamentId: "T-DOUBLES", playerId: P.p8.id, registrationId: r8 });
  await ok("registrant swaps p2 → p8 (p8 solo)", changePartner, P.p1.uid, { registrationId: rd, partnerId: P.p8.id });
  check("p8 solo entry + lock removed, partner = p8", !(await reg(r8)) && (await reg(rd))?.partnerId === P.p8.id
    && !(await db.collection("teamEntries").doc(`t-doubles_${P.p8.id.toLowerCase()}`).get()).exists
    && JSON.stringify((await reg(rd))?.memberUids) === JSON.stringify(["u1", "u8"]));
  await ok("swap back to p2", changePartner, P.p1.uid, { registrationId: rd, partnerId: P.p2.id });
  const r7 = (await ok<{ registrationId: string }>("p7 solo doubles", register, P.p7.uid, { tournamentId: "T-DOUBLES" }))!.registrationId;
  const r8b = (await ok<{ registrationId: string }>("p8 solo again", register, P.p8.uid, { tournamentId: "T-DOUBLES" }))!.registrationId;
  await ok("solo p7 picks solo p8", changePartner, P.p7.uid, { registrationId: r7, partnerId: P.p8.id });
  check("p8 merged into p7's entry", !(await reg(r8b)) && (await reg(r7))?.partnerId === P.p8.id
    && await notified(db, "u8", "partner_added"));
  await expectFail("partner in a pair can't be picked", changePartner, P.p5.uid, { registrationId: r5, partnerId: P.p7.id }, "ALREADY_REGISTERED");
  await expectFail("change partner after draw", changePartner, P.p7.uid, { registrationId: "R-DRAWN", partnerId: P.p8.id }, "DRAW_EXISTS");
  await expectFail("change partner on singles", changePartner, P.p2.uid,
    { registrationId: (await db.collection("registrations").where("tournamentId", "==", "T-SINGLES").where("playerId", "==", P.p2.id).get()).docs[0].id, partnerId: P.p8.id },
    "INVALID_ARGUMENT");

  // Withdraw.
  await ok("partner withdraws", withdraw, P.p2.uid, { registrationId: rd });
  check("partner cleared", (await reg(rd))?.partnerId === undefined && JSON.stringify((await reg(rd))?.memberUids) === JSON.stringify(["u1"]));
  await ok("registrant withdraws", withdraw, P.p1.uid, { registrationId: rd });
  check("registration deleted", !(await reg(rd)));
  await expectFail("stranger withdraws", withdraw, P.p7.uid, { registrationId: r5 }, "NOT_PARTICIPANT");
  await ok("organizer withdraws an entry", withdraw, P.org.uid, { registrationId: r5 });
  check("organizer removal deleted", !(await reg(r5)));
  await expectFail("withdraw after draw", withdraw, P.p7.uid, { registrationId: "R-DRAWN" }, "DRAW_EXISTS");

  // Cricket team entry.
  const team = {
    teamId: "TEAM-1", teamName: "Royals", rosterIds: [P.p1.id, P.p2.id], guestNames: ["Guest A", " guest a "],
    captainId: P.p2.id.toLowerCase(), playerRoles: { [P.p1.id]: "batter" },
  };
  await db.collection("teams").doc("TEAM-1").set({ name: "Royals", sportType: "cricket", captainId: up(P.p2.id), playerIds: [], createdBy: P.host.uid });
  const rc = (await ok<{ registrationId: string }>("host enters team (not playing)", register, P.host.uid, { tournamentId: "T-CRICKET", team }))!.registrationId;
  const dc = await reg(rc);
  check("team doc shape", JSON.stringify(Object.keys(dc ?? {}).sort()) === JSON.stringify(
    ["captainId", "createdAt", "guestNames", "memberUids", "playerId", "playerRoles", "rosterIds", "teamId", "teamName", "tournamentId"])
    && JSON.stringify(dc?.rosterIds) === JSON.stringify([up(P.p1.id), P.p2.id])
    && JSON.stringify(dc?.guestNames) === JSON.stringify(["Guest A"])
    && dc?.captainId === P.p2.id && dc?.playerRoles[up(P.p1.id)] === "batter"
    && JSON.stringify(dc?.memberUids) === JSON.stringify(["u-host", "u1", "u2"]), JSON.stringify(dc));
  const lock = await db.collection("teamEntries").doc(`t-cricket_${P.host.id.toLowerCase()}`).get();
  check("team entry lock written", lock.exists && lock.get("registrationId") === rc && lock.get("playerId") === P.host.id);
  await expectFail("roster player already on a team", register, P.p3.uid,
    { tournamentId: "T-CRICKET", team: { teamName: "Kings", rosterIds: [P.p1.id] } }, "ALREADY_ENTERED_TEAM");
  await expectFail("registrant enters second team", register, P.host.uid,
    { tournamentId: "T-CRICKET", team: { teamName: "Kings", rosterIds: [P.p3.id] } }, "ALREADY_ENTERED_TEAM");
  await expectFail("roster player enters own team", register, P.p1.uid,
    { tournamentId: "T-CRICKET", team: { teamName: "Kings", rosterIds: [P.p3.id] } }, "ALREADY_ENTERED_TEAM");
  // A lock pointing at a live registration blocks (one left by a deleted registration doesn't: see cricketCompleteChecks).
  await db.collection("teamEntries").doc(`t-cricket_${P.p4.id.toLowerCase()}`).set({ tournamentId: "T-CRICKET", playerId: P.p4.id, registrationId: rc });
  await expectFail("existing team lock", register, P.p4.uid,
    { tournamentId: "T-CRICKET", team: { teamName: "Kings", rosterIds: [P.p3.id] } }, "ALREADY_ENTERED_TEAM");
  await expectFail("roster over limit", register, P.p5.uid,
    { tournamentId: "T-CRICKET", team: { teamName: "Big", rosterIds: [], guestNames: Array.from({ length: 16 }, (_, i) => `G${i}`) } }, "INVALID_ARGUMENT");
  const rk = (await ok<{ registrationId: string }>("p5 enters team, no captain given", register, P.p5.uid,
    { tournamentId: "T-CRICKET", team: { teamName: "Kings", rosterIds: [P.p5.id, P.p3.id] } }))!.registrationId;
  check("captain defaults to registrant", (await reg(rk))?.captainId === P.p5.id);

  // Roles.
  await expectFail("non-captain roster member sets roles", setRoles, P.p1.uid, { registrationId: rc, captainId: P.p1.id }, "NOT_PARTICIPANT");
  await expectFail("vice = captain", setRoles, P.p2.uid, { registrationId: rc, captainId: P.p1.id, viceCaptainId: P.p1.id }, "INVALID_ARGUMENT");
  await expectFail("captain off the sheet", setRoles, P.p2.uid, { registrationId: rc, captainId: P.p7.id }, "INVALID_ARGUMENT");
  await expectFail("bad playing role", setRoles, P.p2.uid, { registrationId: rc, captainId: P.p1.id, playerRoles: { [P.p1.id]: "umpire" } }, "INVALID_ARGUMENT");
  const roles = await ok<Record<string, unknown>>("captain sets roles", setRoles, P.p2.uid, {
    registrationId: rc, captainId: P.p1.id, viceCaptainId: P.p2.id, keeperId: "guest:Guest A",
    playerRoles: { "guest:Guest A": "wicketkeeperBatter" },
  });
  const dr = await reg(rc);
  check("roles stored", dr?.captainId === up(P.p1.id) && dr?.viceCaptainId === P.p2.id && dr?.keeperId === "guest:Guest A"
    && JSON.stringify(dr?.playerRoles) === JSON.stringify({ "guest:Guest A": "wicketkeeperBatter" })
    && roles?.captainId === up(P.p1.id), JSON.stringify(dr));

  // Roster.
  await expectFail("stranger updates roster", updateRoster, P.p7.uid, { registrationId: rc, rosterIds: [P.p1.id], guestNames: [] }, "NOT_PARTICIPANT");
  await expectFail("roster adds player from another team", updateRoster, P.p1.uid,
    { registrationId: rc, rosterIds: [P.p1.id, P.p3.id], guestNames: ["Guest A"] }, "ALREADY_ENTERED_TEAM");
  await ok("new captain drops vice-captain p2", updateRoster, P.p1.uid,
    { registrationId: rc, rosterIds: [P.p1.id, P.p8.id], guestNames: ["Guest A"], teamName: "Royal XI" });
  const du = await reg(rc);
  check("roster + roles normalized", JSON.stringify(du?.rosterIds) === JSON.stringify([up(P.p1.id), P.p8.id])
    && du?.viceCaptainId === undefined && du?.captainId === up(P.p1.id) && du?.teamName === "Royal XI"
    && JSON.stringify(du?.memberUids) === JSON.stringify(["u-host", "u1", "u8"]), JSON.stringify(du));
  await ok("captain p1 withdraws from roster", withdraw, P.p1.uid, { registrationId: rc });
  const dw = await reg(rc);
  check("captain passes to first remaining", JSON.stringify(dw?.rosterIds) === JSON.stringify([P.p8.id])
    && dw?.captainId === P.p8.id && JSON.stringify(dw?.memberUids) === JSON.stringify(["u-host", "u8"]), JSON.stringify(dw));
  await ok("registrant withdraws team", withdraw, P.host.uid, { registrationId: rc });
  check("team + lock deleted", !(await reg(rc)) && !(await db.collection("teamEntries").doc(`t-cricket_${P.host.id.toLowerCase()}`).get()).exists);
  await ok("host can enter again after withdrawing", register, P.host.uid,
    { tournamentId: "T-CRICKET", team: { teamName: "Royals", rosterIds: [P.p1.id] } });
}

async function cricketCompleteChecks(db: Firestore): Promise<void> {
  console.log("\n── Cricket: roster locks, roles, awards ──");
  const { register, withdraw, updateRoster, setRoles } = regs;
  const { setTournamentAwards } = awardsFn;
  const reg = async (id: string) => (await db.collection("registrations").doc(id).get()).data();
  const lock = async (pid: string) => (await db.collection("teamEntries").doc(`t-cc_${pid.toLowerCase()}`).get()).data();
  const T = "T-CC";

  const ra = (await ok<{ registrationId: string }>("q1 enters Kings (q1, q2)", register, P.q1.uid,
    { tournamentId: T, team: { teamName: "Kings", rosterIds: [P.q1.id, P.q2.id] } }))!.registrationId;
  check("locks for registrant + roster", (await lock(P.q1.id))?.registrationId === ra && (await lock(P.q2.id))?.registrationId === ra);
  const rb = (await ok<{ registrationId: string }>("q3 enters Royals (q3, q4, guest)", register, P.q3.uid,
    { tournamentId: T, team: { teamName: "Royals", rosterIds: [P.q3.id, P.q4.id], guestNames: ["Gus"] } }))!.registrationId;
  const rc = (await ok<{ registrationId: string }>("q6 enters Spare (q6, q5)", register, P.q6.uid,
    { tournamentId: T, team: { teamName: "Spare", rosterIds: [P.q6.id, P.q5.id] } }))!.registrationId;
  await ok("Spare withdraws", withdraw, P.q6.uid, { registrationId: rc });
  check("withdraw frees every lock", !(await lock(P.q6.id)) && !(await lock(P.q5.id)));

  await ok("registrant sets captain q1, vice q2", setRoles, P.q1.uid, { registrationId: ra, captainId: P.q1.id, viceCaptainId: P.q2.id });
  await ok("vice-captain adds q5", updateRoster, P.q2.uid, { registrationId: ra, rosterIds: [P.q1.id, P.q2.id, P.q5.id], guestNames: [] });
  check("added player's lock", (await lock(P.q5.id))?.registrationId === ra);
  await expectFail("remove captain without a new one", updateRoster, P.q2.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q5.id], guestNames: [] }, "INVALID_ARGUMENT", "Pick a new captain before removing the captain.");
  await expectFail("new captain off the sheet", updateRoster, P.q2.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q5.id], guestNames: [], captainId: P.q1.id }, "INVALID_ARGUMENT");
  await ok("remove captain q1 with new captain q2", updateRoster, P.q2.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q5.id], guestNames: [], captainId: P.q2.id.toLowerCase() });
  const da = await reg(ra);
  check("new captain, vice cleared", da?.captainId === P.q2.id && da?.viceCaptainId === undefined, JSON.stringify(da));
  check("registrant keeps lock when off the roster", (await lock(P.q1.id))?.registrationId === ra);
  await ok("drop q5, add q1 back", updateRoster, P.q1.uid, { registrationId: ra, rosterIds: [P.q2.id, P.q1.id], guestNames: [] });
  check("removed player's lock freed", !(await lock(P.q5.id)));

  // One call: roster + name + every role (contract A), permission by the roles stored before the call.
  await expectFail("q5 can't make themself captain in the same call", updateRoster, P.q5.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q1.id, P.q5.id], guestNames: [], captainId: P.q5.id }, "NOT_PARTICIPANT");
  await expectFail("roles: captain also vice", updateRoster, P.q2.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q1.id], guestNames: [], captainId: P.q2.id, viceCaptainId: P.q2.id }, "INVALID_ARGUMENT");
  await expectFail("roles: keeper off the new sheet", updateRoster, P.q2.uid,
    { registrationId: ra, rosterIds: [P.q2.id], guestNames: [], captainId: P.q2.id, keeperId: P.q1.id }, "INVALID_ARGUMENT",
    "Roles can only go to players on the team sheet.");
  await expectFail("roles: no captain", updateRoster, P.q2.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q1.id], guestNames: [], keeperId: P.q1.id }, "INVALID_ARGUMENT", "Pick a captain.");
  await expectFail("roles: unknown playing role", updateRoster, P.q2.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q1.id], guestNames: [], captainId: P.q2.id, playerRoles: { [P.q1.id]: "umpire" } },
    "INVALID_ARGUMENT");
  await ok("captain saves roster + name + all roles in one call", updateRoster, P.q2.uid, {
    registrationId: ra, rosterIds: [P.q2.id, P.q1.id, P.q5.id], guestNames: ["Gil"], teamName: "Kings XI",
    captainId: P.q5.id.toLowerCase(), viceCaptainId: P.q2.id, keeperId: "guest:Gil",
    playerRoles: { [P.q1.id.toLowerCase()]: "bowler", "guest:Gil": "wicketkeeperBatter" },
  });
  const one = await reg(ra);
  check("one-call save stored", one?.teamName === "Kings XI" && one?.captainId === P.q5.id && one?.viceCaptainId === P.q2.id &&
    one?.keeperId === "guest:Gil" && JSON.stringify(one?.guestNames) === JSON.stringify(["Gil"]) &&
    one?.playerRoles?.[P.q1.id] === "bowler" && one?.playerRoles?.["guest:Gil"] === "wicketkeeperBatter" &&
    (await lock(P.q5.id))?.registrationId === ra, JSON.stringify(one));
  await ok("older apps: roster only keeps roles of those still on the side", updateRoster, P.q5.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q1.id, P.q5.id], guestNames: [] });
  const kept = await reg(ra);
  check("older apps: guest's roles dropped, others kept", kept?.captainId === P.q5.id && kept?.viceCaptainId === P.q2.id &&
    kept?.keeperId === undefined && kept?.playerRoles?.[P.q1.id] === "bowler" && kept?.playerRoles?.["guest:Gil"] === undefined,
    JSON.stringify(kept));
  await expectFail("older apps: removing the captain still refused", updateRoster, P.q2.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q1.id], guestNames: [] }, "INVALID_ARGUMENT", "Pick a new captain before removing the captain.");
  await ok("back to q2 (captain) + q1, roles cleared but captain", updateRoster, P.q5.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q1.id], guestNames: [], teamName: "Kings", captainId: P.q2.id });
  const back = await reg(ra);
  check("only the given roles remain", back?.captainId === P.q2.id && back?.viceCaptainId === undefined && back?.playerRoles === undefined &&
    !(await lock(P.q5.id)), JSON.stringify(back));

  await expectFail("awards before finish", setTournamentAwards, P.org.uid, { tournamentId: T, bestBatter: { key: P.q1.id } },
    "NOT_FINISHED", "Awards can be set once the tournament is finished.");

  // Draw made: one round-robin match.
  await db.collection("matches").doc("M-CC").set({
    tournamentId: T, teamAId: ra, teamBId: rb, round: 1, statusRaw: "scheduled", createdAt: Timestamp.now(), sportType: "cricket",
  });
  await expectFail("roster locked after draw", updateRoster, P.q2.uid, { registrationId: ra, rosterIds: [P.q2.id], guestNames: [] }, "DRAW_EXISTS");
  await expectFail("rename locked after draw", updateRoster, P.org.uid,
    { registrationId: ra, rosterIds: [P.q2.id, P.q1.id], guestNames: [], teamName: "New" }, "DRAW_EXISTS");
  await ok("roles still change after draw", setRoles, P.q2.uid, { registrationId: ra, captainId: P.q2.id, keeperId: P.q1.id });
  await expectFail("register after draw", register, P.q5.uid, { tournamentId: T, team: { teamName: "Late", rosterIds: [P.q5.id, P.q6.id] } },
    "REG_CLOSED", "Registration closed: the draw has already been made.");

  // Finished, with player stats.
  const stats = {
    batting: [
      { teamRegistrationId: ra, key: P.q1.id, name: "Q1", runs: 64, balls: 40, out: true },
      { teamRegistrationId: rb, key: "guest:Gus", name: "Gus", runs: 20, balls: 20, out: false },
    ],
    bowling: [{ teamRegistrationId: rb, key: P.q3.id, name: "Q3", balls: 24, runs: 22, wickets: 2 }],
  };
  await db.collection("matches").doc("M-CC").update({
    statusRaw: "finished", resultType: "win", winnerRegistrationId: ra, playerStatsData: JSON.stringify(stats),
    playerOfMatchKey: P.q3.id, playerOfMatchName: "Q3", playerOfMatchTeamId: rb,
  });
  await expectFail("roles locked once finished", setRoles, P.q2.uid, { registrationId: ra, captainId: P.q2.id }, "FIELDS_LOCKED");
  await awardsSvc.refreshAutoAwards(db, T);
  let td = (await db.collection("tournaments").doc(T).get()).data()!;
  check("auto awards", td.awards?.bestBatter?.key === P.q1.id && td.awards?.bestBatter?.runs === 64 &&
    td.awards?.bestBowler?.key === P.q3.id && td.awards?.playerOfSeries?.key === P.q3.id &&
    td.awards?.source?.bestBatter === "auto", JSON.stringify(td.awards));
  check("POTS = potm 25 + wickets 40 beats 64 runs", td.awards?.playerOfSeries?.teamId === rb);
  check("auto awardPlayerIds", JSON.stringify(td.awardPlayerIds) === JSON.stringify([P.q3.id, P.q1.id]), JSON.stringify(td.awardPlayerIds));
  check("winners notified", await notified(db, "uq1", "award_won") && await notified(db, "uq3", "award_won"));
  const n3 = await db.collection("notifications").where("recipientId", "==", "uq3").where("type", "==", "award_won").get();
  check("one notification per winner, listing awards", n3.size === 1 &&
    n3.docs[0].get("body") === "Player of the Series and Best Bowler in \"Cricket Cup\"" &&
    n3.docs[0].get("title") === "You won an award" && n3.docs[0].get("tournamentId") === T, n3.docs[0]?.get("body"));
  const updatedAt = td.awards?.updatedAt;
  await awardsSvc.refreshAutoAwards(db, T);
  td = (await db.collection("tournaments").doc(T).get()).data()!;
  check("refresh without changes writes nothing", td.awards?.updatedAt?.isEqual(updatedAt));

  await expectFail("awards: not organizer", setTournamentAwards, P.q1.uid, { tournamentId: T, bestBatter: { key: P.q1.id } }, "NOT_ORGANIZER");
  await expectFail("awards: not cricket", setTournamentAwards, P.org.uid, { tournamentId: "T-DOUBLES", bestBatter: { key: P.q1.id } }, "SPORT_NOT_ALLOWED");
  await expectFail("awards: player not on a roster", setTournamentAwards, P.org.uid, { tournamentId: T, bestBatter: { key: P.p1.id } }, "INVALID_ARGUMENT");
  await expectFail("awards: bad value", setTournamentAwards, P.org.uid, { tournamentId: T, bestBatter: "x" }, "INVALID_ARGUMENT");
  const set = await ok<{ awards: Record<string, Record<string, unknown>> }>("organizer: guest best batter, clear bowler, q4 POTS",
    setTournamentAwards, P.org.uid,
    { tournamentId: T.toLowerCase(), bestBatter: { key: "guest:Gus" }, bestBowler: null, playerOfSeries: { key: P.q4.id.toLowerCase() } });
  const a = set?.awards;
  check("override stored + returned", a?.bestBatter?.key === "guest:Gus" && a?.bestBatter?.name === "Gus" && a?.bestBatter?.runs === 20 &&
    a?.bestBatter?.teamId === rb && a?.bestBowler === undefined && a?.playerOfSeries?.key === P.q4.id &&
    a?.playerOfSeries?.name === "Q4" && JSON.stringify(a?.source) === JSON.stringify({ playerOfSeries: "organizer", bestBatter: "organizer", bestBowler: "organizer" }) &&
    typeof a?.updatedAt === "number", JSON.stringify(a));
  td = (await db.collection("tournaments").doc(T).get()).data()!;
  check("override awardPlayerIds (no guests)", JSON.stringify(td.awardPlayerIds) === JSON.stringify([P.q4.id]), JSON.stringify(td.awardPlayerIds));
  check("new organizer pick notified", await notified(db, "uq4", "award_won"));
  await awardsSvc.refreshAutoAwards(db, T);
  td = (await db.collection("tournaments").doc(T).get()).data()!;
  check("auto never overwrites organizer awards", td.awards?.bestBatter?.key === "guest:Gus" && td.awards?.bestBowler === undefined &&
    td.awards?.playerOfSeries?.key === P.q4.id);
  const zero = await ok<{ awards: Record<string, Record<string, unknown>> }>("organizer: bowler without figures", setTournamentAwards, P.org.uid,
    { tournamentId: T, bestBowler: { key: P.q2.id } });
  check("stats zero when none", zero?.awards?.bestBowler?.wickets === 0 && zero?.awards?.bestBowler?.balls === 0 &&
    zero?.awards?.bestBatter?.key === "guest:Gus");

  // Each registered player hears about a given award at most once (awardsNotified).
  td = (await db.collection("tournaments").doc(T).get()).data()!;
  check("awardsNotified recorded", JSON.stringify(td.awardsNotified) === JSON.stringify({
    playerOfSeries: [P.q3.id, P.q4.id], bestBatter: [P.q1.id], bestBowler: [P.q3.id, P.q2.id],
  }), JSON.stringify(td.awardsNotified));
  const n = async () => [P.q1, P.q2, P.q3, P.q4].map(async (p) => notifiedCount(db, p.uid, "award_won"));
  const counts = async () => (await Promise.all(await n())).join(",");
  check("notification counts so far", await counts() === "1,1,1,1", await counts());
  await ok("POTS q4 -> q1 (q1 already told about Best Batter)", setTournamentAwards, P.org.uid, { tournamentId: T, playerOfSeries: { key: P.q1.id } });
  check("a second, different award is told once", await counts() === "2,1,1,1", await counts());
  const q1n = await db.collection("notifications").where("recipientId", "==", "uq1").where("type", "==", "award_won").get();
  check("second notification names only the new award",
    q1n.docs.some((d) => d.get("body") === "Player of the Series in \"Cricket Cup\""), q1n.docs.map((d) => d.get("body")).join(" | "));
  await ok("POTS q1 -> q4 (A -> B -> A)", setTournamentAwards, P.org.uid, { tournamentId: T, playerOfSeries: { key: P.q4.id } });
  await ok("POTS q4 -> q1 again", setTournamentAwards, P.org.uid, { tournamentId: T, playerOfSeries: { key: P.q1.id } });
  check("moving an award back tells no one again", await counts() === "2,1,1,1", await counts());
  await ok("clear bowler", setTournamentAwards, P.org.uid, { tournamentId: T, bestBowler: null });
  await ok("reset bowler to q2", setTournamentAwards, P.org.uid, { tournamentId: T, bestBowler: { key: P.q2.id } });
  check("clear + reset tells no one again", await counts() === "2,1,1,1", await counts());
  await ok("q2 Best Batter (new award for q2)", setTournamentAwards, P.org.uid, { tournamentId: T, bestBatter: { key: P.q2.id } });
  check("q2 told about Best Batter", await counts() === "2,2,1,1", await counts());

  // Manual Draw: finishing is provisional — no roles lock, no automatic award notifications.
  const MD = "T-MD";
  const ma = (await ok<{ registrationId: string }>("q5 enters a manual-draw team", register, P.q5.uid,
    { tournamentId: MD, team: { teamName: "Lions", rosterIds: [P.q5.id] } }))!.registrationId;
  const mb = (await ok<{ registrationId: string }>("q6 enters a manual-draw team", register, P.q6.uid,
    { tournamentId: MD, team: { teamName: "Tigers", rosterIds: [P.q6.id] } }))!.registrationId;
  await db.collection("matches").doc("M-MD").set({
    tournamentId: MD, teamAId: ma, teamBId: mb, round: 1, statusRaw: "finished", resultType: "win", winnerRegistrationId: ma,
    createdAt: Timestamp.now(), sportType: "cricket", playerStatsData: JSON.stringify({
      batting: [{ teamRegistrationId: ma, key: P.q5.id, name: "Q5", runs: 33, balls: 20, out: true }],
      bowling: [{ teamRegistrationId: mb, key: P.q6.id, name: "Q6", balls: 24, runs: 30, wickets: 1 }],
    }),
  });
  await ok("manual draw: roles not locked when every match is finished", setRoles, P.q5.uid, { registrationId: ma, captainId: P.q5.id });
  const before5 = await notifiedCount(db, "uq5", "award_won");
  await awardsSvc.refreshAutoAwards(db, MD);
  let md = (await db.collection("tournaments").doc(MD).get()).data()!;
  check("manual draw: awards computed for display", md.awards?.bestBatter?.key === P.q5.id && md.awards?.bestBowler?.key === P.q6.id,
    JSON.stringify(md.awards));
  check("manual draw: no automatic notification", await notifiedCount(db, "uq5", "award_won") === before5 &&
    await notifiedCount(db, "uq6", "award_won") === 0 && md.awardsNotified === undefined, JSON.stringify(md.awardsNotified));
  await ok("manual draw: organizer sets Best Bowler", setTournamentAwards, P.org.uid, { tournamentId: MD, bestBowler: { key: P.q6.id } });
  md = (await db.collection("tournaments").doc(MD).get()).data()!;
  check("manual draw: organizer's pick notified, auto awards still not", await notifiedCount(db, "uq6", "award_won") === 1 &&
    await notifiedCount(db, "uq5", "award_won") === before5 &&
    JSON.stringify(md.awardsNotified) === JSON.stringify({ playerOfSeries: [], bestBatter: [], bestBowler: [P.q6.id] }),
    JSON.stringify(md.awardsNotified));

  // A lock left behind by a deleted registration (console delete; no trigger here) doesn't block registering.
  const LK = "T-LOCK";
  await db.collection("teamEntries").doc(`t-lock_${P.q1.id.toLowerCase()}`).set({ tournamentId: LK, playerId: P.q1.id, registrationId: "GONE" });
  await ok("stale lock (registration gone) doesn't block", register, P.q1.uid, { tournamentId: LK, team: { teamName: "Fresh", rosterIds: [P.q1.id] } });
  const fresh = (await db.collection("registrations").where("tournamentId", "==", LK).get()).docs[0];
  check("stale lock taken over", (await db.collection("teamEntries").doc(`t-lock_${P.q1.id.toLowerCase()}`).get()).get("registrationId") === fresh?.id);
  await db.collection("teamEntries").doc(`t-lock_${P.q2.id.toLowerCase()}`).set({ tournamentId: LK, playerId: P.q2.id, registrationId: fresh.id });
  await expectFail("live lock still blocks", register, P.q2.uid, { tournamentId: LK, team: { teamName: "Again", rosterIds: [P.q2.id] } },
    "ALREADY_ENTERED_TEAM", "You've already entered a team in this tournament.");
}

async function memberUidChecks(db: Firestore): Promise<void> {
  console.log("\n── memberUids sync ──");
  await db.collection("registrations").doc("R-OLD-A").set({ tournamentId: "T-X", playerId: up(P.p1.id), createdAt: Timestamp.now() });
  await db.collection("registrations").doc("R-OLD-B").set({
    tournamentId: "T-X", playerId: P.p2.id, partnerId: P.p3.id.toLowerCase(), rosterIds: [P.p4.id], createdAt: Timestamp.now(),
  });
  check("old registration synced", await member.syncRegistrationMemberUids(db, "R-OLD-A"));
  check("partner + roster uids (either id case)", await member.syncRegistrationMemberUids(db, "R-OLD-B")
    && JSON.stringify((await db.collection("registrations").doc("R-OLD-B").get()).get("memberUids")) === JSON.stringify(["u2", "u3", "u4"]));
  check("second sync is a no-op", !(await member.syncRegistrationMemberUids(db, "R-OLD-B")));
  await db.collection("matches").doc("M-X").set({ tournamentId: "T-X", teamAId: "R-OLD-A", teamBId: "R-OLD-B", statusRaw: "scheduled" });
  check("match uids set", await member.syncMatchMemberUids(db, "M-X"));
  const m = (await db.collection("matches").doc("M-X").get()).data();
  check("teamAUids / teamBUids", JSON.stringify(m?.teamAUids) === JSON.stringify(["u1"]) && JSON.stringify(m?.teamBUids) === JSON.stringify(["u2", "u3", "u4"]));
  await db.collection("registrations").doc("R-OLD-A").update({ partnerId: P.p5.id });
  await member.syncRegistrationMemberUids(db, "R-OLD-A");
  check("partner change flows to match", (await member.syncMatchesForRegistration(db, "R-OLD-A")) === 1
    && JSON.stringify((await db.collection("matches").doc("M-X").get()).get("teamAUids")) === JSON.stringify(["u1", "u5"]));
}

async function accountChecks(db: Firestore): Promise<void> {
  console.log("\n── deleteAccount ──");
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    check("auth emulator running (npm run test:emulator-core)", false);
    return;
  }
  const { getAuth } = await import("firebase-admin/auth");
  await clear(db);
  await seed(db);
  const PD = { id: "DDDDDDDD-0000-0000-0000-000000000001", uid: "u-del" };
  await db.collection("players").doc(PD.id).set({
    name: "DEL", email: "del@example.test", genderRaw: "male", elo: 1200, streak: 0,
    firebaseUid: PD.uid, fcmToken: "tok", createdAt: Timestamp.now(),
  });
  await getAuth().createUser({ uid: PD.uid }).catch(() => undefined);
  const sess = (id: string, extra: Record<string, unknown>) => db.collection("playSessions").doc(id).set({
    title: id, venue: `Court ${id}`, date: Timestamp.fromMillis(at(100)), durationMinutes: 90,
    endsAt: Timestamp.fromMillis(at(100) + 90 * 60_000), gameType: "doubles", maxPlayers: 4,
    sportType: "badminton", status: "active", hostId: P.host.uid, attendeeIds: [up(P.host.id)],
    waitlistIds: [], attendeeUids: [P.host.uid], createdAt: Timestamp.now(), ...extra,
  });
  await sess("DA", { attendeeIds: [up(P.host.id), PD.id, up(P.p1.id), P.p2.id], waitlistIds: [P.p3.id] });
  await sess("DB", { hostId: PD.uid, attendeeIds: [PD.id, P.p4.id], date: Timestamp.fromMillis(at(110)),
    endsAt: Timestamp.fromMillis(at(110) + 90 * 60_000) });
  await sess("DW", { attendeeIds: [up(P.host.id), P.p5.id, P.p6.id, P.p7.id], waitlistIds: [PD.id],
    date: Timestamp.fromMillis(at(120)), endsAt: Timestamp.fromMillis(at(120) + 90 * 60_000) });
  await sess("DP", { attendeeIds: [up(P.host.id), PD.id], date: Timestamp.fromMillis(Date.now() - 48 * HOUR),
    endsAt: Timestamp.fromMillis(Date.now() - 46 * HOUR) });
  const reg = (id: string, d: Record<string, unknown>) => db.collection("registrations").doc(id).set({ createdAt: Timestamp.now(), ...d });
  await reg("RD-SOLO", { tournamentId: "T-DOUBLES", playerId: PD.id });
  await reg("RD-PARTNER", { tournamentId: "T-DOUBLES", playerId: P.p5.id, partnerId: PD.id, memberUids: ["u5", PD.uid] });
  await reg("RD-DRAWN", { tournamentId: "T-DRAWN", playerId: PD.id });
  await reg("RD-TEAM", { tournamentId: "T-CRICKET", playerId: PD.id, teamName: "Del XI" });
  await db.collection("teamEntries").doc(`t-cricket_${PD.id.toLowerCase()}`).set({ tournamentId: "T-CRICKET", playerId: PD.id, registrationId: "RD-TEAM" });
  for (const r of [PD.uid, PD.uid, "u1"]) {
    await db.collection("notifications").add({ recipientId: r, type: "x", title: "t", body: "b", read: false });
  }

  await expectFail("deleteAccount signed out", account.deleteAccount, null, {}, "UNAUTHENTICATED");
  const r = await ok("deleteAccount", account.deleteAccount, PD.uid, {});
  check("result shape", JSON.stringify(r) === JSON.stringify({ status: "deleted" }));
  const da = await session(db, "DA");
  check("left attended session, waitlisted p3 promoted", !(da.attendeeIds as string[]).includes(PD.id)
    && (da.attendeeIds as string[]).includes(P.p3.id) && (da.waitlistIds as string[]).length === 0
    && await notified(db, "u3", "session_waitlist_promoted"), JSON.stringify(da));
  check("hosted session cancelled, player told", (await session(db, "DB")).status === "cancelled"
    && await notified(db, "u4", "session_cancelled"));
  check("off the waitlist", ((await session(db, "DW")).waitlistIds as string[]).length === 0);
  check("past session untouched", ((await session(db, "DP")).attendeeIds as string[]).includes(PD.id));
  const regDoc = async (id: string) => (await db.collection("registrations").doc(id).get()).data();
  check("solo registration deleted", !(await regDoc("RD-SOLO")));
  const rp = await regDoc("RD-PARTNER");
  check("taken off partner's entry", rp?.partnerId === undefined && JSON.stringify(rp?.memberUids) === JSON.stringify(["u5"]));
  check("drawn tournament entry kept", !!(await regDoc("RD-DRAWN")));
  check("team entry + lock deleted", !(await regDoc("RD-TEAM"))
    && !(await db.collection("teamEntries").doc(`t-cricket_${PD.id.toLowerCase()}`).get()).exists);
  check("own notifications deleted, others kept",
    (await db.collection("notifications").where("recipientId", "==", PD.uid).get()).empty
    && !(await db.collection("notifications").where("recipientId", "==", "u1").get()).empty);
  check("player doc deleted", !(await db.collection("players").doc(PD.id).get()).exists);
  check("auth user deleted", await getAuth().getUser(PD.uid).then(() => false, () => true));
  await ok("deleteAccount again is a no-op", account.deleteAccount, PD.uid, {});
}

async function autoCloseChecks(db: Firestore): Promise<void> {
  console.log("\n── Auto-close ended sessions ──");
  const now = Date.now();
  const mk = (id: string, startMsAgo: number, extra: Record<string, unknown>) =>
    db.collection("playSessions").doc(id).set({
      title: id, venue: "Court Z", hostId: P.host.uid, attendeeIds: [P.host.id],
      date: Timestamp.fromMillis(now - startMsAgo), durationMinutes: 60, status: "active", ...extra,
    });
  await mk("AC-PLAYED", 2 * HOUR, { attendeeIds: [P.host.id, P.p2.id] });
  await mk("AC-ALONE", 2 * HOUR, {});
  await mk("AC-RUNNING", 30 * 60_000, { attendeeIds: [P.host.id, P.p2.id] });
  await mk("AC-LEGACY", 2.5 * HOUR, { attendeeIds: [P.host.id, P.p2.id], durationMinutes: null, status: null });
  await mk("AC-LEGACY-RUNNING", 1.5 * HOUR, { attendeeIds: [P.host.id, P.p2.id], durationMinutes: null });
  await mk("AC-DONE", 2 * HOUR, { status: "cancelled" });

  await autoClose.runAutoCloseSessions(db, new Date(now));
  const st = async (id: string) => (await session(db, id)).status;
  check("ended with players -> completed", await st("AC-PLAYED") === "completed"
    && (await session(db, "AC-PLAYED")).autoClosed === "ended");
  check("ended, host only -> cancelled", await st("AC-ALONE") === "cancelled"
    && (await session(db, "AC-ALONE")).autoClosed === "noPlayers");
  check("host told nobody joined", await notified(db, P.host.uid, "session_cancelled"));
  check("still running untouched", await st("AC-RUNNING") === "active");
  check("legacy (no duration, 120 min) ended -> completed", await st("AC-LEGACY") === "completed");
  check("legacy still inside 120 min untouched", await st("AC-LEGACY-RUNNING") === "active");
  check("already cancelled untouched", await st("AC-DONE") === "cancelled"
    && (await session(db, "AC-DONE")).autoClosed === undefined);
}

async function main(): Promise<void> {
  const db = getFirestore();
  await clear(db);
  await seed(db);
  await openPlayChecks(db);
  await courtsChecks(db);
  await profileChecks();
  await registrationChecks(db);
  await cricketCompleteChecks(db);
  await memberUidChecks(db);
  await accountChecks(db);
  await autoCloseChecks(db);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Emulator checks crashed:", err);
  process.exit(1);
});
