import { Firestore, DocumentData, FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";
import { PlayerDoc } from "../types";

/*
 * Player privacy (player-privacy-design.md). `players/{id}` is public;
 * `playerPrivate/{id}` (same doc id, exact case) holds the owner-only fields
 * and is written only by the server: the onPlayerWritten mirror, the
 * updatePrivateProfile callable and scripts/backfillPlayerPrivate.ts.
 *
 * Reads are private-first: a key present on the private doc wins, even when
 * it is null (the owner cleared it through the callable). Only when the
 * private doc doesn't have the key do we fall back to the legacy public value
 * (accounts not backfilled yet, or old apps between phase 1 and phase 3).
 */

export const PLAYER_PRIVATE = "playerPrivate";

/** Contact fields: blanked to "" (never removed) on public docs; older iOS decoders need the keys. */
export const CONTACT_FIELDS = ["email", "phone"] as const;
/** Tier 2 fields: removed from public docs when scrubbed. */
export const TIER2_FIELDS = ["dateOfBirth", "weightKg", "homePostalCode", "fcmToken"] as const;

export type ScrubMode = "off" | "tier1" | "all";

export interface PlayerPrivateDoc {
  firebaseUid: string | null;
  email: string;
  phone: string;
  phoneDigits: string;
  dateOfBirth?: Timestamp | null;
  weightKg?: number | null;
  homePostalCode?: string | null;
  fcmToken?: string | null;
  updatedAt: Timestamp;
  source: "mirror" | "callable" | "backfill";
}

export function normalizeEmail(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export function phoneDigits(v: unknown): string {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

/** A value worth keeping: non-empty string, finite number or a Timestamp. */
export function hasValue(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v);
  return v instanceof Timestamp;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Timestamp && b instanceof Timestamp) return a.isEqual(b);
  return a === b;
}

/**
 * The account email from Firebase Auth (lower case). Falls back to the
 * legacy public email for players with no auth user (organizer-created) or
 * when the auth user is gone. Never throws.
 */
export async function authEmailFor(uid: string | null | undefined, fallback: unknown): Promise<string> {
  if (typeof uid === "string" && uid.length > 0) {
    try {
      const user = await getAuth().getUser(uid);
      if (user.email) return normalizeEmail(user.email);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "auth/user-not-found") logger.warn("playerPrivate: auth lookup failed", { code });
    }
  }
  return normalizeEmail(fallback);
}

function privateRef(db: Firestore, docId: string) {
  return db.collection(PLAYER_PRIVATE).doc(docId);
}

/** `playerPrivate/{docId}` data, or null when there is none. */
export async function privateFor(db: Firestore, docId: string, tx?: Transaction): Promise<DocumentData | null> {
  const ref = privateRef(db, docId);
  const snap = tx ? await tx.get(ref) : await ref.get();
  return snap.exists ? snap.data() ?? null : null;
}

/** Private value when the private doc has the key (null = cleared), else the legacy public value. */
export function privateFirst<T>(priv: DocumentData | null, publicData: DocumentData | undefined, key: string): T | undefined {
  if (priv && key in priv) {
    const v = priv[key];
    return v === null ? undefined : (v as T);
  }
  const legacy = publicData?.[key];
  return legacy === null ? undefined : (legacy as T | undefined);
}

/**
 * The push token of a player: private first, then the legacy public value.
 * Pass the player doc id when known; otherwise the private doc is found by
 * `firebaseUid` (players without one have no device). Never throws.
 */
export async function deviceTokenFor(
  db: Firestore,
  player: Pick<PlayerDoc, "firebaseUid" | "fcmToken"> | DocumentData | null | undefined,
  docId?: string,
): Promise<string | undefined> {
  if (!player) return undefined;
  let priv: DocumentData | null = null;
  try {
    if (docId) {
      priv = await privateFor(db, docId);
    } else if (typeof player.firebaseUid === "string" && player.firebaseUid) {
      const snap = await db.collection(PLAYER_PRIVATE).where("firebaseUid", "==", player.firebaseUid).limit(1).get();
      priv = snap.empty ? null : snap.docs[0].data();
    }
  } catch (err) {
    logger.warn("deviceTokenFor: private read failed, using the public token", err);
  }
  const token = privateFirst<unknown>(priv, player, "fcmToken");
  return typeof token === "string" && token.trim() ? token : undefined;
}

/** The caller's date of birth (private first, then legacy public), read in `tx` when given. */
export async function dobFor(
  db: Firestore, player: { docId: string; data: DocumentData }, tx?: Transaction,
): Promise<Timestamp | undefined> {
  const priv = await privateFor(db, player.docId, tx);
  const dob = privateFirst<unknown>(priv, player.data, "dateOfBirth");
  return dob instanceof Timestamp ? dob : undefined;
}

/** The private doc as the callables return it: dates as epoch milliseconds. */
export function privateResponse(d: DocumentData | null | undefined): Record<string, unknown> {
  const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : null);
  return {
    email: typeof d?.email === "string" ? d.email : "",
    phone: typeof d?.phone === "string" ? d.phone : "",
    dateOfBirth: ms(d?.dateOfBirth),
    weightKg: typeof d?.weightKg === "number" ? d.weightKg : null,
    homePostalCode: typeof d?.homePostalCode === "string" && d.homePostalCode ? d.homePostalCode : null,
    fcmToken: typeof d?.fcmToken === "string" && d.fcmToken ? d.fcmToken : null,
    updatedAt: ms(d?.updatedAt),
  };
}

export interface MirrorPlan {
  /** Fields to merge into playerPrivate/{id}; null when nothing changes. */
  privateUpdate: Record<string, unknown> | null;
  /** Fields to write on the public doc (scrub); null when nothing to scrub. */
  publicUpdate: Record<string, unknown> | null;
}

/**
 * What onPlayerWritten / the backfill should write for one public player doc.
 *
 * Copy rules (never overwrite a newer private value with a stale public one):
 *  - a public value is copied when it is non-empty AND (it changed in this
 *    write, or the private doc doesn't have that key at all);
 *  - a public field that was removed or blanked is never copied as a clear
 *    (web/new apps delete the public copy after a private save; the scrub
 *    blanks/deletes too). One exception: an old app explicitly nulling its
 *    push token (`fcmToken: null`) clears the private token, but only when the
 *    private token is that same token.
 *  - `email` comes from Firebase Auth (`authEmail`), never from the client;
 *    it is (re)set when the private doc has none.
 *  - `firebaseUid` follows the public doc.
 * Scrub (`mode` tier1: email/phone -> ""; all: also deletes the Tier 2 keys)
 * runs only for fields the private doc holds after this write.
 */
export function planMirror(
  before: DocumentData | undefined,
  after: DocumentData,
  priv: DocumentData | null,
  authEmail: string | null,
  mode: ScrubMode,
  source: PlayerPrivateDoc["source"],
): MirrorPlan {
  const update: Record<string, unknown> = {};
  const has = (k: string) => !!priv && k in priv;
  const changed = (k: string) => !before || !sameValue(before[k], after[k]);

  const uid = typeof after.firebaseUid === "string" && after.firebaseUid ? after.firebaseUid : null;
  if (!priv || (priv.firebaseUid ?? null) !== uid) update.firebaseUid = uid;

  if (!priv || !hasValue(priv.email)) {
    const email = authEmail ?? normalizeEmail(after.email);
    if (email || !priv) update.email = email;
  }

  if (hasValue(after.phone) && (changed("phone") || !hasValue(priv?.phone))) {
    if (!priv || priv.phone !== after.phone) {
      update.phone = String(after.phone).trim();
      update.phoneDigits = phoneDigits(after.phone);
    }
  } else if (!priv) {
    update.phone = "";
    update.phoneDigits = "";
  }

  for (const f of TIER2_FIELDS) {
    const v = after[f];
    if (hasValue(v) && (changed(f) || !has(f))) {
      if (!has(f) || !sameValue(priv![f], v)) update[f] = v;
    }
  }
  // Old app clearing its own token.
  if (before && hasValue(before.fcmToken) && "fcmToken" in after && after.fcmToken === null
      && has("fcmToken") && priv!.fcmToken === before.fcmToken) {
    update.fcmToken = null;
  }

  const privateUpdate = Object.keys(update).length > 0
    ? { ...update, updatedAt: FieldValue.serverTimestamp(), source }
    : null;

  // The private doc after this write, for the scrub's "only what is kept" check.
  const merged: DocumentData = { ...(priv ?? {}), ...update };
  let publicUpdate: Record<string, unknown> | null = null;
  if (mode !== "off") {
    const pub: Record<string, unknown> = {};
    if (hasValue(after.email) && hasValue(merged.email)) pub.email = "";
    if (hasValue(after.phone) && hasValue(merged.phone)) pub.phone = "";
    if (mode === "all") {
      for (const f of TIER2_FIELDS) {
        if (!(f in after)) continue;
        // Kept privately (the private value is the newer one), or nothing worth keeping.
        if (!hasValue(after[f]) || f in merged) {
          pub[f] = FieldValue.delete();
        }
      }
    }
    publicUpdate = Object.keys(pub).length > 0 ? pub : null;
  }
  return { privateUpdate, publicUpdate };
}

/**
 * Admin/script helper: the player doc whose account email is `email`
 * (playerPrivate first, then the legacy public field). Null if none.
 */
export async function playerDocByEmail(db: Firestore, email: string): Promise<FirebaseFirestore.DocumentSnapshot | null> {
  const value = normalizeEmail(email);
  const priv = await db.collection(PLAYER_PRIVATE).where("email", "==", value).limit(1).get();
  if (!priv.empty) {
    const snap = await db.collection("players").doc(priv.docs[0].id).get();
    if (snap.exists) return snap;
  }
  const pub = await db.collection("players").where("email", "in", [...new Set([email, value])]).limit(1).get();
  return pub.empty ? null : pub.docs[0];
}
