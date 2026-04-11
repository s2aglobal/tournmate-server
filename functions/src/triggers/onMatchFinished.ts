import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { MatchDoc, RegistrationDoc, PlayerDoc } from "../types";
import { sendToPlayer } from "../services/notifications";

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

    // Get both teams
    const [teamADoc, teamBDoc] = await Promise.all([
      db.collection("registrations").doc(after.teamAId).get(),
      db.collection("registrations").doc(after.teamBId).get(),
    ]);

    if (!teamADoc.exists || !teamBDoc.exists) return;

    const teamA = teamADoc.data() as RegistrationDoc;
    const teamB = teamBDoc.data() as RegistrationDoc;

    // Collect all player IDs from both teams
    const allPlayerIds = [
      teamA.playerId,
      teamA.partnerId,
      teamB.playerId,
      teamB.partnerId,
    ].filter(Boolean) as string[];

    const scoreText = `${after.scoreA ?? 0} - ${after.scoreB ?? 0}`;

    for (const pid of allPlayerIds) {
      const playerDoc = await db.collection("players").doc(pid).get();
      if (!playerDoc.exists) continue;
      const player = playerDoc.data() as PlayerDoc;
      if (!player.fcmToken) continue;

      await sendToPlayer(
        player.fcmToken,
        "Match Result",
        `Final score: ${scoreText}`,
        {
          type: "match_finished",
          matchId: event.params.matchId,
          tournamentId: after.tournamentId,
        },
      );
    }
  },
);
