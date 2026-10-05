/**
 * Deletes the QA seed data written by seedQaTournaments.ts from
 * **tournmate-dev only**: every doc with `qaSeed == true` in tournaments,
 * registrations, matches, notifications and playSessions. Nothing else is
 * touched (the query is the only selector).
 *
 * Usage (from tournmate-server/functions):
 *   npm run build && node lib/scripts/cleanupQaTournaments.js --dry-run
 *   npm run build && node lib/scripts/cleanupQaTournaments.js
 *
 * Optional: --include-notifications also deletes inbox notifications that the
 * server triggers wrote for QA tournaments/sessions (they carry no qaSeed
 * marker; selected strictly by tournamentId/sessionId of a QA doc).
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROJECT_ID = "tournmate-dev";
const COLLECTIONS = ["tournaments", "registrations", "matches", "notifications", "playSessions"];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const includeNotifications = args.includes("--include-notifications");

  for (const v of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]) {
    const val = process.env[v];
    if (val && val !== PROJECT_ID) {
      console.error(`Refusing to run: ${v}=${val} (expected ${PROJECT_ID}).`);
      process.exit(1);
    }
  }
  if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();

  await db.collection("config").doc("sports").get();
  const connected = (db as unknown as { projectId: string }).projectId;
  console.log(`Connected project: ${connected}${dryRun ? " (dry run)" : ""}`);
  if (connected !== PROJECT_ID) {
    console.error(`Refusing to run: connected to ${connected}, expected ${PROJECT_ID}.`);
    process.exit(1);
  }

  let total = 0;

  // Trigger-written notifications for QA docs: collect QA ids before anything is deleted.
  if (includeNotifications) {
    const qaIds = new Set<string>();
    for (const name of ["tournaments", "playSessions"]) {
      const snap = await db.collection(name).where("qaSeed", "==", true).get();
      snap.docs.forEach((d) => qaIds.add(d.id));
    }
    const ids = [...qaIds].flatMap((id) => [id, id.toUpperCase(), id.toLowerCase()]);
    const unique = [...new Set(ids)];
    const toDelete = new Map<string, FirebaseFirestore.DocumentReference>();
    for (const field of ["tournamentId", "sessionId"]) {
      for (let i = 0; i < unique.length; i += 30) {
        const snap = await db.collection("notifications").where(field, "in", unique.slice(i, i + 30)).get();
        snap.docs.forEach((d) => toDelete.set(d.id, d.ref));
      }
    }
    console.log(`\nnotifications linked to QA docs: ${toDelete.size}`);
    if (!dryRun) {
      const refs = [...toDelete.values()];
      for (let i = 0; i < refs.length; i += 400) {
        const batch = db.batch();
        refs.slice(i, i + 400).forEach((r) => batch.delete(r));
        await batch.commit();
      }
    }
    total += toDelete.size;
  }

  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).where("qaSeed", "==", true).get();
    console.log(`\n${name}: ${snap.size} QA doc(s)`);
    for (const doc of snap.docs) {
      // Belt and braces: never delete a doc that isn't marked, whatever the query returned.
      if (doc.get("qaSeed") !== true) continue;
      console.log(`  ${dryRun ? "would delete" : "delete"} ${doc.id}  ${doc.get("title") ?? ""}`);
    }
    if (!dryRun) {
      const docs = snap.docs.filter((d) => d.get("qaSeed") === true);
      for (let i = 0; i < docs.length; i += 400) {
        const batch = db.batch();
        docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    }
    total += snap.size;
  }
  console.log(`\n${dryRun ? "Would delete" : "Deleted"} ${total} doc(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
  });
