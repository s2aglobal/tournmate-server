/**
 * Admin: remove a sportsmanship review (or restore one) and recount the
 * player's average. DRY RUN unless --apply. Project: tournmate-dev by
 * default; anything else must be named with --project. Personal laptop only.
 *
 * Usage (from tournmate-server/functions):
 *   npm run moderate:rating -- --rating <ratingId> --status removed [--apply]
 *   npm run moderate:rating -- --project tournmate-prod --rating <id> --status visible --apply
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { HIDDEN_RATINGS, RATINGS, RatingStatus, setRatingStatus } from "../services/ratings";
import { parseRatingScriptArgs } from "./ratingScriptArgs";

async function main(): Promise<void> {
  const { projectId, apply, rest } = parseRatingScriptArgs(process.argv.slice(2), ["--rating", "--status"]);
  const ratingId = rest.get("--rating");
  const status = rest.get("--status") as RatingStatus | undefined;
  if (!ratingId || !status || !["removed", "hidden", "visible"].includes(status)) {
    console.error("Usage: --rating <id> --status removed|hidden|visible [--apply] [--project <id>]");
    process.exit(1);
  }
  if (getApps().length === 0) initializeApp({ projectId });
  const db = getFirestore();
  const vis = await db.collection(RATINGS).doc(ratingId).get();
  const hid = await db.collection(HIDDEN_RATINGS).doc(ratingId).get();
  const d = vis.exists ? vis.data() : hid.data();
  if (!d) {
    console.error(`No review ${ratingId} in ${projectId}.`);
    process.exit(1);
  }
  console.log(`${projectId}: review ${ratingId} is ${vis.exists ? "visible" : d.status} (${d.stars}/5) "${d.comment ?? ""}"`);
  if (!apply) {
    console.log(`Dry run: would set status ${status}. Add --apply.`);
    return;
  }
  await setRatingStatus(db, ratingId, status);
  console.log(`Set to ${status}; average recounted.`);
}

main().catch((err) => {
  console.error("moderateRating failed:", err);
  process.exit(1);
});
