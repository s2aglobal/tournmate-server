import { DocumentReference, Firestore } from "firebase-admin/firestore";
import { PlayerDoc } from "../types";

export interface PlayerRecord {
  id: string;
  ref: DocumentReference;
  data: PlayerDoc;
}

/**
 * The player profile linked to an auth uid (`players.firebaseUid`), or null.
 * Player doc ids are UUIDs: upper case from iOS/Android, lower case from the
 * web and the server.
 */
export async function playerForUid(db: Firestore, uid: string): Promise<PlayerRecord | null> {
  const snap = await db.collection("players").where("firebaseUid", "==", uid).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ref: doc.ref, data: doc.data() as PlayerDoc };
}
