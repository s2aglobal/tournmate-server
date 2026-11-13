import { logger } from "firebase-functions/v2";
import { DocumentReference, Firestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { MatchDoc, TournamentDoc } from "../types";
import { resolveDocId } from "./identity";

/**
 * Live video streaming (badminton first; contract: live-stream-contract.md).
 *
 * The organizer's phone creates an unlisted YouTube broadcast and tells us
 * its `videoId`; the server never sees Google tokens. Server-written state:
 * - `matches/{id}.stream`: the match's stream, kept after it ends (replay).
 * - `tournaments/{id}.liveStreams` / `liveStreamCount`: the ACTIVE streams
 *   only, so the Play tab card and the tournament page need no extra query.
 *
 * Every change to a stream updates both in one transaction (start, heartbeat,
 * end, match finish, stale cleanup).
 */

export const STREAM_PROVIDERS = ["youtube"] as const;
export type StreamProvider = (typeof STREAM_PROVIDERS)[number];
export const STREAMING_SPORTS: readonly string[] = ["badminton"];

/** A stream with no heartbeat for this long is ended by the cleanup job (`endedReason: "stale"`). */
export const STREAM_STALE_MS = 10 * 60 * 1000;
/** The apps send a heartbeat about this often. */
export const STREAM_HEARTBEAT_MS = 60 * 1000;

export type EndedReason = "organizer" | "stale" | "match_finished";

/** `matches/{id}.stream`. */
export interface StreamDoc {
  provider: StreamProvider;
  videoId: string;
  status: "live" | "ended";
  label: string;
  byUid: string;
  byName: string;
  startedAt: Timestamp;
  lastHeartbeatAt: Timestamp;
  endedAt?: Timestamp;
  endedReason?: EndedReason;
  viewers: number;
  peakViewers: number;
  reconnects: number;
  bitrateKbps?: number;
}

/** One entry of `tournaments/{id}.liveStreams` (active streams only). */
export interface LiveStreamEntry {
  matchId: string;
  videoId: string;
  label: string;
  teamAName: string;
  teamBName: string;
  viewers: number;
  startedAt: Timestamp;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function isYouTubeVideoId(v: unknown): v is string {
  return typeof v === "string" && YOUTUBE_ID.test(v);
}

export function streamOf(match: MatchDoc | undefined): StreamDoc | null {
  const s = match?.stream as StreamDoc | undefined;
  return s && typeof s === "object" && typeof s.status === "string" && typeof s.videoId === "string" ? s : null;
}

export function isLive(s: StreamDoc | null): s is StreamDoc {
  return !!s && s.status === "live";
}

/** Time of the last sign of life (heartbeat, else start). */
export function lastSeenMs(s: StreamDoc): number {
  return (s.lastHeartbeatAt ?? s.startedAt)?.toMillis?.() ?? 0;
}

export function isStale(s: StreamDoc, nowMs: number): boolean {
  return nowMs - lastSeenMs(s) >= STREAM_STALE_MS;
}

/** The sports switched on in `config/sports.liveStreaming` (absent = off). */
export function streamingEnabled(config: Record<string, unknown> | undefined, sport: string): boolean {
  const map = config?.liveStreaming;
  return STREAMING_SPORTS.includes(sport) && !!map && typeof map === "object" &&
    (map as Record<string, unknown>)[sport] === true;
}

/**
 * Short label for chips and the card ("SF1"). The app sends the label it
 * shows on the match card; otherwise the group or round.
 */
export function streamLabel(requested: unknown, match: MatchDoc): string {
  if (typeof requested === "string") {
    const t = requested.trim().replace(/\s+/g, " ");
    if (t.length > 0) return t.slice(0, 16);
  }
  if (match.groupLabel) return `Group ${match.groupLabel}`;
  if (typeof match.round === "number") return `Round ${match.round}`;
  return "Match";
}

/** Non-negative integer from a heartbeat field (undefined when absent). */
export function countArg(v: unknown, max: number): number | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.min(Math.floor(v), max);
}

/** The stream map after it ends. */
export function endedStream(s: StreamDoc, reason: EndedReason, now: Timestamp): StreamDoc {
  return { ...s, status: "ended", endedAt: now, endedReason: reason };
}

export function entriesOf(t: TournamentDoc | undefined): LiveStreamEntry[] {
  const list = t?.liveStreams;
  return Array.isArray(list) ?
    list.filter((e): e is LiveStreamEntry & Record<string, unknown> => !!e && typeof e.matchId === "string") as LiveStreamEntry[] :
    [];
}

/** Entries with `entry` replacing any for its match, oldest stream first (stable chip order). */
export function upsertEntry(list: LiveStreamEntry[], entry: LiveStreamEntry): LiveStreamEntry[] {
  return [...list.filter((e) => e.matchId !== entry.matchId), entry]
    .sort((a, b) => (a.startedAt?.toMillis?.() ?? 0) - (b.startedAt?.toMillis?.() ?? 0));
}

export function removeEntry(list: LiveStreamEntry[], matchId: string): LiveStreamEntry[] {
  return list.filter((e) => e.matchId !== matchId);
}

/** Tournament fields for a list (only call update when `changed`). */
export function tournamentPatch(before: LiveStreamEntry[], after: LiveStreamEntry[], t: TournamentDoc | undefined):
  { changed: boolean; fields: { liveStreams: LiveStreamEntry[]; liveStreamCount: number } } {
  const fields = { liveStreams: after, liveStreamCount: after.length };
  const changed = JSON.stringify(before) !== JSON.stringify(after) || t?.liveStreamCount !== after.length ||
    !Array.isArray(t?.liveStreams);
  return { changed, fields };
}

export function entryFor(matchId: string, s: StreamDoc, names: { a: string; b: string }): LiveStreamEntry {
  return {
    matchId, videoId: s.videoId, label: s.label, teamAName: names.a, teamBName: names.b, viewers: s.viewers,
    startedAt: s.startedAt,
  };
}

/** Writes the tournament's list without `matchId` when it differs. All reads done by the caller. */
export function dropFromTournament(tx: Transaction, ref: DocumentReference | null, t: TournamentDoc | undefined, matchId: string): void {
  if (!ref || !t) return;
  const before = entriesOf(t);
  const p = tournamentPatch(before, removeEntry(before, matchId), t);
  if (p.changed && before.some((e) => e.matchId === matchId)) tx.update(ref, p.fields);
}

/**
 * Ends the match's live stream in its own transaction when `when(match,
 * stream)` holds (re-checked on fresh data). Used by the match trigger
 * (older apps finishing by direct write) and the cleanup job. Returns
 * whether it ended one.
 */
export async function endStreamForMatch(
  db: Firestore,
  matchId: string,
  reason: EndedReason,
  when: (match: MatchDoc, s: StreamDoc) => boolean = () => true,
): Promise<boolean> {
  const ref = db.collection("matches").doc(matchId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const match = snap.data() as MatchDoc | undefined;
    const s = streamOf(match);
    if (!match || !isLive(s) || !when(match, s)) return false;
    const tRef = match.tournamentId ?
      db.collection("tournaments").doc(await resolveDocId(db, "tournaments", match.tournamentId)) : null;
    const tSnap = tRef ? await tx.get(tRef) : null;
    tx.update(ref, { stream: endedStream(s, reason, Timestamp.now()) });
    dropFromTournament(tx, tRef, tSnap?.exists ? (tSnap.data() as TournamentDoc) : undefined, matchId);
    return true;
  });
}

/** Removes a deleted match's entry from its tournament (match trigger). */
export async function dropDeletedMatch(db: Firestore, tournamentId: string, matchId: string): Promise<void> {
  const ref = db.collection("tournaments").doc(await resolveDocId(db, "tournaments", tournamentId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) dropFromTournament(tx, ref, snap.data() as TournamentDoc, matchId);
  });
}

export interface CleanupResult {
  stale: number;
  finished: number;
  dropped: number;
}

/**
 * The cleanup job (every 5 minutes; `now` is injectable for tests):
 * 1. live streams with no heartbeat for 10 minutes → ended `stale`; live
 *    streams on a finished match → ended `match_finished` (catch-up);
 * 2. tournaments with `liveStreamCount > 0`: entries whose match is gone or
 *    no longer streams that video are dropped.
 */
export async function runStreamCleanup(db: Firestore, now: Date): Promise<CleanupResult> {
  const nowMs = now.getTime();
  const out: CleanupResult = { stale: 0, finished: 0, dropped: 0 };
  const live = await db.collection("matches").where("stream.status", "==", "live").get();
  for (const doc of live.docs) {
    try {
      if (await endStreamForMatch(db, doc.id, "match_finished", (m) => m.statusRaw === "finished")) {
        out.finished++;
      } else if (await endStreamForMatch(db, doc.id, "stale", (_m, s) => isStale(s, nowMs))) {
        out.stale++;
      }
    } catch (err) {
      logger.error(`streamCleanup: ending ${doc.id} failed`, err);
    }
  }
  const streaming = await db.collection("tournaments").where("liveStreamCount", ">", 0).get();
  for (const t of streaming.docs) {
    try {
      out.dropped += await db.runTransaction(async (tx) => {
        const snap = await tx.get(t.ref);
        if (!snap.exists) return 0;
        const data = snap.data() as TournamentDoc;
        const before = entriesOf(data);
        const keep: LiveStreamEntry[] = [];
        for (const e of before) {
          const m = await tx.get(db.collection("matches").doc(e.matchId));
          const s = streamOf(m.data() as MatchDoc | undefined);
          if (isLive(s) && s.videoId === e.videoId) keep.push(e);
        }
        const p = tournamentPatch(before, keep, data);
        if (p.changed) tx.update(t.ref, p.fields);
        return before.length - keep.length;
      });
    } catch (err) {
      logger.error(`streamCleanup: reconciling tournament ${t.id} failed`, err);
    }
  }
  if (out.stale || out.finished || out.dropped) logger.info(`streamCleanup: ${JSON.stringify(out)}`);
  return out;
}
