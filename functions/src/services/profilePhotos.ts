import { getStorage, getDownloadURL } from "firebase-admin/storage";
import { randomUUID } from "crypto";
import { logger } from "firebase-functions/v2";
import type { ImageAnnotatorClient } from "@google-cloud/vision";

/*
 * Profile photos (shared spec: profile-photos-spec.md). Clients upload a
 * 512x512 JPEG to `profilePhotos/{uid}/{photoId}.jpg`; setProfilePhoto copies
 * it to `approvedPhotos/{uid}/` (server-only, so nobody can swap the image
 * after the check), checks the copy with Cloud Vision SafeSearch and writes
 * photoURL / photoPath / photoUpdatedAt on the player doc. Only the server
 * deletes files.
 */

/** Client uploads (transient). */
export const PHOTO_FOLDER = "profilePhotos";
/** Checked photos the apps show; storage.rules deny all client access. */
export const APPROVED_FOLDER = "approvedPhotos";

export function approvedFolder(uid: string): string {
  return `${APPROVED_FOLDER}/${uid}/`;
}
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export function photoFolder(uid: string): string {
  return `${PHOTO_FOLDER}/${uid}/`;
}

/** True if `path` is `profilePhotos/{uid}/<name>.jpg` (one level, no traversal). */
export function isOwnPhotoPath(path: string, uid: string): boolean {
  if (!path.startsWith(photoFolder(uid))) return false;
  const name = path.slice(photoFolder(uid).length);
  return /^[A-Za-z0-9_-]{1,128}\.jpg$/.test(name);
}

export type ModerationVerdict = "pass" | "reject";

/** Checks the image at `gs://{bucket}/{path}`. Throws when the check itself fails. */
export type PhotoModerator = (bucket: string, path: string) => Promise<ModerationVerdict>;

// Created on first use: the client is heavy and most instances never need it.
let visionClient: ImageAnnotatorClient | null = null;

// Likelihood enums arrive as names; numbers (LIKELY = 4, VERY_LIKELY = 5) accepted too.
const BLOCKED = new Set(["LIKELY", "VERY_LIKELY", "4", "5"]);

export interface SafeSearchLike {
  adult?: unknown;
  violence?: unknown;
  racy?: unknown;
}

/** True if adult, violence or racy is LIKELY or VERY_LIKELY. */
export function safeSearchBlocks(s: SafeSearchLike): boolean {
  return [s.adult, s.violence, s.racy].some((v) => v !== null && v !== undefined && BLOCKED.has(String(v)));
}

/** Cloud Vision SafeSearch: reject if adult, violence or racy is LIKELY or VERY_LIKELY. */
export const visionModerator: PhotoModerator = async (bucket, path) => {
  if (!visionClient) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ImageAnnotatorClient: Client } = require("@google-cloud/vision") as typeof import("@google-cloud/vision");
    visionClient = new Client();
  }
  const [res] = await visionClient.safeSearchDetection(`gs://${bucket}/${path}`);
  if (res.error?.message) throw new Error(`SafeSearch: ${res.error.message}`);
  const s = res.safeSearchAnnotation;
  if (!s) throw new Error("SafeSearch: no annotation");
  return safeSearchBlocks(s) ? "reject" : "pass";
};

let moderator: PhotoModerator = visionModerator;

export function photoModerator(): PhotoModerator {
  return moderator;
}

/** Emulator tests only: replace the Vision check (pass `null` to restore it). */
export function setPhotoModerator(fn: PhotoModerator | null): void {
  moderator = fn ?? visionModerator;
}

type StorageFile = ReturnType<ReturnType<ReturnType<typeof getStorage>["bucket"]>["file"]>;

/**
 * Firebase download URL (with token) for `file`, adding a token when the
 * upload has none (client SDK uploads always do).
 */
export async function photoDownloadURL(file: StorageFile): Promise<string> {
  // Always a fresh token: the copy would otherwise keep the upload's token,
  // which the uploading device knows.
  const token = randomUUID();
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  const emulator = process.env.STORAGE_EMULATOR_HOST;
  if (!emulator) return getDownloadURL(file);
  // The emulator checks storage.rules on getDownloadURL's metadata read as if
  // signed out (no admin bypass), so build the same URL from the token.
  return `${emulator}/v0/b/${file.bucket.name}/o/${encodeURIComponent(file.name)}?alt=media&token=${token}`;
}

/** Uploads younger than this may still be on their way to setProfilePhoto. */
export const STALE_UPLOAD_MS = 10 * 60_000;

/**
 * Deletes the uid's files (uploads and approved copies) except `keepPath`.
 * With `olderThanMs`, only files created at least that long ago (so another
 * device's photo still being checked survives). Returns how many were deleted.
 */
export async function deletePhotoFiles(uid: string, keepPath?: string, olderThanMs?: number): Promise<number> {
  const bucket = getStorage().bucket();
  const files = (await Promise.all([photoFolder(uid), approvedFolder(uid)]
    .map((prefix) => bucket.getFiles({ prefix })))).flatMap(([f]) => f);
  const cutoff = olderThanMs === undefined ? Infinity : Date.now() - olderThanMs;
  let deleted = 0;
  for (const f of files) {
    if (f.name === keepPath) continue;
    const created = Date.parse(String(f.metadata?.timeCreated ?? ""));
    if (Number.isFinite(cutoff) && !(created <= cutoff)) continue;
    try {
      await f.delete({ ignoreNotFound: true });
      deleted++;
    } catch (err) {
      logger.warn(`deletePhotoFiles: ${f.name}`, err);
    }
  }
  return deleted;
}
