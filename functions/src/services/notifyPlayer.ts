import { Firestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { PlayerDoc } from "../types";
import { sendToPlayer } from "./notifications";
import { deviceTokenFor } from "./playerPrivate";

/**
 * Inbox doc (`notifications`, keyed by the player's auth uid) plus a push
 * if the player has a token. Never throws: a failed notification must not
 * fail the action that caused it.
 */
export async function notifyPlayer(
  db: Firestore,
  player: PlayerDoc | null | undefined,
  n: { type: string; title: string; body: string; data?: Record<string, string> },
): Promise<void> {
  if (!player) return;
  try {
    if (player.firebaseUid) {
      await db.collection("notifications").add({
        recipientId: player.firebaseUid,
        type: n.type,
        title: n.title,
        body: n.body,
        ...(n.data ?? {}),
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    const token = await deviceTokenFor(db, player);
    if (token) {
      await sendToPlayer(token, n.title, n.body, { type: n.type, ...(n.data ?? {}) });
    }
  } catch (err) {
    logger.error(`notifyPlayer(${n.type}) failed`, err);
  }
}
