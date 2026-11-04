import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { FieldValue, Firestore, Timestamp, getFirestore } from "firebase-admin/firestore";
import { isActiveSession, sessionWindow } from "../services/openPlay";
import { playerForUid } from "../services/identity";
import { notifyPlayer } from "../services/notifyPlayer";

/** Sessions that started this long ago at most are closed (older ones are left alone). */
const LOOKBACK_MS = 48 * 3600_000;

/**
 * Every 15 minutes: Open Play sessions that are over but still active are
 * closed, so nobody has to remember to tap "Finish Session".
 * - Someone besides the host joined: `status: "completed"`. The
 *   onSessionJoined trigger then tells everyone (host included) to log
 *   their calories.
 * - Only the host: `status: "cancelled"` (nobody played); the host is told.
 * Closed docs get `autoClosed: "ended" | "noPlayers"` and `closedAt`.
 */
export const autoCloseSessions = onSchedule({ schedule: "every 15 minutes", region: "us-central1", timeoutSeconds: 300 },
  async () => {
    await runAutoCloseSessions(getFirestore(), new Date());
  });

export async function runAutoCloseSessions(db: Firestore, now: Date): Promise<void> {
  const started = await db.collection("playSessions")
    .where("date", "<=", Timestamp.fromDate(now))
    .where("date", ">=", Timestamp.fromMillis(now.getTime() - LOOKBACK_MS))
    .get();

  for (const doc of started.docs) {
    if (!isActiveSession(doc.data()) || sessionWindow(doc.data()).end > now) continue;
    try {
      const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const s = snap.data();
        if (!s || !isActiveSession(s)) return null;
        const played = ((s.attendeeIds as string[] | undefined) ?? []).length > 1;
        tx.update(doc.ref, {
          status: played ? "completed" : "cancelled",
          autoClosed: played ? "ended" : "noPlayers",
          closedAt: FieldValue.serverTimestamp(),
        });
        return { played, hostId: s.hostId as string | undefined, title: (s.title as string) || "Open Play" };
      });
      if (!outcome) continue;
      logger.info(`autoCloseSessions: ${doc.id} ${outcome.played ? "completed" : "cancelled (no players)"}`);
      if (!outcome.played && outcome.hostId) {
        const host = await playerForUid(db, outcome.hostId);
        await notifyPlayer(db, host?.data, {
          type: "session_cancelled",
          title: "Session Closed",
          body: `Nobody joined "${outcome.title}", so it was closed.`,
          data: { sessionId: doc.id },
        });
      }
    } catch (err) {
      logger.error(`autoCloseSessions: ${doc.id} failed`, err);
    }
  }
}
