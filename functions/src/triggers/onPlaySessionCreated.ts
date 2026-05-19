import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { sendToRegionTopic, sendToCountryTopic } from "../services/notifications";

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

    // --- Send push notifications ---
    if (data.countryCode && data.postalCode) {
      const dateStr = data.date.toDate().toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      // Regional (same ZIP)
      await sendToRegionTopic(
        data.countryCode,
        data.postalCode,
        "Open Play Near You! 🏸",
        `${data.title} on ${dateStr} at ${data.venue}`,
        {
          type: "session_created",
          sessionId,
        },
      );

      // Country-wide (different ZIP or no ZIP)
      await sendToCountryTopic(
        data.countryCode,
        data.postalCode,
        `Open Play in ${data.venue}! 🏸`,
        `${data.title} on ${dateStr}`,
        {
          type: "session_created",
          sessionId,
        },
      );
    } else if (data.countryCode) {
      const dateStr = data.date.toDate().toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      await sendToCountryTopic(
        data.countryCode,
        "",
        `Open Play in ${data.venue}! 🏸`,
        `${data.title} on ${dateStr}`,
        {
          type: "session_created",
          sessionId,
        },
      );
    }
  },
);
