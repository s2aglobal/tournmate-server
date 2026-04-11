import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

/**
 * Runs every hour. Cleans up stale data and logs health metrics.
 *
 * - Removes FCM tokens from players who haven't been active in 90+ days
 *   (prevents sending to dead tokens).
 * - Logs tournament counts for monitoring.
 */
export const hourlyCleanup = onSchedule("every 1 hours", async () => {
  const db = getFirestore();

  // Clean stale FCM tokens (players inactive > 90 days)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);

  const stalePlayers = await db
    .collection("players")
    .where("createdAt", "<", Timestamp.fromDate(cutoff))
    .get();

  let cleanedCount = 0;
  const batch = db.batch();
  for (const doc of stalePlayers.docs) {
    const data = doc.data();
    if (data.fcmToken && !data.lastActiveAt) {
      batch.update(doc.ref, { fcmToken: null });
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    await batch.commit();
    logger.info(`Cleaned ${cleanedCount} stale FCM tokens`);
  }

  // Log tournament metrics
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const upcomingSnap = await db
    .collection("tournaments")
    .where("date", ">=", Timestamp.fromDate(now))
    .where("statusRaw", "==", "scheduled")
    .get();

  logger.info(`Active upcoming tournaments: ${upcomingSnap.size}`);
});

/**
 * Runs daily at midnight UTC.
 * Sends reminder notifications to players registered for tournaments happening tomorrow.
 */
export const dailyReminders = onSchedule("every day 00:00", async () => {
  const db = getFirestore();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);

  const tomorrowTournaments = await db
    .collection("tournaments")
    .where("date", ">=", Timestamp.fromDate(tomorrow))
    .where("date", "<", Timestamp.fromDate(dayAfter))
    .where("statusRaw", "==", "scheduled")
    .get();

  logger.info(`Tournaments tomorrow: ${tomorrowTournaments.size}`);

  for (const tDoc of tomorrowTournaments.docs) {
    const tournament = tDoc.data();
    const tournamentId = tDoc.id;

    // Find all registrations
    const regsSnap = await db
      .collection("registrations")
      .where("tournamentId", "==", tournamentId)
      .get();

    // Collect unique player IDs
    const playerIds = new Set<string>();
    for (const reg of regsSnap.docs) {
      const data = reg.data();
      playerIds.add(data.playerId);
      if (data.partnerId) playerIds.add(data.partnerId);
    }

    // Write reminder notifications
    for (const playerId of playerIds) {
      await db.collection("notifications").add({
        recipientId: playerId,
        type: "tournament_reminder",
        title: "Tournament Tomorrow!",
        body: `${tournament.title} at ${tournament.location} is tomorrow. Get ready!`,
        tournamentId,
        read: false,
        createdAt: new Date(),
      });
    }
  }
});
