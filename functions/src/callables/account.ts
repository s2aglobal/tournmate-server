import { onCall } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";
import { CALLABLE_OPTS, requireUid } from "./shared";
import { fail } from "./errors";
import { cleanupAccount } from "../services/accountCleanup";

/**
 * deleteAccount({}) -> { status: "deleted" }
 * Removes the caller's player profile and what hangs off it (see
 * services/accountCleanup.ts), then deletes their auth user. Apps call this
 * instead of deleting the auth user themselves, then sign out locally.
 * The auth onDelete trigger repeats the cleanup as a safety net.
 */
export const deleteAccount = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const db = getFirestore();
  await cleanupAccount(db, uid);
  try {
    await getAuth().deleteUser(uid);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "auth/user-not-found") {
      logger.error(`deleteAccount: auth delete failed for ${uid}`, err);
      fail("internal", "INVALID_ARGUMENT", "Your data was removed, but the account couldn't be closed. Please try again.");
    }
  }
  return { status: "deleted" as const };
});
