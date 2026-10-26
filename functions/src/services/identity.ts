import { DocumentReference, Firestore } from "firebase-admin/firestore";
import { PlayerDoc } from "../types";

export interface CallerPlayer {
  /** Player doc id (UPPERCASE for iOS/Android players, lowercase for web/server). */
  id: string;
  ref: DocumentReference;
  data: PlayerDoc;
}

/** The player whose `firebaseUid` is `uid`, or null when the user has no profile yet. */
export async function playerForUid(db: Firestore, uid: string): Promise<CallerPlayer | null> {
  const snap = await db.collection("players").where("firebaseUid", "==", uid).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ref: doc.ref, data: doc.data() as PlayerDoc };
}
