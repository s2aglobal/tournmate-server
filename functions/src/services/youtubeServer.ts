import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import { fail } from "../callables/errors";
import { MatchDoc } from "../types";
import { isLive, streamOf } from "./liveStream";

/**
 * Server-held YouTube connection (Tournament crew; contract:
 * live-stream-contract.md "Tournament crew").
 *
 * The organizer's app sends a Google Sign-In server auth code (YouTube
 * scope); we exchange it for a refresh token, encrypt it (AES-256-GCM) and
 * keep it in `private_youtube/{uid}` (deny-all in firestore.rules). A camera
 * crew member's phone then asks `createCrewBroadcast` for a broadcast on the
 * ORGANIZER's channel and gets back only the ingest URL + stream key: the
 * helper never needs a YouTube account or sees the organizer's login.
 *
 * Every broadcast the server creates is recorded in
 * `serverBroadcasts/{broadcastId}` (deny-all) so `startStream` can tell a
 * server broadcast from one the phone made itself, and so the server
 * completes it on YouTube when the stream ends (endStream, crew removal, or
 * the 5-minute sweep for stale / finished / never-started ones).
 *
 * Google HTTP calls go through `deps().fetch`; the emulator checks inject a
 * fake (`setYouTubeDepsForTests`) and never reach Google.
 */

export const YOUTUBE_OAUTH_CLIENT_ID = defineSecret("YOUTUBE_OAUTH_CLIENT_ID");
export const YOUTUBE_OAUTH_CLIENT_SECRET = defineSecret("YOUTUBE_OAUTH_CLIENT_SECRET");
export const YOUTUBE_TOKEN_KEY = defineSecret("YOUTUBE_TOKEN_KEY");
/** Bind these to every function that talks to Google with the organizer's token. */
export const YOUTUBE_SECRETS = [YOUTUBE_OAUTH_CLIENT_ID, YOUTUBE_OAUTH_CLIENT_SECRET, YOUTUBE_TOKEN_KEY];

export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";
export const PRIVATE_YOUTUBE = "private_youtube";
export const SERVER_BROADCASTS = "serverBroadcasts";
export const BROADCAST_RATE = "serverBroadcastRate";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/youtube/v3/";

/** Broadcasts one caller may create per hour (each costs ~150 of the project's 10,000 daily quota units). */
export const MAX_BROADCASTS_PER_HOUR = 10;
/** A server broadcast whose stream never started is cleaned up after this long. */
export const UNSTARTED_BROADCAST_MS = 30 * 60 * 1000;
/** After this many failed attempts the record is closed with `closeResult: "failed"`. */
export const MAX_CLOSE_ATTEMPTS = 6;

// ─── Injectable dependencies ────────────────────────────

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type FetchFn = (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) =>
  Promise<HttpResponse>;

export interface YouTubeDeps {
  fetch: FetchFn;
  clientId: () => string;
  clientSecret: () => string;
  tokenKey: () => string;
}

const secretValue = (s: ReturnType<typeof defineSecret>) => (): string => {
  try {
    return s.value();
  } catch {
    return "";
  }
};

const defaultDeps: YouTubeDeps = {
  fetch: (url, init) => fetch(url, init) as unknown as Promise<HttpResponse>,
  clientId: secretValue(YOUTUBE_OAUTH_CLIENT_ID),
  clientSecret: secretValue(YOUTUBE_OAUTH_CLIENT_SECRET),
  tokenKey: secretValue(YOUTUBE_TOKEN_KEY),
};
let current: YouTubeDeps = defaultDeps;

export function deps(): YouTubeDeps {
  return current;
}

/** Emulator checks only: swap Google HTTP and secrets (null restores the defaults). */
export function setYouTubeDepsForTests(d: YouTubeDeps | null): void {
  current = d ?? defaultDeps;
}

const NOT_CONFIGURED = "YouTube live streaming isn't set up on the server yet.";

function config(): { clientId: string; clientSecret: string; key: Buffer } {
  const d = deps();
  const clientId = d.clientId();
  const clientSecret = d.clientSecret();
  const raw = d.tokenKey();
  if (!clientId || !clientSecret || !raw) fail("failed-precondition", "YOUTUBE_NOT_CONFIGURED", NOT_CONFIGURED);
  return { clientId, clientSecret, key: tokenKey(raw) };
}

/** 32-byte key: the secret as base64 of 32 bytes (`openssl rand -base64 32`), else SHA-256 of it. */
export function tokenKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const b = Buffer.from(trimmed, "base64");
  return b.length === 32 ? b : createHash("sha256").update(trimmed).digest();
}

// ─── Token encryption ───────────────────────────────────

export interface Sealed {
  enc: string;
  iv: string;
  tag: string;
}

/** AES-256-GCM; the uid is the additional data, so a sealed token only opens for its owner. */
export function seal(plain: string, key: Buffer, uid: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(uid));
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { enc: enc.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

export function unseal(s: Sealed, key: Buffer, uid: string): string {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  d.setAAD(Buffer.from(uid));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(s.enc, "base64")), d.final()]).toString("utf8");
}

/** `private_youtube/{uid}` (server only). */
export interface PrivateYouTubeDoc extends Sealed {
  channelId: string;
  channelTitle: string;
  scope: string;
  connectedAt: Timestamp;
  /** Set when Google refused the refresh token (revoked / expired): the organizer must connect again. */
  needsReconnectAt?: Timestamp;
}

/** `serverBroadcasts/{broadcastId}` (server only). The stream key is never stored. */
export interface ServerBroadcastDoc {
  broadcastId: string;
  streamId: string;
  matchId: string;
  tournamentId: string;
  /** Whose channel (and token) it is on: the tournament organizer. */
  organizerUid: string;
  /** Who asked for it (organizer or a camera crew member); only they may startStream with it. */
  createdByUid: string;
  createdAt: Timestamp;
  /** true until the server completed (or deleted) it on YouTube. */
  open: boolean;
  closedAt?: Timestamp;
  closeResult?: EndResult;
  /** Failed attempts to end it on YouTube (the sweep gives up after MAX_CLOSE_ATTEMPTS). */
  closeAttempts?: number;
}

// ─── Google HTTP ────────────────────────────────────────

interface GoogleAnswer {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

async function call(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<GoogleAnswer> {
  let res: HttpResponse;
  try {
    res = await deps().fetch(url, init);
  } catch (err) {
    logger.warn(`YouTube request failed: ${init.method} ${url.split("?")[0]}`, err);
    fail("unavailable", "YOUTUBE_ERROR", "Couldn't reach YouTube. Try again.");
  }
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, ok: res.ok, body };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** Google OAuth token endpoint: code → tokens. */
export async function exchangeCode(authCode: string): Promise<{ refreshToken: string; accessToken: string; scope: string }> {
  const c = config();
  const r = await call(TOKEN_URL, {
    method: "POST", headers: FORM,
    body: form({ code: authCode, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "authorization_code", redirect_uri: "" }),
  });
  if (!r.ok) {
    const err = String(r.body.error ?? "");
    logger.warn(`YouTube code exchange refused: ${r.status} ${err}`);
    if (err === "invalid_client" || err === "unauthorized_client") {
      fail("failed-precondition", "YOUTUBE_NOT_CONFIGURED", NOT_CONFIGURED);
    }
    fail("invalid-argument", "YOUTUBE_CODE_INVALID", "Couldn't connect YouTube. Try connecting again.");
  }
  const refreshToken = typeof r.body.refresh_token === "string" ? r.body.refresh_token : "";
  const accessToken = typeof r.body.access_token === "string" ? r.body.access_token : "";
  const scope = typeof r.body.scope === "string" ? r.body.scope : "";
  if (!accessToken) fail("unavailable", "YOUTUBE_ERROR", "YouTube sent an answer TournMate didn't understand.");
  if (!scope.split(/\s+/).includes(YOUTUBE_SCOPE)) {
    if (refreshToken) await revokeToken(refreshToken);
    fail("failed-precondition", "YOUTUBE_SCOPE_MISSING",
      "TournMate needs permission to manage your YouTube live streams. Connect again and allow YouTube access.");
  }
  if (!refreshToken) {
    // Google returns a refresh token only on a fresh consent (offline access).
    fail("invalid-argument", "YOUTUBE_CODE_INVALID", "Couldn't connect YouTube. Try connecting again.");
  }
  return { refreshToken, accessToken, scope };
}

/** refresh token → access token. `null` when Google refused the refresh token (revoked / expired). */
export async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const c = config();
  const r = await call(TOKEN_URL, {
    method: "POST", headers: FORM,
    body: form({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" }),
  });
  if (r.ok && typeof r.body.access_token === "string") return r.body.access_token;
  const err = String(r.body.error ?? "");
  logger.warn(`YouTube token refresh refused: ${r.status} ${err}`);
  if (err === "invalid_grant") return null;
  if (err === "invalid_client" || err === "unauthorized_client") fail("failed-precondition", "YOUTUBE_NOT_CONFIGURED", NOT_CONFIGURED);
  fail("unavailable", "YOUTUBE_ERROR", "Couldn't reach YouTube. Try again.");
}

/** Best effort; never throws. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const r = await call(REVOKE_URL, { method: "POST", headers: FORM, body: form({ token }) });
    // 400 invalid_token = already revoked.
    return r.ok || r.status === 400;
  } catch (err) {
    logger.warn("YouTube revoke failed", err);
    return false;
  }
}

// ─── YouTube Data API v3 (mirrors iOS YouTubeLiveRequests.swift) ─────────

export interface YouTubeRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
}

/** "SF1 · Priya & Arjun vs Maya & Leo · Club Night" (YouTube allows 100 chars, refuses < and >). */
export function broadcastTitle(label: string, teamA: string, teamB: string, tournament: string): string {
  const parts = [label, `${teamA} vs ${teamB}`, tournament].map((p) => p.trim()).filter((p) => p.length > 0);
  return Array.from(parts.join(" · ").replace(/[<>]/g, "")).slice(0, 100).join("");
}

export function broadcastDescription(tournament: string): string {
  return `${tournament} — streamed live with TournMate. The live score is on the video and in the TournMate app.`;
}

export const yt = {
  insertBroadcast(title: string, description: string, scheduledStart: Date): YouTubeRequest {
    return {
      method: "POST", path: "liveBroadcasts", query: { part: "id,snippet,contentDetails,status" },
      body: {
        snippet: { title, description, scheduledStartTime: scheduledStart.toISOString().replace(/\.\d{3}Z$/, "Z") },
        status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
        contentDetails: {
          enableAutoStart: true, enableAutoStop: false, latencyPreference: "ultraLow",
          enableDvr: true, recordFromStart: true, enableEmbed: true,
        },
      },
    };
  },
  insertStream(broadcastId: string): YouTubeRequest {
    return {
      method: "POST", path: "liveStreams", query: { part: "id,snippet,cdn,contentDetails,status" },
      body: {
        snippet: { title: `TournMate ${broadcastId}` },
        cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
        contentDetails: { isReusable: false },
      },
    };
  },
  bind(broadcastId: string, streamId: string): YouTubeRequest {
    return { method: "POST", path: "liveBroadcasts/bind", query: { id: broadcastId, streamId, part: "id,contentDetails" } };
  },
  broadcastStatus(broadcastId: string): YouTubeRequest {
    return { method: "GET", path: "liveBroadcasts", query: { part: "status", id: broadcastId } };
  },
  myChannel(): YouTubeRequest {
    return { method: "GET", path: "channels", query: { part: "snippet", mine: "true" } };
  },
  complete(broadcastId: string): YouTubeRequest {
    return { method: "POST", path: "liveBroadcasts/transition", query: { broadcastStatus: "complete", id: broadcastId, part: "id,status" } };
  },
  deleteBroadcast(broadcastId: string): YouTubeRequest {
    return { method: "DELETE", path: "liveBroadcasts", query: { id: broadcastId } };
  },
};

export function requestUrl(r: YouTubeRequest): string {
  const q = Object.keys(r.query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(r.query[k])}`).join("&");
  return `${API}${r.path}${q ? `?${q}` : ""}`;
}

async function send(r: YouTubeRequest, accessToken: string): Promise<GoogleAnswer> {
  return call(requestUrl(r), {
    method: r.method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(r.body ? { "Content-Type": "application/json" } : {}) },
    ...(r.body ? { body: JSON.stringify(r.body) } : {}),
  });
}

export type YouTubeErrorKind = "authExpired" | "liveNotEnabled" | "quota" | "apiNotEnabled" | "insufficientScope" |
  "invalidTransition" | "other";

/** `{"error":{"code":403,"errors":[{"reason":"liveStreamingNotEnabled"}]}}` → kind (as iOS mapError). */
export function errorKind(status: number, body: Record<string, unknown>): YouTubeErrorKind {
  const e = (body.error ?? {}) as { errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> };
  const all = new Set([...(e.errors ?? []), ...(e.details ?? [])].map((x) => x?.reason).filter((x): x is string => !!x));
  const any = (list: string[]) => list.some((x) => all.has(x));
  if (status === 401 || all.has("authError")) return "authExpired";
  if (any(["liveStreamingNotEnabled", "livePermissionBlocked", "insufficientLivePermissions"])) return "liveNotEnabled";
  if (any(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"])) return "quota";
  if (any(["accessNotConfigured", "SERVICE_DISABLED"])) return "apiNotEnabled";
  if (any(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"])) return "insufficientScope";
  if (any(["invalidTransition", "redundantTransition", "errorStreamInactive"])) return "invalidTransition";
  return "other";
}

/** Throws the user-facing error for a refused YouTube call. `forOrganizer`: the caller owns the channel. */
export function failYouTube(kind: YouTubeErrorKind, forOrganizer: boolean): never {
  if (kind === "authExpired" || kind === "insufficientScope") {
    fail("failed-precondition", "YOUTUBE_AUTH_EXPIRED", forOrganizer ?
      "Your YouTube connection has expired. Connect YouTube again in TournMate." :
      "The organizer's YouTube connection has expired. Ask the organizer to connect YouTube again in TournMate.");
  }
  if (kind === "liveNotEnabled") {
    fail("failed-precondition", "YOUTUBE_LIVE_NOT_ENABLED", forOrganizer ?
      "Live streaming isn't turned on for your YouTube channel. Turn it on at youtube.com/features (the first time can take up to 24 hours)." :
      "Live streaming isn't turned on for the organizer's YouTube channel yet. Ask the organizer to turn it on at youtube.com/features.");
  }
  if (kind === "quota") {
    fail("resource-exhausted", "YOUTUBE_QUOTA", "TournMate has reached its YouTube limit for today. Try again tomorrow.");
  }
  if (kind === "apiNotEnabled") fail("failed-precondition", "YOUTUBE_NOT_CONFIGURED", NOT_CONFIGURED);
  fail("unavailable", "YOUTUBE_ERROR", "YouTube couldn't set up the stream right now. Try again.");
}

/** The connected channel (`channels.list mine=true`). */
export async function myChannel(accessToken: string): Promise<{ channelId: string; channelTitle: string }> {
  const r = await send(yt.myChannel(), accessToken);
  if (!r.ok) failYouTube(errorKind(r.status, r.body), true);
  const item = (r.body.items as Array<{ id?: string; snippet?: { title?: string } }> | undefined)?.[0];
  if (!item?.id) {
    fail("failed-precondition", "YOUTUBE_NO_CHANNEL",
      "This Google account has no YouTube channel. Create one at youtube.com, then connect again.");
  }
  return { channelId: item.id, channelTitle: item.snippet?.title ?? "" };
}

// ─── Stored connection ──────────────────────────────────

/** Encrypts and stores the connection; returns the replaced refresh token (to revoke) if different. */
export async function storeConnection(db: Firestore, uid: string, refreshToken: string, scope: string,
  channel: { channelId: string; channelTitle: string }): Promise<string | null> {
  const { key } = config();
  const ref = db.collection(PRIVATE_YOUTUBE).doc(uid);
  const before = await ref.get();
  let previous: string | null = null;
  if (before.exists) {
    try {
      previous = unseal(before.data() as PrivateYouTubeDoc, key, uid);
    } catch {
      previous = null;
    }
  }
  const doc: PrivateYouTubeDoc = { ...seal(refreshToken, key, uid), ...channel, scope, connectedAt: Timestamp.now() };
  await ref.set(doc);
  return previous && previous !== refreshToken ? previous : null;
}

export async function loadRefreshToken(db: Firestore, uid: string): Promise<{ token: string; doc: PrivateYouTubeDoc } | null> {
  const snap = await db.collection(PRIVATE_YOUTUBE).doc(uid).get();
  if (!snap.exists) return null;
  const doc = snap.data() as PrivateYouTubeDoc;
  const { key } = config();
  try {
    return { token: unseal(doc, key, uid), doc };
  } catch (err) {
    // Wrong / rotated YOUTUBE_TOKEN_KEY: treat as not connected.
    logger.error(`private_youtube/${uid}: can't decrypt the refresh token`, err);
    return null;
  }
}

/**
 * A fresh access token for `organizerUid`'s channel. Fails YOUTUBE_NOT_CONNECTED
 * (nothing stored) or YOUTUBE_AUTH_EXPIRED (Google refused the refresh token;
 * marked `needsReconnectAt`).
 */
export async function organizerAccessToken(db: Firestore, organizerUid: string, forOrganizer: boolean): Promise<string> {
  const stored = await loadRefreshToken(db, organizerUid);
  if (!stored) {
    fail("failed-precondition", "YOUTUBE_NOT_CONNECTED", forOrganizer ?
      "Connect YouTube in TournMate first." : "Ask the organizer to connect YouTube in TournMate.");
  }
  const access = await refreshAccessToken(stored.token);
  if (!access) {
    await db.collection(PRIVATE_YOUTUBE).doc(organizerUid).update({ needsReconnectAt: Timestamp.now() }).catch(() => undefined);
    failYouTube("authExpired", forOrganizer);
  }
  return access;
}

// ─── Create a broadcast ─────────────────────────────────

export interface CreatedBroadcast {
  broadcastId: string;
  streamId: string;
  videoId: string;
  rtmpUrl: string;
  streamKey: string;
}

/** liveBroadcasts.insert → liveStreams.insert → bind (as the iOS app does on the device). */
export async function createBroadcast(accessToken: string, title: string, description: string, forOrganizer: boolean,
  now = new Date()): Promise<CreatedBroadcast> {
  const b = await send(yt.insertBroadcast(title, description, now), accessToken);
  if (!b.ok) failYouTube(errorKind(b.status, b.body), forOrganizer);
  const broadcastId = typeof b.body.id === "string" ? b.body.id : "";
  if (!broadcastId) fail("unavailable", "YOUTUBE_ERROR", "YouTube sent an answer TournMate didn't understand.");
  try {
    const s = await send(yt.insertStream(broadcastId), accessToken);
    if (!s.ok) failYouTube(errorKind(s.status, s.body), forOrganizer);
    const ingestion = parseIngestion(s.body);
    if (!ingestion) fail("unavailable", "YOUTUBE_ERROR", "YouTube sent an answer TournMate didn't understand.");
    const bound = await send(yt.bind(broadcastId, ingestion.streamId), accessToken);
    if (!bound.ok) failYouTube(errorKind(bound.status, bound.body), forOrganizer);
    return { broadcastId, streamId: ingestion.streamId, videoId: broadcastId, rtmpUrl: ingestion.address, streamKey: ingestion.key };
  } catch (err) {
    // Don't leave an empty broadcast on the organizer's channel.
    await send(yt.deleteBroadcast(broadcastId), accessToken).catch(() => undefined);
    throw err;
  }
}

/** RTMPS address when offered (encrypted), else RTMP. */
export function parseIngestion(body: Record<string, unknown>): { streamId: string; address: string; key: string } | null {
  const id = body.id;
  const info = (body.cdn as { ingestionInfo?: Record<string, unknown> } | undefined)?.ingestionInfo;
  const key = info?.streamName;
  const address = info?.rtmpsIngestionAddress ?? info?.ingestionAddress;
  if (typeof id !== "string" || !id || typeof key !== "string" || !key || typeof address !== "string" || !address) return null;
  return { streamId: id, address, key };
}

/** Caps `createCrewBroadcast` per caller (YouTube quota). Fails RATE_LIMITED. */
export async function takeBroadcastSlot(db: Firestore, uid: string, nowMs = Date.now()): Promise<void> {
  const ref = db.collection(BROADCAST_RATE).doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stamps = ((snap.get("stamps") as number[] | undefined) ?? []).filter((t) => typeof t === "number" && nowMs - t < 3_600_000);
    if (stamps.length >= MAX_BROADCASTS_PER_HOUR) {
      fail("resource-exhausted", "RATE_LIMITED", "You've started a lot of streams in the last hour. Try again later.");
    }
    tx.set(ref, { stamps: [...stamps, nowMs] });
  });
}

// ─── End a broadcast ────────────────────────────────────

/** What happened on YouTube when the server ended a broadcast. */
export type EndResult = "completed" | "deleted" | "already_ended" | "not_connected" | "failed";

/**
 * Completes the broadcast on YouTube; one that never went live is deleted
 * instead, one YouTube already ended is left alone (iOS endFallback). Never
 * throws.
 */
export async function endBroadcastOnYouTube(db: Firestore, organizerUid: string, broadcastId: string): Promise<EndResult> {
  try {
    const stored = await loadRefreshToken(db, organizerUid);
    if (!stored) return "not_connected";
    const access = await refreshAccessToken(stored.token);
    if (!access) return "not_connected";
    const done = await send(yt.complete(broadcastId), access);
    if (done.ok) return "completed";
    const kind = errorKind(done.status, done.body);
    if (kind !== "invalidTransition" && done.status !== 404) return "failed";
    if (done.status === 404) return "already_ended";
    const st = await send(yt.broadcastStatus(broadcastId), access);
    const item = (st.body.items as Array<{ status?: { lifeCycleStatus?: string } }> | undefined)?.[0];
    const life = item?.status?.lifeCycleStatus;
    if (st.ok && !item) return "already_ended";
    if (life === "complete" || life === "revoked") return "already_ended";
    if (life && ["created", "ready", "testStarting", "testing"].includes(life)) {
      const del = await send(yt.deleteBroadcast(broadcastId), access);
      return del.ok || del.status === 404 ? "deleted" : "failed";
    }
    return "failed";
  } catch (err) {
    logger.warn(`Ending YouTube broadcast ${broadcastId} failed`, err);
    return "failed";
  }
}

/**
 * Ends the server broadcast `broadcastId` on YouTube once and marks its
 * record closed. Returns null when it isn't a server broadcast or was
 * already closed (so nothing to do). Never throws.
 */
export async function closeServerBroadcast(db: Firestore, broadcastId: string): Promise<EndResult | null> {
  try {
    const ref = db.collection(SERVER_BROADCASTS).doc(broadcastId);
    // Claim it first so two callers (endStream + sweep) don't both end it.
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.data() as ServerBroadcastDoc | undefined;
      if (!d || d.open !== true) return null;
      tx.update(ref, { open: false, closedAt: Timestamp.now() });
      return d;
    });
    if (!claimed) return null;
    const result = await endBroadcastOnYouTube(db, claimed.organizerUid, broadcastId);
    const attempts = (claimed.closeAttempts ?? 0) + (result === "failed" ? 1 : 0);
    const retry = result === "failed" && attempts < MAX_CLOSE_ATTEMPTS;
    await ref.update(retry ?
      { open: true, closedAt: FieldValue.delete(), closeResult: result, closeAttempts: attempts } :
      { closeResult: result, closeAttempts: attempts });
    logger.info(`serverBroadcast ${broadcastId}: ${result}`);
    return result;
  } catch (err) {
    logger.warn(`closeServerBroadcast ${broadcastId} failed`, err);
    return "failed";
  }
}

/**
 * The 5-minute sweep (streamCleanup): open server broadcasts whose match no
 * longer streams them live (ended stale / match finished / replaced), or that
 * never started within 30 minutes, are ended on YouTube.
 */
export async function sweepServerBroadcasts(db: Firestore, now: Date): Promise<number> {
  const open = await db.collection(SERVER_BROADCASTS).where("open", "==", true).get();
  let closed = 0;
  for (const doc of open.docs) {
    const d = doc.data() as ServerBroadcastDoc;
    const m = await db.collection("matches").doc(d.matchId).get();
    const s = streamOf(m.data() as MatchDoc | undefined);
    const mine = !!s && s.videoId === d.broadcastId;
    if (mine && isLive(s)) continue;
    const age = now.getTime() - (d.createdAt?.toMillis?.() ?? 0);
    if (!mine && age < UNSTARTED_BROADCAST_MS) continue; // the phone may still be about to startStream
    const r = await closeServerBroadcast(db, d.broadcastId);
    if (r && r !== "failed") closed++;
  }
  if (closed) logger.info(`serverBroadcast sweep: ${closed} ended on YouTube`);
  return closed;
}
