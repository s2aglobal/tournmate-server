import { FieldValue, Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { sendToPlayer } from "../notifications";

export interface DrawNotice {
  type: string;
  title: string;
  body: string;
  tournamentId: string;
}

/**
 * Inbox doc + push for each auth uid (the pattern every trigger uses).
 * Never throws: a failed notification must not undo a draw.
 */
export async function notifyUids(db: Firestore, uids: Iterable<string>, notice: DrawNotice): Promise<void> {
  for (const uid of new Set([...uids].filter((u) => typeof u === "string" && u.length > 0))) {
    try {
      await db.collection("notifications").add({
        recipientId: uid,
        type: notice.type,
        title: notice.title,
        body: notice.body,
        tournamentId: notice.tournamentId,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
      const snap = await db.collection("players").where("firebaseUid", "==", uid).limit(1).get();
      const token = snap.empty ? undefined : (snap.docs[0].data().fcmToken as string | undefined);
      if (token) {
        await sendToPlayer(token, notice.title, notice.body, { type: notice.type, tournamentId: notice.tournamentId });
      }
    } catch (err) {
      logger.error(`notifyUids: ${notice.type} to ${uid} failed`, err);
    }
  }
}
