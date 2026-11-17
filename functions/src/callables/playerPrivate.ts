import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { Firestore, FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { fail } from "./errors";
import { CALLABLE_OPTS, Data, dataOf, parseDate, requirePlayer, requireUid } from "./shared";
import { canonicalPlayerId, playerById } from "../services/identity";
import {
  PLAYER_PRIVATE, TIER2_FIELDS, authEmailFor, normalizeEmail, phoneDigits, privateResponse,
} from "../services/playerPrivate";

/*
 * Player privacy callables (player-privacy-design.md S4, S5).
 * Error codes: unauthenticated / UNAUTHENTICATED, failed-precondition /
 * NO_PROFILE, invalid-argument / INVALID_ARGUMENT, resource-exhausted /
 * RATE_LIMITED (lookup limit).
 */

export const LOOKUP_LIMIT = 20;
export const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
export const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;
const MIN_AGE = 13;
const RATE_LIMITS = "rateLimits";

/**
 * Lookup query: an email (contains "@"; trimmed, lower case) or a phone
 * number (digits only, at least 7). Null when it is neither.
 */
export function parseContactQuery(raw: unknown): { kind: "email"; value: string } | { kind: "phone"; value: string } | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim();
  if (!q || q.length > 254) return null;
  if (q.includes("@")) {
    const email = normalizeEmail(q);
    return /^[^@\s]+@[^@\s]+$/.test(email) ? { kind: "email", value: email } : null;
  }
  const digits = phoneDigits(q);
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null;
  return { kind: "phone", value: digits };
}

/**
 * Digits to match: as typed, plus the same number with / without the North
 * American "1" country code (most stored numbers are US, typed either way).
 */
export function phoneVariants(digits: string): string[] {
  const out = [digits];
  if (digits.length === 10) out.push(`1${digits}`);
  if (digits.length === 11 && digits.startsWith("1")) out.push(digits.slice(1));
  return out;
}

/** Counts one lookup for `uid`; RATE_LIMITED past LOOKUP_LIMIT in the window. Server-only rateLimits/{uid}. */
async function countLookup(db: Firestore, uid: string): Promise<number> {
  const ref = db.collection(RATE_LIMITS).doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.get("findPlayerByContact") as { windowStart?: Timestamp; count?: number } | undefined;
    const now = Date.now();
    const fresh = !cur?.windowStart || now - cur.windowStart.toMillis() >= LOOKUP_WINDOW_MS;
    const count = fresh ? 1 : (cur?.count ?? 0) + 1;
    if (count > LOOKUP_LIMIT) {
      fail("resource-exhausted", "RATE_LIMITED", "Too many lookups. Try again in a few minutes.");
    }
    tx.set(ref, {
      findPlayerByContact: { windowStart: fresh ? Timestamp.fromMillis(now) : cur!.windowStart, count },
    }, { merge: true });
    return count;
  });
}

/** Player id from matching docs: prefer a real account (has firebaseUid), then the first. */
async function pickPlayer(db: Firestore, docs: { id: string; firebaseUid?: unknown }[]): Promise<string | null> {
  const ordered = [...docs].sort((a, b) => Number(!!b.firebaseUid) - Number(!!a.firebaseUid));
  for (const d of ordered) {
    const p = await playerById(db, d.id);
    if (p) return p.id;
  }
  return null;
}

/**
 * findPlayerByContact({ query }) -> { playerId: string | null }
 * Teammate lookup by email or phone. Never returns contact data. Phases 1-2:
 * falls back to the legacy public players query when playerPrivate has no match.
 */
export const findPlayerByContact = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const parsed = parseContactQuery(dataOf(req).query);
  if (!parsed) fail("invalid-argument", "INVALID_ARGUMENT", "Enter an email address or a phone number.");
  const db = getFirestore();
  await requirePlayer(db, uid);
  const count = await countLookup(db, uid);

  const field = parsed.kind === "email" ? "email" : "phoneDigits";
  const values = parsed.kind === "email" ? [parsed.value] : phoneVariants(parsed.value);
  const priv = await db.collection(PLAYER_PRIVATE).where(field, "in", values).limit(2).get();
  let playerId = await pickPlayer(db, priv.docs.map((d) => ({ id: d.id, firebaseUid: d.get("firebaseUid") })));

  let legacy = false;
  if (!playerId) {
    // LEGACY (phases 1-2): remove once public docs are scrubbed (phase 3).
    const raw = String(dataOf(req).query).trim();
    const legacyValues = [...new Set(parsed.kind === "email" ? [parsed.value, raw] : [raw, ...values])];
    const pub = await db.collection("players").where(parsed.kind, "in", legacyValues).limit(2).get();
    playerId = await pickPlayer(db, pub.docs.map((d) => ({ id: d.id, firebaseUid: d.get("firebaseUid") })));
    legacy = !!playerId;
  }
  // The count and outcome only, never the query.
  logger.info("findPlayerByContact", { kind: parsed.kind, found: !!playerId, legacy, count });
  return { playerId: playerId ? canonicalPlayerId(playerId) : null };
});

// ─── updatePrivateProfile ──────────────────────────────

/** "" or null clears a field; absent leaves it alone. */
function isClear(v: unknown): boolean {
  return v === null || (typeof v === "string" && v.trim() === "");
}

function ageOn(birth: Date, today: Date): number {
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const m = today.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

/** Validated changes for playerPrivate (FieldValue.delete() never used: null marks a cleared field). */
export function privateChanges(d: Data, now = new Date()): Record<string, unknown> {
  // Other keys (including `email`) are ignored, so newer apps can send more.
  const out: Record<string, unknown> = {};

  if ("phone" in d && d.phone !== undefined) {
    if (isClear(d.phone)) {
      out.phone = "";
      out.phoneDigits = "";
    } else {
      if (typeof d.phone !== "string" || d.phone.length > 32) fail("invalid-argument", "INVALID_ARGUMENT", "Enter a valid phone number.");
      const digits = phoneDigits(d.phone);
      if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
        fail("invalid-argument", "INVALID_ARGUMENT", "Enter a valid phone number.");
      }
      out.phone = d.phone.trim();
      out.phoneDigits = digits;
    }
  }

  if ("dateOfBirth" in d && d.dateOfBirth !== undefined) {
    if (isClear(d.dateOfBirth)) {
      out.dateOfBirth = null;
    } else {
      const birth = parseDate(d.dateOfBirth, "dateOfBirth")!;
      if (birth.getTime() > now.getTime()) fail("invalid-argument", "INVALID_ARGUMENT", "Date of birth can't be in the future.");
      if (ageOn(birth, now) < MIN_AGE) fail("invalid-argument", "INVALID_ARGUMENT", `You must be at least ${MIN_AGE} to use TournMate.`);
      if (ageOn(birth, now) > 120) fail("invalid-argument", "INVALID_ARGUMENT", "Enter a valid date of birth.");
      out.dateOfBirth = Timestamp.fromDate(birth);
    }
  }

  if ("weightKg" in d && d.weightKg !== undefined) {
    if (d.weightKg === null) {
      out.weightKg = null;
    } else {
      const w = d.weightKg;
      if (typeof w !== "number" || !Number.isFinite(w) || w < 20 || w > 300) {
        fail("invalid-argument", "INVALID_ARGUMENT", "Weight must be between 20 and 300 kg.");
      }
      out.weightKg = w;
    }
  }

  if ("homePostalCode" in d && d.homePostalCode !== undefined) {
    if (isClear(d.homePostalCode)) {
      out.homePostalCode = null;
    } else {
      const v = d.homePostalCode;
      if (typeof v !== "string" || v.trim().length > 12) fail("invalid-argument", "INVALID_ARGUMENT", "Postal code is too long.");
      out.homePostalCode = v.trim();
    }
  }

  if ("fcmToken" in d && d.fcmToken !== undefined) {
    if (isClear(d.fcmToken)) {
      out.fcmToken = null;
    } else {
      const v = d.fcmToken;
      if (typeof v !== "string" || v.length > 4096) fail("invalid-argument", "INVALID_ARGUMENT", "Invalid device token.");
      out.fcmToken = v.trim();
    }
  }
  return out;
}

/**
 * updatePrivateProfile({ phone?, dateOfBirth?, weightKg?, homePostalCode?, fcmToken? })
 *   -> { email, phone, dateOfBirth (epoch ms | null), weightKg, homePostalCode, fcmToken, updatedAt (epoch ms) }
 * Owner only: writes playerPrivate/{myPlayerDocId}, creating it if missing.
 * Absent keys are left alone; null (or "" for text) clears. `dateOfBirth` is
 * epoch milliseconds or an ISO date. `email` is never taken from input (it is
 * ignored): the server always refreshes it from Firebase Auth. `{}` just
 * refreshes the email and returns the doc. The legacy public copy of every
 * field written or cleared is removed from players/{id} (phone -> "").
 */
export const updatePrivateProfile = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const changes = privateChanges(dataOf(req));
  const db = getFirestore();
  const me = await requirePlayer(db, uid);
  const email = await authEmailFor(uid, req.auth?.token?.email ?? "");
  const ref = db.collection(PLAYER_PRIVATE).doc(me.docId);
  await ref.set({
    ...changes,
    firebaseUid: uid,
    ...(email ? { email } : {}),
    updatedAt: FieldValue.serverTimestamp(),
    source: "callable",
  }, { merge: true });
  // A new doc gets "" contact placeholders so lookups and decoders see strings.
  const snap = await ref.get();
  const fill: Record<string, unknown> = {};
  if (typeof snap.get("email") !== "string") fill.email = "";
  if (typeof snap.get("phone") !== "string") fill.phone = "";
  if (typeof snap.get("phoneDigits") !== "string") fill.phoneDigits = phoneDigits(snap.get("phone"));
  if (Object.keys(fill).length > 0) await ref.set(fill, { merge: true });

  // Remove the legacy public copy of every field written or cleared here, so a
  // stale public value can't come back through client fallbacks or the mirror.
  // (Deletions / blanks on the public doc are never mirrored back.) phone stays
  // as a "" placeholder; Tier 2 keys are deleted.
  const legacy: Record<string, unknown> = {};
  for (const k of Object.keys(changes)) {
    if (k === "phone") {
      if (typeof me.data.phone === "string" && me.data.phone !== "") legacy.phone = "";
    } else if ((TIER2_FIELDS as readonly string[]).includes(k) && k in me.data) {
      legacy[k] = FieldValue.delete();
    }
  }
  if (Object.keys(legacy).length > 0) await me.ref.update(legacy);
  logger.info("updatePrivateProfile", { playerId: me.id, fields: Object.keys(changes) });
  return privateResponse({ ...snap.data(), ...fill });
});
