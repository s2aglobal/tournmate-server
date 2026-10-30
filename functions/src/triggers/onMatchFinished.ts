import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { MatchDoc } from "../types";
import { applyEloForMatch } from "../services/elo";
import { notifyMatchFinished } from "../services/matchNotifications";

/**
 * Fires when a match document is updated.
 * When status transitions to "finished", apply Elo (once) and notify both
 * teams of the result.
 *
 * The score callables apply Elo in the transaction that finishes the match
 * (setting `eloApplied`) and send the result notifications themselves; this
 * trigger covers direct writes from older app versions.
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

    // Finished by a score callable (it set eloApplied in the same write and
    // has notified the teams).
    if (after.eloApplied === true && before.eloApplied !== true) return;

    await notifyMatchFinished(db, event.params.matchId, after);
  },
);
