/**
 * Emulator checks for profile photos: setProfilePhoto / removeProfilePhoto
 * (moderation stubbed via setPhotoModerator), the SafeSearch verdict and the
 * account-cleanup photo delete. Runs the callable handlers directly (`.run`)
 * against the Firestore + Storage emulators; never a real project.
 * Storage / Firestore rules for photos: tools/rules-test/run-photos.sh.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-photos
 * which runs, under `firebase emulators:exec --only firestore,storage,auth --project demo-tournmate`:
 *   node lib/scripts/emulatorPhotoChecks.js
 *
 * Exits non-zero if any case fails.
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp, Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore + Storage emulators and a demo-* project (use npm run test:emulator-photos).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` });

// Imported after initializeApp so the handlers hit the emulators.
/* eslint-disable @typescript-eslint/no-var-requires */
const profile = require("../callables/profile") as typeof import("../callables/profile");
const photos = require("../services/profilePhotos") as typeof import("../services/profilePhotos");
const cleanup = require("../services/accountCleanup") as typeof import("../services/accountCleanup");

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

const ME = { id: "BBBBBBBB-0000-0000-0000-000000000001", uid: "u-photo" };
const OTHER = { id: "BBBBBBBB-0000-0000-0000-000000000002", uid: "u-other" };
const GONE = { id: "BBBBBBBB-0000-0000-0000-000000000003", uid: "u-gone" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

const bucket = () => getStorage().bucket();
async function upload(path: string, opts: { contentType?: string; token?: boolean; bytes?: Buffer } = {}): Promise<void> {
  const metadata: Record<string, string> = {};
  if (opts.token !== false) metadata.firebaseStorageDownloadTokens = `tok-${Math.random().toString(36).slice(2)}`;
  await bucket().file(path).save(opts.bytes ?? JPEG, {
    resumable: false,
    contentType: opts.contentType ?? "image/jpeg",
    metadata: { metadata },
  });
}
async function exists(path: string): Promise<boolean> {
  return (await bucket().file(path).exists())[0];
}
async function filesOf(uid: string): Promise<string[]> {
  return (await bucket().getFiles({ prefix: `profilePhotos/${uid}/` }))[0].map((f) => f.name).sort();
}
async function player(db: Firestore, id: string) {
  return (await db.collection("players").doc(id).get()).data() ?? {};
}

async function seed(db: Firestore): Promise<void> {
  for (const c of ["players", "notifications"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await bucket().deleteFiles({ prefix: "profilePhotos/" });
  for (const p of [ME, OTHER, GONE]) {
    await db.collection("players").doc(p.id).set({
      name: p.uid, phone: "", email: `${p.uid}@example.test`, genderRaw: "male",
      elo: 1200, streak: 0, firebaseUid: p.uid, avatarId: "a1", createdAt: Timestamp.now(),
    });
  }
}

function safeSearchChecks(): void {
  console.log("\n── SafeSearch verdict ──");
  const blocks = photos.safeSearchBlocks;
  check("all unlikely passes", !blocks({ adult: "VERY_UNLIKELY", violence: "UNLIKELY", racy: "POSSIBLE" }));
  check("adult LIKELY blocks", blocks({ adult: "LIKELY", violence: "VERY_UNLIKELY", racy: "VERY_UNLIKELY" }));
  check("violence VERY_LIKELY blocks", blocks({ adult: "UNLIKELY", violence: "VERY_LIKELY", racy: "UNLIKELY" }));
  check("racy LIKELY blocks", blocks({ racy: "LIKELY" }));
  check("numeric LIKELY (4) blocks", blocks({ adult: 4 }));
  check("numeric POSSIBLE (3) passes", !blocks({ adult: 3, violence: 1, racy: 2 }));
  check("missing values pass", !blocks({}));
}

async function setPhotoChecks(db: Firestore): Promise<void> {
  console.log("\n── setProfilePhoto ──");
  const { setProfilePhoto } = profile;
  const seen: string[] = [];
  photos.setPhotoModerator(async (b, p) => {
    seen.push(`gs://${b}/${p}`);
    return "pass";
  });
  const p1 = `profilePhotos/${ME.uid}/11111111-aaaa.jpg`;

  await expectFail("signed out", setProfilePhoto, null, { path: p1 }, "UNAUTHENTICATED");
  await expectFail("missing path", setProfilePhoto, ME.uid, {}, "INVALID_ARGUMENT");
  await expectFail("other user's folder", setProfilePhoto, ME.uid, { path: `profilePhotos/${OTHER.uid}/x.jpg` }, "INVALID_ARGUMENT");
  await expectFail("nested path", setProfilePhoto, ME.uid, { path: `profilePhotos/${ME.uid}/a/b.jpg` }, "INVALID_ARGUMENT");
  await expectFail("traversal", setProfilePhoto, ME.uid, { path: `profilePhotos/${ME.uid}/../${OTHER.uid}/x.jpg` }, "INVALID_ARGUMENT");
  await expectFail("not .jpg", setProfilePhoto, ME.uid, { path: `profilePhotos/${ME.uid}/x.png` }, "INVALID_ARGUMENT");
  await expectFail("other folder", setProfilePhoto, ME.uid, { path: `avatars/${ME.uid}/x.jpg` }, "INVALID_ARGUMENT");
  await expectFail("no profile", setProfilePhoto, "u-none", { path: "profilePhotos/u-none/x.jpg" }, "NO_PROFILE");
  await expectFail("file missing", setProfilePhoto, ME.uid, { path: p1 }, "NOT_FOUND");

  const png = `profilePhotos/${ME.uid}/png.jpg`;
  await upload(png, { contentType: "image/png" });
  await expectFail("wrong content type", setProfilePhoto, ME.uid, { path: png }, "INVALID_ARGUMENT");
  check("wrong content type: file deleted", !(await exists(png)));
  const big = `profilePhotos/${ME.uid}/big.jpg`;
  await upload(big, { bytes: Buffer.alloc(2 * 1024 * 1024 + 1, 1) });
  await expectFail("over 2 MB", setProfilePhoto, ME.uid, { path: big }, "INVALID_ARGUMENT");
  check("over 2 MB: file deleted", !(await exists(big)));

  // Rejected by moderation.
  photos.setPhotoModerator(async () => "reject");
  const bad = `profilePhotos/${ME.uid}/bad.jpg`;
  await upload(bad);
  await expectFail("moderation rejects", setProfilePhoto, ME.uid, { path: bad }, "PHOTO_REJECTED",
    "This photo can't be used. Please choose a different one.");
  check("rejected: file deleted", !(await exists(bad)));
  check("rejected: player unchanged", (await player(db, ME.id)).photoURL === undefined);

  // Moderation unavailable: fail closed.
  photos.setPhotoModerator(async () => {
    throw new Error("vision down");
  });
  const down = `profilePhotos/${ME.uid}/down.jpg`;
  await upload(down);
  await expectFail("moderation error", setProfilePhoto, ME.uid, { path: down }, "PHOTO_CHECK_FAILED",
    "We couldn't check this photo right now. Please try again later.");
  check("check failed: file deleted", !(await exists(down)));
  check("check failed: player unchanged", (await player(db, ME.id)).photoURL === undefined);

  // Pass.
  photos.setPhotoModerator(async (b, p) => {
    seen.push(`gs://${b}/${p}`);
    return "pass";
  });
  seen.length = 0;
  await upload(p1);
  const r1 = await ok<{ photoURL: string }>("set photo", setProfilePhoto, ME.uid, { path: p1 });
  check("moderator got gs:// path", seen[0] === `gs://${bucket().name}/${p1}`, seen[0]);
  const d1 = await player(db, ME.id);
  check("player photoURL = returned URL", !!r1 && d1.photoURL === r1.photoURL);
  check("photoURL has download token", typeof d1.photoURL === "string" && /[?&]token=/.test(d1.photoURL), d1.photoURL);
  check("photoURL names the path", typeof d1.photoURL === "string" && d1.photoURL.includes(encodeURIComponent(p1)));
  check("player photoPath set", d1.photoPath === p1);
  check("player photoUpdatedAt set", d1.photoUpdatedAt instanceof Timestamp);
  check("avatarId untouched", d1.avatarId === "a1");
  if (r1) {
    const res = await fetch(r1.photoURL.replace(/^https?:\/\/[^/]+/, `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`));
    check("download URL serves the file", res.ok && Buffer.from(await res.arrayBuffer()).equals(JPEG), String(res.status));
  }

  // Replace: previous photo and stray uploads go; another user's folder stays.
  const p2 = `profilePhotos/${ME.uid}/22222222-bbbb.jpg`;
  const stray = `profilePhotos/${ME.uid}/stray.jpg`;
  const theirs = `profilePhotos/${OTHER.uid}/theirs.jpg`;
  await upload(p2);
  await upload(stray);
  await upload(theirs);
  await ok("replace photo", setProfilePhoto, ME.uid, { path: p2 });
  check("only the new file remains", JSON.stringify(await filesOf(ME.uid)) === JSON.stringify([p2]),
    (await filesOf(ME.uid)).join(","));
  check("other user's file kept", await exists(theirs));
  check("photoPath updated", (await player(db, ME.id)).photoPath === p2);

  // Upload without a download token (e.g. not from a client SDK): one is added.
  const noTok = `profilePhotos/${OTHER.uid}/notoken.jpg`;
  await upload(noTok, { token: false });
  const r3 = await ok<{ photoURL: string }>("set photo without token", setProfilePhoto, OTHER.uid, { path: noTok });
  check("token added", !!r3 && /[?&]token=/.test(r3.photoURL));
  check("other user's earlier file replaced", !(await exists(theirs)));
  photos.setPhotoModerator(null);
}

async function removePhotoChecks(db: Firestore): Promise<void> {
  console.log("\n── removeProfilePhoto ──");
  const { removeProfilePhoto } = profile;
  await expectFail("signed out", removeProfilePhoto, null, {}, "UNAUTHENTICATED");
  const r = await ok<{ status: string }>("remove", removeProfilePhoto, ME.uid, {});
  check("status removed", r?.status === "removed");
  const d = await player(db, ME.id);
  check("fields cleared to null", d.photoURL === null && d.photoPath === null && d.photoUpdatedAt === null);
  check("files deleted", (await filesOf(ME.uid)).length === 0);
  check("other user's photo kept", (await filesOf(OTHER.uid)).length === 1);
  await ok("remove again is a no-op", removeProfilePhoto, ME.uid, {});
  await ok("remove without a profile", removeProfilePhoto, "u-none", {});
}

async function cleanupChecks(db: Firestore): Promise<void> {
  console.log("\n── account cleanup ──");
  await upload(`profilePhotos/${GONE.uid}/a.jpg`);
  await upload(`profilePhotos/${GONE.uid}/b.jpg`);
  const s = await cleanup.cleanupAccount(db, GONE.uid);
  check("photos deleted", s.photosDeleted === 2 && (await filesOf(GONE.uid)).length === 0, JSON.stringify(s));
  check("player deleted", !(await db.collection("players").doc(GONE.id).get()).exists);
  check("other user's photo kept", (await filesOf(OTHER.uid)).length === 1);
  await upload(`profilePhotos/u-noprofile/c.jpg`);
  const s2 = await cleanup.cleanupAccount(db, "u-noprofile");
  check("photos deleted without a player doc", s2.photosDeleted === 1 && (await filesOf("u-noprofile")).length === 0);
  const s3 = await cleanup.cleanupAccount(db, GONE.uid);
  check("second run finds nothing", s3.photosDeleted === 0);
}

async function main(): Promise<void> {
  const db = getFirestore();
  await seed(db);
  safeSearchChecks();
  await setPhotoChecks(db);
  await removePhotoChecks(db);
  await cleanupChecks(db);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Emulator checks crashed:", err);
  process.exit(1);
});
