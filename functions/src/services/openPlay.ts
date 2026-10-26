import { DocumentData, Firestore, QueryDocumentSnapshot, Timestamp, Transaction } from "firebase-admin/firestore";

/**
 * Open Play rules shared by the session triggers (old-app clean-up) and the
 * Open Play callables. Pure helpers plus a couple of query helpers; nothing
 * here writes.
 *
 * Session docs: `date` (start), `durationMinutes` (optional on docs written
 * by older apps), `endsAt` (server-set by newer code), `gameType` (stored
 * raw game type: singles / doubles / mixed / any), `status`
 * (active / cancelled / completed / flagged), `attendeeIds` (UPPERCASE
 * player ids), `hostId` (host auth uid).
 */

/** Duration assumed for sessions without one (older apps allowed open-ended). */
export const LEGACY_DURATION_MINUTES = 120;
/** Alias used by the callables. */
export const LEGACY_SESSION_MINUTES = LEGACY_DURATION_MINUTES;

/** Most upcoming active sessions one host may have at a time. */
export const MAX_UPCOMING_HOSTED_SESSIONS = 3;

/** Mixed sessions: at most this many men and this many women. */
export const MIXED_SLOTS_PER_GENDER = 2;

/**
 * How far before a window we look for sessions that could still be running
 * in it. Sessions are at most a few hours long; a day is a safe margin.
 */
const CLASH_LOOKBACK_MS = 24 * 60 * 60 * 1000;

type DateLike = Timestamp | Date | { toDate(): Date } | null | undefined;

/** Loose session shape: works for raw Firestore data and typed docs. */
export interface SessionLike {
  date?: DateLike;
  endsAt?: DateLike;
  durationMinutes?: number | null;
  status?: string | null;
  gameType?: string | null;
  gameTypeRaw?: string | null;
  createdAt?: DateLike;
}

export interface SessionWindow {
  start: Date;
  end: Date;
}

/** A session that overlaps a window, with what a clash message needs. */
export interface ClashingSession {
  id: string;
  title: string;
  venue: string;
  start: Date;
  end: Date;
  timeZone?: string;
  hostId?: string;
}

export function toDate(value: DateLike): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate(): Date }).toDate();
  }
  return null;
}

/**
 * Start and end of a session. `endsAt` wins when present (and after the
 * start); otherwise `date + durationMinutes`, with a missing / non-positive
 * duration treated as LEGACY_DURATION_MINUTES. A session without a start
 * date gets the epoch as its start (so it never clashes with real sessions).
 */
export function sessionWindow(session: SessionLike | DocumentData): SessionWindow {
  const start = toDate(session.date) ?? new Date(0);
  const endsAt = toDate(session.endsAt);
  if (endsAt && endsAt.getTime() > start.getTime()) return { start, end: endsAt };
  const minutes = typeof session.durationMinutes === "number" && session.durationMinutes > 0
    ? session.durationMinutes
    : LEGACY_DURATION_MINUTES;
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
}

/** Half-open overlap: back-to-back sessions (one ends as the next starts) don't clash. */
export function windowsOverlap(a: SessionWindow, b: SessionWindow): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** The stored game type (`gameType`; `gameTypeRaw` accepted too). Missing means "any". */
export function sessionGameType(session: SessionLike): string {
  return session.gameType || session.gameTypeRaw || "any";
}

/** Player cap by game type: singles 2, everything else (doubles, mixed, any) 4. */
export function capacityFor(gameTypeRaw: unknown): number {
  return gameTypeRaw === "singles" ? 2 : 4;
}

/** Missing status counts as active (older docs). */
export function isActiveSession(session: SessionLike): boolean {
  return (session.status ?? "active") === "active";
}

/** Gender for mixed slots, or null when unknown / prefer not to say. */
export function mixedGender(genderRaw: string | null | undefined): "male" | "female" | null {
  return genderRaw === "male" || genderRaw === "female" ? genderRaw : null;
}

/**
 * Mixed sessions: which of `newIds` overflow their gender's slots. Attendees
 * already in the session keep their places; new ones are taken in attendee
 * order and overflow once their gender has MIXED_SLOTS_PER_GENDER players.
 * Players without a known gender never overflow here.
 */
export function mixedOverflowIds(
  attendees: Array<{ id: string; gender: string | null | undefined }>,
  newIds: string[],
): string[] {
  const isNew = new Set(newIds);
  const counts = { male: 0, female: 0 };
  for (const a of attendees) {
    const g = mixedGender(a.gender);
    if (g && !isNew.has(a.id)) counts[g] += 1;
  }
  const overflow: string[] = [];
  for (const a of attendees) {
    if (!isNew.has(a.id)) continue;
    const g = mixedGender(a.gender);
    if (!g) continue;
    if (counts[g] >= MIXED_SLOTS_PER_GENDER) {
      overflow.push(a.id);
    } else {
      counts[g] += 1;
    }
  }
  return overflow;
}

/**
 * Stable "which came first" order for sessions: by createdAt, then id.
 * Sessions without createdAt sort first (they are the oldest docs).
 */
export function createdBefore(
  a: { id: string; createdAt?: DateLike },
  b: { id: string; createdAt?: DateLike },
): boolean {
  const ta = toDate(a.createdAt)?.getTime() ?? 0;
  const tb = toDate(b.createdAt)?.getTime() ?? 0;
  return ta !== tb ? ta < tb : a.id < b.id;
}

/** "Sat, Jun 1 at 6:00 PM" in the session's time zone (UTC if unknown). */
export function formatSessionTime(date: Date, timeZone?: string | null): string {
  const tz = timeZone || "UTC";
  try {
    const day = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
    return `${day} at ${time}`;
  } catch {
    return formatSessionTime(date, "UTC");
  }
}

/** What a clash message needs from a session doc. */
export function toClashingSession(doc: { id: string; data(): DocumentData | undefined }): ClashingSession {
  const data = doc.data() ?? {};
  const w = sessionWindow(data);
  return {
    id: doc.id,
    title: (data.title as string) || "Open Play",
    venue: (data.venue as string) || "",
    start: w.start,
    end: w.end,
    timeZone: data.timeZone as string | undefined,
    hostId: data.hostId as string | undefined,
  };
}

/** Upper, lower and given case of a player id (attendeeIds may hold either). */
function idVariants(playerId: string): string[] {
  return [...new Set([playerId, playerId.toUpperCase(), playerId.toLowerCase()])];
}

/**
 * Active sessions the player is in (attendeeIds, id in either case) whose
 * window overlaps [start, end), excluding `excludeSessionId`, earliest
 * first. Pass `tx` to read inside a transaction. Needs the
 * playSessions(attendeeIds CONTAINS, date ASC) index. Use
 * `toClashingSession` for venue / time.
 */
export async function findClashingSessions(
  db: Firestore,
  playerId: string,
  start: Date,
  end: Date,
  excludeSessionId?: string | null,
  tx?: Transaction,
): Promise<QueryDocumentSnapshot[]> {
  const q = db
    .collection("playSessions")
    .where("attendeeIds", "array-contains-any", idVariants(playerId))
    .where("date", ">=", Timestamp.fromMillis(start.getTime() - CLASH_LOOKBACK_MS))
    .where("date", "<", Timestamp.fromDate(end));
  const snap = tx ? await tx.get(q) : await q.get();
  const window = { start, end };
  return snap.docs
    .filter((doc) => {
      if (doc.id === excludeSessionId) return false;
      const data = doc.data();
      return isActiveSession(data) && toDate(data.date) !== null && windowsOverlap(sessionWindow(data), window);
    })
    .sort((a, b) => sessionWindow(a.data()).start.getTime() - sessionWindow(b.data()).start.getTime());
}

/**
 * Active sessions hosted by `hostUid` that haven't ended by `now` (so both
 * upcoming and running ones), earliest first. Needs the
 * playSessions(hostId ASC, date ASC) index.
 */
export async function findHostedActiveSessions(
  db: Firestore,
  hostUid: string,
  now: Date = new Date(),
): Promise<Array<ClashingSession & { createdAt?: Date }>> {
  const snap = await db
    .collection("playSessions")
    .where("hostId", "==", hostUid)
    .where("date", ">=", Timestamp.fromMillis(now.getTime() - CLASH_LOOKBACK_MS))
    .get();
  const out: Array<ClashingSession & { createdAt?: Date }> = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!isActiveSession(data)) continue;
    const s = toClashingSession(doc);
    if (s.end.getTime() <= now.getTime()) continue;
    out.push({ ...s, createdAt: toDate(data.createdAt) ?? undefined });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
