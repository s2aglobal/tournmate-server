import { CallableRequest } from "firebase-functions/v2/https";
import { Firestore, Transaction, Timestamp } from "firebase-admin/firestore";
import { fail } from "./errors";
import { playerForUid, PlayerRef } from "../services/identity";

/** Options shared by every callable. */
export const CALLABLE_OPTS = { region: "us-central1" } as const;

export type Data = Record<string, unknown>;

export function requireUid(req: CallableRequest<unknown>): string {
  const uid = req.auth?.uid;
  if (!uid) fail("unauthenticated", "UNAUTHENTICATED", "Please sign in first.");
  return uid;
}

export function dataOf(req: CallableRequest<unknown>): Data {
  const d = req.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Missing request data.");
  }
  return d as Data;
}

/** The caller's player profile, or NO_PROFILE. */
export async function requirePlayer(db: Firestore, uid: string, tx?: Transaction): Promise<PlayerRef> {
  const p = await playerForUid(db, uid, tx);
  if (!p) fail("failed-precondition", "NO_PROFILE", "Create your player profile first.");
  return p;
}

export function requireString(d: Data, key: string, maxLen = 200): string {
  const v = d[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    fail("invalid-argument", "INVALID_ARGUMENT", `Missing ${key}.`);
  }
  if (v.length > maxLen) fail("invalid-argument", "INVALID_ARGUMENT", `${key} is too long.`);
  return v.trim();
}

export function optionalString(d: Data, key: string, maxLen = 2000): string | undefined {
  const v = d[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") fail("invalid-argument", "INVALID_ARGUMENT", `${key} must be text.`);
  if (v.length > maxLen) fail("invalid-argument", "INVALID_ARGUMENT", `${key} is too long.`);
  return v;
}

export function optionalNumber(d: Data, key: string): number | undefined {
  const v = d[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail("invalid-argument", "INVALID_ARGUMENT", `${key} must be a number.`);
  }
  return v;
}

export function optionalStringArray(d: Data, key: string, maxItems = 50): string[] | undefined {
  const v = d[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > maxItems || v.some((x) => typeof x !== "string")) {
    fail("invalid-argument", "INVALID_ARGUMENT", `${key} must be a list of text.`);
  }
  return v as string[];
}

/** A date sent as epoch milliseconds or an ISO-8601 string. */
export function parseDate(v: unknown, key: string): Date | undefined {
  if (v === undefined || v === null) return undefined;
  let date: Date | null = null;
  if (typeof v === "number" && Number.isFinite(v)) date = new Date(v);
  else if (typeof v === "string") date = new Date(v);
  else if (v instanceof Timestamp) date = v.toDate();
  if (!date || Number.isNaN(date.getTime())) {
    fail("invalid-argument", "INVALID_ARGUMENT", `${key} must be epoch milliseconds or an ISO date.`);
  }
  return date;
}

/** "Sat, Nov 1 at 6:00 PM" in the given time zone (UTC if missing/invalid). */
export function formatWhen(date: Date, timeZone?: string): string {
  const fmt = (tz: string) => {
    const day = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
    return `${day} at ${time}`;
  };
  try {
    return fmt(timeZone || "UTC");
  } catch {
    return fmt("UTC");
  }
}
