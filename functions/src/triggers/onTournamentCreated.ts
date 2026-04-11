import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { TournamentDoc } from "../types";
import { sendToRegionTopic } from "../services/notifications";

/**
 * Fires when a new tournament document is created.
 * Sends a push notification to users subscribed to the tournament's regional topic.
 */
export const onTournamentCreated = onDocumentCreated(
  "tournaments/{tournamentId}",
  async (event) => {
    const data = event.data?.data() as TournamentDoc | undefined;
    if (!data) return;

    logger.info(`New tournament created: ${data.title}`);

    if (data.countryCode && data.postalCode) {
      const dateStr = data.date.toDate().toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      await sendToRegionTopic(
        data.countryCode,
        data.postalCode,
        "New Tournament Near You!",
        `${data.title} on ${dateStr} at ${data.location}`,
        {
          type: "tournament_created",
          tournamentId: event.params.tournamentId,
        },
      );
    }
  },
);
