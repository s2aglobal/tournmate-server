import { Firestore, DocumentData } from "firebase-admin/firestore";
import { RegistrationDoc, registrationPlayerIds } from "../types";
import { playerById } from "./identity";

/**
 * `registrations.memberUids`: auth uids of the player, partner and roster.
 * `matches.teamAUids` / `teamBUids`: the memberUids of each side's
 * registration. Kept by triggers (triggers/memberUids.ts); rules and the
 * score callables use them to tell who plays in a match.
 */

/** Auth uids for a registration's players (players without a uid are skipped). */
export async function memberUidsFor(db: Firestore, reg: DocumentData): Promise<string[]> {
  const uids: string[] = [];
  for (const id of registrationPlayerIds(reg as RegistrationDoc)) {
    const uid = (await playerById(db, id))?.data.firebaseUid;
    if (uid && !uids.includes(uid)) uids.push(uid);
  }
  return uids;
}

export function sameMembers(a: unknown, b: string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** Recomputes `memberUids` on one registration. Returns true if it changed. */
export async function syncRegistrationMemberUids(db: Firestore, registrationId: string, dryRun = false): Promise<boolean> {
  const ref = db.collection("registrations").doc(registrationId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const uids = await memberUidsFor(db, snap.data()!);
  if (sameMembers(snap.get("memberUids"), uids)) return false;
  if (!dryRun) await ref.update({ memberUids: uids });
  return true;
}

async function sideUids(db: Firestore, registrationId: unknown): Promise<string[]> {
  if (typeof registrationId !== "string" || registrationId.length === 0) return [];
  const snap = await db.collection("registrations").doc(registrationId).get();
  if (!snap.exists) return [];
  const stored = snap.get("memberUids");
  return Array.isArray(stored) ? stored : memberUidsFor(db, snap.data()!);
}

/** Recomputes `teamAUids` / `teamBUids` on one match. Returns true if it changed. */
export async function syncMatchMemberUids(db: Firestore, matchId: string, dryRun = false): Promise<boolean> {
  const ref = db.collection("matches").doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const a = await sideUids(db, snap.get("teamAId"));
  const b = await sideUids(db, snap.get("teamBId"));
  if (sameMembers(snap.get("teamAUids"), a) && sameMembers(snap.get("teamBUids"), b)) return false;
  if (!dryRun) await ref.update({ teamAUids: a, teamBUids: b });
  return true;
}

/** Re-syncs every match that has this registration on either side. */
export async function syncMatchesForRegistration(db: Firestore, registrationId: string): Promise<number> {
  const [asA, asB] = await Promise.all([
    db.collection("matches").where("teamAId", "==", registrationId).get(),
    db.collection("matches").where("teamBId", "==", registrationId).get(),
  ]);
  let changed = 0;
  for (const doc of [...asA.docs, ...asB.docs]) {
    if (await syncMatchMemberUids(db, doc.id)) changed++;
  }
  return changed;
}
