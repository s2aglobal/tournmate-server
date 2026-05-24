import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { RegistrationDoc, TournamentDoc } from "../types";
import { sendToPlayer } from "../services/notifications";

/**
 * Fires when a new registration is created.
 * Notifies the tournament organizer via push + inbox doc.
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

    // Notify the organizer
    if (tournament.createdBy) {
      // Write inbox doc
      await db.collection("notifications").add({
        recipientId: tournament.createdBy,
        type: "new_registration",
        title: "New Registration 🎉",
        body: `${playerName} registered for ${tournament.title}`,
        tournamentId: data.tournamentId,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Send push notification
      const orgSnap = await db
        .collection("players")
        .where("firebaseUid", "==", tournament.createdBy)
        .limit(1)
        .get();

      if (!orgSnap.empty) {
        const fcmToken = orgSnap.docs[0].data()?.fcmToken as string | undefined;
        if (fcmToken) {
          await sendToPlayer(
            fcmToken,
            "New Registration 🎉",
            `${playerName} registered for ${tournament.title}`,
            { type: "new_registration", tournamentId: data.tournamentId },
          );
        }
      }
    }
  },
);
