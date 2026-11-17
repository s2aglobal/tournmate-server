import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { DocumentData, Firestore, getFirestore, Timestamp } from "firebase-admin/firestore";
import { PLAYER_PRIVATE, ScrubMode, authEmailFor, hasValue, planMirror } from "../services/playerPrivate";

/**
 * Public-doc scrub (player-privacy-design.md S3):
 *  - "off"   phase 1-2: copy only. Old apps and the old web keep working.
 *  - "tier1" fast path: also blanks email / phone ("" placeholders stay).
 *  - "all"   phase 3 (after the min-version bump): also deletes dateOfBirth,
 *            weightKg, homePostalCode and fcmToken from the public doc.
 * Change it here and redeploy functions; run the backfill with the matching
 * --scrub flags first.
 */
export const SCRUB_PUBLIC: ScrubMode = "off";

/**
 * Mirrors one write of players/{id} into playerPrivate/{id}. Exported for
 * the emulator checks. Idempotent: a second run has nothing to move, so the
 * scrub's own write of the public doc doesn't loop.
 */
export async function mirrorPlayerWrite(
  db: Firestore,
  docId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  afterUpdateTime: Timestamp | undefined,
  mode: ScrubMode = SCRUB_PUBLIC,
): Promise<{ privateWritten: boolean; publicScrubbed: boolean; privateDeleted: boolean }> {
  const privRef = db.collection(PLAYER_PRIVATE).doc(docId);
  if (!after) {
    await privRef.delete();
    return { privateWritten: false, publicScrubbed: false, privateDeleted: true };
  }
  const privSnap = await privRef.get();
  const priv = privSnap.exists ? privSnap.data() ?? null : null;
  const needsEmail = !priv || !hasValue(priv.email);
  const authEmail = needsEmail ? await authEmailFor(after.firebaseUid, after.email) : null;
  const plan = planMirror(before, after, priv, authEmail, mode, "mirror");
  if (!plan.privateUpdate && !plan.publicUpdate) {
    return { privateWritten: false, publicScrubbed: false, privateDeleted: false };
  }
  const batch = db.batch();
  if (plan.privateUpdate) batch.set(privRef, plan.privateUpdate, { merge: true });
  if (plan.publicUpdate) {
    const pubRef = db.collection("players").doc(docId);
    // Only scrub the version we copied from; a newer write gets its own run.
    if (afterUpdateTime) batch.update(pubRef, plan.publicUpdate, { lastUpdateTime: afterUpdateTime });
    else batch.update(pubRef, plan.publicUpdate);
  }
  try {
    await batch.commit();
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    // FAILED_PRECONDITION (9): the player doc changed meanwhile; that write re-runs this.
    if (code === 9 || code === 5 || code === "failed-precondition" || code === "not-found") {
      logger.info(`onPlayerWritten ${docId}: doc changed during scrub, skipped`);
      return { privateWritten: false, publicScrubbed: false, privateDeleted: false };
    }
    throw err;
  }
  // Field names only, never values.
  logger.info(`onPlayerWritten ${docId}`, {
    private: plan.privateUpdate ? Object.keys(plan.privateUpdate) : [],
    scrubbed: plan.publicUpdate ? Object.keys(plan.publicUpdate) : [],
  });
  return { privateWritten: !!plan.privateUpdate, publicScrubbed: !!plan.publicUpdate, privateDeleted: false };
}

export const onPlayerWritten = onDocumentWritten(
  { document: "players/{playerId}", region: "us-central1" },
  async (event) => {
    const before = event.data?.before;
    const after = event.data?.after;
    await mirrorPlayerWrite(
      getFirestore(),
      event.params.playerId,
      before?.exists ? before.data() : undefined,
      after?.exists ? after.data() : undefined,
      after?.exists ? after.updateTime : undefined,
    );
  },
);
