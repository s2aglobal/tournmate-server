import { Firestore, Timestamp } from "firebase-admin/firestore";
import { currentProjectId, MailMessage, sendMail, subjectPrefix } from "./mailer";
import { formatTime } from "./feedbackEmails";
import { HIDDEN_RATINGS, RATING_AUTHORS, RATING_REPORTS, RATINGS } from "./ratings";

/*
 * Daily admin email listing sportsmanship review reports from the last 24
 * hours (same mailer, secrets and recipient as the feedback digest). Grouped
 * by review: text, stars, current status, report count and reasons, the rated
 * player and the author (admins only; never shown in the apps).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = "America/Chicago";

export interface ReportedReview {
  ratingId: string;
  status: string;
  stars: number | null;
  comment: string | null;
  anonymous: boolean;
  playerId: string | null;
  playerName: string | null;
  raterId: string | null;
  raterName: string | null;
  reportCount: number;
  reports: { reporterId: string; reason: string; note: string | null; createdAt: Date | null }[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function nameOf(db: Firestore, id: string | null, cache: Map<string, string | null>): Promise<string | null> {
  if (!id) return null;
  if (!cache.has(id)) {
    const snap = await db.collection("players").doc(id).get();
    const n = snap.exists ? snap.data()?.name : null;
    cache.set(id, typeof n === "string" ? n : null);
  }
  return cache.get(id) ?? null;
}

/** Reports created in (now - 24h, now], grouped by review. */
export async function collectReportedReviews(db: Firestore, now: Date): Promise<ReportedReview[]> {
  const snap = await db.collection(RATING_REPORTS)
    .where("createdAt", ">", Timestamp.fromMillis(now.getTime() - DAY_MS))
    .where("createdAt", "<=", Timestamp.fromDate(now)).get();
  const byRating = new Map<string, ReportedReview["reports"]>();
  for (const doc of snap.docs) {
    const d = doc.data();
    const list = byRating.get(d.ratingId) ?? [];
    list.push({
      reporterId: String(d.reporterId ?? ""),
      reason: String(d.reason ?? "other"),
      note: typeof d.note === "string" ? d.note : null,
      createdAt: d.createdAt instanceof Timestamp ? d.createdAt.toDate() : null,
    });
    byRating.set(d.ratingId, list);
  }
  const names = new Map<string, string | null>();
  const out: ReportedReview[] = [];
  for (const [ratingId, reports] of byRating) {
    const [vis, hid, author] = await Promise.all([
      db.collection(RATINGS).doc(ratingId).get(),
      db.collection(HIDDEN_RATINGS).doc(ratingId).get(),
      db.collection(RATING_AUTHORS).doc(ratingId).get(),
    ]);
    const r = (vis.exists ? vis.data() : hid.data()) ?? {};
    const status = vis.exists ? "visible" : hid.exists ? String(r.status ?? "hidden") : "deleted";
    const playerId = typeof r.playerId === "string" ? r.playerId : null;
    const raterId = typeof author.data()?.raterId === "string" ? author.data()?.raterId : null;
    out.push({
      ratingId, status,
      stars: typeof r.stars === "number" ? r.stars : null,
      comment: typeof r.comment === "string" ? r.comment : null,
      anonymous: r.anonymous === true,
      playerId, playerName: await nameOf(db, playerId, names),
      raterId, raterName: await nameOf(db, raterId, names),
      reportCount: typeof r.reportCount === "number" ? r.reportCount : reports.length,
      reports,
    });
  }
  return out.sort((a, b) => b.reportCount - a.reportCount || a.ratingId.localeCompare(b.ratingId));
}

export function buildReportDigestMessage(reviews: ReportedReview[], now: Date, projectId = currentProjectId()): MailMessage {
  const n = reviews.reduce((s, r) => s + r.reports.length, 0);
  const hidden = reviews.filter((r) => r.status === "hidden").length;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const who = (name: string | null, id: string | null) => (id ? `${name ?? "(no name)"} (${id})` : "unknown");
  const lines = (r: ReportedReview): string[] => [
    `Review ${r.ratingId} · ${r.status.toUpperCase()} · ${r.reportCount} report(s) total`,
    `  Stars: ${r.stars ?? "?"}/5${r.anonymous ? " · posted anonymously" : ""}`,
    `  Comment: ${r.comment ?? "(none)"}`,
    `  About: ${who(r.playerName, r.playerId)}`,
    `  Author: ${who(r.raterName, r.raterId)}`,
    ...r.reports.map((x) => `  Report: ${x.reason}${x.note ? ` "${x.note}"` : ""} by ${x.reporterId} at ${formatTime(x.createdAt)}`),
    `  Remove: npm run moderate:rating -- --project ${projectId} --rating ${r.ratingId} --status removed`,
  ];
  const head = `Review reports in the last 24 hours (${projectId}): ${n} report(s) on ${reviews.length} review(s), ${hidden} hidden by reports`;
  const text = [head, "", ...reviews.flatMap((r) => [...lines(r), ""])].join("\n");
  const html = `<p><b>${esc(head)}</b></p><hr>`
    + reviews.map((r) => `<p>${lines(r).map((l) => esc(l.trim())).join("<br>")}</p>`).join("");
  return { subject: `${subjectPrefix(projectId)} Review reports · ${date} · ${n} reports`, text, html };
}

/** Emails one digest of the last 24h of review reports; sends nothing if there are none. Returns the report count. */
export async function sendRatingReportDigest(db: Firestore, now: Date): Promise<number> {
  const reviews = await collectReportedReviews(db, now);
  if (reviews.length === 0) return 0;
  await sendMail(buildReportDigestMessage(reviews, now));
  return reviews.reduce((s, r) => s + r.reports.length, 0);
}
