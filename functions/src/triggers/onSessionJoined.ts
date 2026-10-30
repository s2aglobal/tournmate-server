import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue, Firestore, Timestamp, DocumentData, DocumentSnapshot } from "firebase-admin/firestore";
import { PlayerDoc, parseSportType, sportEmoji } from "../types";
import { sendToPlayer } from "../services/notifications";
import {
  ClashingSession,
  MIXED_SLOTS_PER_GENDER,
  findClashingSessions,
  formatSessionTime,
  isActiveSession,
  mixedGender,
  mixedOverflowIds,
  sessionGameType,
  sessionWindow,
  toClashingSession,
  windowsOverlap,
} from "../services/openPlay";

/**
 * Fires when a play session is updated.
 * - If attendeeIds grew (someone joined), enforce the Open Play rules that
 *   older apps (iOS 1.7, Android 1.0) don't check: a joiner whose other
 *   session clashes, or who overflows a mixed session's 2 men / 2 women, is
 *   removed again and told why. Then notify the host about the rest.
 * - If attendeeIds shrunk (someone left), notify the host (not for the
 *   server's own removals, marked by `autoRemoved`).
 */
export const onSessionJoined = onDocumentUpdated(
  "playSessions/{sessionId}",
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;

    const hostId = after.hostId as string | undefined;
    if (!hostId) return;

    const db = getFirestore();
    const sessionId = event.params.sessionId;
    const sessionTitle = (after.title as string) || "Open Play";
    const joinedTitle = `Player Joined! ${sportEmoji(parseSportType(after.sportType))}`;

    // --- Session FINISHED (status changed to completed) ---
    const beforeStatus = before.status as string | undefined;
    const afterStatus = after.status as string | undefined;

    if (beforeStatus !== "completed" && afterStatus === "completed") {
      const attendeeIds: string[] = after.attendeeIds ?? [];
      logger.info(`Session ${sessionId} finished by host, notifying ${attendeeIds.length} attendees`);

      for (const attendeeId of attendeeIds) {
        // Don't notify the host
        if (attendeeId === hostId) continue;

        const playerSnap = await db.collection("players").doc(attendeeId).get();
        if (!playerSnap.exists) continue;
        const playerData = playerSnap.data() as PlayerDoc;
        const playerUid = playerData.firebaseUid;

        // Write inbox notification
        if (playerUid) {
          await db.collection("notifications").add({
            recipientId: playerUid,
            type: "session_finished",
            title: "Session Complete! 🏁",
            body: `"${sessionTitle}" has ended. Don't forget to log your calories!`,
            sessionId,
            read: false,
            createdAt: FieldValue.serverTimestamp(),
          });
        }

        // Send push
        if (playerData.fcmToken) {
          await sendToPlayer(
            playerData.fcmToken,
            "Session Complete! 🏁",
            `"${sessionTitle}" has ended. Don't forget to log your calories!`,
            { type: "session_finished", sessionId },
          );
        }
      }
      return;
    }

    // --- Attendee changes ---
    const beforeAttendees: string[] = before.attendeeIds ?? [];
    const afterAttendees: string[] = after.attendeeIds ?? [];

    const joined = afterAttendees.filter((id) => !beforeAttendees.includes(id));
    const left = beforeAttendees.filter((id) => !afterAttendees.includes(id));

    // --- SWAP: someone left and a waitlisted player was promoted (leaveSession) ---
    if (joined.length > 0 && left.length > 0) {
      if (left.includes(hostId) || isAutoRemoval(before, after, left)) return;
      await syncAttendeeUids(db, sessionId, after, left, "remove");
      await syncAttendeeUids(db, sessionId, after, joined, "add");
      const names = async (ids: string[]) => {
        const snaps = await Promise.all(ids.map((id) => playerSnap(db, id)));
        return snaps.map((p) => (p.data()?.name as string) || "A player").join(", ");
      };
      const waitlist: string[] = before.waitlistIds ?? [];
      const fromWaitlist = joined.every((id) => sameIdIn(waitlist, id));
      const body = `${await names(left)} left, ${await names(joined)} joined` +
        `${fromWaitlist ? " from the waitlist" : ""} "${sessionTitle}"`;
      logger.info(`Session ${sessionId}: ${body}`);
      await notifyHost(db, hostId, "session_joined", joinedTitle, body, sessionId);
      return;
    }

    // --- Someone JOINED ---
    if (joined.length > 0) {
      const removed = await removeInvalidJoiners(db, sessionId, after, joined);
      const newAttendees = joined.filter((id) => !removed.includes(id));
      if (newAttendees.length === 0) return;
      await syncAttendeeUids(db, sessionId, after, newAttendees, "add");

      const joinerNames: string[] = [];
      for (const attendeeId of newAttendees) {
        const playerDoc = await db.collection("players").doc(attendeeId).get();
        if (playerDoc.exists) {
          joinerNames.push((playerDoc.data()?.name as string) || "A player");
        }
      }

      const joinText = joinerNames.length === 1
        ? `${joinerNames[0]} joined your session`
        : `${joinerNames.length} players joined your session`;

      logger.info(`Session ${sessionId}: ${joinText}`);

      // Write inbox notification for host
      await db.collection("notifications").add({
        recipientId: hostId,
        type: "session_joined",
        title: joinedTitle,
        body: `${joinText} "${sessionTitle}"`,
        sessionId,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Send push to host
      const hostSnap = await db
        .collection("players")
        .where("firebaseUid", "==", hostId)
        .limit(1)
        .get();

      if (!hostSnap.empty) {
        const hostPlayer = hostSnap.docs[0].data() as PlayerDoc;
        if (hostPlayer.fcmToken) {
          await sendToPlayer(
            hostPlayer.fcmToken,
            joinedTitle,
            `${joinText} "${sessionTitle}"`,
            { type: "session_joined", sessionId },
          );
        }
      }
      return;
    }

    // --- Someone LEFT ---
    if (left.length > 0) {
      const leftAttendees = left;

      // Don't notify host if they removed themselves (cancelled session etc.)
      if (leftAttendees.includes(hostId)) return;

      // The server removed them (clash / mixed overflow); they were told why.
      if (isAutoRemoval(before, after, leftAttendees)) return;
      await syncAttendeeUids(db, sessionId, after, leftAttendees, "remove");

      const leaverNames: string[] = [];
      for (const attendeeId of leftAttendees) {
        const playerDoc = await db.collection("players").doc(attendeeId).get();
        if (playerDoc.exists) {
          leaverNames.push((playerDoc.data()?.name as string) || "A player");
        }
      }

      const leaveText = leaverNames.length === 1
        ? `${leaverNames[0]} left your session`
        : `${leaverNames.length} players left your session`;

      logger.info(`Session ${sessionId}: ${leaveText}`);

      // Write inbox notification for host
      await db.collection("notifications").add({
        recipientId: hostId,
        type: "session_left",
        title: "Player Left 👋",
        body: `${leaveText} "${sessionTitle}"`,
        sessionId,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Send push to host
      const hostSnap = await db
        .collection("players")
        .where("firebaseUid", "==", hostId)
        .limit(1)
        .get();

      if (!hostSnap.empty) {
        const hostPlayer = hostSnap.docs[0].data() as PlayerDoc;
        if (hostPlayer.fcmToken) {
          await sendToPlayer(
            hostPlayer.fcmToken,
            "Player Left 👋",
            `${leaveText} "${sessionTitle}"`,
            { type: "session_left", sessionId },
          );
        }
      }
    }
  },
);

/** Inbox notification + push to the host (auth uid). */
async function notifyHost(
  db: Firestore, hostId: string, type: string, title: string, body: string, sessionId: string,
): Promise<void> {
  await db.collection("notifications").add({
    recipientId: hostId, type, title, body, sessionId, read: false, createdAt: FieldValue.serverTimestamp(),
  });
  const hostSnap = await db.collection("players").where("firebaseUid", "==", hostId).limit(1).get();
  const token = hostSnap.empty ? undefined : (hostSnap.docs[0].data() as PlayerDoc).fcmToken;
  if (token) await sendToPlayer(token, title, body, { type, sessionId });
}

/** A player doc by id in either case (web profiles have lower-case doc ids). */
async function playerSnap(db: Firestore, playerId: string): Promise<DocumentSnapshot> {
  const exact = await db.collection("players").doc(playerId).get();
  if (exact.exists) return exact;
  for (const id of [playerId.toLowerCase(), playerId.toUpperCase()]) {
    if (id === playerId) continue;
    const alt = await db.collection("players").doc(id).get();
    if (alt.exists) return alt;
  }
  return exact;
}

function sameIdIn(ids: unknown, playerId: string): boolean {
  const want = playerId.toLowerCase();
  return Array.isArray(ids) && ids.some((x) => typeof x === "string" && x.toLowerCase() === want);
}

// ─── attendeeUids for direct writes ──────────────────────

/**
 * Sessions created through the callables carry `attendeeUids` (auth uids of
 * attendeeIds). Older apps join/leave by writing attendeeIds directly, so
 * mirror those changes here. Sessions without the field are left alone.
 */
async function syncAttendeeUids(
  db: Firestore,
  sessionId: string,
  session: DocumentData,
  playerIds: string[],
  op: "add" | "remove",
): Promise<void> {
  if (!Array.isArray(session.attendeeUids) || playerIds.length === 0) return;
  const snaps = await Promise.all(playerIds.map((id) => playerSnap(db, id)));
  // The callables keep attendeeUids themselves; skip when nothing changes so
  // their joins / leaves don't cost a second write (and a second trigger run).
  const current = new Set(session.attendeeUids as string[]);
  const uids = snaps.map((p) => p.data()?.firebaseUid as string | undefined)
    .filter((u): u is string => !!u && (op === "add" ? !current.has(u) : current.has(u)));
  if (uids.length === 0) return;
  await db.collection("playSessions").doc(sessionId).update({
    attendeeUids: op === "add" ? FieldValue.arrayUnion(...uids) : FieldValue.arrayRemove(...uids),
  });
}

// ─── Join enforcement for older apps ──────────────────────

type RemovalReason =
  | { kind: "clash"; other: ClashingSession }
  | { kind: "mixed"; gender: "male" | "female" };

/** True when this shrink is the server's own removal of exactly these players. */
function isAutoRemoval(before: DocumentData, after: DocumentData, leftIds: string[]): boolean {
  const a = after.autoRemoved as { playerIds?: string[]; at?: Timestamp } | undefined;
  if (!a?.playerIds || !a.at) return false;
  const b = before.autoRemoved as { at?: Timestamp } | undefined;
  if (b?.at && b.at.isEqual(a.at)) return false;
  return leftIds.every((id) => a.playerIds!.includes(id));
}

/**
 * Removes joiners who clash with another active session they're in, or who
 * overflow a mixed session's gender slots, and notifies them. Returns the
 * removed player ids.
 *
 * Runs in a transaction that re-reads this session and each clashing one: a
 * player is only removed here while they're still in the other session, so
 * two racing joins can't both be undone (the newest join is the one left).
 */
async function removeInvalidJoiners(
  db: Firestore,
  sessionId: string,
  session: DocumentData,
  joined: string[],
): Promise<string[]> {
  if (!isActiveSession(session)) return [];
  const window = sessionWindow(session);

  // Candidate clashes (query outside the transaction, re-checked inside).
  const clashCandidates = new Map<string, ClashingSession[]>();
  if (session.date) {
    for (const playerId of joined) {
      const clashes = await findClashingSessions(db, playerId, window.start, window.end, sessionId);
      if (clashes.length > 0) clashCandidates.set(playerId, clashes.map(toClashingSession));
    }
  }

  // Genders, for mixed sessions.
  const isMixed = sessionGameType(session) === "mixed";
  const genders = new Map<string, string | undefined>();
  if (isMixed) {
    const ids: string[] = session.attendeeIds ?? [];
    const snaps = await Promise.all(ids.map((id) => playerSnap(db, id)));
    snaps.forEach((snap, i) => genders.set(ids[i], snap.data()?.genderRaw as string | undefined));
  }
  if (clashCandidates.size === 0 && !isMixed) return [];

  const uidById = new Map<string, string | undefined>();
  for (const id of joined) uidById.set(id, (await playerSnap(db, id)).data()?.firebaseUid as string | undefined);

  const ref = db.collection("playSessions").doc(sessionId);
  const reasons = await db.runTransaction(async (tx) => {
    const found = new Map<string, RemovalReason>();
    const current = await tx.get(ref);
    const attendees: string[] = current.data()?.attendeeIds ?? [];
    const present = joined.filter((id) => attendees.includes(id));

    for (const playerId of present) {
      for (const other of clashCandidates.get(playerId) ?? []) {
        const otherSnap = await tx.get(db.collection("playSessions").doc(other.id));
        const o = otherSnap.data();
        const ow = o ? sessionWindow(o) : null;
        if (o && ow && isActiveSession(o)
            && sameIdIn(o.attendeeIds, playerId) && windowsOverlap(ow, window)) {
          found.set(playerId, { kind: "clash", other });
          break;
        }
      }
    }

    if (isMixed) {
      const stillIn = attendees.filter((id) => !found.has(id));
      const overflow = mixedOverflowIds(
        stillIn.map((id) => ({ id, gender: genders.get(id) })),
        present.filter((id) => !found.has(id)),
      );
      for (const id of overflow) {
        found.set(id, { kind: "mixed", gender: mixedGender(genders.get(id)) ?? "male" });
      }
    }

    if (found.size === 0) return found;
    const ids = [...found.keys()];
    const update: Record<string, unknown> = {
      attendeeIds: FieldValue.arrayRemove(...ids),
      autoRemoved: { playerIds: ids, reasons: ids.map((id) => found.get(id)!.kind), at: Timestamp.now() },
    };
    if (Array.isArray(current.data()?.attendeeUids)) {
      const uids: string[] = [];
      for (const id of ids) {
        const uid = uidById.get(id);
        if (uid) uids.push(uid);
      }
      if (uids.length > 0) update.attendeeUids = FieldValue.arrayRemove(...uids);
    }
    tx.update(ref, update);
    return found;
  });

  const title = (session.title as string) || "Open Play";
  for (const [playerId, reason] of reasons) {
    const body = reason.kind === "clash"
      ? `You were removed from "${title}": it clashes with your session at ${reason.other.venue || "another venue"} ` +
        `on ${formatSessionTime(reason.other.start, reason.other.timeZone)}.`
      : `You were removed from "${title}": this mixed session already has ${MIXED_SLOTS_PER_GENDER} ` +
        `${reason.gender === "male" ? "men" : "women"}.`;
    logger.info(`Session ${sessionId}: removed ${playerId} (${reason.kind})`);
    await notifyPlayer(db, playerId, "Couldn't join Open Play", body, sessionId);
  }
  return [...reasons.keys()];
}

async function notifyPlayer(db: Firestore, playerId: string, title: string, body: string, sessionId: string) {
  const snap = await playerSnap(db, playerId);
  if (!snap.exists) return;
  const player = snap.data() as PlayerDoc;
  if (player.firebaseUid) {
    await db.collection("notifications").add({
      recipientId: player.firebaseUid,
      type: "session_removed",
      title,
      body,
      sessionId,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  if (player.fcmToken) {
    await sendToPlayer(player.fcmToken, title, body, { type: "session_removed", sessionId });
  }
}
