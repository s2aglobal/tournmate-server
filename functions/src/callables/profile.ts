import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { fail } from "./errors";
import { CALLABLE_OPTS, dataOf, requirePlayer, requireString, requireUid } from "./shared";
import { playerForUid } from "../services/identity";
import { MAX_PHOTO_BYTES, deletePhotoFiles, isOwnPhotoPath, photoDownloadURL, photoModerator } from "../services/profilePhotos";

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
 * Checked with Cloud Vision SafeSearch (fail closed: a rejected or uncheckable
 * file is deleted), then photoURL / photoPath / photoUpdatedAt are set on the
 * caller's player and their other photo files are deleted.
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

  let verdict;
  try {
    verdict = await photoModerator()(bucket.name, path);
  } catch (err) {
    logger.error(`setProfilePhoto: moderation failed for ${path}`, err);
    await file.delete({ ignoreNotFound: true });
    fail("unavailable", "PHOTO_CHECK_FAILED", "We couldn't check this photo right now. Please try again later.");
  }
  if (verdict !== "pass") {
    logger.info(`setProfilePhoto: rejected ${path}`);
    await file.delete({ ignoreNotFound: true });
    fail("invalid-argument", "PHOTO_REJECTED", "This photo can't be used. Please choose a different one.");
  }

  const photoURL = await photoDownloadURL(file);
  await me.ref.update({ photoURL, photoPath: path, photoUpdatedAt: FieldValue.serverTimestamp() });
  // The previous photo (and any abandoned uploads) under the caller's folder.
  await deletePhotoFiles(uid, path);
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
