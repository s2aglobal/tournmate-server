import { onCall } from "firebase-functions/v2/https";
import {
  getFirestore, FieldValue, Firestore, Timestamp, Transaction, DocumentData, DocumentReference,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { randomUUID } from "crypto";
import { fail } from "./errors";
import {
  CALLABLE_OPTS, Data, dataOf, optionalString, optionalStringArray, requirePlayer, requireString, requireUid,
} from "./shared";
import { PlayerRef, playerById, sameId } from "../services/identity";
import {
  TeamRoles, isPlayingRole, normalizeRoles, roleKey, rolesFromFirestore, rolesToFirestore, rosterKeys,
  PlayingRole,
} from "../services/teamRoles";
import { resolveCricketRules } from "../services/cricket";
import {
  AGE_GROUP_RULES, AgeGroup, TournamentDoc, TournamentFormat, isAgeEligible, isSinglesFormat, parseSportType,
} from "../types";

/*
 * Registration callables (shared spec: server-authority-spec.md →
 * Registration). Documents have exactly the shape iOS writes today
 * (FirestoreRegistrationRepository.encode): tournamentId, playerId,
 * partnerId?, teamId?, teamName?, rosterIds? (non-empty), guestNames?
 * (non-empty), captainId?, viceCaptainId?, keeperId?, playerRoles?,
 * createdAt — plus server-kept memberUids. Player ids are UPPER case.
 * Team entries also hold teamEntries/{tournamentId}_{playerId} (lower case).
 */

/** Substitutes allowed beyond the playing side (iOS `rosterLimit`). */
const ROSTER_EXTRA = 4;
const MAX_TEAM_NAME = 40;
const MAX_GUEST_NAME = 40;

interface Tournament {
  id: string;
  ref: DocumentReference;
  data: TournamentDoc;
}

interface Ctx {
  db: Firestore;
  tx: Transaction;
}

// ─── Reads ──────────────────────────────────────────────

async function getTournament({ db, tx }: Ctx, id: string): Promise<Tournament> {
  const ref = db.collection("tournaments").doc(id);
  const snap = await tx.get(ref);
  if (!snap.exists) fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
  return { id: snap.id, ref, data: snap.data() as TournamentDoc };
}

async function getRegistration({ db, tx }: Ctx, id: string): Promise<QueryDocumentSnapshot> {
  const snap = await tx.get(db.collection("registrations").doc(id));
  if (!snap.exists) fail("not-found", "NOT_FOUND", "This registration no longer exists.");
  return snap as QueryDocumentSnapshot;
}

async function registrationsFor({ db, tx }: Ctx, tournamentId: string): Promise<QueryDocumentSnapshot[]> {
  return (await tx.get(db.collection("registrations").where("tournamentId", "==", tournamentId))).docs;
}

async function drawExists({ db, tx }: Ctx, tournamentId: string): Promise<boolean> {
  return !(await tx.get(db.collection("matches").where("tournamentId", "==", tournamentId).limit(1))).empty;
}

/** Everyone a registration speaks for (player, partner, roster). */
function membersOf(reg: DocumentData): string[] {
  return [reg.playerId, reg.partnerId, ...(Array.isArray(reg.rosterIds) ? reg.rosterIds : [])]
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

function entryHolding(regs: QueryDocumentSnapshot[], playerId: string, exceptId?: string) {
  return regs.find((r) => r.id !== exceptId && membersOf(r.data()).some((m) => sameId(m, playerId)));
}

function entryName(reg: DocumentData): string {
  return typeof reg.teamName === "string" && reg.teamName ? reg.teamName : "another entry";
}

// ─── Rules ──────────────────────────────────────────────

function isCricket(t: TournamentDoc): boolean {
  return parseSportType(t.sportType) === "cricket";
}

function isOrganizer(t: TournamentDoc, uid: string): boolean {
  return !!t.createdBy && t.createdBy === uid;
}

/**
 * Registration closes at `registrationDeadline`. Docs without one (or with
 * the apps' "never set" far-future value) close when the tournament starts.
 */
function deadlineOf(t: TournamentDoc): Date {
  const date = t.date instanceof Timestamp ? t.date.toDate() : new Date(8.64e15);
  const d = t.registrationDeadline instanceof Timestamp ? t.registrationDeadline.toDate() : null;
  if (!d || d.getUTCFullYear() >= 3000) return date;
  return d;
}

function requireOpen(t: TournamentDoc): void {
  if (t.statusRaw === "cancelled") fail("failed-precondition", "REG_CLOSED", "This tournament was cancelled.");
  if (Date.now() >= deadlineOf(t).getTime()) {
    fail("failed-precondition", "REG_CLOSED", "Registration is closed for this tournament.");
  }
}

function maxParticipants(t: TournamentDoc): number | null {
  if (!t.formatConfigData) return null;
  try {
    const n = JSON.parse(t.formatConfigData)?.maxParticipants;
    return typeof n === "number" && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function checkAge(t: TournamentDoc, me: PlayerRef): void {
  const ageGroup = (t.ageGroupRaw || "open") as AgeGroup;
  if (ageGroup === "open" || !AGE_GROUP_RULES[ageGroup]) return;
  const dob = me.data.dateOfBirth;
  if (!dob) {
    fail("failed-precondition", "INVALID_ARGUMENT",
      "This tournament has an age restriction. Set your date of birth in your profile to register.");
  }
  const birth = dob.toDate();
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  if (!isAgeEligible(age, ageGroup)) {
    fail("failed-precondition", "INVALID_ARGUMENT", `This tournament's age group doesn't include your age (${age}).`);
  }
}

function rosterLimit(t: TournamentDoc): number {
  return resolveCricketRules(t.rulesData).playersPerSide + ROSTER_EXTRA;
}

function cleanGuestNames(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const name of raw ?? []) {
    const n = name.trim();
    if (!n) continue;
    if (n.length > MAX_GUEST_NAME) fail("invalid-argument", "INVALID_ARGUMENT", "A guest name is too long.");
    if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out;
}

function cleanTeamName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const n = raw.trim();
  if (!n) fail("invalid-argument", "INVALID_ARGUMENT", "Give the team a name.");
  if (n.length > MAX_TEAM_NAME) fail("invalid-argument", "INVALID_ARGUMENT", `Team names are up to ${MAX_TEAM_NAME} characters.`);
  return n;
}

/** Reads every roster player (UPPER-cased ids, de-duplicated); unknown ids fail. */
async function readRoster(ctx: Ctx, ids: string[]): Promise<PlayerRef[]> {
  const out: PlayerRef[] = [];
  for (const id of ids) {
    if (out.some((p) => sameId(p.id, id))) continue;
    const p = await playerById(ctx.db, id, ctx.tx);
    if (!p) fail("invalid-argument", "INVALID_ARGUMENT", "A player on the roster no longer exists.");
    out.push(p);
  }
  return out;
}

/** Roster players already playing for another entry in this tournament → ALREADY_ENTERED_TEAM. */
function checkRosterFree(regs: QueryDocumentSnapshot[], roster: PlayerRef[], exceptId?: string): void {
  for (const p of roster) {
    const other = entryHolding(regs, p.id, exceptId);
    if (other) {
      fail("failed-precondition", "ALREADY_ENTERED_TEAM",
        `${p.data.name || "A player"} already plays for ${entryName(other.data())} in this tournament.`);
    }
  }
}

function checkRosterSize(t: TournamentDoc, rosterCount: number): void {
  const limit = rosterLimit(t);
  if (rosterCount > limit) {
    fail("invalid-argument", "INVALID_ARGUMENT", `A team can name up to ${limit} players for this event.`);
  }
}

/** Roles from callable input ({ captainId, viceCaptainId, keeperId, playerRoles }). */
function rolesFromInput(d: Data): TeamRoles {
  const playing: Record<string, PlayingRole> = {};
  const raw = d.playerRoles;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      fail("invalid-argument", "INVALID_ARGUMENT", "playerRoles must map players to roles.");
    }
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!isPlayingRole(v)) fail("invalid-argument", "INVALID_ARGUMENT", `Unknown playing role "${String(v)}".`);
      playing[roleKey(k)] = v;
    }
  }
  const key = (name: string) => {
    const v = optionalString(d, name, 100);
    return v ? roleKey(v) : undefined;
  };
  return { captain: key("captainId"), viceCaptain: key("viceCaptainId"), keeper: key("keeperId"), playing };
}

/** Role fields to write; roles that were set before and are now empty are deleted. */
function roleUpdate(roles: TeamRoles): DocumentData {
  const fields = rolesToFirestore(roles);
  const out: DocumentData = {};
  for (const k of ["captainId", "viceCaptainId", "keeperId", "playerRoles"]) {
    out[k] = fields[k] ?? FieldValue.delete();
  }
  return out;
}

function uidsOf(players: Array<PlayerRef | null | undefined>): string[] {
  const out: string[] = [];
  for (const p of players) {
    const uid = p?.data.firebaseUid;
    if (uid && !out.includes(uid)) out.push(uid);
  }
  return out;
}

function teamEntryLock(db: Firestore, tournamentId: string, playerId: string): DocumentReference {
  return db.collection("teamEntries").doc(`${tournamentId.toLowerCase()}_${playerId.toLowerCase()}`);
}

/** Captain (by role), whoever entered the team, or the organizer. */
function canManageTeam(reg: DocumentData, t: TournamentDoc, me: PlayerRef, uid: string): boolean {
  if (sameId(reg.playerId, me.id) || isOrganizer(t, uid)) return true;
  const roles = rolesFromFirestore(reg);
  return roles.captain !== undefined && roles.captain === roleKey(me.id);
}

function isTeamEntry(reg: DocumentData): boolean {
  return reg.teamId !== undefined || reg.teamName !== undefined;
}

// ─── register ───────────────────────────────────────────

/**
 * register({ tournamentId, partnerId?, team?: { teamId?, teamName, rosterIds,
 *   guestNames?, captainId?, viceCaptainId?, keeperId?, playerRoles? } })
 *   -> { registrationId }
 */
export const register = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const tournamentId = requireString(d, "tournamentId", 64);
  const partnerIdRaw = optionalString(d, "partnerId", 64)?.trim() || undefined;
  const teamRaw = d.team;
  if (teamRaw !== undefined && teamRaw !== null && (typeof teamRaw !== "object" || Array.isArray(teamRaw))) {
    fail("invalid-argument", "INVALID_ARGUMENT", "team must be an object.");
  }
  const team = (teamRaw ?? undefined) as Data | undefined;
  const db = getFirestore();
  const registrationId = randomUUID().toUpperCase();

  await db.runTransaction(async (tx) => {
    const ctx = { db, tx };
    const t = await getTournament(ctx, tournamentId);
    const me = await requirePlayer(db, uid, tx);
    const regs = await registrationsFor(ctx, t.id);
    const hasDraw = await drawExists(ctx, t.id);

    // Reads that depend on the entry type (all before any write).
    let partner: PlayerRef | null = null;
    let roster: PlayerRef[] = [];
    let teamDoc: DocumentData | undefined;
    let lockRef: DocumentReference | undefined;
    let lockTaken = false;
    if (team) {
      roster = await readRoster(ctx, optionalStringArray(team, "rosterIds", 60) ?? []);
      const teamId = optionalString(team, "teamId", 64)?.trim() || undefined;
      if (teamId) {
        const ts = await tx.get(db.collection("teams").doc(teamId));
        if (!ts.exists) fail("not-found", "NOT_FOUND", "That team no longer exists.");
        teamDoc = ts.data();
      }
      lockRef = teamEntryLock(db, t.id, me.id);
      lockTaken = (await tx.get(lockRef)).exists;
    } else if (partnerIdRaw) {
      partner = await playerById(db, partnerIdRaw, tx);
      if (!partner) fail("not-found", "NOT_FOUND", "That partner no longer exists.");
    }

    // Checks.
    requireOpen(t.data);
    if (hasDraw) fail("failed-precondition", "REG_CLOSED", "Registration is closed: the draw has been made.");
    checkAge(t.data, me);
    if (isCricket(t.data) && !team) {
      fail("failed-precondition", "SPORT_NOT_ALLOWED", "Cricket tournaments take team entries. Register a team.");
    }
    if (!isCricket(t.data) && team) {
      fail("failed-precondition", "SPORT_NOT_ALLOWED", "Team entries are only for team sports.");
    }
    const mine = entryHolding(regs, me.id);
    if (mine) {
      fail("already-exists", isTeamEntry(mine.data()) ? "ALREADY_ENTERED_TEAM" : "ALREADY_REGISTERED",
        isTeamEntry(mine.data())
          ? `You already play for ${entryName(mine.data())} in this tournament.`
          : "You're already registered for this tournament.");
    }
    if (lockTaken) {
      fail("already-exists", "ALREADY_ENTERED_TEAM", "You've already entered a team in this tournament.");
    }
    const max = maxParticipants(t.data);
    if (max !== null && regs.length >= max) {
      fail("resource-exhausted", "REG_FULL", "This tournament is full.");
    }

    const doc: DocumentData = {
      tournamentId: t.id,
      playerId: me.id,
      createdAt: Timestamp.now(),
    };

    if (team) {
      const teamName = cleanTeamName(optionalString(team, "teamName", 200) ?? (teamDoc?.name as string | undefined));
      if (!teamName) fail("invalid-argument", "INVALID_ARGUMENT", "Give the team a name.");
      const guestNames = cleanGuestNames(optionalStringArray(team, "guestNames", 60));
      checkRosterSize(t.data, roster.length + guestNames.length);
      checkRosterFree(regs, roster);
      const rosterIds = roster.map((p) => p.id);
      const roles = normalizeRoles(rolesFromInput(team), rosterKeys(rosterIds, guestNames), me.id);
      const teamId = optionalString(team, "teamId", 64)?.trim();
      if (teamId) doc.teamId = teamId;
      doc.teamName = teamName;
      if (rosterIds.length > 0) doc.rosterIds = rosterIds;
      if (guestNames.length > 0) doc.guestNames = guestNames;
      Object.assign(doc, rolesToFirestore(roles));
      doc.memberUids = uidsOf([me, ...roster]);
      tx.set(lockRef!, { tournamentId: t.id, playerId: me.id, registrationId });
    } else {
      const format = t.data.formatRaw as TournamentFormat;
      if (partner) {
        if (isSinglesFormat(format)) fail("invalid-argument", "INVALID_ARGUMENT", "Singles events don't take partners.");
        if (t.data.randomPairing) {
          fail("invalid-argument", "INVALID_ARGUMENT", "Partners are paired randomly in this tournament.");
        }
        if (sameId(partner.id, me.id)) fail("invalid-argument", "INVALID_ARGUMENT", "You can't partner yourself.");
        if (entryHolding(regs, partner.id)) {
          fail("already-exists", "ALREADY_REGISTERED", `${partner.data.name || "Your partner"} is already registered.`);
        }
        checkMixedPair(format, me, partner);
        doc.partnerId = partner.id;
      }
      doc.memberUids = uidsOf([me, partner]);
    }
    tx.set(db.collection("registrations").doc(registrationId), doc);
  });
  return { registrationId };
});

function checkMixedPair(format: TournamentFormat, a: PlayerRef, b: PlayerRef): void {
  if (format !== "mixedDoubles") return;
  const ga = a.data.genderRaw;
  const gb = b.data.genderRaw;
  const known = (g: string) => g === "male" || g === "female";
  if (!known(ga) || !known(gb)) {
    fail("failed-precondition", "GENDER_REQUIRED", "Mixed doubles needs both players' gender set.");
  }
  if (ga === gb) fail("failed-precondition", "INVALID_ARGUMENT", "Mixed doubles pairs one man and one woman.");
}

// ─── withdraw ───────────────────────────────────────────

/**
 * withdraw({ registrationId }) -> { result: "deleted" | "partnerCleared" | "leftRoster" }
 * Registrant or organizer deletes the entry (and its team lock); a partner
 * leaves (partnerId cleared); a roster player removes themself.
 */
export const withdraw = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const registrationId = requireString(dataOf(req), "registrationId", 64);
  const db = getFirestore();

  const result = await db.runTransaction(async (tx) => {
    const ctx = { db, tx };
    const regSnap = await getRegistration(ctx, registrationId);
    const reg = regSnap.data();
    const t = await getTournament(ctx, reg.tournamentId);
    const me = await requirePlayer(db, uid, tx);
    const hasDraw = await drawExists(ctx, t.id);
    const lockRef = isTeamEntry(reg) ? teamEntryLock(db, reg.tournamentId, reg.playerId) : undefined;
    const lock = lockRef ? await tx.get(lockRef) : undefined;
    // Uids of whoever stays, for memberUids (read before writes).
    const stay = async (ids: string[]) => {
      const out: PlayerRef[] = [];
      for (const id of ids) {
        const p = await playerById(db, id, tx);
        if (p) out.push(p);
      }
      return uidsOf(out);
    };

    const isRegistrant = sameId(reg.playerId, me.id);
    const organizer = isOrganizer(t.data, uid);
    const isPartner = sameId(reg.partnerId, me.id);
    const rosterIds: string[] = Array.isArray(reg.rosterIds) ? reg.rosterIds : [];
    const onRoster = rosterIds.some((id) => sameId(id, me.id));
    if (!isRegistrant && !organizer && !isPartner && !onRoster) {
      fail("permission-denied", "NOT_PARTICIPANT", "You're not part of this entry.");
    }
    if (hasDraw) fail("failed-precondition", "DRAW_EXISTS", "You can't withdraw once the draw has been made.");

    if (isRegistrant || organizer) {
      tx.delete(regSnap.ref);
      if (lockRef && lock?.exists && lock.get("registrationId") === registrationId) tx.delete(lockRef);
      return "deleted" as const;
    }
    if (isPartner) {
      const uids = await stay(membersOf({ ...reg, partnerId: undefined }));
      tx.update(regSnap.ref, { partnerId: FieldValue.delete(), memberUids: uids });
      return "partnerCleared" as const;
    }
    const remaining = rosterIds.filter((id) => !sameId(id, me.id));
    const guestNames: string[] = Array.isArray(reg.guestNames) ? reg.guestNames : [];
    const roles = normalizeRoles(rolesFromFirestore(reg), rosterKeys(remaining, guestNames), reg.playerId);
    const uids = await stay(membersOf({ ...reg, rosterIds: remaining }));
    tx.update(regSnap.ref, {
      rosterIds: remaining.length > 0 ? remaining : FieldValue.delete(),
      memberUids: uids,
      ...roleUpdate(roles),
    });
    return "leftRoster" as const;
  });
  return { result };
});

// ─── joinAsPartner ──────────────────────────────────────

/**
 * joinAsPartner({ registrationId }) -> { registrationId }
 * Caller becomes the partner on an open doubles registration. If the caller
 * had their own solo entry it is removed; if they partnered someone else
 * they leave that entry.
 */
export const joinAsPartner = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const registrationId = requireString(dataOf(req), "registrationId", 64);
  const db = getFirestore();

  await db.runTransaction(async (tx) => {
    const ctx = { db, tx };
    const regSnap = await getRegistration(ctx, registrationId);
    const reg = regSnap.data();
    const t = await getTournament(ctx, reg.tournamentId);
    const me = await requirePlayer(db, uid, tx);
    const regs = await registrationsFor(ctx, t.id);
    const hasDraw = await drawExists(ctx, t.id);
    const registrant = await playerById(db, reg.playerId, tx);

    const format = t.data.formatRaw as TournamentFormat;
    if (isCricket(t.data) || isTeamEntry(reg) || isSinglesFormat(format)) {
      fail("failed-precondition", "INVALID_ARGUMENT", "This entry doesn't take a partner.");
    }
    requireOpen(t.data);
    if (hasDraw) fail("failed-precondition", "DRAW_EXISTS", "Partners can't change once the draw has been made.");
    if (sameId(reg.playerId, me.id)) fail("invalid-argument", "INVALID_ARGUMENT", "You can't partner yourself.");
    if (sameId(reg.partnerId, me.id)) return;
    if (typeof reg.partnerId === "string" && reg.partnerId.length > 0) {
      fail("failed-precondition", "REG_FULL", "That player already has a partner.");
    }
    checkAge(t.data, me);
    if (!registrant) fail("not-found", "NOT_FOUND", "That player no longer exists.");
    checkMixedPair(format, registrant, me);

    // The caller's current entry, if any.
    const mine = entryHolding(regs, me.id, regSnap.id);
    if (mine) {
      const m = mine.data();
      if (sameId(m.playerId, me.id) && !m.partnerId) {
        tx.delete(mine.ref); // solo entry merges into this one
      } else if (sameId(m.partnerId, me.id)) {
        const leftBehind = await playerById(db, m.playerId, tx);
        tx.update(mine.ref, { partnerId: FieldValue.delete(), memberUids: uidsOf([leftBehind]) });
      } else {
        fail("already-exists", "ALREADY_REGISTERED", "You're already on a team in this tournament. Withdraw first.");
      }
    }
    tx.update(regSnap.ref, { partnerId: me.id, memberUids: uidsOf([registrant, me]) });
  });
  return { registrationId };
});

// ─── updateRoster ───────────────────────────────────────

/**
 * updateRoster({ registrationId, rosterIds, guestNames, teamName? }) -> { registrationId }
 * Registrant, captain or organizer. Roles are re-normalized to the new side.
 */
export const updateRoster = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const registrationId = requireString(d, "registrationId", 64);
  const rosterInput = optionalStringArray(d, "rosterIds", 60);
  if (!rosterInput) fail("invalid-argument", "INVALID_ARGUMENT", "Missing rosterIds.");
  const guestNames = cleanGuestNames(optionalStringArray(d, "guestNames", 60));
  const teamName = cleanTeamName(optionalString(d, "teamName", 200));
  const db = getFirestore();

  await db.runTransaction(async (tx) => {
    const ctx = { db, tx };
    const regSnap = await getRegistration(ctx, registrationId);
    const reg = regSnap.data();
    const t = await getTournament(ctx, reg.tournamentId);
    const me = await requirePlayer(db, uid, tx);
    const regs = await registrationsFor(ctx, t.id);
    const roster = await readRoster(ctx, rosterInput);
    const registrant = await playerById(db, reg.playerId, tx);

    if (!isTeamEntry(reg)) fail("failed-precondition", "INVALID_ARGUMENT", "Only team entries have a roster.");
    if (!canManageTeam(reg, t.data, me, uid)) {
      fail("permission-denied", "NOT_PARTICIPANT", "Only the captain, whoever entered the team, or the organizer can change the roster.");
    }
    checkRosterSize(t.data, roster.length + guestNames.length);
    checkRosterFree(regs, roster, regSnap.id);

    const rosterIds = roster.map((p) => p.id);
    const roles = normalizeRoles(rolesFromFirestore(reg), rosterKeys(rosterIds, guestNames), reg.playerId);
    const update: DocumentData = {
      rosterIds: rosterIds.length > 0 ? rosterIds : FieldValue.delete(),
      guestNames: guestNames.length > 0 ? guestNames : FieldValue.delete(),
      memberUids: uidsOf([registrant, ...roster]),
      ...roleUpdate(roles),
    };
    if (teamName) update.teamName = teamName;
    tx.update(regSnap.ref, update);
  });
  return { registrationId };
});

// ─── setRoles ───────────────────────────────────────────

/**
 * setRoles({ registrationId, captainId, viceCaptainId?, keeperId?, playerRoles? })
 *   -> { captainId?, viceCaptainId?, keeperId?, playerRoles? } (as stored)
 * Keys are player ids or `guest:<name>` and must be on the side. The captain
 * can't also be vice-captain; there is always a captain while anyone plays.
 */
export const setRoles = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const registrationId = requireString(d, "registrationId", 64);
  const input = rolesFromInput(d);
  const db = getFirestore();

  return db.runTransaction(async (tx) => {
    const ctx = { db, tx };
    const regSnap = await getRegistration(ctx, registrationId);
    const reg = regSnap.data();
    const t = await getTournament(ctx, reg.tournamentId);
    const me = await requirePlayer(db, uid, tx);

    if (!isTeamEntry(reg)) fail("failed-precondition", "INVALID_ARGUMENT", "Only team entries have roles.");
    if (!canManageTeam(reg, t.data, me, uid)) {
      fail("permission-denied", "NOT_PARTICIPANT", "Only the captain, whoever entered the team, or the organizer can set roles.");
    }
    const keys = rosterKeys(
      Array.isArray(reg.rosterIds) ? reg.rosterIds : [],
      Array.isArray(reg.guestNames) ? reg.guestNames : [],
    );
    const inSide = new Set(keys);
    const notOnSide = (k?: string) => k !== undefined && !inSide.has(k);
    if (keys.length > 0 && !input.captain) fail("invalid-argument", "INVALID_ARGUMENT", "Pick a captain.");
    if ([input.captain, input.viceCaptain, input.keeper, ...Object.keys(input.playing)].some(notOnSide)) {
      fail("invalid-argument", "INVALID_ARGUMENT", "Roles can only go to players on the team sheet.");
    }
    if (input.viceCaptain && input.viceCaptain === input.captain) {
      fail("invalid-argument", "INVALID_ARGUMENT", "The captain can't also be vice-captain.");
    }
    const roles = normalizeRoles(input, keys, reg.playerId);
    tx.update(regSnap.ref, roleUpdate(roles));
    return rolesToFirestore(roles);
  });
});
