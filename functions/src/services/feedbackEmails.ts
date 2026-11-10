import { logger } from "firebase-functions/v2";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import { currentProjectId, MailMessage, sendMail, subjectPrefix } from "./mailer";

export const MOOD_LABELS: Record<number, string> = { 1: "Awful", 2: "Meh", 3: "Okay", 4: "Good", 5: "Great" };
export const LOW_MOOD_MAX = 2;
const TZ = "America/Chicago";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FeedbackEntry {
  id: string;
  mood: number;
  sport: string;
  tags: string[];
  text: string;
  playerId: string | null;
  playerName: string | null;
  platform: string | null;
  appVersion: string | null;
  createdAt: Date | null;
  alerted: boolean;
}

const moodLabel = (m: number): string => MOOD_LABELS[m] ?? String(m);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatTime(d: Date | null): string {
  if (!d) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(d);
}

function formatDate(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return p; // YYYY-MM-DD
}

async function toEntry(db: Firestore, id: string, d: FirebaseFirestore.DocumentData,
  names: Map<string, string | null>): Promise<FeedbackEntry> {
  const playerId = typeof d.playerId === "string" && d.playerId ? d.playerId : null;
  let playerName: string | null = null;
  if (playerId) {
    if (!names.has(playerId)) {
      const snap = await db.collection("players").doc(playerId).get();
      const n = snap.exists ? snap.data()?.name : null;
      names.set(playerId, typeof n === "string" ? n : null);
    }
    playerName = names.get(playerId) ?? null;
  }
  const created = d.createdAt;
  return {
    id,
    mood: Number(d.mood),
    sport: String(d.sport ?? "unknown"),
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    text: typeof d.text === "string" ? d.text : "",
    playerId,
    playerName,
    platform: d.appPlatform ?? null,
    appVersion: d.appVersion ?? null,
    createdAt: created instanceof Timestamp ? created.toDate() : null,
    alerted: !!d.alertedAt,
  };
}

function playerLine(e: FeedbackEntry): string {
  if (!e.playerId) return "unknown";
  return `${e.playerName ?? "(no name)"} (${e.playerId})`;
}
function appLine(e: FeedbackEntry): string {
  return `${e.platform ?? "unknown"} ${e.appVersion ?? ""}`.trim();
}

export function buildAlertMessage(e: FeedbackEntry, projectId = currentProjectId()): MailMessage {
  const rows: [string, string][] = [
    ["Mood", `${moodLabel(e.mood)} (${e.mood}/5)`],
    ["Sport", e.sport],
    ["Tags", e.tags.join(", ") || "none"],
    ["Comment", e.text || "(none)"],
    ["Player", playerLine(e)],
    ["App", appLine(e)],
    ["Time", formatTime(e.createdAt)],
    ["Project", projectId],
  ];
  return {
    subject: `${subjectPrefix(projectId)} Low feedback: ${moodLabel(e.mood)} · ${e.sport}`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
    html: `<table cellpadding="4">${rows.map(([k, v]) =>
      `<tr><td><b>${k}</b></td><td>${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("")}</table>`,
  };
}

/**
 * Emails immediately for low-mood feedback, then stamps `alertedAt`.
 * Idempotent (skips if already alerted) and never throws.
 */
export async function alertOnFeedback(db: Firestore, id: string): Promise<boolean> {
  try {
    const ref = db.collection("feedback").doc(id);
    const snap = await ref.get();
    const d = snap.data();
    if (!d || d.alertedAt) return false;
    if (typeof d.mood !== "number" || d.mood > LOW_MOOD_MAX) return false;
    const entry = await toEntry(db, id, d, new Map());
    if (!(await sendMail(buildAlertMessage(entry)))) return false;
    await ref.update({ alertedAt: Timestamp.now() });
    return true;
  } catch (e) {
    logger.error("feedback alert failed", { id, error: e });
    return false;
  }
}

export function buildDigestMessage(entries: FeedbackEntry[], now: Date, projectId = currentProjectId()): MailMessage {
  const n = entries.length;
  const count = (key: (e: FeedbackEntry) => string[]): [string, number][] => {
    const m = new Map<string, number>();
    for (const e of entries) for (const k of key(e)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const byMood = [5, 4, 3, 2, 1].map((m) => [`${moodLabel(m)} (${m})`, entries.filter((e) => e.mood === m).length] as [string, number])
    .filter(([, c]) => c > 0);
  const bySport = count((e) => [e.sport]);
  const topTags = count((e) => e.tags).slice(0, 5);
  const fmt = (xs: [string, number][]): string => xs.map(([k, c]) => `${k}: ${c}`).join(", ") || "none";

  const sorted = [...entries].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  const entryLines = (e: FeedbackEntry): string[] => [
    `${moodLabel(e.mood)} (${e.mood}/5) · ${e.sport}${e.alerted ? "  [already alerted]" : ""}`,
    `  Tags: ${e.tags.join(", ") || "none"}`,
    `  Comment: ${e.text || "(none)"}`,
    `  Player: ${playerLine(e)}`,
    `  App: ${appLine(e)}`,
    `  Time: ${formatTime(e.createdAt)}`,
  ];
  const text = [
    `Feedback in the last 24 hours (${projectId})`,
    `By mood: ${fmt(byMood)}`,
    `By sport: ${fmt(bySport)}`,
    `Top tags: ${fmt(topTags)}`,
    "",
    ...sorted.flatMap((e) => [...entryLines(e), ""]),
  ].join("\n");
  const html = `<p><b>Feedback in the last 24 hours</b> (${esc(projectId)})</p>`
    + `<p>By mood: ${esc(fmt(byMood))}<br>By sport: ${esc(fmt(bySport))}<br>Top tags: ${esc(fmt(topTags))}</p><hr>`
    + sorted.map((e) => `<p>${entryLines(e).map((l) => esc(l.trim())).join("<br>")}</p>`).join("");
  return { subject: `${subjectPrefix(projectId)} Feedback digest · ${formatDate(now)} · ${n} responses`, text, html };
}

/** Emails one digest of feedback from the 24 hours before `now`; sends nothing if there is none. */
export async function sendFeedbackDigest(db: Firestore, now: Date): Promise<number> {
  const snap = await db.collection("feedback")
    .where("createdAt", ">=", Timestamp.fromMillis(now.getTime() - DAY_MS))
    .where("createdAt", "<=", Timestamp.fromDate(now)).get();
  if (snap.empty) return 0;
  const names = new Map<string, string | null>();
  const entries: FeedbackEntry[] = [];
  for (const doc of snap.docs) entries.push(await toEntry(db, doc.id, doc.data(), names));
  await sendMail(buildDigestMessage(entries, now));
  return entries.length;
}
