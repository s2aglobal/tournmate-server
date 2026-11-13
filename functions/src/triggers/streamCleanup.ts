import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";
import { runStreamCleanup } from "../services/liveStream";

/**
 * Every 5 minutes: ends live video streams with no heartbeat for 10 minutes
 * (`endedReason: "stale"`) or on a finished match, and drops tournament
 * `liveStreams` entries whose match no longer streams (services/liveStream.ts).
 */
export const streamCleanup = onSchedule({ schedule: "every 5 minutes", region: "us-central1", timeoutSeconds: 120 },
  async () => {
    await runStreamCleanup(getFirestore(), new Date());
  });
