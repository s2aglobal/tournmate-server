import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { PlayerDoc } from "../types";
import { sendToPlayer } from "../services/notifications";

/**
 * Fires when a play session is updated.
 * - If attendeeIds grew (someone joined), notify the host.
 * - If attendeeIds shrunk (someone left), notify the host.
 */
export const onSessionJoined = onDocumentUpdated(
  "playSessions/{sessionId}",
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;

    const beforeAttendees: string[] = before.attendeeIds ?? [];
    const afterAttendees: string[] = after.attendeeIds ?? [];

    const hostId = after.hostId as string | undefined;
    if (!hostId) return;

    const db = getFirestore();
    const sessionId = event.params.sessionId;
    const sessionTitle = (after.title as string) || "Open Play";

    // --- Someone JOINED ---
    if (afterAttendees.length > beforeAttendees.length) {
      const newAttendees = afterAttendees.filter((id) => !beforeAttendees.includes(id));
      if (newAttendees.length === 0) return;

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
        title: "Player Joined! 🏸",
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
            "Player Joined! 🏸",
            `${joinText} "${sessionTitle}"`,
            { type: "session_joined", sessionId },
          );
        }
      }
      return;
    }

    // --- Someone LEFT ---
    if (afterAttendees.length < beforeAttendees.length) {
      const leftAttendees = beforeAttendees.filter((id) => !afterAttendees.includes(id));
      if (leftAttendees.length === 0) return;

      // Don't notify host if they removed themselves (cancelled session etc.)
      if (leftAttendees.includes(hostId)) return;

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
