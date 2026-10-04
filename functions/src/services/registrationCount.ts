import { Firestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

/**
 * Recomputes `tournaments/{id}.registrationCount` from the registrations
 * collection. A recount (not +1/-1) keeps it correct when a trigger is
 * retried or events arrive out of order. Clients read it for the
 * "Filling fast" sort; security rules stop them from writing it.
 */
export async function refreshRegistrationCount(db: Firestore, tournamentId: string): Promise<number | null> {
  const ref = db.collection("tournaments").doc(tournamentId);
  const snap = await db.collection("registrations")
    .where("tournamentId", "==", tournamentId)
    .count()
    .get();
  const count = snap.data().count;
  try {
    await ref.update({ registrationCount: count, registrationCountUpdatedAt: FieldValue.serverTimestamp() });
    return count;
  } catch (err) {
    // Tournament deleted (or never existed) — nothing to update.
    logger.info(`registrationCount not updated for ${tournamentId}: ${(err as Error).message}`);
    return null;
  }
}
