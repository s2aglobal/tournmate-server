/**
 * Emulator checks for feedback emails (low-mood alert, idempotency, daily
 * digest) using a fake transport. Never sends real mail; demo-* projects only.
 *
 * Usage (from tournmate-server/functions): npm run test:emulator-feedback-email
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore emulator and a demo-* project.");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });

/* eslint-disable @typescript-eslint/no-var-requires */
const mailer = require("../services/mailer") as typeof import("../services/mailer");
const emails = require("../services/feedbackEmails") as typeof import("../services/feedbackEmails");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

type Sent = { subject: string; text: string; html: string };
const sent: Sent[] = [];
mailer.setMailTransportForTests({ sendMail: async (m) => { sent.push(m); } });

async function main(): Promise<void> {
  const db = getFirestore();
  const fb = db.collection("feedback");
  const now = new Date();
  const ago = (h: number) => Timestamp.fromMillis(now.getTime() - h * 3600_000);
  await db.collection("players").doc("P1").set({ name: "Pat Player" });

  const low = await fb.add({ uid: "u1", playerId: "P1", sport: "badminton", mood: 1, tags: ["crashes", "slow"],
    text: "Broke <b>again</b>", appPlatform: "ios", appVersion: "1.8", createdAt: ago(1) });
  const ok3 = await fb.add({ uid: "u2", playerId: "P1", sport: "tennis", mood: 3, tags: ["design"], text: "fine",
    appPlatform: "android", appVersion: "1.1", createdAt: ago(2) });

  // Low mood: sends once
  check("low mood sends", await emails.alertOnFeedback(db, low.id) === true && sent.length === 1);
  const a = sent[0];
  check("alert subject", a.subject === "[TournMate dev] Low feedback: Awful · badminton", a.subject);
  check("alert text has fields", ["Awful", "badminton", "crashes, slow", "Broke <b>again</b>", "Pat Player", "P1", "ios 1.8",
    "America/Chicago".length ? "CST" : "", projectId].every((s) => a.text.includes(s) || (s === "CST" && /C[SD]T/.test(a.text))), a.text);
  check("alert html escapes", a.html.includes("&lt;b&gt;again&lt;/b&gt;") && !a.html.includes("<b>again"));
  check("alertedAt set", !!(await low.get()).data()?.alertedAt);

  // Retry: no resend
  check("retry skipped", await emails.alertOnFeedback(db, low.id) === false && sent.length === 1);

  // Mood 3+: nothing
  check("mood 3 no email", await emails.alertOnFeedback(db, ok3.id) === false && sent.length === 1);

  // Failing transport: no alertedAt, no throw
  const low2 = await fb.add({ uid: "u3", playerId: null, sport: "pickleball", mood: 2, tags: [], text: "", createdAt: ago(3) });
  mailer.setMailTransportForTests({ sendMail: async () => { throw new Error("smtp down"); } });
  check("send failure does not throw or stamp", await emails.alertOnFeedback(db, low2.id) === false
    && !(await low2.get()).data()?.alertedAt);
  mailer.setMailTransportForTests({ sendMail: async (m) => { sent.push(m); } });

  // Old entry excluded from digest
  await fb.add({ uid: "u4", playerId: "P1", sport: "badminton", mood: 5, tags: ["design"], text: "old", createdAt: ago(30) });
  await fb.add({ uid: "u5", playerId: "P1", sport: "badminton", mood: 5, tags: ["design", "brackets"], text: "great", createdAt: ago(4) });

  sent.length = 0;
  const n = await emails.sendFeedbackDigest(db, now);
  check("digest sent once for 4 recent", n === 4 && sent.length === 1, `n=${n} sent=${sent.length}`);
  const d = sent[0];
  check("digest subject", /^\[TournMate dev\] Feedback digest · \d{4}-\d{2}-\d{2} · 4 responses$/.test(d.subject), d.subject);
  check("digest mood counts", d.text.includes("Great (5): 1") && d.text.includes("Okay (3): 1")
    && d.text.includes("Meh (2): 1") && d.text.includes("Awful (1): 1"), d.text);
  check("digest sport counts", d.text.includes("badminton: 2") && d.text.includes("tennis: 1") && d.text.includes("pickleball: 1"));
  check("digest top tags", d.text.includes("design: 2") && d.text.includes("crashes: 1"));
  check("digest lists entries", d.text.includes("great") && d.text.includes("fine") && d.text.includes("Broke <b>again</b>")
    && !d.text.includes("old"));
  check("digest marks alerted", d.text.includes("Awful (1/5) · badminton  [already alerted]")
    && !d.text.includes("Meh (2/5) · pickleball  [already alerted]"));

  // Empty digest
  for (const doc of (await fb.get()).docs) await doc.ref.delete();
  sent.length = 0;
  check("empty digest sends nothing", await emails.sendFeedbackDigest(db, now) === 0 && sent.length === 0);

  console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
