import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { Firestore, Timestamp, Transaction, getFirestore } from "firebase-admin/firestore";
import { fail } from "./errors";
import { CALLABLE_OPTS, Data, dataOf, requireUid } from "./shared";
import { Loaded, isOrganizer, load } from "./scores";
import { playerById, playerForUid, resolveDocId } from "../services/identity";
import { MatchDoc, RegistrationDoc, TournamentDoc, parseSportType } from "../types";
import { SPORTS_CONFIG_COLLECTION, SPORTS_CONFIG_DOC_ID } from "../config/sportsCatalog";
import {
  StreamDoc, StreamProvider, countArg, endedStream, entriesOf, entryFor, isLive, isStale, isYouTubeVideoId,
  removeEntry, streamLabel, streamOf, streamingEnabled, tournamentPatch, upsertEntry, STREAM_PROVIDERS,
} from "../services/liveStream";

/**
 * Live video streaming callables (contract: live-stream-contract.md).
 * `startStream` / `heartbeatStream` / `endStream` keep `matches/{id}.stream`
 * and the tournament's `liveStreams` / `liveStreamCount` in step, in one
 * transaction each. Independent of live scoring (callables/racketLive.ts).
 * Stale streams are ended by `streamCleanup` (triggers/streamCleanup.ts);
 * a finishing match ends its stream in `commit` (callables/scores.ts).
 */

const DISABLED = "Live video isn't available for this sport yet.";
const ORGANIZER_ONLY = "Only the organizer can stream this match.";
const MAX_VIEWERS = 10_000_000;
const MAX_RECONNECTS = 100_000;
const MAX_BITRATE = 100_000;

function requireMatchId(d: Data): string {
  const id = d.matchId;
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || id.includes("/")) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Missing match.");
  }
  return id;
}

/** Heartbeat / end counters: `viewers`, `reconnects`, `bitrateKbps` (all optional). */
function counters(d: Data): { viewers?: number; reconnects?: number; bitrateKbps?: number } {
  const out: { viewers?: number; reconnects?: number; bitrateKbps?: number } = {};
  for (const [key, max] of [["viewers", MAX_VIEWERS], ["reconnects", MAX_RECONNECTS], ["bitrateKbps", MAX_BITRATE]] as const) {
    const v = countArg(d[key], max);
    if (v === null) fail("invalid-argument", "INVALID_ARGUMENT", `${key} must be a number of 0 or more.`);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** "Priya & Arjun": a team's name, else the players' first names. */
async function sideName(db: Firestore, tx: Transaction, reg: RegistrationDoc | null): Promise<string> {
  if (!reg) return "TBD";
  if (reg.teamName && reg.teamName.trim()) return reg.teamName.trim();
  const names: string[] = [];
  for (const id of [reg.playerId, reg.partnerId]) {
    if (!id) continue;
    const p = await playerById(db, id, tx);
    const first = (p?.data.name ?? "").trim().split(/\s+/)[0];
    if (first) names.push(first);
  }
  return names.join(" & ") || "TBD";
}

interface Ref {
  db: Firestore;
  tx: Transaction;
  matchId: string;
  match: MatchDoc;
  tournament: TournamentDoc | undefined;
  tournamentRef: FirebaseFirestore.DocumentReference | null;
}

/** Light read for heartbeat / end: the match and its tournament (no registrations). */
async function openLight(db: Firestore, tx: Transaction, matchId: string): Promise<Ref> {
  const snap = await tx.get(db.collection("matches").doc(matchId));
  if (!snap.exists) fail("not-found", "NOT_FOUND", "This match no longer exists.");
  const match = snap.data() as MatchDoc;
  const tournamentRef = match.tournamentId ?
    db.collection("tournaments").doc(await resolveDocId(db, "tournaments", match.tournamentId)) : null;
  const tSnap = tournamentRef ? await tx.get(tournamentRef) : null;
  return { db, tx, matchId, match, tournament: tSnap?.exists ? (tSnap.data() as TournamentDoc) : undefined, tournamentRef };
}

function organizerOf(t: TournamentDoc | undefined, uid: string): boolean {
  return !!t?.createdBy && t.createdBy === uid;
}

/** Streamer or organizer. */
function requireStreamer(r: Ref, s: StreamDoc, uid: string): void {
  if (s.byUid !== uid && !organizerOf(r.tournament, uid)) fail("permission-denied", "NOT_ORGANIZER", ORGANIZER_ONLY);
}

function writeTournament(r: Ref, next: (list: ReturnType<typeof entriesOf>) => ReturnType<typeof entriesOf>): void {
  if (!r.tournamentRef || !r.tournament) return;
  const before = entriesOf(r.tournament);
  const p = tournamentPatch(before, next(before), r.tournament);
  if (p.changed) r.tx.update(r.tournamentRef, p.fields);
}

function durationSec(s: StreamDoc): number {
  const end = s.endedAt?.toMillis() ?? Date.now();
  return Math.max(0, Math.round((end - (s.startedAt?.toMillis() ?? end)) / 1000));
}

// ─── startStream ────────────────────────────────────────

/**
 * startStream({ matchId, provider: "youtube", videoId, label? }) →
 * { status: "live", streamStatus: "started" | "resumed" | "restarted", videoId }.
 * Organizer only; badminton; the match not finished; the sport switched on in
 * `config/sports.liveStreaming` (for a new stream). One live stream per match:
 * the same streamer calling again resumes (same videoId) or restarts with a
 * new videoId; anyone else gets STREAM_ACTIVE (unless the stream is stale).
 */
export const startStream = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const provider = d.provider ?? "youtube";
  if (!(STREAM_PROVIDERS as readonly unknown[]).includes(provider)) {
    fail("invalid-argument", "INVALID_ARGUMENT", "This video service isn't supported. Update the app and try again.");
  }
  if (!isYouTubeVideoId(d.videoId)) {
    fail("invalid-argument", "INVALID_ARGUMENT", "That YouTube stream isn't valid. Try going live again.");
  }
  const videoId = d.videoId;

  const result = await db.runTransaction(async (tx) => {
    const l: Loaded = await load(db, tx, matchId);
    const sport = parseSportType(l.tournament.sportType);
    const configSnap = await tx.get(db.collection(SPORTS_CONFIG_COLLECTION).doc(SPORTS_CONFIG_DOC_ID));
    if (!isOrganizer(l, uid)) fail("permission-denied", "NOT_ORGANIZER", ORGANIZER_ONLY);
    const liveStatus = (l.match.live as { status?: unknown } | undefined)?.status;
    if (l.match.statusRaw !== "scheduled" || liveStatus === "finished") {
      fail("failed-precondition", "MATCH_FINISHED", "This match is already finished.");
    }
    const current = streamOf(l.match);
    const now = Timestamp.now();
    const r: Ref = {
      db, tx, matchId, match: l.match, tournament: l.tournament,
      tournamentRef: db.collection("tournaments").doc(l.tournamentDocId),
    };
    const names = { a: await sideName(db, tx, l.regA), b: await sideName(db, tx, l.regB) };

    if (isLive(current) && (current.byUid === uid || !isStale(current, now.toMillis()))) {
      if (current.byUid !== uid) {
        fail("failed-precondition", "STREAM_ACTIVE", `${current.byName} is streaming this match.`);
      }
      // Same streamer: resume (same video) or restart with a new broadcast.
      const restarted = current.videoId !== videoId;
      const next: StreamDoc = restarted ?
        { ...current, provider: provider as StreamProvider, videoId, startedAt: now, lastHeartbeatAt: now,
          viewers: 0, peakViewers: 0, reconnects: 0 } :
        { ...current, lastHeartbeatAt: now };
      delete next.bitrateKbps;
      tx.update(db.collection("matches").doc(matchId), { stream: next });
      writeTournament(r, (list) => upsertEntry(list, entryFor(matchId, next, names)));
      return { streamStatus: restarted ? "restarted" : "resumed", stream: next };
    }

    if (!streamingEnabled(configSnap.data(), sport)) fail("failed-precondition", "LIVE_STREAMING_DISABLED", DISABLED);
    const me = await playerForUid(db, uid, tx);
    const stream: StreamDoc = {
      provider: provider as StreamProvider, videoId, status: "live", label: streamLabel(d.label, l.match),
      byUid: uid, byName: me?.data.name || "The organizer", startedAt: now, lastHeartbeatAt: now,
      viewers: 0, peakViewers: 0, reconnects: 0,
    };
    tx.update(db.collection("matches").doc(matchId), { stream });
    writeTournament(r, (list) => upsertEntry(list, entryFor(matchId, stream, names)));
    return { streamStatus: "started", stream };
  });
  logger.info(`startStream ${matchId}: ${result.streamStatus} ${result.stream.videoId}`);
  return { status: "live", streamStatus: result.streamStatus, videoId: result.stream.videoId, label: result.stream.label };
});

// ─── heartbeatStream ────────────────────────────────────

/**
 * heartbeatStream({ matchId, viewers?, bitrateKbps?, reconnects? }) →
 * { status: "live", viewers, peakViewers, reconnects }. About every 60 s
 * from the streaming phone. `reconnects` is the phone's running total (the
 * stored value never goes down). The tournament entry is written only when
 * its viewer count changes. A stream that has ended → STREAM_ENDED (the
 * phone stops broadcasting).
 */
export const heartbeatStream = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const c = counters(d);
  return db.runTransaction(async (tx) => {
    const r = await openLight(db, tx, matchId);
    const s = streamOf(r.match);
    if (!s) fail("failed-precondition", "STREAM_ENDED", "This match isn't being streamed.");
    requireStreamer(r, s, uid);
    if (!isLive(s)) fail("failed-precondition", "STREAM_ENDED", "This stream has ended.");
    const viewers = c.viewers ?? s.viewers ?? 0;
    const next: StreamDoc = {
      ...s,
      lastHeartbeatAt: Timestamp.now(),
      viewers,
      peakViewers: Math.max(s.peakViewers ?? 0, viewers),
      reconnects: Math.max(s.reconnects ?? 0, c.reconnects ?? 0),
      ...(c.bitrateKbps !== undefined ? { bitrateKbps: c.bitrateKbps } : {}),
    };
    tx.update(db.collection("matches").doc(matchId), { stream: next });
    // Only the viewer count (or a missing entry) touches the tournament doc.
    writeTournament(r, (list) => {
      const mine = list.find((e) => e.matchId === matchId);
      if (mine && mine.viewers === viewers && mine.videoId === next.videoId) return list;
      const names = { a: mine?.teamAName ?? "", b: mine?.teamBName ?? "" };
      return upsertEntry(list, entryFor(matchId, next, names));
    });
    return { status: "live", viewers: next.viewers, peakViewers: next.peakViewers, reconnects: next.reconnects };
  });
});

// ─── endStream ──────────────────────────────────────────

/**
 * endStream({ matchId, viewers?, reconnects?, bitrateKbps? }) →
 * { status: "ended", alreadyEnded, endedReason, durationSec, peakViewers, reconnects }.
 * Streamer or organizer. Idempotent: no stream or already ended →
 * `alreadyEnded: true`, nothing written. Optional final counters as in a heartbeat.
 */
export const endStream = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const c = counters(d);
  const out = await db.runTransaction(async (tx) => {
    const r = await openLight(db, tx, matchId);
    const s = streamOf(r.match);
    if (!s) {
      if (!organizerOf(r.tournament, uid)) fail("permission-denied", "NOT_ORGANIZER", ORGANIZER_ONLY);
      return { alreadyEnded: true, stream: null };
    }
    requireStreamer(r, s, uid);
    if (!isLive(s)) return { alreadyEnded: true, stream: s };
    const viewers = c.viewers ?? s.viewers ?? 0;
    const ended = endedStream({
      ...s, viewers,
      peakViewers: Math.max(s.peakViewers ?? 0, viewers),
      reconnects: Math.max(s.reconnects ?? 0, c.reconnects ?? 0),
      ...(c.bitrateKbps !== undefined ? { bitrateKbps: c.bitrateKbps } : {}),
    }, "organizer", Timestamp.now());
    tx.update(db.collection("matches").doc(matchId), { stream: ended });
    writeTournament(r, (list) => removeEntry(list, matchId));
    return { alreadyEnded: false, stream: ended };
  });
  const s = out.stream;
  if (!out.alreadyEnded) logger.info(`endStream ${matchId}: ${s ? durationSec(s) : 0}s`);
  return {
    status: "ended",
    alreadyEnded: out.alreadyEnded,
    endedReason: s?.endedReason ?? null,
    durationSec: s ? durationSec(s) : 0,
    peakViewers: s?.peakViewers ?? 0,
    reconnects: s?.reconnects ?? 0,
  };
});
