import { logger } from "firebase-functions/v2";
import { DocumentData, Firestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { canonicalPlayerId, playerById, playerForUid, PlayerRef } from "./identity";
import { ratingTextProblem } from "./ratingText";

/*
 * Sportsmanship reviews (issue 40, shared spec in 40-rating-comments.md).
 *
 *   ratings/{ratingId}         public, VISIBLE reviews only (any signed-in user reads).
 *                              No raterId: named reviews carry raterName / avatar,
 *                              anonymous ones carry nothing about the author.
 *   hiddenRatings/{ratingId}   reviews hidden by reports (status "hidden") or by an
 *                              admin (status "removed"). Only the author can get theirs.
 *   ratingAuthors/{ratingId}   { raterId, raterUid, playerId }. The author can read
 *                              their own (to find "my rating"); nobody else.
 *   ratingReports/{ratingId}_{reporterId}  server-only, one per reporter per review.
 *   players/{id}.sportsmanship { avg, count, withComments, dist } kept by the server.
 *
 * One review per rater per player: ratePlayer finds the existing one through
 * ratingAuthors and replaces it. Rating ids are random, so a public doc id
 * says nothing about who wrote it.
 *
 * Old app versions still write `ratings/{uuid}` directly with `raterId` on the
 * public doc (allowed for one release). onRatingCreated / the backfill call
 * normalizeLegacyRating to move raterId to ratingAuthors and keep one review
 * per pair (the newest).
 */

export const RATINGS = "ratings";
export const HIDDEN_RATINGS = "hiddenRatings";
export const RATING_AUTHORS = "ratingAuthors";
export const RATING_REPORTS = "ratingReports";

export const RATING_MAX_COMMENT = 200;
export const RATING_DAILY_LIMIT = 20;
export const REPORT_DAILY_LIMIT = 20;
/** Reports that hide a review for everyone. */
export const REPORT_HIDE_AT = 3;
export const REPORT_REASONS = ["offensive", "harassment", "spam", "off_topic", "other"] as const;
export type ReportReason = typeof REPORT_REASONS[number];

export type RatingStatus = "visible" | "hidden" | "removed";

export interface Sportsmanship {
  avg: number;
  count: number;
  withComments: number;
  dist: Record<"1" | "2" | "3" | "4" | "5", number>;
}

/** "Arjun Kumar" -> "Arjun K."; "Arjun" -> "Arjun"; blank -> null. */
export function reviewerDisplayName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0].slice(0, 40);
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1];
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

function validStars(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
}

function hasComment(d: DocumentData): boolean {
  return typeof d.comment === "string" && d.comment.trim().length > 0;
}

/** The aggregate over visible rating docs. */
export function sportsmanshipOf(docs: DocumentData[]): Sportsmanship {
  const dist = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let sum = 0;
  let count = 0;
  let withComments = 0;
  for (const d of docs) {
    const s = validStars(d.stars);
    if (s === null) continue;
    dist[String(s) as keyof typeof dist]++;
    sum += s;
    count++;
    if (hasComment(d)) withComments++;
  }
  return { avg: count ? Math.round((sum / count) * 100) / 100 : 0, count, withComments, dist };
}

/** Recounts `players/{playerDocId}.sportsmanship` from the visible ratings. */
export async function refreshSportsmanship(db: Firestore, playerDocId: string): Promise<Sportsmanship | null> {
  const ref = db.collection("players").doc(playerDocId);
  return db.runTransaction(async (tx) => {
    const p = await tx.get(ref);
    if (!p.exists) return null;
    const snap = await tx.get(db.collection(RATINGS).where("playerId", "==", playerDocId));
    const agg = sportsmanshipOf(snap.docs.map((d) => d.data()));
    tx.update(ref, { sportsmanship: agg });
    return agg;
  });
}

/** Author fields copied onto the public doc (null when anonymous). */
function authorFields(rater: PlayerRef | null, anonymous: boolean): Record<string, unknown> {
  if (anonymous || !rater) return { raterName: null, raterAvatarId: null, raterPhotoURL: null };
  return {
    raterName: reviewerDisplayName(rater.data.name),
    raterAvatarId: typeof rater.data.avatarId === "string" && rater.data.avatarId ? rater.data.avatarId : null,
    raterPhotoURL: typeof rater.data.photoURL === "string" && rater.data.photoURL ? rater.data.photoURL : null,
  };
}

/** The author doc for (rater, player), read inside `tx`. */
async function findAuthorDoc(db: Firestore, tx: Transaction, raterId: string, playerDocId: string) {
  const q = db.collection(RATING_AUTHORS).where("raterId", "==", raterId).where("playerId", "==", playerDocId).limit(5);
  const snap = await tx.get(q);
  return snap.docs;
}

export interface UpsertInput {
  rater: PlayerRef;
  target: PlayerRef;
  stars: number;
  comment: string | null;
  anonymous: boolean;
  tournamentId: string | null;
}

export type UpsertResult = { status: "created" | "updated"; ratingId: string } | { error: "SAME_REJECTED_TEXT" };

/**
 * Creates or replaces the rater's one review of `target`. A review that was
 * hidden or removed comes back as visible (reports cleared) unless the
 * comment is unchanged.
 */
export async function upsertRating(db: Firestore, input: UpsertInput): Promise<UpsertResult> {
  const { rater, target } = input;
  const result = await db.runTransaction(async (tx): Promise<UpsertResult> => {
    const authors = await findAuthorDoc(db, tx, rater.id, target.docId);
    const existingId = authors[0]?.id ?? null;
    let prev: DocumentData | null = null;
    let prevHidden = false;
    if (existingId) {
      const vis = await tx.get(db.collection(RATINGS).doc(existingId));
      if (vis.exists) prev = vis.data() ?? null;
      else {
        const hid = await tx.get(db.collection(HIDDEN_RATINGS).doc(existingId));
        if (hid.exists) { prev = hid.data() ?? null; prevHidden = true; }
      }
    }
    if (prevHidden && prev && input.comment && prev.comment === input.comment) {
      return { error: "SAME_REJECTED_TEXT" };
    }
    // Reports on the old text: dropped when a hidden review is rewritten.
    const staleReports = prevHidden && existingId
      ? (await tx.get(db.collection(RATING_REPORTS).where("ratingId", "==", existingId))).docs
      : [];

    const id = existingId ?? db.collection(RATINGS).doc().id;
    const now = Timestamp.now();
    const doc: Record<string, unknown> = {
      playerId: target.docId,
      stars: input.stars,
      comment: input.comment,
      anonymous: input.anonymous,
      ...authorFields(rater, input.anonymous),
      status: "visible",
      reportCount: prevHidden ? 0 : (typeof prev?.reportCount === "number" ? prev.reportCount : 0),
      createdAt: prev?.createdAt instanceof Timestamp ? prev.createdAt : now,
      updatedAt: now,
      tournamentId: input.tournamentId,
    };
    tx.set(db.collection(RATINGS).doc(id), doc);
    if (prevHidden) tx.delete(db.collection(HIDDEN_RATINGS).doc(id));
    for (const r of staleReports) tx.delete(r.ref);
    for (const extra of authors.slice(1)) tx.delete(extra.ref); // should never happen
    tx.set(db.collection(RATING_AUTHORS).doc(id), {
      raterId: rater.id,
      raterUid: rater.data.firebaseUid ?? null,
      playerId: target.docId,
      createdAt: authors[0]?.data().createdAt ?? now,
      updatedAt: now,
    });
    return { status: existingId ? "updated" : "created", ratingId: id };
  });
  if (!("error" in result)) await refreshSportsmanship(db, target.docId);
  return result;
}

/** Deletes the rater's review of `target`. False if there is none. */
export async function deleteOwnRating(db: Firestore, rater: PlayerRef, target: PlayerRef): Promise<boolean> {
  const found = await db.runTransaction(async (tx) => {
    const authors = await findAuthorDoc(db, tx, rater.id, target.docId);
    if (authors.length === 0) return false;
    const reports = (await tx.get(db.collection(RATING_REPORTS)
      .where("ratingId", "in", authors.map((a) => a.id)))).docs;
    for (const a of authors) {
      tx.delete(db.collection(RATINGS).doc(a.id));
      tx.delete(db.collection(HIDDEN_RATINGS).doc(a.id));
      tx.delete(a.ref);
    }
    for (const r of reports) tx.delete(r.ref);
    return true;
  });
  if (found) await refreshSportsmanship(db, target.docId);
  return found;
}

export type ReportResult = "reported" | "already_reported" | "hidden" | "not_found" | "own_review";

/**
 * Records one report. At REPORT_HIDE_AT reports the review moves to
 * hiddenRatings and stops counting toward the average.
 */
export async function reportRatingById(db: Firestore, reporter: PlayerRef, ratingId: string,
  reason: ReportReason, note: string | null): Promise<ReportResult> {
  let playerDocId: string | null = null;
  const result = await db.runTransaction(async (tx): Promise<ReportResult> => {
    const visRef = db.collection(RATINGS).doc(ratingId);
    const hidRef = db.collection(HIDDEN_RATINGS).doc(ratingId);
    const reportRef = db.collection(RATING_REPORTS).doc(`${ratingId}_${reporter.id}`);
    const [vis, hid, author, existing] = await Promise.all([
      tx.get(visRef), tx.get(hidRef), tx.get(db.collection(RATING_AUTHORS).doc(ratingId)), tx.get(reportRef),
    ]);
    if (!vis.exists && !hid.exists) return "not_found";
    const authorId = author.data()?.raterId;
    if (typeof authorId === "string" && canonicalPlayerId(authorId) === reporter.id) return "own_review";
    if (existing.exists) return "already_reported";
    const data = (vis.exists ? vis.data() : hid.data()) ?? {};
    tx.set(reportRef, {
      ratingId,
      playerId: data.playerId ?? null,
      reporterId: reporter.id,
      reason,
      note,
      createdAt: Timestamp.now(),
    });
    if (!vis.exists) return "reported"; // already hidden
    const count = (typeof data.reportCount === "number" ? data.reportCount : 0) + 1;
    if (count >= REPORT_HIDE_AT) {
      tx.set(hidRef, { ...data, reportCount: count, status: "hidden", hiddenAt: Timestamp.now() });
      tx.delete(visRef);
      playerDocId = typeof data.playerId === "string" ? data.playerId : null;
      return "hidden";
    }
    tx.update(visRef, { reportCount: count });
    return "reported";
  });
  if (result === "hidden" && playerDocId) await refreshSportsmanship(db, playerDocId);
  return result;
}

/** Admin: hide/remove a review or make it visible again. False if not found. */
export async function setRatingStatus(db: Firestore, ratingId: string, status: RatingStatus): Promise<boolean> {
  let playerDocId: string | null = null;
  const found = await db.runTransaction(async (tx) => {
    const visRef = db.collection(RATINGS).doc(ratingId);
    const hidRef = db.collection(HIDDEN_RATINGS).doc(ratingId);
    const [vis, hid] = await Promise.all([tx.get(visRef), tx.get(hidRef)]);
    const data = vis.exists ? vis.data() : hid.exists ? hid.data() : null;
    if (!data) return false;
    playerDocId = typeof data.playerId === "string" ? data.playerId : null;
    if (status === "visible") {
      const rest = { ...data };
      delete rest.hiddenAt;
      tx.set(visRef, { ...rest, status: "visible", reportCount: 0 });
      tx.delete(hidRef);
    } else {
      tx.set(hidRef, { ...data, status, hiddenAt: Timestamp.now() });
      tx.delete(visRef);
    }
    return true;
  });
  if (found && playerDocId) await refreshSportsmanship(db, playerDocId);
  return found;
}

/** Resolves a legacy `raterId` (player id in either case, or an auth uid). */
async function resolveRater(db: Firestore, raterId: string, tx?: Transaction): Promise<PlayerRef | null> {
  return (await playerById(db, raterId, tx)) ?? (await playerForUid(db, raterId, tx));
}

function millis(v: unknown): number {
  return v instanceof Timestamp ? v.toMillis() : 0;
}

export type LegacyOutcome = "normalized" | "merged" | "superseded" | "skipped";

/**
 * Normalises one old-shape `ratings/{id}` doc (has `raterId`): moves the
 * author to ratingAuthors, shows it as anonymous, drops a comment that fails
 * the text check, and keeps only the newest review per (rater, player).
 * `dryRun` reports what would happen without writing.
 */
export async function normalizeLegacyRating(db: Firestore, ratingId: string,
  opts: { dryRun?: boolean; refresh?: boolean } = {}): Promise<{ outcome: LegacyOutcome; playerId?: string; droppedComment?: boolean }> {
  const out = await db.runTransaction(async (tx) => {
    const ref = db.collection(RATINGS).doc(ratingId);
    const snap = await tx.get(ref);
    const d = snap.data();
    if (!snap.exists || !d || typeof d.raterId !== "string" || !d.raterId) return { outcome: "skipped" as const };
    const stars = validStars(d.stars);
    if (stars === null || typeof d.playerId !== "string" || !d.playerId) return { outcome: "skipped" as const };

    const rater = await resolveRater(db, d.raterId, tx);
    const raterId = rater ? rater.id : d.raterId;
    const raterUid = rater ? (rater.data.firebaseUid ?? null) : d.raterId;
    const playerDocId: string = d.playerId;
    const authors = (await findAuthorDoc(db, tx, raterId, playerDocId)).filter((a) => a.id !== ratingId);

    // The other review by the same rater (visible or hidden), if any.
    let other: { id: string; data: DocumentData; hidden: boolean } | null = null;
    for (const a of authors) {
      const v = await tx.get(db.collection(RATINGS).doc(a.id));
      if (v.exists) { other = { id: a.id, data: v.data() ?? {}, hidden: false }; break; }
      const h = await tx.get(db.collection(HIDDEN_RATINGS).doc(a.id));
      if (h.exists) { other = { id: a.id, data: h.data() ?? {}, hidden: true }; break; }
    }
    const legacyTime = millis(d.updatedAt) || millis(d.createdAt);
    const otherTime = other ? (millis(other.data.updatedAt) || millis(other.data.createdAt)) : 0;

    if (other && otherTime > legacyTime) {
      if (!opts.dryRun) tx.delete(ref);
      return { outcome: "superseded" as const, playerId: playerDocId };
    }

    const rawComment = typeof d.comment === "string" ? d.comment.trim().slice(0, RATING_MAX_COMMENT) : "";
    const droppedComment = rawComment.length > 0 && ratingTextProblem(rawComment) !== null;
    const comment = rawComment.length > 0 && !droppedComment ? rawComment : null;
    // Keep the existing id when merging so reports on it still apply.
    const id = other ? other.id : ratingId;
    const created = other?.data.createdAt instanceof Timestamp ? other.data.createdAt
      : d.createdAt instanceof Timestamp ? d.createdAt : Timestamp.now();
    const doc: Record<string, unknown> = {
      playerId: playerDocId,
      stars,
      comment,
      // Old ratings were written with no promise that names would show.
      anonymous: true,
      ...authorFields(null, true),
      status: "visible",
      reportCount: 0,
      createdAt: created,
      updatedAt: d.createdAt instanceof Timestamp ? d.createdAt : created,
      tournamentId: typeof d.tournamentId === "string" && d.tournamentId ? d.tournamentId : null,
    };
    if (!opts.dryRun) {
      tx.set(db.collection(RATINGS).doc(id), doc);
      if (other?.hidden) tx.delete(db.collection(HIDDEN_RATINGS).doc(id));
      if (id !== ratingId) tx.delete(ref);
      tx.set(db.collection(RATING_AUTHORS).doc(id), {
        raterId, raterUid, playerId: playerDocId,
        createdAt: created, updatedAt: Timestamp.now(), legacy: true,
      });
      for (const a of authors) if (a.id !== id) tx.delete(a.ref);
    }
    return { outcome: other ? "merged" as const : "normalized" as const, playerId: playerDocId, droppedComment };
  });
  if (!opts.dryRun && opts.refresh !== false && out.playerId) {
    try {
      await refreshSportsmanship(db, out.playerId);
    } catch (e) {
      logger.warn("sportsmanship refresh failed", { playerId: out.playerId, error: e });
    }
  }
  return out;
}
