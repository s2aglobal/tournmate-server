import * as functionsV1 from "firebase-functions/v1";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { cleanupAccount } from "../services/accountCleanup";

/**
 * Safety net for account deletion: whenever an auth user is deleted (the
 * deleteAccount callable, the console, or an older app deleting itself),
 * remove the player profile and what hangs off it. Idempotent. Auth
 * triggers exist only in the v1 API.
 */
export const onAuthUserDeleted = functionsV1.region("us-central1").auth.user().onDelete(async (user) => {
  try {
    await cleanupAccount(getFirestore(), user.uid);
  } catch (err) {
    logger.error(`onAuthUserDeleted ${user.uid} failed`, err);
  }
});
