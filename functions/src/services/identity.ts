import { Firestore, DocumentReference, Transaction } from "firebase-admin/firestore";
import { PlayerDoc } from "../types";

/**
 * Player ids are random UUIDs. iOS/Android write them UPPER case (doc ids
 * and references); web/server-created player docs may be lower case. Ids
 * stored on registrations / sessions are UPPER case, so compare with
 * `sameId` and look players up with `playerById` (tries both cases).
 */
export interface PlayerRef {
  /** Canonical (UPPER case) player id, as stored on registrations/sessions. */
  id: string;
  /** Actual document id (may be lower case for web-created players). */
  docId: string;
  ref: DocumentReference;
  data: PlayerDoc;
}

export function canonicalPlayerId(id: string): string {
  return id.toUpperCase();
}

export function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toUpperCase() === b.toUpperCase();
}

/** The caller's player: `players where firebaseUid == uid`. Null if they have no profile. */
export async function playerForUid(db: Firestore, uid: string, tx?: Transaction): Promise<PlayerRef | null> {
  const q = db.collection("players").where("firebaseUid", "==", uid).limit(1);
  const snap = tx ? await tx.get(q) : await q.get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: canonicalPlayerId(doc.id), docId: doc.id, ref: doc.ref, data: doc.data() as PlayerDoc };
}

/** A player by id in either case (exact, UPPER, lower). */
export async function playerById(db: Firestore, id: string, tx?: Transaction): Promise<PlayerRef | null> {
  if (!id) return null;
  for (const candidate of [...new Set([id, id.toUpperCase(), id.toLowerCase()])]) {
    const ref = db.collection("players").doc(candidate);
    const snap = tx ? await tx.get(ref) : await ref.get();
    if (snap.exists) {
      return { id: canonicalPlayerId(snap.id), docId: snap.id, ref, data: snap.data() as PlayerDoc };
    }
  }
  return null;
}
