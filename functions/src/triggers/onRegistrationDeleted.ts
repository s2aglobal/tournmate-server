import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { RegistrationDoc, TournamentDoc } from "../types";
import { sendToPlayer } from "../services/notifications";
import { refreshRegistrationCount } from "../services/registrationCount";

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

    // Keep the tournament's registrationCount in sync ("Filling fast" sort).
    await refreshRegistrationCount(db, data.tournamentId);

    // Team entries: free the one-entry locks (registrant + roster) if the
    // app didn't (e.g. the registration was deleted from the console), so
    // they can enter again.
    if (data.teamId || data.teamName) {
      await releaseTeamEntryLocks(db, data, event.params.registrationId);
    }

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

/**
 * Deletes teamEntries/{tournamentId}_{playerId} of whoever entered the team
 * and of every roster player, where the lock still belongs to this
 * registration (a player may have entered another team since).
 */
async function releaseTeamEntryLocks(
  db: FirebaseFirestore.Firestore,
  data: RegistrationDoc,
  registrationId: string,
): Promise<void> {
  const ids = [data.playerId, ...(Array.isArray(data.rosterIds) ? data.rosterIds : [])]
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const seen = new Set<string>();
  for (const id of ids) {
    const lower = id.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const lock = db.collection("teamEntries").doc(`${data.tournamentId.toLowerCase()}_${lower}`);
    const snap = await lock.get();
    if (snap.exists && String(snap.data()?.registrationId ?? "").toUpperCase() === registrationId.toUpperCase()) {
      await lock.delete();
    }
  }
}
