/**
 * Emulator checks for player privacy (player-privacy-design.md 10): the
 * onPlayerWritten mirror (copy + scrub), findPlayerByContact,
 * updatePrivateProfile, account deletion, the draw's isPlayer fix,
 * private-first token / DOB reads and the backfill script. Runs handlers
 * directly against the Firestore + Auth (+ Storage) emulators with a demo-*
 * project; never a real project. Rules: tools/rules-test/run-player-privacy.sh.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-player-privacy
 *
 * Exits non-zero if any case fails.
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { DocumentData, FieldValue, Firestore, Timestamp, getFirestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST
    || !process.env.FIREBASE_STORAGE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore + Auth + Storage emulators and a demo-* project (use npm run test:emulator-player-privacy).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` });

/* eslint-disable @typescript-eslint/no-var-requires */
const callables = require("../callables/playerPrivate") as typeof import("../callables/playerPrivate");
const svc = require("../services/playerPrivate") as typeof import("../services/playerPrivate");
const trigger = require("../triggers/onPlayerWritten") as typeof import("../triggers/onPlayerWritten");
const cleanup = require("../services/accountCleanup") as typeof import("../services/accountCleanup");
const draw = require("../services/draw/tournament") as typeof import("../services/draw/tournament");
const backfill = require("./backfillPlayerPrivate") as typeof import("./backfillPlayerPrivate");
const broadcast = require("./sendBroadcast") as typeof import("./sendBroadcast");

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) passes++; else failures++;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = { run: (req: any) => any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(fn: Fn, uid: string | null, data: unknown, email?: string): Promise<any> {
  return await fn.run({ data, auth: uid ? { uid, token: email ? { email } : {} } : undefined, rawRequest: {}, acceptsStreaming: false });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok(name: string, fn: Fn, uid: string | null, data: unknown, email?: string): Promise<any> {
  try {
    const r = await call(fn, uid, data, email);
    check(name, true);
    return r;
  } catch (e) {
    const err = e as { message?: string; code?: string; details?: { reason?: string } };
    check(name, false, `threw ${err.code ?? ""} ${err.details?.reason ?? ""} ${err.message}`);
    return null;
  }
}
async function bad(name: string, fn: Fn, uid: string | null, data: unknown, reason: string, code?: string): Promise<void> {
  try {
    const r = await call(fn, uid, data);
    check(name, false, `expected ${reason}, got ${JSON.stringify(r)}`);
  } catch (e) {
    const err = e as { message?: string; code?: string; details?: { reason?: string } };
    check(name, err.details?.reason === reason && (!code || err.code === code), `${err.code} ${err.details?.reason}: ${err.message}`);
  }
}

const P = (n: number) => `AAAAAAAA-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const DOB = Timestamp.fromDate(new Date(Date.UTC(1990, 4, 17)));
const pub = async (db: Firestore, id: string) => (await db.collection("players").doc(id).get()).data() ?? {};
const priv = async (db: Firestore, id: string) => (await db.collection("playerPrivate").doc(id).get()).data();

/** Runs the mirror the way the deployed trigger would: on the write just made. */
async function write(db: Firestore, id: string, data: DocumentData | null, merge = false, mode: "off" | "tier1" | "all" = "off") {
  const ref = db.collection("players").doc(id);
  const beforeSnap = await ref.get();
  if (data === null) await ref.delete();
  else if (merge) await ref.set(data, { merge: true });
  else await ref.set(data);
  const afterSnap = await ref.get();
  return trigger.mirrorPlayerWrite(db, id, beforeSnap.exists ? beforeSnap.data() : undefined,
    afterSnap.exists ? afterSnap.data() : undefined, afterSnap.exists ? afterSnap.updateTime : undefined, mode);
}
/** The trigger's re-run on its own scrub write. */
async function rerun(db: Firestore, id: string, mode: "off" | "tier1" | "all") {
  const s = await db.collection("players").doc(id).get();
  return trigger.mirrorPlayerWrite(db, id, s.data(), s.data(), s.updateTime, mode);
}

const OLD = (uid: string | null, extra: DocumentData = {}) => ({
  name: "Old Shape", email: "Old.Shape@Example.com", phone: "(512) 555-0101", elo: 1200, streak: 0,
  genderRaw: "male", avatarId: "avatar_1", createdAt: Timestamp.now(), dateOfBirth: DOB, weightKg: 80,
  homePostalCode: "78641", fcmToken: "tok-old", ...(uid ? { firebaseUid: uid } : {}), ...extra,
});

async function mirrorChecks(db: Firestore) {
  const auth = getAuth();
  await auth.createUser({ uid: "m1", email: "real.m1@example.com" });

  // Old-shape create: everything copied, email from Auth (not the public value).
  const r1 = await write(db, P(1), OLD("m1"));
  const p1 = await priv(db, P(1));
  check("mirror: old-shape create writes playerPrivate", r1.privateWritten && !!p1);
  check("mirror: email comes from Auth", p1?.email === "real.m1@example.com", p1?.email);
  check("mirror: phone + phoneDigits", p1?.phone === "(512) 555-0101" && p1?.phoneDigits === "5125550101");
  check("mirror: Tier 2 copied", p1?.dateOfBirth instanceof Timestamp && p1.dateOfBirth.isEqual(DOB)
    && p1?.weightKg === 80 && p1?.homePostalCode === "78641" && p1?.fcmToken === "tok-old");
  check("mirror: firebaseUid + source", p1?.firebaseUid === "m1" && p1?.source === "mirror");
  check("mirror: copy mode leaves the public doc alone", (await pub(db, P(1))).email === "Old.Shape@Example.com");
  const again = await rerun(db, P(1), "off");
  check("mirror: idempotent (second run writes nothing)", !again.privateWritten && !again.publicScrubbed);

  // Old app changes a field: copied.
  await write(db, P(1), { weightKg: 82 }, true);
  check("mirror: changed public value copied", (await priv(db, P(1)))?.weightKg === 82);

  // Newer private value (callable) is not overwritten by an unchanged stale public value.
  await db.collection("playerPrivate").doc(P(1)).set({ homePostalCode: "10001", weightKg: 75 }, { merge: true });
  await write(db, P(1), { name: "Renamed" }, true);
  const p1b = await priv(db, P(1));
  check("mirror: stale public value never overwrites newer private", p1b?.homePostalCode === "10001" && p1b?.weightKg === 75,
    `${p1b?.homePostalCode}/${p1b?.weightKg}`);

  // Web / new app deletes the public copy: private kept.
  await write(db, P(1), { homePostalCode: FieldValue.delete(), weightKg: FieldValue.delete(), email: "", phone: "" }, true);
  const p1c = await priv(db, P(1));
  check("mirror: deleting / blanking public fields never wipes private",
    p1c?.homePostalCode === "10001" && p1c?.weightKg === 75 && p1c?.email === "real.m1@example.com" && p1c?.phone === "(512) 555-0101");

  // Old app nulls its own token: cleared privately (same token only).
  await write(db, P(1), { fcmToken: null }, true);
  check("mirror: old app clearing its token clears it privately", (await priv(db, P(1)))?.fcmToken === null);
  await write(db, P(1), { fcmToken: "tok-2" }, true);
  await db.collection("playerPrivate").doc(P(1)).set({ fcmToken: "tok-new-device" }, { merge: true });
  await write(db, P(1), { fcmToken: null }, true);
  check("mirror: a different private token is not cleared", (await priv(db, P(1)))?.fcmToken === "tok-new-device");

  // Scrub tier1: email/phone blanked, Tier 2 kept, keys stay.
  await auth.createUser({ uid: "m2", email: "m2@example.com" });
  const r2 = await write(db, P(2), OLD("m2"), false, "tier1");
  const pub2 = await pub(db, P(2));
  check("scrub tier1: public email/phone blanked (keys kept)", r2.publicScrubbed && pub2.email === "" && pub2.phone === "");
  check("scrub tier1: Tier 2 stays public", pub2.dateOfBirth instanceof Timestamp && pub2.fcmToken === "tok-old");
  check("scrub tier1: private holds contact", (await priv(db, P(2)))?.email === "m2@example.com"
    && (await priv(db, P(2)))?.phoneDigits === "5125550101");
  const r2b = await rerun(db, P(2), "tier1");
  check("scrub tier1: re-run on its own write is a no-op (no loop)", !r2b.privateWritten && !r2b.publicScrubbed);

  // Scrub all.
  const r3 = await write(db, P(3), OLD("m3"), false, "all");
  const pub3 = await pub(db, P(3));
  check("scrub all: Tier 2 removed from the public doc", r3.publicScrubbed
    && !("dateOfBirth" in pub3) && !("weightKg" in pub3) && !("homePostalCode" in pub3) && !("fcmToken" in pub3));
  check("scrub all: email/phone placeholders kept as \"\"", pub3.email === "" && pub3.phone === "");
  const p3 = await priv(db, P(3));
  check("scrub all: private holds everything (Auth user missing -> public email)",
    p3?.email === "old.shape@example.com" && p3?.weightKg === 80 && p3?.fcmToken === "tok-old");
  const r3b = await rerun(db, P(3), "all");
  check("scrub all: re-run is a no-op", !r3b.privateWritten && !r3b.publicScrubbed);

  // Legacy organizer-created player (no firebaseUid).
  await write(db, P(4), OLD(null), false, "all");
  const p4 = await priv(db, P(4));
  check("no firebaseUid: private firebaseUid null, email from the public doc", p4?.firebaseUid === null && p4?.email === "old.shape@example.com");
  check("no firebaseUid: scrubbed", (await pub(db, P(4))).email === "");

  // New-app create ("" placeholders, nothing private): private doc with Auth email.
  await auth.createUser({ uid: "m5", email: "New@Example.com" });
  await write(db, P(5), { name: "New", email: "", phone: "", elo: 1200, streak: 0, firebaseUid: "m5" });
  const p5 = await priv(db, P(5));
  check("new-app create: private doc with lower-case Auth email", p5?.email === "new@example.com" && p5?.phone === "" && p5?.phoneDigits === "");

  // Delete.
  const rd = await write(db, P(5), null);
  check("mirror: player delete removes playerPrivate", rd.privateDeleted && !(await priv(db, P(5))));
}

async function lookupChecks(db: Firestore) {
  const auth = getAuth();
  await auth.createUser({ uid: "L1", email: "Finder@Example.com" });
  await auth.createUser({ uid: "L2", email: "target@example.com" });
  await write(db, P(11), { name: "Finder", email: "", phone: "", elo: 1200, streak: 0, firebaseUid: "L1" });
  await write(db, P(12), OLD("L2", { name: "Target", phone: "+1 512-555-0199" }), false, "all");
  // Legacy, public only (not backfilled yet).
  await db.collection("players").doc(P(13)).set(OLD("L3", { name: "Legacy", email: "legacy@example.com", phone: "5125550177" }));

  const r1 = await ok("lookup: by email, any letter case", callables.findPlayerByContact, "L1", { query: "  TARGET@Example.COM " });
  check("lookup: email -> playerId", r1?.playerId === P(12), JSON.stringify(r1));
  check("lookup: response holds playerId only (no contact data)", !!r1 && Object.keys(r1).join() === "playerId"
    && !JSON.stringify(r1).includes("@") && !JSON.stringify(r1).includes("555"));
  const r2 = await ok("lookup: by phone with formatting", callables.findPlayerByContact, "L1", { query: "(512) 555-0199" });
  check("lookup: phone -> playerId", r2?.playerId === P(12));
  const r3 = await ok("lookup: by phone, digits only + country code", callables.findPlayerByContact, "L1", { query: "15125550199" });
  check("lookup: digits match", r3?.playerId === P(12));
  const r4 = await ok("lookup: phase 1 falls back to the public doc", callables.findPlayerByContact, "L1", { query: "legacy@example.com" });
  check("lookup: legacy fallback", r4?.playerId === P(13), JSON.stringify(r4));
  const r5 = await ok("lookup: unknown email", callables.findPlayerByContact, "L1", { query: "nobody@example.com" });
  check("lookup: not found -> { playerId: null }", r5 !== null && r5.playerId === null && Object.keys(r5).join() === "playerId");
  // lower-case doc id (web profile) -> canonical UPPER id
  await write(db, "bbbbbbbb-0000-0000-0000-000000000014", OLD("L4", { name: "Web", email: "web@example.com" }), false, "tier1");
  const r6 = await ok("lookup: web profile (lower-case doc id)", callables.findPlayerByContact, "L1", { query: "web@example.com" });
  check("lookup: canonical UPPER id", r6?.playerId === "BBBBBBBB-0000-0000-0000-000000000014", r6?.playerId);

  await bad("lookup: signed out", callables.findPlayerByContact, null, { query: "target@example.com" }, "UNAUTHENTICATED", "unauthenticated");
  await bad("lookup: needs a profile", callables.findPlayerByContact, "nobody-uid", { query: "target@example.com" }, "NO_PROFILE");
  await bad("lookup: too-short phone", callables.findPlayerByContact, "L1", { query: "12345" }, "INVALID_ARGUMENT");
  await bad("lookup: empty", callables.findPlayerByContact, "L1", { query: "  " }, "INVALID_ARGUMENT");
  await bad("lookup: not text", callables.findPlayerByContact, "L1", { query: 5125550199 }, "INVALID_ARGUMENT");

  // Rate limit: 20 per 10 minutes; the 21st fails with RESOURCE_EXHAUSTED.
  await db.collection("rateLimits").doc("L2").delete();
  let allowed = 0;
  for (let i = 0; i < 20; i++) {
    try { await call(callables.findPlayerByContact, "L2", { query: "finder@example.com" }); allowed++; } catch { /* counted below */ }
  }
  check("rate limit: 20 lookups allowed", allowed === 20, String(allowed));
  await bad("rate limit: 21st -> RESOURCE_EXHAUSTED", callables.findPlayerByContact, "L2", { query: "finder@example.com" }, "RATE_LIMITED", "resource-exhausted");
  await db.collection("rateLimits").doc("L2").set({ findPlayerByContact: { windowStart: Timestamp.fromMillis(Date.now() - 11 * 60 * 1000), count: 20 } });
  await ok("rate limit: resets after the window", callables.findPlayerByContact, "L2", { query: "finder@example.com" });
}

async function updateChecks(db: Firestore) {
  const auth = getAuth();
  await auth.createUser({ uid: "U1", email: "Owner@Example.com" });
  await db.collection("players").doc(P(21)).set({ name: "Owner", email: "", phone: "", elo: 1200, streak: 0, firebaseUid: "U1" });
  const dobMs = Date.UTC(1995, 0, 15);

  const r1 = await ok("update: creates the private doc when missing", callables.updatePrivateProfile, "U1",
    { dateOfBirth: dobMs, homePostalCode: " 78641 ", weightKg: 70.5, email: "attacker@evil.com" });
  check("update: returns DOB as epoch ms", r1?.dateOfBirth === dobMs, String(r1?.dateOfBirth));
  check("update: email from Auth, input email ignored", r1?.email === "owner@example.com", r1?.email);
  const p1 = await priv(db, P(21));
  check("update: stored DOB is a Timestamp", p1?.dateOfBirth instanceof Timestamp && p1.dateOfBirth.toMillis() === dobMs);
  check("update: firebaseUid + source + trimmed postal", p1?.firebaseUid === "U1" && p1?.source === "callable" && p1?.homePostalCode === "78641");
  check("update: phone placeholders filled", p1?.phone === "" && p1?.phoneDigits === "");

  await ok("update: ISO date accepted", callables.updatePrivateProfile, "U1", { dateOfBirth: "1995-01-15T00:00:00.000Z" });
  await ok("update: token alone (Android token sync)", callables.updatePrivateProfile, "U1", { fcmToken: "tok-u1" });
  const p2 = await priv(db, P(21));
  check("update: token alone leaves other fields", p2?.fcmToken === "tok-u1" && p2?.weightKg === 70.5 && p2?.homePostalCode === "78641");
  await ok("update: phone accepted (still allowed, never required)", callables.updatePrivateProfile, "U1", { phone: "+1 (512) 555-0123" });
  check("update: phoneDigits set", (await priv(db, P(21)))?.phoneDigits === "15125550123");
  const r3 = await ok("update: \"\" clears postal code, null clears weight", callables.updatePrivateProfile, "U1",
    { homePostalCode: "", weightKg: null });
  check("update: cleared fields return null", r3?.homePostalCode === null && r3?.weightKg === null);
  const p3 = await priv(db, P(21));
  check("update: cleared fields stored as null (private wins over legacy public)",
    "homePostalCode" in (p3 ?? {}) && p3?.homePostalCode === null && p3?.weightKg === null);
  const r4 = await ok("update: {} just returns the doc", callables.updatePrivateProfile, "U1", {});
  check("update: {} response shape", !!r4 && ["email", "phone", "dateOfBirth", "weightKg", "homePostalCode", "fcmToken", "updatedAt"]
    .every((k) => k in r4));

  const now = new Date();
  const future = Date.now() + 86_400_000;
  const twelve = Date.UTC(now.getUTCFullYear() - 12, now.getUTCMonth(), now.getUTCDate());
  const thirteen = Date.UTC(now.getUTCFullYear() - 13, now.getUTCMonth(), now.getUTCDate());
  await bad("update: DOB in the future", callables.updatePrivateProfile, "U1", { dateOfBirth: future }, "INVALID_ARGUMENT");
  await bad("update: under 13", callables.updatePrivateProfile, "U1", { dateOfBirth: twelve }, "INVALID_ARGUMENT");
  await ok("update: exactly 13 today", callables.updatePrivateProfile, "U1", { dateOfBirth: thirteen });
  await bad("update: DOB not a date", callables.updatePrivateProfile, "U1", { dateOfBirth: "yesterday" }, "INVALID_ARGUMENT");
  await bad("update: weight 19", callables.updatePrivateProfile, "U1", { weightKg: 19 }, "INVALID_ARGUMENT");
  await bad("update: weight 301", callables.updatePrivateProfile, "U1", { weightKg: 301 }, "INVALID_ARGUMENT");
  await bad("update: weight as text", callables.updatePrivateProfile, "U1", { weightKg: "70" }, "INVALID_ARGUMENT");
  await bad("update: postal code 13 chars", callables.updatePrivateProfile, "U1", { homePostalCode: "1234567890123" }, "INVALID_ARGUMENT");
  await bad("update: token over 4096", callables.updatePrivateProfile, "U1", { fcmToken: "x".repeat(4097) }, "INVALID_ARGUMENT");
  await bad("update: phone too short", callables.updatePrivateProfile, "U1", { phone: "12345" }, "INVALID_ARGUMENT");
  await bad("update: signed out", callables.updatePrivateProfile, null, { weightKg: 70 }, "UNAUTHENTICATED");
  await bad("update: needs a profile", callables.updatePrivateProfile, "no-profile", { weightKg: 70 }, "NO_PROFILE");
  check("update: failed validation wrote nothing", (await priv(db, P(21)))?.weightKg === null);

  // Legacy public copies are removed for the fields written / cleared.
  await auth.createUser({ uid: "U2", email: "u2@example.com" });
  await write(db, P(22), OLD("U2"));
  const before = await db.collection("players").doc(P(22)).get();
  await ok("update: owner with an old-shape public doc", callables.updatePrivateProfile, "U2",
    { weightKg: 90, dateOfBirth: null, phone: "5125550100", fcmToken: "" });
  const after = await db.collection("players").doc(P(22)).get();
  const ap = after.data() ?? {};
  check("update: public weightKg / dateOfBirth / fcmToken copies deleted, phone -> \"\"",
    !("weightKg" in ap) && !("dateOfBirth" in ap) && !("fcmToken" in ap) && ap.phone === "", JSON.stringify(Object.keys(ap)));
  check("update: untouched public fields stay (old apps)", ap.homePostalCode === "78641" && ap.email === "Old.Shape@Example.com");
  // The mirror's run on that public write must not undo the private values.
  await trigger.mirrorPlayerWrite(db, P(22), before.data(), ap, after.updateTime, "off");
  const pp = await priv(db, P(22));
  check("update + mirror: private values survive the public deletion", pp?.weightKg === 90 && pp?.dateOfBirth === null
    && pp?.fcmToken === null && pp?.phoneDigits === "5125550100" && pp?.homePostalCode === "78641");
}

async function readChecks(db: Firestore) {
  // Token: private only, private null overrides public, fallback to public, lookup by uid.
  await db.collection("players").doc(P(31)).set({ name: "T1", firebaseUid: "t1", email: "", phone: "" });
  await db.collection("playerPrivate").doc(P(31)).set({ firebaseUid: "t1", fcmToken: "priv-tok" });
  check("token: private-only token found (by id)", await svc.deviceTokenFor(db, await pub(db, P(31)), P(31)) === "priv-tok");
  check("token: private-only token found (by firebaseUid)", await svc.deviceTokenFor(db, await pub(db, P(31))) === "priv-tok");
  await db.collection("players").doc(P(32)).set({ name: "T2", firebaseUid: "t2", fcmToken: "old-pub" });
  check("token: legacy public fallback", await svc.deviceTokenFor(db, await pub(db, P(32)), P(32)) === "old-pub");
  await db.collection("playerPrivate").doc(P(32)).set({ firebaseUid: "t2", fcmToken: null });
  check("token: cleared private token wins over public", await svc.deviceTokenFor(db, await pub(db, P(32)), P(32)) === undefined);

  // DOB.
  await db.collection("players").doc(P(33)).set({ name: "D", firebaseUid: "d1", dateOfBirth: Timestamp.fromMillis(0) });
  check("dob: legacy public fallback", (await svc.dobFor(db, { docId: P(33), data: await pub(db, P(33)) }))?.toMillis() === 0);
  await db.collection("playerPrivate").doc(P(33)).set({ dateOfBirth: DOB });
  check("dob: private first", (await svc.dobFor(db, { docId: P(33), data: await pub(db, P(33)) }))?.isEqual(DOB) === true);

  // Broadcast audience reads private tokens.
  const { recipients } = await broadcast.collectAudience(db, { title: "t", body: "b", apply: false, testUid: "t1" } as never);
  check("broadcast: private token used", recipients.length === 1 && recipients[0].token === "priv-tok");

  // Draw: players without email / phone keys are still included.
  await db.collection("tournaments").doc("TDRAW").set({ title: "Draw", date: Timestamp.now(), location: "X", formatRaw: "singles",
    sportType: "badminton", createdBy: "org" });
  await db.collection("players").doc(P(34)).set({ name: "No Keys A", elo: 1200 });
  await db.collection("players").doc(P(35)).set({ name: "No Keys B", elo: 1250 });
  await db.collection("registrations").doc("RD1").set({ tournamentId: "TDRAW", playerId: P(34) });
  await db.collection("registrations").doc("RD2").set({ tournamentId: "TDRAW", playerId: P(35) });
  const state = await draw.loadDrawState(db, "TDRAW");
  check("draw: players lacking email/phone keys are included", state?.entries.length === 2, String(state?.entries.length));
}

async function accountChecks(db: Firestore) {
  await getAuth().createUser({ uid: "GONE", email: "gone@example.com" });
  await write(db, P(41), OLD("GONE"));
  check("account: private doc exists before delete", !!(await priv(db, P(41))));
  const s = await cleanup.cleanupAccount(db, "GONE");
  check("account: deleteAccount cleanup removes playerPrivate", s.privateDeleted === 1 && !(await priv(db, P(41))), JSON.stringify(s));
  const s2 = await cleanup.cleanupAccount(db, "GONE");
  check("account: second run finds nothing", s2.privateDeleted === 0 && !s2.playerDeleted);
}

async function backfillChecks(db: Firestore) {
  // Fresh collections for the backfill counts.
  for (const c of ["players", "playerPrivate", "tournaments", "registrations"]) {
    const snap = await db.collection(c).get();
    for (const d of snap.docs) await d.ref.delete();
  }
  const auth = getAuth();
  await auth.createUser({ uid: "B1", email: "b1@example.com" });
  await auth.createUser({ uid: "B2", email: "different@example.com" });
  await db.collection("players").doc(P(51)).set(OLD("B1", { email: "b1@example.com" }));
  await db.collection("players").doc(P(52)).set(OLD("B2", { email: "b2@example.com", phone: "" }));
  await db.collection("players").doc(P(53)).set(OLD(null, { email: "organizer-made@example.com" }));
  await db.collection("players").doc(P(54)).set({ name: "No keys", elo: 1200, firebaseUid: "B-missing" });
  // A newer callable-written private doc for P51.
  await db.collection("playerPrivate").doc(P(51)).set({ firebaseUid: "B1", email: "b1@example.com", weightKg: 66,
    phone: "", phoneDigits: "", updatedAt: Timestamp.fromMillis(Date.now() + 60_000), source: "callable" });
  await db.collection("tournaments").doc("TC").set({ title: "Cricket", sportType: "cricket", formatRaw: "team" });
  await db.collection("tournaments").doc("TT").set({ title: "Team", sportType: "badminton", formatRaw: "team" });
  await db.collection("tournaments").doc("TB").set({ title: "Badminton", sportType: "badminton", formatRaw: "singles" });
  await db.collection("registrations").doc("R1").set({ tournamentId: "TC", playerId: P(51), rosterIds: [P(51), P(52)] });

  const dry = await backfill.backfillPlayerPrivate(db, { apply: false, scrub: "off", restore: false, verifyOnly: false });
  check("backfill dry run: counts", dry.players === 4 && dry.withEmail === 3 && dry.withPhone === 2 && dry.withToken === 3
    && dry.noFirebaseUid === 1 && dry.contactKeysMissing === 1 && dry.privateToCreate === 3 && dry.privateToUpdate === 1,
    JSON.stringify(dry));
  check("backfill dry run: auth mismatch / missing", dry.authEmailMismatch === 1 && dry.authUserMissing === 1);
  check("backfill dry run: team/cricket signal", dry.teamOrCricketTournaments === 2 && dry.playersInTeamOrCricket === 2,
    `${dry.teamOrCricketTournaments}/${dry.playersInTeamOrCricket}`);
  check("backfill dry run: wrote nothing", dry.writes === 0 && (await db.collection("playerPrivate").get()).size === 1);
  const dryOut = JSON.stringify(dry);
  check("backfill output holds counts only", !dryOut.includes("@") && !dryOut.includes("tok-"));

  const v0 = await backfill.verifyPlayerPrivate(db, "tier1");
  check("verify before scrub fails", !v0.ok);

  const applied = await backfill.backfillPlayerPrivate(db, { apply: true, scrub: "off", restore: false, verifyOnly: false });
  check("backfill --apply: writes", applied.writes === 4 && (await db.collection("playerPrivate").get()).size === 4, String(applied.writes));
  const p51 = await priv(db, P(51));
  check("backfill --apply: newer private value kept, missing keys filled", p51?.weightKg === 66 && p51?.fcmToken === "tok-old"
    && p51?.homePostalCode === "78641", JSON.stringify({ w: p51?.weightKg }));
  check("backfill --apply: Auth email wins", (await priv(db, P(52)))?.email === "different@example.com");
  check("backfill --apply: no-uid player uses public email", (await priv(db, P(53)))?.email === "organizer-made@example.com"
    && (await priv(db, P(53)))?.firebaseUid === null);
  check("backfill --apply: copy leaves public docs", (await pub(db, P(52))).email === "b2@example.com");
  const again = await backfill.backfillPlayerPrivate(db, { apply: true, scrub: "off", restore: false, verifyOnly: false });
  check("backfill --apply: idempotent", again.writes === 0, String(again.writes));
  check("verify after copy: every player has a private doc", (await backfill.verifyPlayerPrivate(db, "off")).ok);

  const t1 = await backfill.backfillPlayerPrivate(db, { apply: true, scrub: "tier1", restore: false, verifyOnly: false });
  check("backfill --scrub --tier1: nothing refused", t1.scrubRefused === 0 && t1.publicToScrub === 3, JSON.stringify(t1));
  const v1 = await backfill.verifyPlayerPrivate(db, "tier1");
  check("verify tier1 passes", v1.ok && v1.publicWithContact === 0, JSON.stringify(v1));
  check("tier1: Tier 2 still public", (await pub(db, P(52))).fcmToken === "tok-old");
  check("verify all still fails (Tier 2 public)", !(await backfill.verifyPlayerPrivate(db, "all")).ok);

  await backfill.backfillPlayerPrivate(db, { apply: true, scrub: "all", restore: false, verifyOnly: false });
  const v2 = await backfill.verifyPlayerPrivate(db, "all");
  check("backfill --scrub (all) + verify passes", v2.ok, JSON.stringify(v2));
  const p52 = await pub(db, P(52));
  check("scrub all: placeholders kept, Tier 2 gone", p52.email === "" && p52.phone === "" && !("dateOfBirth" in p52));

  const restored = await backfill.backfillPlayerPrivate(db, { apply: true, scrub: "off", restore: true, verifyOnly: false });
  const r52 = await pub(db, P(52));
  check("--restore writes private values back", restored.publicToRestore === 3 && r52.email === "different@example.com"
    && r52.fcmToken === "tok-old" && r52.dateOfBirth instanceof Timestamp, JSON.stringify(restored));

  check("args: dry run default", backfill.parseBackfillArgs(["--project", "demo-x"]).apply === false);
  check("args: --scrub --tier1", backfill.parseBackfillArgs(["--project", "demo-x", "--apply", "--scrub", "--tier1"]).scrub === "tier1");
  let threw = false;
  try { backfill.parseBackfillArgs(["--project", "demo-x", "--tier1"]); } catch { threw = true; }
  check("args: --tier1 needs --scrub", threw);
}

async function pureChecks() {
  check("parse: email lower-cased", JSON.stringify(callables.parseContactQuery(" A@B.CO ")) === JSON.stringify({ kind: "email", value: "a@b.co" }));
  check("parse: phone digits", JSON.stringify(callables.parseContactQuery("+1 (512) 555-0101")) === JSON.stringify({ kind: "phone", value: "15125550101" }));
  check("parse: 6 digits rejected", callables.parseContactQuery("123-456") === null);
  check("parse: bad email rejected", callables.parseContactQuery("a@") === null);
  check("parse: guest name rejected", callables.parseContactQuery("John Smith") === null);
}

async function main(): Promise<void> {
  const db = getFirestore();
  await pureChecks();
  await mirrorChecks(db);
  await lookupChecks(db);
  await updateChecks(db);
  await readChecks(db);
  await accountChecks(db);
  await backfillChecks(db);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
