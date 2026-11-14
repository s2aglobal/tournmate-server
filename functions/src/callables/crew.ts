import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { Firestore, Timestamp, getFirestore } from "firebase-admin/firestore";
import { fail } from "./errors";
import { CALLABLE_OPTS, Data, dataOf, requirePlayer, requireUid } from "./shared";
import { PlayerRef, canonicalPlayerId, playerById, playerForUid, resolveDocId, sameId } from "../services/identity";
import { notifyPlayer } from "../services/notifyPlayer";
import { tournamentIdVariants } from "../services/draw/tournament";
import { MatchDoc, RegistrationDoc, TournamentDoc, registrationPlayerIds } from "../types";
import {
  CREW_INVITES, CrewInviteDoc, CrewMember, MAX_CREW, crewOf, crewUrl, newInviteCode, normalizeInviteCode, tournamentClosed,
} from "../services/crew";
import { StreamDoc, endedStream, entriesOf, isLive, removeEntry, streamOf, tournamentPatch } from "../services/liveStream";
import { YOUTUBE_SECRETS, closeServerBroadcast } from "../services/youtubeServer";

/**
 * Tournament crew callables (contract: live-stream-contract.md "Tournament
 * crew"; data: services/crew.ts). Organizer only unless noted. Invite, add
 * and join are refused once the tournament has finished or was cancelled;
 * leave and remove always work. A member who leaves or is removed while
 * streaming has their stream ended (`endedReason: "crew_removed"`), and a
 * server broadcast is completed on YouTube.
 */

const ORGANIZER_ONLY = "Only the organizer can manage the crew.";

function requireTournamentId(d: Data): string {
  const id = d.tournamentId;
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || id.includes("/")) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Missing tournament.");
  }
  return id;
}

async function tournamentRef(db: Firestore, id: string): Promise<FirebaseFirestore.DocumentReference> {
  return db.collection("tournaments").doc(await resolveDocId(db, "tournaments", id));
}

function requireOpen(t: TournamentDoc): void {
  const closed = tournamentClosed(t);
  if (closed === "cancelled") fail("failed-precondition", "TOURNAMENT_CLOSED", "This tournament was cancelled.");
  if (closed === "finished") fail("failed-precondition", "TOURNAMENT_CLOSED", "This tournament has finished.");
}

function requireRoom(crew: Record<string, CrewMember>): void {
  if (Object.keys(crew).length >= MAX_CREW) fail("failed-precondition", "CREW_FULL", `The crew is full (${MAX_CREW} people).`);
}

/** The member as returned to the apps (timestamps as epoch ms). */
function memberOut(uid: string, m: CrewMember): Record<string, unknown> {
  return {
    uid, role: m.role, status: m.status, name: m.name, playerId: m.playerId, via: m.via, invitedBy: m.invitedBy,
    invitedAt: m.invitedAt?.toMillis?.() ?? null, ...(m.joinedAt ? { joinedAt: m.joinedAt.toMillis() } : {}),
  };
}

// ─── createCrewInvite ───────────────────────────────────

/**
 * createCrewInvite({ tournamentId, rotate? }) → { code, url, created }.
 * One active code per tournament: returns the existing one, or a new one when
 * there is none or `rotate: true` (the old code stops working: "reset link").
 */
export const createCrewInvite = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const ref = await tournamentRef(db, requireTournamentId(d));
  const rotate = d.rotate === true;
  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
    const t = snap.data() as TournamentDoc;
    if (t.createdBy !== uid) fail("permission-denied", "NOT_ORGANIZER", ORGANIZER_ONLY);
    requireOpen(t);
    const existing = await tx.get(db.collection(CREW_INVITES).where("tournamentId", "==", ref.id));
    if (!rotate && !existing.empty) return { code: existing.docs[0].id, created: false };
    let code = newInviteCode();
    for (let i = 0; i < 5 && (await tx.get(db.collection(CREW_INVITES).doc(code))).exists; i++) code = newInviteCode();
    for (const doc of existing.docs) tx.delete(doc.ref);
    const invite: CrewInviteDoc = { tournamentId: ref.id, createdBy: uid, createdAt: Timestamp.now(), role: "camera" };
    tx.set(db.collection(CREW_INVITES).doc(code), invite);
    return { code, created: true };
  });
  return { code: out.code, url: crewUrl(out.code), created: out.created };
});

// ─── addCrewMember ──────────────────────────────────────

/** Whether the player plays in the tournament (any registration naming them or their uid). */
async function isRegistered(db: Firestore, tournamentId: string, player: PlayerRef, uid: string): Promise<boolean> {
  const regs = await db.collection("registrations").where("tournamentId", "in", tournamentIdVariants(tournamentId)).get();
  return regs.docs.some((doc) => {
    const r = doc.data() as RegistrationDoc & { memberUids?: unknown };
    return registrationPlayerIds(r).some((id) => sameId(id, player.id)) ||
      (Array.isArray(r.memberUids) && r.memberUids.includes(uid));
  });
}

/**
 * addCrewMember({ tournamentId, uid } | { tournamentId, playerId }) →
 * { member, alreadyMember }. The player must be registered in the tournament.
 * They are added as `invited` (role camera) and get a `crew_invite`
 * notification (inbox + push); they join with joinCrew({ tournamentId }).
 * Already in the crew → unchanged, no new notification.
 */
export const addCrewMember = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const ref = await tournamentRef(db, requireTournamentId(d));
  let player: PlayerRef | null = null;
  if (typeof d.uid === "string" && d.uid.length > 0 && d.uid.length <= 128) player = await playerForUid(db, d.uid);
  else if (typeof d.playerId === "string" && d.playerId.length > 0 && d.playerId.length <= 128) player = await playerById(db, d.playerId);
  else fail("invalid-argument", "INVALID_ARGUMENT", "Missing player.");
  const target = player?.data.firebaseUid;
  if (!player || !target) fail("failed-precondition", "NOT_REGISTERED", "That player doesn't have a TournMate account.");

  const pre = await ref.get();
  if (!pre.exists) fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
  if ((pre.data() as TournamentDoc).createdBy !== uid) fail("permission-denied", "NOT_ORGANIZER", ORGANIZER_ONLY);
  if (target === uid) fail("failed-precondition", "IS_ORGANIZER", "You organize this tournament, so you can already stream it.");
  if (!(await isRegistered(db, ref.id, player, target))) {
    fail("failed-precondition", "NOT_REGISTERED", "That player isn't registered in this tournament.");
  }

  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
    const t = snap.data() as TournamentDoc;
    if (t.createdBy !== uid) fail("permission-denied", "NOT_ORGANIZER", ORGANIZER_ONLY);
    requireOpen(t);
    const crew = crewOf(t);
    if (crew[target]) return { member: crew[target], already: true, t };
    requireRoom(crew);
    const member: CrewMember = {
      role: "camera", status: "invited", name: player.data.name ?? "", playerId: canonicalPlayerId(player.id),
      invitedBy: uid, invitedAt: Timestamp.now(), via: "player",
    };
    tx.update(ref, { crew: { ...crew, [target]: member } });
    return { member, already: false, t };
  });
  if (!out.already) {
    const organizer = await playerForUid(db, uid);
    const who = organizer?.data.name?.trim() || "The organizer";
    await notifyPlayer(db, player.data, {
      type: "crew_invite",
      title: "Join the camera crew",
      body: `${who} asked you to stream matches at ${out.t.title}. Tap to join.`,
      data: { tournamentId: ref.id, role: "camera" },
    });
    logger.info(`addCrewMember ${ref.id}: ${target} invited by ${uid}`);
  }
  return { member: memberOut(target, out.member), alreadyMember: out.already };
});

// ─── joinCrew ───────────────────────────────────────────

/**
 * joinCrew({ code }) | joinCrew({ tournamentId }) → { tournamentId, member, alreadyJoined }.
 * Any signed-in user with a player profile. `code` (or the full invite URL):
 * joins as a camera member (an existing invite is accepted). `tournamentId`:
 * accepts an invite from addCrewMember (NOT_INVITED otherwise).
 */
export const joinCrew = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const me = await requirePlayer(db, uid);
  let ref: FirebaseFirestore.DocumentReference;
  let byCode = false;
  if (d.code !== undefined && d.code !== null) {
    const code = normalizeInviteCode(d.code);
    const invite = code ? await db.collection(CREW_INVITES).doc(code).get() : null;
    if (!invite?.exists) fail("not-found", "INVITE_INVALID", "This crew invite isn't valid anymore. Ask the organizer for a new one.");
    ref = db.collection("tournaments").doc((invite.data() as CrewInviteDoc).tournamentId);
    byCode = true;
  } else {
    ref = await tournamentRef(db, requireTournamentId(d));
  }
  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      if (byCode) fail("not-found", "INVITE_INVALID", "This crew invite isn't valid anymore. Ask the organizer for a new one.");
      fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
    }
    const t = snap.data() as TournamentDoc;
    if (t.createdBy === uid) fail("failed-precondition", "IS_ORGANIZER", "You organize this tournament, so you can already stream it.");
    requireOpen(t);
    const crew = crewOf(t);
    const existing = crew[uid];
    if (existing?.status === "joined") return { member: existing, already: true };
    if (!existing && !byCode) fail("failed-precondition", "NOT_INVITED", "You haven't been invited to this crew.");
    if (!existing) requireRoom(crew);
    const now = Timestamp.now();
    const member: CrewMember = existing ?
      { ...existing, status: "joined", joinedAt: now, name: me.data.name || existing.name } :
      { role: "camera", status: "joined", name: me.data.name ?? "", playerId: me.id, invitedBy: uid, invitedAt: now, joinedAt: now, via: "link" };
    tx.update(ref, { crew: { ...crew, [uid]: member } });
    return { member, already: false };
  });
  if (!out.already) logger.info(`joinCrew ${ref.id}: ${uid} joined (${byCode ? "link" : "invite"})`);
  return { tournamentId: ref.id, member: memberOut(uid, out.member), alreadyJoined: out.already };
});

// ─── leaveCrew / removeCrewMember ───────────────────────

/**
 * Removes `memberUid` from the crew and ends their live streams in the
 * tournament (`crew_removed`), in one transaction; then completes their
 * server broadcasts on YouTube. Returns whether they were in the crew and
 * how many streams ended.
 */
async function removeFromCrew(db: Firestore, ref: FirebaseFirestore.DocumentReference, memberUid: string,
  allowed: (t: TournamentDoc) => void): Promise<{ removed: boolean; endedStreams: number }> {
  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
    const t = snap.data() as TournamentDoc;
    allowed(t);
    const crew = crewOf(t);
    const ended: Array<{ matchId: string; stream: StreamDoc }> = [];
    // Only a crew member's streams end here (never the organizer's own).
    if (!crew[memberUid]) return { removed: false, ended };
    const before = entriesOf(t);
    for (const e of before) {
      const m = await tx.get(db.collection("matches").doc(e.matchId));
      const s = streamOf(m.data() as MatchDoc | undefined);
      if (isLive(s) && s.byUid === memberUid) ended.push({ matchId: e.matchId, stream: s });
    }
    const now = Timestamp.now();
    let list = before;
    for (const x of ended) {
      tx.update(db.collection("matches").doc(x.matchId), { stream: endedStream(x.stream, "crew_removed", now) });
      list = removeEntry(list, x.matchId);
    }
    const nextCrew = { ...crew };
    delete nextCrew[memberUid];
    const p = tournamentPatch(before, list, t);
    tx.update(ref, { crew: nextCrew, ...(ended.length && p.changed ? p.fields : {}) });
    return { removed: true, ended };
  });
  for (const x of out.ended) {
    if (x.stream.createdBy === "server") await closeServerBroadcast(db, x.stream.videoId);
  }
  return { removed: out.removed, endedStreams: out.ended.length };
}

/** leaveCrew({ tournamentId }) → { left, endedStreams }. The member themselves; not in the crew → left: false. */
export const leaveCrew = onCall({ ...CALLABLE_OPTS, secrets: YOUTUBE_SECRETS }, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const ref = await tournamentRef(db, requireTournamentId(d));
  const r = await removeFromCrew(db, ref, uid, () => undefined);
  if (r.removed) logger.info(`leaveCrew ${ref.id}: ${uid} left, ${r.endedStreams} stream(s) ended`);
  return { left: r.removed, endedStreams: r.endedStreams };
});

/** removeCrewMember({ tournamentId, uid }) → { removed, endedStreams }. Organizer; not in the crew → removed: false. */
export const removeCrewMember = onCall({ ...CALLABLE_OPTS, secrets: YOUTUBE_SECRETS }, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const ref = await tournamentRef(db, requireTournamentId(d));
  const target = d.uid;
  if (typeof target !== "string" || target.length === 0 || target.length > 128) fail("invalid-argument", "INVALID_ARGUMENT", "Missing member.");
  const r = await removeFromCrew(db, ref, target, (t) => {
    if (t.createdBy !== uid) fail("permission-denied", "NOT_ORGANIZER", ORGANIZER_ONLY);
  });
  if (r.removed) logger.info(`removeCrewMember ${ref.id}: ${target} removed by ${uid}, ${r.endedStreams} stream(s) ended`);
  return { removed: r.removed, endedStreams: r.endedStreams };
});
