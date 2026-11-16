import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { normalizeLegacyRating } from "../services/ratings";

/**
 * Old app versions (before the ratePlayer callable) still write
 * `ratings/{uuid}` directly with `raterId` on the public doc. This moves the
 * author to ratingAuthors, keeps one review per rater per player (the newest)
 * and refreshes the player's aggregate. Docs written by ratePlayer have no
 * raterId and are skipped. Remove with the phase B rules change
 * (`allow create: if false` on ratings).
 */
export const onRatingCreated = onDocumentCreated(
  { document: "ratings/{ratingId}", region: "us-central1" },
  async (event) => {
    const d = event.data?.data();
    if (!d || typeof d.raterId !== "string") return;
    try {
      const r = await normalizeLegacyRating(getFirestore(), event.params.ratingId);
      logger.info("legacy rating normalized", { ratingId: event.params.ratingId, ...r });
    } catch (e) {
      logger.error("legacy rating normalize failed", { ratingId: event.params.ratingId, error: e });
    }
  });
