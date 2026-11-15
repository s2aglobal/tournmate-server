import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { runStreamCleanup } from "../services/liveStream";
import { YOUTUBE_SECRETS, sweepServerBroadcasts } from "../services/youtubeServer";

/**
 * Every 5 minutes: ends live video streams with no heartbeat for 10 minutes
 * (`endedReason: "stale"`) or on a finished match, and drops tournament
 * `liveStreams` entries whose match no longer streams (services/liveStream.ts).
 * Then ends on YouTube the server-created broadcasts (Tournament crew) that
 * are no longer streamed or never started (services/youtubeServer.ts).
 */
export const streamCleanup = onSchedule({
  schedule: "every 5 minutes", region: "us-central1", timeoutSeconds: 120, secrets: YOUTUBE_SECRETS,
}, async () => {
  const db = getFirestore();
  const now = new Date();
  await runStreamCleanup(db, now);
  try {
    await sweepServerBroadcasts(db, now);
  } catch (err) {
    logger.error("streamCleanup: server broadcast sweep failed", err);
  }
});
