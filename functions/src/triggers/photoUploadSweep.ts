import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { APPROVED_FOLDER, PHOTO_FOLDER } from "../services/profilePhotos";
import { playerForUid } from "../services/identity";

/** Uploads older than this that aren't anyone's current photo are deleted. */
const ABANDONED_MS = 3600_000;

/**
 * Daily: deletes photo files over an hour old that are no player's current
 * `photoPath`: uploads under `profilePhotos/` never sent to setProfilePhoto,
 * and approved copies left behind by a failed delete. Keeps unchecked files
 * from piling up.
 */
export const photoUploadSweep = onSchedule({ schedule: "every day 04:00", region: "us-central1", timeoutSeconds: 540 },
  async () => {
    await runPhotoUploadSweep(getFirestore(), new Date());
  });

export async function runPhotoUploadSweep(db: Firestore, now: Date): Promise<number> {
  const bucket = getStorage().bucket();
  const files = (await Promise.all([PHOTO_FOLDER, APPROVED_FOLDER]
    .map((folder) => bucket.getFiles({ prefix: `${folder}/` })))).flatMap(([f]) => f);
  const current = new Map<string, string | null>();
  let deleted = 0;
  for (const f of files) {
    const created = Date.parse(String(f.metadata?.timeCreated ?? ""));
    if (!(created <= now.getTime() - ABANDONED_MS)) continue;
    const uid = f.name.split("/")[1];
    if (!uid) continue;
    if (!current.has(uid)) {
      const me = await playerForUid(db, uid);
      current.set(uid, (me?.data.photoPath as string | null | undefined) ?? null);
    }
    if (current.get(uid) === f.name) continue;
    try {
      await f.delete({ ignoreNotFound: true });
      deleted++;
    } catch (err) {
      logger.warn(`photoUploadSweep: ${f.name}`, err);
    }
  }
  if (deleted > 0) logger.info(`photoUploadSweep: deleted ${deleted} abandoned uploads`);
  return deleted;
}
