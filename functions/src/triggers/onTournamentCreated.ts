import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { TournamentDoc } from "../types";
import { sendToRegionTopic, sendToCountryTopic } from "../services/notifications";

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

    // --- Send push notifications ---
    if (data.countryCode && data.postalCode) {
      const dateStr = data.date.toDate().toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      // Regional (same ZIP) — "near you" message
      await sendToRegionTopic(
        data.countryCode,
        data.postalCode,
        "New Tournament Near You! 🏸",
        `${data.title} on ${dateStr} at ${data.location}`,
        {
          type: "tournament_created",
          tournamentId,
        },
      );

      // Country-wide (different ZIP or no ZIP) — includes city/location
      await sendToCountryTopic(
        data.countryCode,
        data.postalCode,
        `New Tournament in ${data.location}! 🏸`,
        `${data.title} on ${dateStr}`,
        {
          type: "tournament_created",
          tournamentId,
        },
      );
    } else if (data.countryCode) {
      // No postal code on tournament — send country-wide only
      const dateStr = data.date.toDate().toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      await sendToCountryTopic(
        data.countryCode,
        "",
        `New Tournament in ${data.location}! 🏸`,
        `${data.title} on ${dateStr}`,
        {
          type: "tournament_created",
          tournamentId,
        },
      );
    }
  },
);
