import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue, Firestore, Timestamp, DocumentData } from "firebase-admin/firestore";
import { sendToRegionTopicExcluding, sendToCountryTopicExcluding, sendToPlayer } from "../services/notifications";
import { PlayerDoc, parseSportType, sportName, sportEmoji } from "../types";
import {
  ClashingSession,
  MAX_UPCOMING_HOSTED_SESSIONS,
  createdBefore,
  findClashingSessions,
  findHostedActiveSessions,
  formatSessionTime,
  isActiveSession,
  sessionWindow,
  toClashingSession,
  windowsOverlap,
} from "../services/openPlay";

const MAX_CREATES_PER_DAY = 8;

/**
 * Fires when a new play session document is created.
 * Rate-checks the host, then enforces the hosting rules older apps don't
 * check (at most 3 upcoming active sessions, no overlap with the host's own
 * sessions) by cancelling the new session and telling the host, before
 * sending regional push notifications.
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

    // --- Hosting rules (older apps write sessions directly) ---
    if (data.hostId && isActiveSession(data)) {
      const problem = await hostingProblem(db, sessionId, data);
      if (problem) {
        logger.warn(`Session ${sessionId}: cancelled (${problem.reason}) for host ${data.hostId}`);
        await event.data?.ref.update({
          status: "cancelled",
          autoCancelled: { reason: problem.reason, at: Timestamp.now() },
        });
        await notifyHost(db, data.hostId, sessionId, problem.message);
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

    // Notify players of this sport only (badminton uses the original topics).
    const sport = parseSportType(data.sportType);
    const emoji = sportEmoji(sport);

    // Exclude the creator from receiving their own notification
    const creatorUid = data.hostId || "";

    // --- Send push notifications ---
    // Unknown sports parse as `generic`; nobody subscribes to generic topics,
    // so skip the region/country broadcast (the creator's inbox doc below still goes out).
    if (sport === "generic") {
      logger.info(
        `Session ${sessionId}: sport ${JSON.stringify(data.sportType)} parses as generic; ` +
        "skipping region/country broadcast.",
      );
    } else if (data.countryCode && data.postalCode) {
      // Regional (same ZIP)
      await sendToRegionTopicExcluding(
        data.countryCode,
        data.postalCode,
        creatorUid,
        `${sportName(sport)} Open Play Near You! ${emoji}`,
        `${data.title} on ${fullDateStr} at ${data.venue}`,
        { type: "session_created", sessionId, createdBy: creatorUid },
        sport,
      );

      // Country-wide (different ZIP or no ZIP)
      await sendToCountryTopicExcluding(
        data.countryCode,
        data.postalCode,
        creatorUid,
        `${sportName(sport)} Open Play in ${data.venue}! ${emoji}`,
        `${data.title} on ${fullDateStr}`,
        { type: "session_created", sessionId, createdBy: creatorUid },
        sport,
      );
    } else if (data.countryCode) {
      await sendToCountryTopicExcluding(
        data.countryCode,
        "",
        creatorUid,
        `${sportName(sport)} Open Play in ${data.venue}! ${emoji}`,
        `${data.title} on ${fullDateStr}`,
        { type: "session_created", sessionId, createdBy: creatorUid },
        sport,
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

// ─── Hosting rules ──────────────────────────────────────

interface HostingProblem {
  reason: "HOST_LIMIT" | "SESSION_CLASH";
  message: string;
}

/**
 * Why the new session can't stand, or null. Only sessions created before
 * this one count against it, so when two racing creates conflict only the
 * newer one is cancelled.
 */
async function hostingProblem(db: Firestore, sessionId: string, data: DocumentData): Promise<HostingProblem | null> {
  const window = sessionWindow(data);
  if (!data.date) return null;
  const title = (data.title as string) || "Open Play";
  const me = { id: sessionId, createdAt: data.createdAt };
  const now = new Date();

  const hosted = (await findHostedActiveSessions(db, data.hostId, now))
    .filter((s) => s.id !== sessionId && createdBefore(s, me));

  // Limit: upcoming (not yet started) sessions, this one included.
  const upcoming = hosted.filter((s) => s.start.getTime() > now.getTime()).length
    + (window.start.getTime() > now.getTime() ? 1 : 0);
  if (upcoming > MAX_UPCOMING_HOSTED_SESSIONS) {
    return {
      reason: "HOST_LIMIT",
      message: `"${title}" was cancelled: you can host up to ${MAX_UPCOMING_HOSTED_SESSIONS} upcoming sessions at a time.`,
    };
  }

  // Overlap with a session the host runs or has joined.
  let clash: ClashingSession | undefined = hosted.find((s) => windowsOverlap(s, window));
  if (!clash) {
    const hostPlayerId = await hostPlayerIdFor(db, data);
    if (hostPlayerId) {
      const joined = await findClashingSessions(db, hostPlayerId, window.start, window.end, sessionId);
      clash = joined.map(toClashingSession).find((s) => s.hostId !== data.hostId);
    }
  }
  if (clash) {
    return {
      reason: "SESSION_CLASH",
      message: `"${title}" was cancelled: it overlaps your session at ${clash.venue || "another venue"} ` +
        `on ${formatSessionTime(clash.start, clash.timeZone)}.`,
    };
  }
  return null;
}

/** The host's player id: from their profile, else the session's first attendee. */
async function hostPlayerIdFor(db: Firestore, data: DocumentData): Promise<string | null> {
  const snap = await db.collection("players").where("firebaseUid", "==", data.hostId).limit(1).get();
  if (!snap.empty) return snap.docs[0].id.toUpperCase();
  const first = (data.attendeeIds as string[] | undefined)?.[0];
  return first ?? null;
}

async function notifyHost(db: Firestore, hostUid: string, sessionId: string, body: string) {
  const title = "Open Play cancelled";
  await db.collection("notifications").add({
    recipientId: hostUid,
    type: "session_cancelled",
    title,
    body,
    sessionId,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  const snap = await db.collection("players").where("firebaseUid", "==", hostUid).limit(1).get();
  const player = snap.empty ? undefined : (snap.docs[0].data() as PlayerDoc);
  if (player?.fcmToken) {
    await sendToPlayer(player.fcmToken, title, body, { type: "session_cancelled", sessionId });
  }
}
