import { HttpsError, FunctionsErrorCode } from "firebase-functions/v2/https";

/**
 * Machine-readable reasons sent in `HttpsError.details.reason`. Apps branch
 * on these; `message` is user-facing and shown as-is. Shared specs:
 * server-authority-spec.md, profile-photos-spec.md, cricket-live-contract.md,
 * racket-live-contract.md, live-stream-contract.md.
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
  | "NOT_FINISHED"
  | "PHOTO_REJECTED"
  | "PHOTO_CHECK_FAILED"
  | "RATE_LIMITED"
  | "NOT_SCORER"
  | "SCORER_ACTIVE"
  | "LINEUP_LOCKED"
  | "INVALID_BALL"
  | "INNINGS_OVER"
  | "MATCH_FINISHED"
  | "INVALID_POINT"
  | "LIVE_SCORING_DISABLED"
  | "LIVE_STREAMING_DISABLED"
  | "PLAYERS_NOT_AGREED"
  | "STREAM_ACTIVE"
  | "STREAM_ENDED"
  | "TOURNAMENT_CLOSED"
  | "CREW_FULL"
  | "INVITE_INVALID"
  | "NOT_INVITED"
  | "NOT_REGISTERED"
  | "IS_ORGANIZER"
  | "YOUTUBE_NOT_CONNECTED"
  | "YOUTUBE_AUTH_EXPIRED"
  | "YOUTUBE_LIVE_NOT_ENABLED"
  | "YOUTUBE_QUOTA"
  | "YOUTUBE_ERROR"
  | "YOUTUBE_NOT_CONFIGURED"
  | "YOUTUBE_CODE_INVALID"
  | "YOUTUBE_SCOPE_MISSING"
  | "YOUTUBE_NO_CHANNEL"
  | "INVALID_ARGUMENT";

/** Throws `HttpsError(code, message, { reason })`. */
export function fail(code: FunctionsErrorCode, reason: FailReason, message: string): never {
  throw new HttpsError(code, message, { reason });
}
