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

    const hostId = after.hostId as string | undefined;
    if (!hostId) return;

    const db = getFirestore();
    const sessionId = event.params.sessionId;
    const sessionTitle = (after.title as string) || "Open Play";

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
