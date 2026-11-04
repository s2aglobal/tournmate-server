import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { randomUUID } from "crypto";
import { fail } from "./errors";
import { CALLABLE_OPTS, dataOf, requirePlayer, requireString, requireUid } from "./shared";
import { playerForUid } from "../services/identity";
import { MAX_PHOTO_BYTES, STALE_UPLOAD_MS, approvedFolder, deletePhotoFiles, isOwnPhotoPath, photoDownloadURL, photoModerator } from "../services/profilePhotos";

/**
 * setGender({ gender: "male" | "female" }) -> { gender }
 * One-time: allowed only while the stored gender is missing or
 * `preferNotToSay` (GENDER_LOCKED otherwise; same value again is a no-op).
 */
export const setGender = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const gender = dataOf(req).gender;
  if (gender !== "male" && gender !== "female") {
    fail("invalid-argument", "INVALID_ARGUMENT", "Choose male or female.");
  }
  const db = getFirestore();
  await db.runTransaction(async (tx) => {
    const me = await requirePlayer(db, uid, tx);
    const current = me.data.genderRaw;
    if (current === gender) return;
    if (current && current !== "preferNotToSay") {
      fail("failed-precondition", "GENDER_LOCKED", "Your gender is already set and can't be changed.");
    }
    tx.update(me.ref, { genderRaw: gender });
  });
  return { gender };
});

/**
 * setProfilePhoto({ path }) -> { photoURL }
 * `path` is the JPEG the app just uploaded to `profilePhotos/{uid}/<id>.jpg`.
 * Copied to `approvedPhotos/{uid}/` and checked there with Cloud Vision
 * SafeSearch (fail closed: a rejected or uncheckable photo is deleted), then
 * photoURL / photoPath / photoUpdatedAt are set on the caller's player and the
 * photo it replaced is deleted.
 */
export const setProfilePhoto = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const path = requireString(dataOf(req), "path", 300);
  if (!isOwnPhotoPath(path, uid)) {
    fail("invalid-argument", "INVALID_ARGUMENT", "That photo upload isn't valid. Please try again.");
  }
  const db = getFirestore();
  const me = await requirePlayer(db, uid);

  const bucket = getStorage().bucket();
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) fail("not-found", "NOT_FOUND", "The photo upload wasn't found. Please try again.");
  const [meta] = await file.getMetadata();
  if (meta.contentType !== "image/jpeg" || Number(meta.size ?? 0) > MAX_PHOTO_BYTES) {
    await file.delete({ ignoreNotFound: true });
    fail("invalid-argument", "INVALID_ARGUMENT", "Photos must be JPEG images under 2 MB.");
  }

  // Check a server-only copy, so the client can't replace the image after it
  // passes (the upload path stays client-writable).
  const approvedPath = `${approvedFolder(uid)}${randomUUID()}.jpg`;
  const approved = bucket.file(approvedPath);
  await file.copy(approved);
  await file.delete({ ignoreNotFound: true });

  let verdict;
  try {
    verdict = await photoModerator()(bucket.name, approvedPath);
  } catch (err) {
    logger.error(`setProfilePhoto: moderation failed for ${path}`, err);
    await approved.delete({ ignoreNotFound: true });
    fail("unavailable", "PHOTO_CHECK_FAILED", "We couldn't check this photo right now. Please try again later.");
  }
  if (verdict !== "pass") {
    logger.info(`setProfilePhoto: rejected ${path}`);
    await approved.delete({ ignoreNotFound: true });
    fail("invalid-argument", "PHOTO_REJECTED", "This photo can't be used. Please choose a different one.");
  }

  const photoURL = await photoDownloadURL(approved);
  // Read the previous photo inside the write, so two devices setting a photo
  // at once each delete only the one they replaced (never the other's).
  const previous = await db.runTransaction(async (tx) => {
    const snap = await tx.get(me.ref);
    tx.update(me.ref, { photoURL, photoPath: approvedPath, photoUpdatedAt: FieldValue.serverTimestamp() });
    return snap.get("photoPath") as string | null | undefined;
  });
  if (previous && previous !== approvedPath) {
    await bucket.file(previous).delete({ ignoreNotFound: true }).catch((err) => logger.warn(`setProfilePhoto: delete ${previous}`, err));
  }
  // Abandoned uploads; recent ones may be another device's, still being checked.
  await deletePhotoFiles(uid, approvedPath, STALE_UPLOAD_MS);
  return { photoURL };
});

/**
 * removeProfilePhoto({}) -> { status: "removed" }
 * Clears the photo fields and deletes the caller's photo files. Idempotent.
 */
export const removeProfilePhoto = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const db = getFirestore();
  const me = await playerForUid(db, uid);
  if (me) await me.ref.update({ photoURL: null, photoPath: null, photoUpdatedAt: null });
  await deletePhotoFiles(uid);
  return { status: "removed" as const };
});
