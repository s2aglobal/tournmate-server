import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { TournamentDoc } from "../types";
import { sendToRegionTopicExcluding, sendToCountryTopicExcluding } from "../services/notifications";

const MAX_CREATES_PER_DAY = 5;

/**
 * Fires when a new tournament document is created.
 * Rate-checks the creator before sending regional push notifications.
 */
export const onTournamentCreated = onDocumentCreated(
  "tournaments/{tournamentId}",
  async (event) => {
    const data = event.data?.data() as TournamentDoc | undefined;
    if (!data) return;

    const db = getFirestore();
    const tournamentId = event.params.tournamentId;

    logger.info(`New tournament created: ${data.title} by ${data.createdBy}`);

    // --- Rate check: how many tournaments did this user create in the last 24h? ---
    if (data.createdBy) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentSnap = await db
        .collection("tournaments")
        .where("createdBy", "==", data.createdBy)
        .where("createdAt", ">", Timestamp.fromDate(oneDayAgo))
        .get();

      if (recentSnap.size > MAX_CREATES_PER_DAY) {
        logger.warn(
          `Rate limit exceeded: user ${data.createdBy} created ${recentSnap.size} tournaments in 24h. ` +
          `Flagging tournament ${tournamentId} and skipping notification.`
        );
        await event.data?.ref.update({ statusRaw: "flagged" });
        return;
      }
    }

    // Use the timezone stored with the document, fallback to UTC
    const tz = data.timeZone || "UTC";
    const dateStr = data.date.toDate().toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: tz,
    });
    const timeStr = data.date.toDate().toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    });
    const fullDateStr = `${dateStr} at ${timeStr}`;

    // Exclude the creator from receiving their own notification
    const creatorUid = data.createdBy || "";

    // --- Send push notifications ---
    if (data.countryCode && data.postalCode) {
      // Regional (same ZIP) — "near you" message
      await sendToRegionTopicExcluding(
        data.countryCode,
        data.postalCode,
        creatorUid,
        "New Tournament Near You! 🏸",
        `${data.title} on ${fullDateStr} at ${data.location}`,
        { type: "tournament_created", tournamentId },
      );

      // Country-wide (different ZIP or no ZIP) — includes city/location
      await sendToCountryTopicExcluding(
        data.countryCode,
        data.postalCode,
        creatorUid,
        `New Tournament in ${data.location}! 🏸`,
        `${data.title} on ${fullDateStr}`,
        { type: "tournament_created", tournamentId },
      );
    } else if (data.countryCode) {
      await sendToCountryTopicExcluding(
        data.countryCode,
        "",
        creatorUid,
        `New Tournament in ${data.location}! 🏸`,
        `${data.title} on ${fullDateStr}`,
        { type: "tournament_created", tournamentId },
      );
    }

    // Write a confirmation inbox notification for the creator
    if (creatorUid) {
      await db.collection("notifications").add({
        recipientId: creatorUid,
        type: "tournament_created",
        title: "Tournament Posted! 🎉",
        body: `Your ${data.title} on ${fullDateStr} at ${data.location} is live.`,
        tournamentId,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  },
);
