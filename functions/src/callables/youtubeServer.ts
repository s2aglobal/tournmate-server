import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { fail } from "./errors";
import { CALLABLE_OPTS, dataOf, requireUid } from "./shared";
import { isOrganizer, load } from "./scores";
import { requireCanStream, requireMatchId, sideName } from "./liveStream";
import { resolveDocId } from "../services/identity";
import { TournamentDoc, parseSportType } from "../types";
import { SPORTS_CONFIG_COLLECTION, SPORTS_CONFIG_DOC_ID } from "../config/sportsCatalog";
import { courtArg, isLive, isStale, streamLabel, streamOf, streamingEnabled } from "../services/liveStream";
import { crewOf } from "../services/crew";
import {
  PRIVATE_YOUTUBE, PrivateYouTubeDoc, SERVER_BROADCASTS, ServerBroadcastDoc, YOUTUBE_SECRETS, broadcastDescription,
  broadcastTitle, createBroadcast, exchangeCode, loadRefreshToken, myChannel, organizerAccessToken, revokeToken,
  storeConnection, takeBroadcastSlot,
} from "../services/youtubeServer";

/**
 * Server-held YouTube connection + crew broadcasts (contract:
 * live-stream-contract.md "Tournament crew"; services/youtubeServer.ts).
 */

const OPTS = { ...CALLABLE_OPTS, secrets: YOUTUBE_SECRETS };

// ─── connectYouTubeServer ───────────────────────────────

/**
 * connectYouTubeServer({ authCode }) → { connected: true, channelId, channelTitle }.
 * `authCode`: the Google Sign-In server auth code requested with the
 * `https://www.googleapis.com/auth/youtube` scope for the OAuth web client.
 * Replaces (and revokes) an earlier connection of the caller.
 */
export const connectYouTubeServer = onCall(OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const code = d.authCode;
  if (typeof code !== "string" || code.trim().length === 0 || code.length > 2048) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Missing authCode.");
  }
  const db = getFirestore();
  const tokens = await exchangeCode(code.trim());
  let channel: { channelId: string; channelTitle: string };
  try {
    channel = await myChannel(tokens.accessToken);
  } catch (err) {
    await revokeToken(tokens.refreshToken);
    throw err;
  }
  const previous = await storeConnection(db, uid, tokens.refreshToken, tokens.scope, channel);
  if (previous) await revokeToken(previous);
  logger.info(`connectYouTubeServer ${uid}: channel ${channel.channelId}`);
  return { connected: true, channelId: channel.channelId, channelTitle: channel.channelTitle };
});

// ─── disconnectYouTubeServer ────────────────────────────

/**
 * disconnectYouTubeServer() → { disconnected, revoked }. Revokes the stored
 * refresh token at Google and deletes it. `disconnected: false` when nothing
 * was stored. Streams already running keep running (their phones hold the
 * stream key) but the server can no longer complete them on YouTube.
 */
export const disconnectYouTubeServer = onCall(OPTS, async (req) => {
  const uid = requireUid(req);
  const db = getFirestore();
  const ref = db.collection(PRIVATE_YOUTUBE).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return { disconnected: false, revoked: false };
  const stored = await loadRefreshToken(db, uid);
  const revoked = stored ? await revokeToken(stored.token) : false;
  await ref.delete();
  logger.info(`disconnectYouTubeServer ${uid}: revoked=${revoked}`);
  return { disconnected: true, revoked };
});

// ─── getYouTubeConnection ───────────────────────────────

/**
 * getYouTubeConnection({ tournamentId? }) →
 * { connected, needsReconnect, channelId?, channelTitle?, connectedAt? (epoch ms) }.
 * Without `tournamentId`: the caller's own connection. With it: the
 * tournament organizer's (caller must be the organizer or in its crew), so a
 * crew member's app can say "Streams go to <channel>" or "Ask the organizer
 * to connect YouTube". No Google call.
 */
export const getYouTubeConnection = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  let owner = uid;
  if (d.tournamentId !== undefined && d.tournamentId !== null) {
    if (typeof d.tournamentId !== "string" || !d.tournamentId || d.tournamentId.includes("/") || d.tournamentId.length > 128) {
      fail("invalid-argument", "INVALID_ARGUMENT", "Missing tournament.");
    }
    const tSnap = await db.collection("tournaments").doc(await resolveDocId(db, "tournaments", d.tournamentId)).get();
    if (!tSnap.exists) fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
    const t = tSnap.data() as TournamentDoc;
    if (t.createdBy !== uid && !crewOf(t)[uid]) fail("permission-denied", "NOT_ORGANIZER", "Only the organizer and the crew can see this.");
    owner = t.createdBy ?? "";
  }
  const snap = owner ? await db.collection(PRIVATE_YOUTUBE).doc(owner).get() : null;
  if (!snap?.exists) return { connected: false, needsReconnect: false };
  const doc = snap.data() as PrivateYouTubeDoc;
  return {
    connected: true, needsReconnect: !!doc.needsReconnectAt, channelId: doc.channelId, channelTitle: doc.channelTitle,
    connectedAt: doc.connectedAt?.toMillis?.() ?? null,
  };
});

// ─── createCrewBroadcast ────────────────────────────────

/**
 * createCrewBroadcast({ matchId, court?, label? }) →
 * { broadcastId, streamId, videoId, rtmpUrl, streamKey, channelTitle }.
 * Organizer or joined camera crew member. Creates an unlisted broadcast on the
 * ORGANIZER's YouTube channel (server-held token) + an RTMP stream, binds
 * them, and records it in `serverBroadcasts`. The phone then publishes RTMP to
 * `rtmpUrl` + `streamKey` and calls startStream with `videoId`.
 * Checks before spending YouTube quota: can stream, sport on, match not
 * finished, no one else streaming the match; at most 10 per caller per hour.
 */
export const createCrewBroadcast = onCall(OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const db = getFirestore();
  const matchId = await resolveDocId(db, "matches", requireMatchId(d));
  const court = courtArg(d.court);
  if (court === null) fail("invalid-argument", "INVALID_ARGUMENT", "Pick a court from 1 to 20.");

  const ctx = await db.runTransaction(async (tx) => {
    const l = await load(db, tx, matchId);
    const configSnap = await tx.get(db.collection(SPORTS_CONFIG_COLLECTION).doc(SPORTS_CONFIG_DOC_ID));
    requireCanStream(l.tournament, uid);
    if (!streamingEnabled(configSnap.data(), parseSportType(l.tournament.sportType))) {
      fail("failed-precondition", "LIVE_STREAMING_DISABLED", "Live video isn't available for this sport yet.");
    }
    const liveStatus = (l.match.live as { status?: unknown } | undefined)?.status;
    if (l.match.statusRaw !== "scheduled" || liveStatus === "finished") {
      fail("failed-precondition", "MATCH_FINISHED", "This match is already finished.");
    }
    const current = streamOf(l.match);
    if (isLive(current) && current.byUid !== uid && !isStale(current, Date.now())) {
      fail("failed-precondition", "STREAM_ACTIVE", `${current.byName} is streaming this match.`);
    }
    return {
      organizerUid: l.tournament.createdBy ?? "",
      organizer: isOrganizer(l, uid),
      tournamentId: l.tournamentDocId,
      tournamentTitle: l.tournament.title ?? "",
      label: streamLabel(d.label, l.match),
      teamA: await sideName(db, tx, l.regA),
      teamB: await sideName(db, tx, l.regB),
    };
  }, { readOnly: true });

  const access = await organizerAccessToken(db, ctx.organizerUid, ctx.organizer);
  await takeBroadcastSlot(db, uid);
  const label = court !== undefined ? `Court ${court} · ${ctx.label}` : ctx.label;
  const b = await createBroadcast(access, broadcastTitle(label, ctx.teamA, ctx.teamB, ctx.tournamentTitle),
    broadcastDescription(ctx.tournamentTitle), ctx.organizer);
  const record: ServerBroadcastDoc = {
    broadcastId: b.broadcastId, streamId: b.streamId, matchId, tournamentId: ctx.tournamentId,
    organizerUid: ctx.organizerUid, createdByUid: uid, createdAt: Timestamp.now(), open: true,
  };
  await db.collection(SERVER_BROADCASTS).doc(b.broadcastId).set(record);
  const channel = (await db.collection(PRIVATE_YOUTUBE).doc(ctx.organizerUid).get()).get("channelTitle");
  logger.info(`createCrewBroadcast ${matchId}: ${b.broadcastId} by ${uid} on ${ctx.organizerUid}'s channel`);
  return {
    broadcastId: b.broadcastId, streamId: b.streamId, videoId: b.videoId, rtmpUrl: b.rtmpUrl, streamKey: b.streamKey,
    channelTitle: typeof channel === "string" ? channel : "",
  };
});
