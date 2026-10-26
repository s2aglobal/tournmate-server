import { FunctionsErrorCode, HttpsError } from "firebase-functions/v2/https";

/** `details.reason` codes shared by every callable (see the server-authority spec). */
export type FailReason =
  | "UNAUTHENTICATED"
  | "NO_PROFILE"
  | "NOT_FOUND"
  | "NOT_ORGANIZER"
  | "NOT_HOST"
  | "NOT_PARTICIPANT"
  | "SESSION_FULL"
  | "SESSION_CLOSED"
  | "SESSION_CLASH"
  | "HOST_LIMIT"
  | "GENDER_REQUIRED"
  | "GENDER_SLOT_FULL"
  | "GENDER_LOCKED"
  | "FIELDS_LOCKED"
  | "SPORT_NOT_ALLOWED"
  | "REG_CLOSED"
  | "REG_FULL"
  | "ALREADY_REGISTERED"
  | "ALREADY_ENTERED_TEAM"
  | "INVALID_SCORE"
  | "SCORE_LOCKED"
  | "DRAW_EXISTS"
  | "DRAW_LOCKED"
  | "TOO_FEW_ENTRIES"
  | "INVALID_ARGUMENT";

/**
 * Throws an `HttpsError`. `message` is user-facing (apps show it as-is);
 * `reason` is the machine-readable code in `details.reason`.
 */
export function fail(code: FunctionsErrorCode, reason: FailReason, message: string): never {
  throw new HttpsError(code, message, { reason });
}
