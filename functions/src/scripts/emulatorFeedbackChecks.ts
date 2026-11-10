/**
 * Emulator checks for the submitFeedback callable (valid input, validation,
 * rate limit). Runs the handler directly (`.run`) against the Firestore
 * emulator; never a real project. Rules deny: tools/rules-test/run-feedback.sh.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-feedback
 *
 * Exits non-zero if any case fails.
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore emulator and a demo-* project (use npm run test:emulator-feedback).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });

/* eslint-disable @typescript-eslint/no-var-requires */
const feedback = require("../callables/feedback") as typeof import("../callables/feedback");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (uid: string | null, data: unknown) => (feedback.submitFeedback as any).run({
  data, auth: uid ? { uid, token: {} } : undefined, rawRequest: {}, acceptsStreaming: false,
});
async function expectFail(name: string, uid: string | null, data: unknown, reason: string, message?: string): Promise<void> {
  try {
    const r = await call(uid, data);
    check(name, false, `expected ${reason}, got ${JSON.stringify(r)}`);
  } catch (e) {
    const err = e as { message?: string; details?: { reason?: string } };
    check(name, err.details?.reason === reason && (message === undefined || err.message === message),
      `${err.details?.reason}: ${err.message}`);
  }
}

const ME = { id: "CCCCCCCC-0000-0000-0000-000000000001", uid: "u-fb" };
const NOPROFILE_UID = "u-fb-none";
const valid = { sport: "badminton", mood: 5, tags: ["design", "brackets"], text: "  Love it  ", platform: "ios", appVersion: "1.8" };

async function main(): Promise<void> {
  const db = getFirestore();
  await db.collection("players").doc(ME.id).set({ name: "Fb", firebaseUid: ME.uid });
  const feedbackFor = async (uid: string) => (await db.collection("feedback").where("uid", "==", uid).get()).docs;

  // Valid
  const r = await call(ME.uid, valid);
  check("valid feedback returns sent", r?.status === "sent", JSON.stringify(r));
  const docs = await feedbackFor(ME.uid);
  const f = docs[0]?.data();
  check("doc written once", docs.length === 1);
  check("doc fields", !!f && f.sport === "badminton" && f.mood === 5 && f.playerId === ME.id && f.text === "Love it"
    && f.appPlatform === "ios" && f.appVersion === "1.8" && JSON.stringify(f.tags) === '["design","brackets"]'
    && f.createdAt instanceof Timestamp, JSON.stringify(f));
  const r2 = await call(ME.uid, { sport: "tennis", mood: 2 });
  check("tags and text optional", r2?.status === "sent");

  // Invalid
  await expectFail("signed out", null, valid, "UNAUTHENTICATED");
  await expectFail("no profile", NOPROFILE_UID, valid, "NO_PROFILE");
  await expectFail("unknown sport", ME.uid, { ...valid, sport: "chess" }, "INVALID_ARGUMENT");
  await expectFail("missing sport", ME.uid, { mood: 3 }, "INVALID_ARGUMENT");
  for (const mood of [0, 6, 2.5, "3", null]) {
    await expectFail(`mood ${JSON.stringify(mood)}`, ME.uid, { ...valid, mood }, "INVALID_ARGUMENT");
  }
  await expectFail("unknown tag", ME.uid, { ...valid, tags: ["nope"] }, "INVALID_ARGUMENT");
  await expectFail("tags not a list", ME.uid, { ...valid, tags: "design" }, "INVALID_ARGUMENT");
  await expectFail("more than 8 tags", ME.uid, { ...valid, tags: Array(9).fill("design") }, "INVALID_ARGUMENT");
  await expectFail("text over 1000", ME.uid, { ...valid, text: "x".repeat(1001) }, "INVALID_ARGUMENT");
  const r3 = await call(ME.uid, { ...valid, text: "x".repeat(1000) });
  check("text of exactly 1000 accepted", r3?.status === "sent");
  check("invalid calls wrote nothing", (await feedbackFor(ME.uid)).length === 3);

  // Rate limit: 5 per 24h
  await call(ME.uid, valid);
  await call(ME.uid, valid);
  check("5 accepted", (await feedbackFor(ME.uid)).length === 5);
  await expectFail("6th in 24h rate limited", ME.uid, valid, "RATE_LIMITED",
    "You've sent a lot of feedback today. Thanks — try again tomorrow.");
  // Older than 24h doesn't count.
  const oldest = (await feedbackFor(ME.uid))[0];
  await oldest.ref.update({ createdAt: Timestamp.fromMillis(Date.now() - 25 * 60 * 60 * 1000) });
  const r4 = await call(ME.uid, valid);
  check("accepted again once one is older than 24h", r4?.status === "sent");

  console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
