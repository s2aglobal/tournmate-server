import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { RegistrationDoc, TournamentDoc } from "../types";
import { sendToPlayer } from "../services/notifications";

/**
 * Fires when a registration is deleted (player unregisters from tournament).
 * Notifies the tournament organizer.
 */
export const onRegistrationDeleted = onDocumentDeleted(
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

    logger.info(`${playerName} unregistered from ${tournament.title}`);

    // Write a notification for the organizer
    if (tournament.createdBy) {
      await db.collection("notifications").add({
        recipientId: tournament.createdBy,
        type: "player_unregistered",
        title: "Player Left Tournament 👋",
        body: `${playerName} unregistered from ${tournament.title}`,
        tournamentId: data.tournamentId,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Send push to organizer
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
            "Player Left Tournament 👋",
            `${playerName} unregistered from ${tournament.title}`,
            { type: "player_unregistered", tournamentId: data.tournamentId },
          );
        }
      }
    }
  },
);
