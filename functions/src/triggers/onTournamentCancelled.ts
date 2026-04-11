import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { TournamentDoc, RegistrationDoc, PlayerDoc } from "../types";
import { sendToPlayer } from "../services/notifications";

/**
 * Fires when a tournament document is updated.
 * If the status changed to "cancelled", notify all registered players.
 */
export const onTournamentCancelled = onDocumentUpdated(
  "tournaments/{tournamentId}",
  async (event) => {
    const before = event.data?.before.data() as TournamentDoc | undefined;
    const after = event.data?.after.data() as TournamentDoc | undefined;
    if (!before || !after) return;

    // Only react to status change → cancelled
    if (before.statusRaw === after.statusRaw || after.statusRaw !== "cancelled") {
      return;
    }

    logger.info(`Tournament cancelled: ${after.title}`);

    const db = getFirestore();
    const tournamentId = event.params.tournamentId;

    // Find all registrations for this tournament
    const regsSnap = await db
      .collection("registrations")
      .where("tournamentId", "==", tournamentId)
      .get();

    // Collect unique player IDs
    const playerIds = new Set<string>();
    for (const doc of regsSnap.docs) {
      const reg = doc.data() as RegistrationDoc;
      playerIds.add(reg.playerId);
      if (reg.partnerId) playerIds.add(reg.partnerId);
    }

    // Notify each player with an FCM token
    for (const playerId of playerIds) {
      const playerDoc = await db.collection("players").doc(playerId).get();
      if (!playerDoc.exists) continue;

      const player = playerDoc.data() as PlayerDoc;
      if (!player.fcmToken) continue;

      await sendToPlayer(
        player.fcmToken,
        "Tournament Cancelled",
        `${after.title} has been cancelled by the organizer.`,
        {
          type: "tournament_cancelled",
          tournamentId,
        },
      );
    }
  },
);
