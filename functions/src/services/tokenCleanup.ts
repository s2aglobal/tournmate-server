import { Firestore, DocumentReference, Timestamp } from "firebase-admin/firestore";

/*
 * Push-token cleanup.
 *
 * Tokens are removed only when we know they are dead:
 *  - FCM rejected them (`messaging/registration-token-not-registered` or
 *    `invalid-registration-token`, see notifications.ts `sendToPlayer`);
 *  - a player has a `lastActiveAt` older than STALE_DAYS. Nothing writes
 *    `lastActiveAt` yet, so this is a no-op today; a player WITHOUT it is never
 *    touched. (The old hourlyCleanup nulled every token of a player created
 *    90+ days ago with no lastActiveAt, i.e. every older account, every hour.)
 * The apps rewrite their token on launch, so a cleared live token comes back.
 */

export const STALE_DAYS = 90;
/** Firestore allows 500 writes per batch; stay under it. */
export const BATCH_SIZE = 400;
/** Collections that may hold a player's `fcmToken` (playerPrivate: player privacy). */
export const TOKEN_COLLECTIONS = ["players", "playerPrivate"] as const;

const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

export function isInvalidTokenError(code: string | undefined): boolean {
  return !!code && INVALID_TOKEN_CODES.has(code);
}

/** Sets `fcmToken: null` on every ref, in batches of BATCH_SIZE. Returns the count. */
export async function nullTokens(db: Firestore, refs: DocumentReference[]): Promise<number> {
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + BATCH_SIZE)) batch.update(ref, { fcmToken: null });
    await batch.commit();
  }
  return refs.length;
}

/** Clears a token FCM reported as dead, wherever it is stored. */
export async function clearInvalidToken(db: Firestore, token: string): Promise<number> {
  if (!token) return 0;
  const refs: DocumentReference[] = [];
  for (const c of TOKEN_COLLECTIONS) {
    const snap = await db.collection(c).where("fcmToken", "==", token).get();
    refs.push(...snap.docs.map((d) => d.ref));
  }
  return nullTokens(db, refs);
}

/**
 * Clears tokens of players whose `lastActiveAt` is older than STALE_DAYS.
 * Only players that HAVE `lastActiveAt` are considered.
 */
export async function clearStaleTokens(db: Firestore, now = new Date()): Promise<number> {
  const cutoff = Timestamp.fromMillis(now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const snap = await db.collection("players").where("lastActiveAt", "<", cutoff).get();
  const refs = snap.docs
    .filter((d) => typeof d.get("fcmToken") === "string" && d.get("fcmToken") !== "")
    .map((d) => d.ref);
  return nullTokens(db, refs);
}
