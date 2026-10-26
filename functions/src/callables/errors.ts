import { HttpsError, FunctionsErrorCode } from "firebase-functions/v2/https";

/**
 * Machine-readable reasons sent in `HttpsError.details.reason`. Apps branch
 * on these; `message` is user-facing and shown as-is. Shared spec:
 * server-authority-spec.md.
 */
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

/** Throws `HttpsError(code, message, { reason })`. */
export function fail(code: FunctionsErrorCode, reason: FailReason, message: string): never {
  throw new HttpsError(code, message, { reason });
}
