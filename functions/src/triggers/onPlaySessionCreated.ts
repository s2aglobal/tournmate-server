import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { sendToRegionTopicExcluding, sendToCountryTopicExcluding } from "../services/notifications";

const MAX_CREATES_PER_DAY = 8;

/**
 * Fires when a new play session document is created.
 * Rate-checks the host before sending regional push notifications.
 */
export const onPlaySessionCreated = onDocumentCreated(
  "playSessions/{sessionId}",
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const db = getFirestore();
    const sessionId = event.params.sessionId;

    logger.info(`New play session created: ${data.title} by ${data.hostId}`);

    // --- Rate check: how many sessions did this host create in the last 24h? ---
    if (data.hostId) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentSnap = await db
        .collection("playSessions")
        .where("hostId", "==", data.hostId)
        .where("createdAt", ">", Timestamp.fromDate(oneDayAgo))
        .get();

      if (recentSnap.size > MAX_CREATES_PER_DAY) {
        logger.warn(
          `Rate limit exceeded: host ${data.hostId} created ${recentSnap.size} sessions in 24h. ` +
          `Flagging session ${sessionId} and skipping notification.`
        );
        await event.data?.ref.update({ status: "flagged" });
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
    const creatorUid = data.hostId || "";

    // --- Send push notifications ---
    if (data.countryCode && data.postalCode) {
      // Regional (same ZIP)
      await sendToRegionTopicExcluding(
        data.countryCode,
        data.postalCode,
        creatorUid,
        "Open Play Near You! 🏸",
        `${data.title} on ${fullDateStr} at ${data.venue}`,
        { type: "session_created", sessionId, createdBy: creatorUid },
      );

      // Country-wide (different ZIP or no ZIP)
      await sendToCountryTopicExcluding(
        data.countryCode,
        data.postalCode,
        creatorUid,
        `Open Play in ${data.venue}! 🏸`,
        `${data.title} on ${fullDateStr}`,
        { type: "session_created", sessionId, createdBy: creatorUid },
      );
    } else if (data.countryCode) {
      await sendToCountryTopicExcluding(
        data.countryCode,
        "",
        creatorUid,
        `Open Play in ${data.venue}! 🏸`,
        `${data.title} on ${fullDateStr}`,
        { type: "session_created", sessionId, createdBy: creatorUid },
      );
    }

    // Write a confirmation inbox notification for the creator
    if (creatorUid) {
      await db.collection("notifications").add({
        recipientId: creatorUid,
        type: "session_created",
        title: "Session Posted! 🎉",
        body: `Your ${data.title} on ${fullDateStr} at ${data.venue} is live.`,
        sessionId,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  },
);
