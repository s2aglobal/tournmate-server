/**
 * Emulator checks for push-token cleanup (services/tokenCleanup.ts): the
 * hourly job no longer wipes tokens of players without `lastActiveAt` (the
 * old bug: every account older than 90 days lost its token every hour),
 * still clears players inactive for 90+ days when `lastActiveAt` exists,
 * batches past the 500-write limit, and dead tokens reported by FCM are
 * cleared from players and playerPrivate. Firestore emulator, demo-* only.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-push-tokens
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore emulator and a demo-* project (use npm run test:emulator-push-tokens).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });

/* eslint-disable @typescript-eslint/no-var-requires */
const tc = require("../services/tokenCleanup") as typeof import("../services/tokenCleanup");

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) passes++; else failures++;
}

const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const db = getFirestore();
  const old = Timestamp.fromMillis(Date.now() - 400 * DAY);
  const put = async (prefix: string, n: number, data: (i: number) => Record<string, unknown>) => {
    for (let i = 0; i < n; i += 400) {
      const b = db.batch();
      for (let j = i; j < Math.min(n, i + 400); j++) b.set(db.collection("players").doc(`${prefix}${j}`), data(j));
      await b.commit();
    }
  };
  // 600 old accounts that never had lastActiveAt (every real account today).
  await put("noactive", 600, (i) => ({ name: `P${i}`, createdAt: old, fcmToken: `tok-noactive-${i}` }));
  // 550 players inactive for 120 days (more than one 500-write batch).
  await put("inactive", 550, (i) => ({ name: `I${i}`, createdAt: old, lastActiveAt: Timestamp.fromMillis(Date.now() - 120 * DAY),
    fcmToken: `tok-inactive-${i}` }));
  // Recently active.
  await put("active", 5, (i) => ({ name: `A${i}`, createdAt: old, lastActiveAt: Timestamp.fromMillis(Date.now() - 2 * DAY),
    fcmToken: `tok-active-${i}` }));

  const cleared = await tc.clearStaleTokens(db);
  check("stale cleanup clears only players inactive 90+ days (550, over one batch)", cleared === 550, String(cleared));
  const tokenOf = async (id: string) => (await db.collection("players").doc(id).get()).get("fcmToken");
  check("player without lastActiveAt keeps its token (the bug)", await tokenOf("noactive0") === "tok-noactive-0"
    && await tokenOf("noactive599") === "tok-noactive-599");
  const kept = await db.collection("players").where("fcmToken", ">=", "tok-noactive-").where("fcmToken", "<", "tok-noactive.").count().get();
  check("all 600 accounts without lastActiveAt keep their tokens", kept.data().count === 600, String(kept.data().count));
  check("recently active player keeps its token", await tokenOf("active3") === "tok-active-3");
  check("inactive player's token cleared", await tokenOf("inactive549") === null);
  check("second run is a no-op", (await tc.clearStaleTokens(db)) === 0);

  // Dead token reported by FCM: cleared everywhere it is stored, nothing else.
  await db.collection("players").doc("dead1").set({ name: "D1", fcmToken: "tok-dead" });
  await db.collection("players").doc("dead2").set({ name: "D2", fcmToken: "tok-dead" });
  await db.collection("playerPrivate").doc("dead1").set({ firebaseUid: "u", fcmToken: "tok-dead" });
  await db.collection("players").doc("alive").set({ name: "OK", fcmToken: "tok-alive" });
  const n = await tc.clearInvalidToken(db, "tok-dead");
  check("dead token cleared from players and playerPrivate", n === 3
    && await tokenOf("dead1") === null && await tokenOf("dead2") === null
    && (await db.collection("playerPrivate").doc("dead1").get()).get("fcmToken") === null, String(n));
  check("other tokens untouched", await tokenOf("alive") === "tok-alive");
  check("empty token clears nothing", (await tc.clearInvalidToken(db, "")) === 0);

  check("invalid-token codes recognised", tc.isInvalidTokenError("messaging/registration-token-not-registered")
    && tc.isInvalidTokenError("messaging/invalid-registration-token"));
  check("other FCM errors don't clear tokens", !tc.isInvalidTokenError("messaging/internal-error") && !tc.isInvalidTokenError(undefined));

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
