import { onCall } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Firestore, Timestamp, Transaction, DocumentData } from "firebase-admin/firestore";
import { randomUUID } from "crypto";
import { fail } from "./errors";
import {
  CALLABLE_OPTS, Data, dataOf, formatWhen, optionalNumber, optionalString, parseDate,
  requirePlayer, requireString, requireUid,
} from "./shared";
import { capacityFor, findClashingSessions, sessionWindow } from "../services/openPlay";
import { PlayerRef, playerById, playerForUid, resolveDocId, sameId } from "../services/identity";
import { notifyPlayer } from "../services/notifyPlayer";
import { PlayerDoc, isSportType, parseSportType, sportEmoji } from "../types";

/*
 * Open Play callables (shared spec: server-authority-spec.md → Open Play).
 * Every check and write happens in one Firestore transaction; notifications
 * go out after it commits.
 *
 * Session fields as the apps store them (FirestorePlaySessionRepository):
 * title, venue, venueAddress, venueLatitude, venueLongitude, countryCode,
 * postalCode, date, durationMinutes, skillLevel, gameType, costPerPerson,
 * currency, notes, preferredAgeGroup, status, hostId, attendeeIds,
 * createdAt, timeZone, sportType. Server-only: maxPlayers, endsAt,
 * waitlistIds, attendeeUids.
 */

export const DEFAULT_DURATION_MINUTES = 90;
export const MAX_DURATION_MINUTES = 240;
export const MIN_DURATION_MINUTES = 15;
/** Upcoming active sessions one host may have at a time. */
export const HOST_SESSION_LIMIT = 3;
/** Mixed sessions: at most this many men and this many women. */
export const MIXED_PER_GENDER = 2;

const GAME_TYPES = ["any", "singles", "doubles", "mixed"];

const STRING_FIELDS = [
  "title", "venue", "venueAddress", "countryCode", "postalCode", "skillLevel",
  "gameType", "currency", "notes", "preferredAgeGroup", "timeZone", "sportType",
] as const;
const NUMBER_FIELDS = ["venueLatitude", "venueLongitude", "costPerPerson", "durationMinutes"] as const;
/** Optional fields a host may clear by sending null. */
const CLEARABLE = new Set(["notes", "costPerPerson", "venueLatitude", "venueLongitude", "countryCode", "postalCode"]);
/** Locked once anyone besides the host has joined. */
const LOCKED_FIELDS = new Set([
  "date", "durationMinutes", "gameType", "sportType", "costPerPerson",
  "venue", "venueAddress", "venueLatitude", "venueLongitude",
]);

type SessionInput = Record<string, string | number | Date | null>;

/** Reads the session fields present in `d` (gameTypeRaw accepted for gameType). */
function readSessionFields(d: Data): SessionInput {
  const out: SessionInput = {};
  const src: Data = { ...d };
  if (src.gameType === undefined && src.gameTypeRaw !== undefined) src.gameType = src.gameTypeRaw;
  for (const key of STRING_FIELDS) {
    if (!(key in src)) continue;
    if (src[key] === null && CLEARABLE.has(key)) { out[key] = null; continue; }
    const v = optionalString(src, key, key === "notes" ? 2000 : 200);
    if (v !== undefined) out[key] = v.trim();
  }
  for (const key of NUMBER_FIELDS) {
    if (!(key in src)) continue;
    if (src[key] === null && CLEARABLE.has(key)) { out[key] = null; continue; }
    const v = optionalNumber(src, key);
    if (v !== undefined) out[key] = v;
  }
  const date = parseDate(src.date, "date");
  if (date) out.date = date;
  return out;
}

function validateSessionValues(f: SessionInput): void {
  if ("venue" in f && (typeof f.venue !== "string" || f.venue.length === 0)) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Add a venue.");
  }
  if ("durationMinutes" in f) {
    const m = f.durationMinutes as number;
    if (!Number.isInteger(m) || m < MIN_DURATION_MINUTES || m > MAX_DURATION_MINUTES) {
      fail("invalid-argument", "INVALID_ARGUMENT",
        `Duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`);
    }
  }
  if ("gameType" in f && !GAME_TYPES.includes(f.gameType as string)) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Unknown game type.");
  }
  if ("sportType" in f) {
    if (f.sportType === "cricket") {
      fail("failed-precondition", "SPORT_NOT_ALLOWED", "Open Play isn't available for cricket. Host a tournament instead.");
    }
    if (!isSportType(f.sportType) || f.sportType === "generic") {
      fail("invalid-argument", "INVALID_ARGUMENT", "Unknown sport.");
    }
  }
  if ("date" in f && (f.date as Date).getTime() <= Date.now()) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Pick a start time in the future.");
  }
  if ("costPerPerson" in f && typeof f.costPerPerson === "number" && f.costPerPerson < 0) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Cost can't be negative.");
  }
}

function genderOf(p: PlayerDoc | null | undefined): "male" | "female" | null {
  const g = p?.genderRaw;
  return g === "male" || g === "female" ? g : null;
}

function isMixed(session: DocumentData): boolean {
  return (session.gameType ?? session.gameTypeRaw) === "mixed";
}

function capacityOf(session: DocumentData): number {
  return typeof session.maxPlayers === "number" && session.maxPlayers > 0
    ? session.maxPlayers
    : capacityFor(session.gameType ?? session.gameTypeRaw);
}

function idsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function clashMessage(other: DocumentData): string {
  const { start } = sessionWindow(other);
  return `You're already playing at ${other.venue || "another session"} on ${formatWhen(start, other.timeZone)}.`;
}

async function failOnClash(
  db: Firestore, tx: Transaction, playerId: string, start: Date, end: Date, excludeId: string | null,
): Promise<void> {
  const clashes = await findClashingSessions(db, playerId, start, end, excludeId, tx);
  if (clashes.length > 0) fail("failed-precondition", "SESSION_CLASH", clashMessage(clashes[0].data()));
}

/** Genders of the current attendees (null = not set), read inside the transaction. */
async function attendeeGenders(db: Firestore, tx: Transaction, ids: string[]): Promise<Array<"male" | "female" | null>> {
  const out: Array<"male" | "female" | null> = [];
  for (const id of ids) out.push(genderOf((await playerById(db, id, tx))?.data));
  return out;
}

function sessionLabel(s: DocumentData): string {
  return `${s.title || "Open Play"} at ${s.venue || "the venue"} on ${formatWhen(sessionWindow(s).start, s.timeZone)}`;
}

// ─── createSession ──────────────────────────────────────

/**
 * createSession({ title?, venue, venueAddress?, venueLatitude?, venueLongitude?,
 *   countryCode?, postalCode?, date, durationMinutes?, skillLevel?, gameType?,
 *   costPerPerson?, currency?, notes?, preferredAgeGroup?, timeZone?, sportType?,
 *   sessionId? }) -> { sessionId }
 */
export const createSession = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const f = readSessionFields(d);
  if (!f.date) fail("invalid-argument", "INVALID_ARGUMENT", "Pick a date and time.");
  requireString(f as Data, "venue");
  f.durationMinutes ??= DEFAULT_DURATION_MINUTES;
  f.gameType ??= "any";
  f.sportType ??= "badminton";
  validateSessionValues(f);

  let sessionId = randomUUID().toUpperCase();
  if (d.sessionId !== undefined) {
    const raw = requireString(d, "sessionId", 64);
    if (!/^[0-9a-fA-F-]{36}$/.test(raw)) fail("invalid-argument", "INVALID_ARGUMENT", "sessionId must be a UUID.");
    sessionId = raw.toUpperCase();
  }

  const start = f.date as Date;
  const minutes = f.durationMinutes as number;
  const end = new Date(start.getTime() + minutes * 60_000);
  const ref = db.collection("playSessions").doc(sessionId);

  await db.runTransaction(async (tx) => {
    const me = await requirePlayer(db, uid, tx);
    if (f.gameType === "mixed" && !genderOf(me.data)) {
      fail("failed-precondition", "GENDER_REQUIRED", "Set your gender to host a mixed session.");
    }
    const hosted = await tx.get(db.collection("playSessions").where("hostId", "==", uid));
    const now = Date.now();
    const upcoming = hosted.docs.filter((s) =>
      (s.get("status") ?? "active") === "active" && sessionWindow(s.data()).start.getTime() > now);
    if (upcoming.length >= HOST_SESSION_LIMIT) {
      fail("resource-exhausted", "HOST_LIMIT",
        `You can host up to ${HOST_SESSION_LIMIT} upcoming sessions. Cancel one or wait until one has started.`);
    }
    // The host plays in their own sessions, so any overlap clashes.
    const ownOverlap = upcoming.find((s) => {
      const w = sessionWindow(s.data());
      return w.start < end && start < w.end;
    });
    if (ownOverlap) fail("failed-precondition", "SESSION_CLASH", clashMessage(ownOverlap.data()));
    await failOnClash(db, tx, me.id, start, end, null);
    if ((await tx.get(ref)).exists) fail("already-exists", "INVALID_ARGUMENT", "That session already exists.");

    const doc: DocumentData = {
      title: (f.title as string | undefined) || "Open Play",
      venue: f.venue,
      venueAddress: (f.venueAddress as string | undefined) ?? "",
      date: Timestamp.fromDate(start),
      durationMinutes: minutes,
      endsAt: Timestamp.fromDate(end),
      skillLevel: (f.skillLevel as string | undefined) || "allLevels",
      gameType: f.gameType,
      currency: (f.currency as string | undefined) || "USD",
      preferredAgeGroup: (f.preferredAgeGroup as string | undefined) || "open",
      sportType: f.sportType,
      status: "active",
      hostId: uid,
      attendeeIds: [me.id],
      attendeeUids: [uid],
      waitlistIds: [],
      maxPlayers: capacityFor(f.gameType),
      createdAt: Timestamp.now(),
    };
    for (const key of ["venueLatitude", "venueLongitude", "countryCode", "postalCode", "costPerPerson", "notes", "timeZone"]) {
      if (f[key] !== undefined && f[key] !== null && f[key] !== "") doc[key] = f[key];
    }
    tx.set(ref, doc);
  });
  return { sessionId };
});

// ─── updateSession ──────────────────────────────────────

/** updateSession({ sessionId, ...fields }) -> { sessionId }. Host only. */
export const updateSession = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const sessionId = await resolveDocId(db, "playSessions", requireString(d, "sessionId", 64));
  const f = readSessionFields(d);

  await db.runTransaction(async (tx) => {
    const ref = db.collection("playSessions").doc(sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "NOT_FOUND", "This session no longer exists.");
    const s = snap.data()!;
    if (s.hostId !== uid) fail("permission-denied", "NOT_HOST", "Only the host can edit this session.");
    if ((s.status ?? "active") !== "active") fail("failed-precondition", "SESSION_CLOSED", "This session is no longer active.");

    // Keep only real changes (apps may send the whole session back).
    const changes: SessionInput = {};
    for (const [key, value] of Object.entries(f)) {
      const current = s[key];
      const same = value instanceof Date
        ? current instanceof Timestamp && current.toMillis() === value.getTime()
        : value === null ? current === undefined || current === null : current === value;
      if (!same) changes[key] = value;
    }
    if (Object.keys(changes).length === 0) return;
    validateSessionValues(changes);

    const attendees = idsOf(s.attendeeIds);
    if (attendees.length > 1) {
      const locked = Object.keys(changes).filter((k) => LOCKED_FIELDS.has(k));
      if (locked.length > 0) {
        fail("failed-precondition", "FIELDS_LOCKED",
          "Players have joined, so the time, length, game type, sport, cost and venue can't change. You can still edit the title and notes.");
      }
    }

    const update: DocumentData = {};
    for (const [key, value] of Object.entries(changes)) {
      update[key] = value === null ? FieldValue.delete()
        : value instanceof Date ? Timestamp.fromDate(value) : value;
    }
    if (changes.gameType !== undefined) {
      update.maxPlayers = capacityFor(changes.gameType);
      if (changes.gameType === "mixed") {
        const me = await requirePlayer(db, uid, tx);
        if (!genderOf(me.data)) fail("failed-precondition", "GENDER_REQUIRED", "Set your gender to host a mixed session.");
      }
    }
    if (changes.date !== undefined || changes.durationMinutes !== undefined) {
      const start = (changes.date as Date | undefined) ?? sessionWindow(s).start;
      const minutes = (changes.durationMinutes as number | undefined)
        ?? (typeof s.durationMinutes === "number" ? s.durationMinutes : DEFAULT_DURATION_MINUTES);
      const end = new Date(start.getTime() + minutes * 60_000);
      if (s.durationMinutes === undefined) update.durationMinutes = minutes;
      update.endsAt = Timestamp.fromDate(end);
      const me = await requirePlayer(db, uid, tx);
      await failOnClash(db, tx, me.id, start, end, sessionId);
    }
    update.updatedAt = FieldValue.serverTimestamp();
    tx.update(ref, update);
  });
  return { sessionId };
});

// ─── joinSession ────────────────────────────────────────

/** joinSession({ sessionId }) -> { status: "joined" | "waitlisted" } */
export const joinSession = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const db = getFirestore();
  const sessionId = await resolveDocId(db, "playSessions", requireString(dataOf(req), "sessionId", 64));

  return db.runTransaction(async (tx) => {
    const ref = db.collection("playSessions").doc(sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "NOT_FOUND", "This session no longer exists.");
    const s = snap.data()!;
    const me = await requirePlayer(db, uid, tx);
    const attendees = idsOf(s.attendeeIds);
    const waitlist = idsOf(s.waitlistIds);
    if (attendees.some((id) => sameId(id, me.id))) return { status: "joined" as const };
    if (waitlist.some((id) => sameId(id, me.id))) return { status: "waitlisted" as const };

    const { start, end } = sessionWindow(s);
    if ((s.status ?? "active") !== "active" || start.getTime() <= Date.now()) {
      fail("failed-precondition", "SESSION_CLOSED", "This session has already started or is no longer open.");
    }
    if (parseSportType(s.sportType) === "cricket") {
      fail("failed-precondition", "SPORT_NOT_ALLOWED", "Open Play isn't available for cricket.");
    }
    const mixed = isMixed(s);
    const myGender = genderOf(me.data);
    if (mixed && !myGender) {
      fail("failed-precondition", "GENDER_REQUIRED", "Set your gender to join a mixed session.");
    }
    await failOnClash(db, tx, me.id, start, end, sessionId);

    let full = attendees.length >= capacityOf(s);
    if (!full && mixed) {
      const genders = await attendeeGenders(db, tx, attendees);
      full = genders.filter((g) => g === myGender).length >= MIXED_PER_GENDER;
    }
    if (full) {
      tx.update(ref, { waitlistIds: FieldValue.arrayUnion(me.id) });
      return { status: "waitlisted" as const };
    }
    tx.update(ref, {
      attendeeIds: FieldValue.arrayUnion(me.id),
      attendeeUids: FieldValue.arrayUnion(uid),
    });
    return { status: "joined" as const };
  });
});

// ─── leaveSession ───────────────────────────────────────

/**
 * leaveSession({ sessionId }) -> { status: "left", promotedPlayerId?: string }
 * Promotes the first waitlisted player who fits (gender for mixed) and has
 * no clash, and notifies them.
 */
export const leaveSession = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const db = getFirestore();
  const sessionId = await resolveDocId(db, "playSessions", requireString(dataOf(req), "sessionId", 64));
  return leaveSessionFor(db, sessionId, uid);
});

/**
 * Takes the caller (auth `uid`) off a session's attendees or waitlist,
 * promotes the first waitlisted player who fits, and notifies them. Shared
 * by leaveSession and deleteAccount.
 */
export async function leaveSessionFor(
  db: Firestore, sessionId: string, uid: string,
): Promise<{ status: "left"; promotedPlayerId?: string }> {
  const result = await db.runTransaction(async (tx) => {
    const ref = db.collection("playSessions").doc(sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "NOT_FOUND", "This session no longer exists.");
    const s = snap.data()!;
    const me = await requirePlayer(db, uid, tx);
    if (s.hostId === uid) {
      fail("failed-precondition", "INVALID_ARGUMENT", "You're hosting this session. Cancel it instead of leaving.");
    }
    const attendees = idsOf(s.attendeeIds);
    const waitlist = idsOf(s.waitlistIds);

    const onWaitlist = waitlist.filter((id) => sameId(id, me.id));
    const attending = attendees.filter((id) => sameId(id, me.id));
    if (onWaitlist.length === 0 && attending.length === 0) {
      fail("failed-precondition", "NOT_PARTICIPANT", "You're not in this session.");
    }
    if (attending.length === 0) {
      tx.update(ref, { waitlistIds: FieldValue.arrayRemove(...onWaitlist) });
      return { status: "left" as const, session: s, promoted: null as PlayerRef | null };
    }

    const remaining = attendees.filter((id) => !sameId(id, me.id));
    const remainingWaitlist = waitlist.filter((id) => !sameId(id, me.id));
    const { start, end } = sessionWindow(s);
    let promoted: PlayerRef | null = null;
    const canPromote = (s.status ?? "active") === "active" && start.getTime() > Date.now()
      && remaining.length < capacityOf(s);
    if (canPromote && remainingWaitlist.length > 0) {
      const mixed = isMixed(s);
      const genders = mixed ? await attendeeGenders(db, tx, remaining) : [];
      for (const candidateId of remainingWaitlist) {
        const candidate = await playerById(db, candidateId, tx);
        if (!candidate) continue;
        if (mixed) {
          const g = genderOf(candidate.data);
          if (!g || genders.filter((x) => x === g).length >= MIXED_PER_GENDER) continue;
        }
        const clashes = await findClashingSessions(db, candidateId, start, end, sessionId, tx);
        if (clashes.length > 0) continue;
        promoted = { ...candidate, id: candidateId };
        break;
      }
    }

    const uids = idsOf(s.attendeeUids).filter((u) => u !== uid);
    if (promoted?.data.firebaseUid && !uids.includes(promoted.data.firebaseUid)) uids.push(promoted.data.firebaseUid);
    const update: DocumentData = {
      attendeeIds: promoted ? [...remaining, promoted.id] : remaining,
      attendeeUids: uids,
    };
    if (promoted) {
      update.waitlistIds = remainingWaitlist.filter((id) => id !== promoted!.id);
    } else if (onWaitlist.length > 0) {
      update.waitlistIds = remainingWaitlist;
    }
    tx.update(ref, update);
    return { status: "left" as const, session: s, promoted };
  });

  if (result.promoted) {
    const s = result.session;
    await notifyPlayer(db, result.promoted.data, {
      type: "session_waitlist_promoted",
      title: `You're in! ${sportEmoji(parseSportType(s.sportType))}`,
      body: `A spot opened up: you're now playing in ${sessionLabel(s)}.`,
      data: { sessionId },
    });
  }
  return result.promoted
    ? { status: result.status, promotedPlayerId: result.promoted.id }
    : { status: result.status };
}

// ─── cancelSession ──────────────────────────────────────

/** cancelSession({ sessionId }) -> { status: "cancelled" }. Host only; notifies attendees + waitlist. */
export const cancelSession = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const db = getFirestore();
  const sessionId = await resolveDocId(db, "playSessions", requireString(dataOf(req), "sessionId", 64));
  return cancelSessionFor(db, sessionId, uid);
});

/** Host (auth `uid`) cancels a session and attendees + waitlist are told. Shared by cancelSession and deleteAccount. */
export async function cancelSessionFor(db: Firestore, sessionId: string, uid: string): Promise<{ status: "cancelled" }> {
  const s = await db.runTransaction(async (tx) => {
    const ref = db.collection("playSessions").doc(sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "NOT_FOUND", "This session no longer exists.");
    const data = snap.data()!;
    if (data.hostId !== uid) fail("permission-denied", "NOT_HOST", "Only the host can cancel this session.");
    if (data.status === "cancelled") return null;
    if ((data.status ?? "active") !== "active") {
      fail("failed-precondition", "SESSION_CLOSED", "This session is no longer active.");
    }
    tx.update(ref, { status: "cancelled", cancelledAt: FieldValue.serverTimestamp() });
    return data;
  });

  if (s) {
    const hostPlayer = await playerForUid(db, uid);
    const recipients = [...idsOf(s.attendeeIds), ...idsOf(s.waitlistIds)]
      .filter((id) => !sameId(id, hostPlayer?.id));
    const seen = new Set<string>();
    for (const id of recipients) {
      if (seen.has(id.toUpperCase())) continue;
      seen.add(id.toUpperCase());
      const p = await playerById(db, id);
      await notifyPlayer(db, p?.data, {
        type: "session_cancelled",
        title: "Session Cancelled",
        body: `${sessionLabel(s)} was cancelled by the host.`,
        data: { sessionId },
      });
    }
  }
  return { status: "cancelled" };
}

// ─── finishSession ──────────────────────────────────────

/**
 * finishSession({ sessionId }) -> { status: "completed" }. Host only; an
 * active session becomes `status: "completed"` (what the apps write today).
 * The onSessionJoined trigger tells the attendees.
 */
export const finishSession = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const db = getFirestore();
  const sessionId = await resolveDocId(db, "playSessions", requireString(dataOf(req), "sessionId", 64));

  await db.runTransaction(async (tx) => {
    const ref = db.collection("playSessions").doc(sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "NOT_FOUND", "This session no longer exists.");
    const data = snap.data()!;
    if (data.hostId !== uid) fail("permission-denied", "NOT_HOST", "Only the host can finish this session.");
    if (data.status === "completed") return;
    if ((data.status ?? "active") !== "active") {
      fail("failed-precondition", "SESSION_CLOSED", "This session is no longer active.");
    }
    tx.update(ref, { status: "completed" });
  });
  return { status: "completed" as const };
});

// ─── deleteSession ──────────────────────────────────────

/** deleteSession({ sessionId }) -> { status: "deleted" }. Host only; already gone counts as deleted. */
export const deleteSession = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const db = getFirestore();
  const sessionId = await resolveDocId(db, "playSessions", requireString(dataOf(req), "sessionId", 64));

  await db.runTransaction(async (tx) => {
    const ref = db.collection("playSessions").doc(sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    if (snap.get("hostId") !== uid) fail("permission-denied", "NOT_HOST", "Only the host can delete this session.");
    tx.delete(ref);
  });
  return { status: "deleted" as const };
});
