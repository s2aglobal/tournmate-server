import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { fail } from "./errors";
import { CALLABLE_OPTS, dataOf, optionalString, requirePlayer, requireString, requireUid } from "./shared";
import { playerById } from "../services/identity";
import { ratingTextProblem, textModerator } from "../services/ratingText";
import {
  deleteOwnRating, RATING_AUTHORS, RATING_DAILY_LIMIT, RATING_MAX_COMMENT, RATING_REPORTS, REPORT_DAILY_LIMIT,
  REPORT_REASONS, ReportReason, reportRatingById, upsertRating,
} from "../services/ratings";

const DAY_MS = 24 * 60 * 60 * 1000;
const REJECTED_MESSAGE = "Please keep it respectful. Edit your comment and try again.";

/**
 * ratePlayer({ playerId, stars: 1..5, comment?, anonymous?, tournamentId? })
 *   -> { status: "created" | "updated", ratingId }
 * One review per rater per player; a second call replaces it. Comments are
 * trimmed, max 200, and must pass the text check (no profanity, links, emails
 * or phone numbers). `anonymous` defaults to false (named).
 */
export const ratePlayer = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const playerId = requireString(d, "playerId", 128);
  const stars = d.stars;
  if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Choose 1 to 5 stars.");
  }
  // Allow a little slack for whitespace the apps trim anyway.
  const rawComment = optionalString(d, "comment", RATING_MAX_COMMENT + 50);
  const comment = rawComment?.trim() ? rawComment.trim() : null;
  if (comment && comment.length > RATING_MAX_COMMENT) {
    fail("invalid-argument", "INVALID_ARGUMENT", `Comments can be up to ${RATING_MAX_COMMENT} characters.`);
  }
  if (d.anonymous !== undefined && d.anonymous !== null && typeof d.anonymous !== "boolean") {
    fail("invalid-argument", "INVALID_ARGUMENT", "anonymous must be true or false.");
  }
  const anonymous = d.anonymous === true;
  const tournamentId = optionalString(d, "tournamentId", 128)?.trim() || null;

  const db = getFirestore();
  const me = await requirePlayer(db, uid);
  const target = await playerById(db, playerId);
  if (!target) fail("not-found", "NOT_FOUND", "That player no longer exists.");
  if (target.id === me.id) fail("failed-precondition", "SELF_RATING", "You can't rate yourself.");

  if (comment) {
    let verdict: "pass" | "reject";
    try {
      verdict = await textModerator()(comment);
    } catch (e) {
      logger.error("rating text check failed", e);
      fail("unavailable", "RATING_CHECK_FAILED", "We couldn't check your comment. Try again in a moment.");
    }
    if (verdict === "reject") {
      logger.info("rating comment rejected", { raterId: me.id, reason: ratingTextProblem(comment) ?? "moderator" });
      fail("invalid-argument", "RATING_TEXT_REJECTED", REJECTED_MESSAGE);
    }
  }

  const since = Timestamp.fromMillis(Date.now() - DAY_MS);
  const recent = await db.collection(RATING_AUTHORS)
    .where("raterId", "==", me.id).where("updatedAt", ">=", since).count().get();
  if (recent.data().count >= RATING_DAILY_LIMIT) {
    fail("resource-exhausted", "RATE_LIMITED", "You've rated a lot of players today. Try again tomorrow.");
  }

  const r = await upsertRating(db, { rater: me, target, stars, comment, anonymous, tournamentId });
  if ("error" in r) fail("invalid-argument", "RATING_TEXT_REJECTED", "Change your comment before posting it again.");
  return r;
});

/** deleteRating({ playerId }) -> { status: "deleted" }. Deletes the caller's review of that player. */
export const deleteRating = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const playerId = requireString(d, "playerId", 128);
  const db = getFirestore();
  const me = await requirePlayer(db, uid);
  const target = await playerById(db, playerId);
  if (!target) fail("not-found", "NOT_FOUND", "That player no longer exists.");
  const ok = await deleteOwnRating(db, me, target);
  if (!ok) fail("not-found", "NOT_FOUND", "You haven't rated this player.");
  return { status: "deleted" as const };
});

/**
 * reportRating({ ratingId, reason, note? }) -> { status: "reported" | "already_reported" | "hidden" }
 * reason: offensive | harassment | spam | off_topic | other. Hidden for everyone at 3 reports.
 */
export const reportRating = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);
  const ratingId = requireString(d, "ratingId", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(ratingId)) fail("invalid-argument", "INVALID_ARGUMENT", "Unknown review.");
  const reason = d.reason;
  if (typeof reason !== "string" || !REPORT_REASONS.includes(reason as ReportReason)) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Choose a reason.");
  }
  const note = optionalString(d, "note", 300)?.trim() || null;
  const db = getFirestore();
  const me = await requirePlayer(db, uid);

  const since = Timestamp.fromMillis(Date.now() - DAY_MS);
  const recent = await db.collection(RATING_REPORTS)
    .where("reporterId", "==", me.id).where("createdAt", ">=", since).count().get();
  if (recent.data().count >= REPORT_DAILY_LIMIT) {
    fail("resource-exhausted", "RATE_LIMITED", "You've sent a lot of reports today. Try again tomorrow.");
  }

  const r = await reportRatingById(db, me, ratingId, reason as ReportReason, note);
  if (r === "not_found") fail("not-found", "NOT_FOUND", "This review was already removed.");
  if (r === "own_review") fail("failed-precondition", "OWN_REVIEW", "You can't report your own review.");
  return { status: r };
});
