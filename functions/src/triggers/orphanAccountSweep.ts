import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import { cleanupAccount } from "../services/accountCleanup";

/** Most accounts cleaned in one run, so a bad lookup can't wipe many profiles. */
const MAX_CLEANUPS_PER_RUN = 50;
const PAGE_SIZE = 100;

/**
 * Safety net for account deletion, run nightly: finds player profiles whose
 * sign-in account no longer exists (deleted in the console, or by an older
 * app that deleted the account before its profile) and runs the same
 * cleanup as the deleteAccount callable. Auth onDelete triggers exist only
 * on Gen 1, which doesn't support the Node 24 runtime, hence the sweep.
 */
export const orphanAccountSweep = onSchedule("every day 03:30", async () => {
  const db = getFirestore();
  const auth = getAuth();
  let cleaned = 0;
  let checked = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  while (cleaned < MAX_CLEANUPS_PER_RUN) {
    let query = db.collection("players").orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    if (page.empty) break;
    last = page.docs[page.docs.length - 1];

    const uids = [...new Set(page.docs
      .map((d) => d.get("firebaseUid"))
      .filter((uid): uid is string => typeof uid === "string" && uid.length > 0))];
    checked += uids.length;
    if (uids.length === 0) continue;

    const result = await auth.getUsers(uids.map((uid) => ({ uid })));
    for (const missing of result.notFound) {
      if (cleaned >= MAX_CLEANUPS_PER_RUN) break;
      const uid = (missing as { uid: string }).uid;
      try {
        await cleanupAccount(db, uid);
        cleaned++;
      } catch (err) {
        logger.error(`orphanAccountSweep ${uid} failed`, err);
      }
    }
  }

  logger.info(`orphanAccountSweep checked ${checked} uids, cleaned ${cleaned}`);
});
