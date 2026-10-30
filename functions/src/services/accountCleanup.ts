import { Firestore, FieldValue, Timestamp, DocumentData } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { playerForUid } from "./identity";
import { sessionWindow } from "./openPlay";
import { cancelSessionFor, leaveSessionFor } from "../callables/openPlay";

/*
 * Removes what a deleted account leaves behind (deleteAccount callable and
 * the auth onDelete safety net). Idempotent: a second run finds nothing.
 *  - upcoming Open Play: hosted sessions are cancelled (players told); as a
 *    player or on a waitlist they leave (first fitting waitlisted player is
 *    promoted and told)
 *  - tournaments not started and not drawn: solo registrations (and any
 *    team-entry lock) are deleted; as someone's partner they are taken off
 *  - inbox notifications
 *  - the player doc (which holds the device token)
 * Past sessions, drawn tournaments, matches and ratings stay as history.
 */

export interface CleanupSummary {
  playerDeleted: boolean;
  sessionsLeft: number;
  sessionsCancelled: number;
  registrationsDeleted: number;
  partnerCleared: number;
  notificationsDeleted: number;
}

function idVariants(id: string): string[] {
  return [...new Set([id, id.toUpperCase(), id.toLowerCase()])];
}

async function tournamentOpen(db: Firestore, tournamentId: string, cache: Map<string, boolean>): Promise<boolean> {
  if (cache.has(tournamentId)) return cache.get(tournamentId)!;
  let open = false;
  for (const id of idVariants(tournamentId)) {
    const t = await db.collection("tournaments").doc(id).get();
    if (!t.exists) continue;
    const date = t.get("date");
    const started = date instanceof Timestamp ? date.toMillis() <= Date.now() : true;
    const drawn = !(await db.collection("matches").where("tournamentId", "in", idVariants(tournamentId)).limit(1).get()).empty;
    open = !started && !drawn && t.get("statusRaw") !== "cancelled";
    break;
  }
  cache.set(tournamentId, open);
  return open;
}

function isTeamEntry(reg: DocumentData): boolean {
  return reg.teamId !== undefined || reg.teamName !== undefined;
}

export async function cleanupAccount(db: Firestore, uid: string): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    playerDeleted: false, sessionsLeft: 0, sessionsCancelled: 0,
    registrationsDeleted: 0, partnerCleared: 0, notificationsDeleted: 0,
  };
  const me = await playerForUid(db, uid);

  if (me) {
    const ids = idVariants(me.id);

    // Open Play: upcoming active sessions the player is in or waiting for.
    const seen = new Set<string>();
    const hosted = await db.collection("playSessions").where("hostId", "==", uid).get();
    const attending = await db.collection("playSessions").where("attendeeIds", "array-contains-any", ids).get();
    const waiting = await db.collection("playSessions").where("waitlistIds", "array-contains-any", ids).get();
    for (const doc of [...hosted.docs, ...attending.docs, ...waiting.docs]) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      const s = doc.data();
      if ((s.status ?? "active") !== "active" || sessionWindow(s).start.getTime() <= Date.now()) continue;
      try {
        if (s.hostId === uid) {
          await cancelSessionFor(db, doc.id, uid);
          summary.sessionsCancelled++;
        } else {
          await leaveSessionFor(db, doc.id, uid);
          summary.sessionsLeft++;
        }
      } catch (err) {
        logger.warn(`cleanupAccount: session ${doc.id} for ${uid}`, err);
      }
    }

    // Registrations in tournaments that haven't started or been drawn.
    const open = new Map<string, boolean>();
    const mine = await db.collection("registrations").where("playerId", "in", ids).get();
    for (const doc of mine.docs) {
      const r = doc.data();
      const solo = !r.partnerId && !(Array.isArray(r.rosterIds) && r.rosterIds.length > 0);
      if (!solo || !(await tournamentOpen(db, r.tournamentId, open))) continue;
      const batch = db.batch();
      batch.delete(doc.ref);
      if (isTeamEntry(r)) {
        const lockRef = db.collection("teamEntries").doc(`${String(r.tournamentId).toLowerCase()}_${me.id.toLowerCase()}`);
        const lock = await lockRef.get();
        if (lock.exists && String(lock.get("registrationId")).toUpperCase() === doc.id.toUpperCase()) batch.delete(lockRef);
      }
      await batch.commit();
      summary.registrationsDeleted++;
    }
    const partnered = await db.collection("registrations").where("partnerId", "in", ids).get();
    for (const doc of partnered.docs) {
      if (!(await tournamentOpen(db, doc.get("tournamentId"), open))) continue;
      await doc.ref.update({ partnerId: FieldValue.delete(), memberUids: FieldValue.arrayRemove(uid) });
      summary.partnerCleared++;
    }
  }

  // Inbox.
  for (;;) {
    const snap = await db.collection("notifications").where("recipientId", "==", uid).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    summary.notificationsDeleted += snap.size;
  }

  // Profile last (leaving sessions above reads it). Holds the device token.
  if (me) {
    await me.ref.delete();
    summary.playerDeleted = true;
  }
  logger.info(`cleanupAccount ${uid}`, summary);
  return summary;
}
