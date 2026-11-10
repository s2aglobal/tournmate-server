import { onCall } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { fail } from "./errors";
import { CALLABLE_OPTS, dataOf, optionalString, requirePlayer, requireUid } from "./shared";
import { CATALOG_SPORT_IDS } from "../config/sportsCatalog";

export const FEEDBACK_MAX_TEXT = 1000;
export const FEEDBACK_MAX_TAGS = 8;
export const FEEDBACK_DAILY_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Tag ids the apps send (same on iOS and Android). */
export const FEEDBACK_TAGS: readonly string[] = [
  "sets_tiebreaks", "easy_to_use", "brackets", "live_scores", "design", "finding_courts",
  "rally_scoring", "crashes", "slow", "confusing", "missing_feature",
];

/**
 * submitFeedback({ sport, mood: 1..5, tags: string[], text?, platform?, appVersion? }) -> { status: "sent" }
 * Stores `feedback/{autoId}`. Max 5 per user per 24 hours.
 */
export const submitFeedback = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const d = dataOf(req);

  const sport = d.sport;
  if (typeof sport !== "string" || !CATALOG_SPORT_IDS.includes(sport as never)) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Choose a sport.");
  }
  const mood = d.mood;
  if (typeof mood !== "number" || !Number.isInteger(mood) || mood < 1 || mood > 5) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Choose how you feel.");
  }
  const tagsRaw = d.tags ?? [];
  if (!Array.isArray(tagsRaw) || tagsRaw.length > FEEDBACK_MAX_TAGS
      || tagsRaw.some((t) => typeof t !== "string" || !FEEDBACK_TAGS.includes(t))) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Those tags aren't valid.");
  }
  const tags = [...new Set(tagsRaw as string[])];
  const text = (optionalString(d, "text", FEEDBACK_MAX_TEXT) ?? "").trim();
  const platform = d.platform === "ios" || d.platform === "android" ? d.platform : null;
  const appVersion = optionalString(d, "appVersion", 40)?.trim() || null;

  const db = getFirestore();
  const me = await requirePlayer(db, uid);

  const since = Timestamp.fromMillis(Date.now() - DAY_MS);
  const recent = await db.collection("feedback")
    .where("uid", "==", uid).where("createdAt", ">=", since).count().get();
  if (recent.data().count >= FEEDBACK_DAILY_LIMIT) {
    fail("failed-precondition", "RATE_LIMITED", "You've sent a lot of feedback today. Thanks — try again tomorrow.");
  }

  await db.collection("feedback").add({
    uid,
    playerId: me.id,
    sport,
    mood,
    tags,
    text,
    appPlatform: platform,
    appVersion,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { status: "sent" as const };
});
