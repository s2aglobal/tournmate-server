import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { MatchDoc, RegistrationDoc, PlayerDoc, registrationPlayerIds } from "../types";
import { sendToPlayer } from "../services/notifications";
import { applyEloForMatch } from "../services/elo";

/**
 * Fires when a match document is updated.
 * When status transitions to "finished", notify both teams of the result.
 */
export const onMatchFinished = onDocumentUpdated(
  "matches/{matchId}",
  async (event) => {
    const before = event.data?.before.data() as MatchDoc | undefined;
    const after = event.data?.after.data() as MatchDoc | undefined;
    if (!before || !after) return;

    if (before.statusRaw === after.statusRaw || after.statusRaw !== "finished") {
      return;
    }

    logger.info(`Match finished: ${event.params.matchId}`);

    const db = getFirestore();

    // Ratings are server-authoritative: security rules don't let clients
    // write elo/eloRatings/streak. Idempotent via match.eloApplied.
    if (event.data?.after.ref) {
      try {
        await applyEloForMatch(db, event.data.after.ref);
      } catch (err) {
        logger.error(`Elo update failed for match ${event.params.matchId}:`, err);
      }
    }

    // Get both teams
    const [teamADoc, teamBDoc] = await Promise.all([
      db.collection("registrations").doc(after.teamAId).get(),
      db.collection("registrations").doc(after.teamBId).get(),
    ]);

    if (!teamADoc.exists || !teamBDoc.exists) return;

    const teamA = teamADoc.data() as RegistrationDoc;
    const teamB = teamBDoc.data() as RegistrationDoc;

    // Collect all player IDs from both teams (team sports: the whole roster)
    const allPlayerIds = [...new Set([
      ...registrationPlayerIds(teamA),
      ...registrationPlayerIds(teamB),
    ])];

    // Cricket stores a sentence ("Dallas Royals won by 6 wickets"); set-based
    // sports show the games score.
    const resultText = after.summary ?? `Final score: ${after.scoreA ?? 0} - ${after.scoreB ?? 0}`;

    for (const pid of allPlayerIds) {
      const playerDoc = await db.collection("players").doc(pid).get();
      if (!playerDoc.exists) continue;
      const player = playerDoc.data() as PlayerDoc;

      // Write inbox notification doc
      if (player.firebaseUid) {
        await db.collection("notifications").add({
          recipientId: player.firebaseUid,
          type: "match_finished",
          title: "Match Result",
          body: resultText,
          tournamentId: after.tournamentId,
          read: false,
          createdAt: new Date(),
        });
      }

      // Send push notification
      if (player.fcmToken) {
        await sendToPlayer(
          player.fcmToken,
          "Match Result",
          resultText,
          {
            type: "match_finished",
            matchId: event.params.matchId,
            tournamentId: after.tournamentId,
          },
        );
      }
    }
  },
);
