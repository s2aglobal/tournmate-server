import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { RegistrationDoc, TournamentDoc } from "../types";

/**
 * Fires when a new registration is created.
 * Writes a notification document so the tournament organizer is informed.
 */
export const onRegistrationCreated = onDocumentCreated(
  "registrations/{registrationId}",
  async (event) => {
    const data = event.data?.data() as RegistrationDoc | undefined;
    if (!data) return;

    const db = getFirestore();

    // Look up the tournament for context
    const tDoc = await db.collection("tournaments").doc(data.tournamentId).get();
    if (!tDoc.exists) return;
    const tournament = tDoc.data() as TournamentDoc;

    // Look up the player name
    const playerDoc = await db.collection("players").doc(data.playerId).get();
    const playerName = playerDoc.exists
      ? (playerDoc.data()?.name as string) ?? "A player"
      : "A player";

    logger.info(`${playerName} registered for ${tournament.title}`);

    // Write a notification for the organizer
    if (tournament.createdBy) {
      const orgSnap = await db
        .collection("players")
        .where("firebaseUid", "==", tournament.createdBy)
        .limit(1)
        .get();

      if (!orgSnap.empty) {
        await db.collection("notifications").add({
          recipientId: orgSnap.docs[0].id,
          type: "new_registration",
          title: "New Registration",
          body: `${playerName} registered for ${tournament.title}`,
          tournamentId: data.tournamentId,
          read: false,
          createdAt: new Date(),
        });
      }
    }
  },
);
