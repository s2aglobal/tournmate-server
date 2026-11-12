/**
 * Deletes the QA seed data written by seedQaTournaments.ts from
 * **tournmate-dev only**: every doc with `qaSeed == true` in tournaments,
 * registrations, matches, notifications, playSessions, teams and
 * teamEntries (seedQaTournaments.ts, seedQaCricket.ts and
 * seedQaBadmintonLive.ts). Also, selected strictly by the id of a QA doc:
 * - matches and registrations of QA tournaments that carry no marker
 *   (written by generateDraw / advanceRound or by registering in the app);
 * - every subcollection of those matches and of QA matches (live scoring:
 *   `points`, `racketLive`, `balls`, `cricketLive`), deleted recursively;
 * - `standings/{tournamentId}` of each QA tournament (built by the
 *   onMatchWritten trigger).
 * Nothing else is touched.
 *
 * Usage (from tournmate-server/functions):
 *   npm run build && node lib/scripts/cleanupQaTournaments.js --dry-run
 *   npm run build && node lib/scripts/cleanupQaTournaments.js
 *
 * Optional: --include-notifications also deletes inbox notifications that the
 * server triggers wrote for QA tournaments/sessions (they carry no qaSeed
 * marker; selected strictly by tournamentId/sessionId of a QA doc).
 *
 * --emulator: run against the Firestore emulator instead (only with
 * FIRESTORE_EMULATOR_HOST set and a demo-* project id).
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DEV_PROJECT_ID = "tournmate-dev";
const COLLECTIONS = ["tournaments", "registrations", "matches", "notifications", "playSessions", "teams", "teamEntries"];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const includeNotifications = args.includes("--include-notifications");
  const emulator = args.includes("--emulator");

  let PROJECT_ID = DEV_PROJECT_ID;
  if (emulator) {
    const pid = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
    if (!process.env.FIRESTORE_EMULATOR_HOST || !pid.startsWith("demo-")) {
      console.error("Refusing to run: --emulator needs FIRESTORE_EMULATOR_HOST and a demo-* project id.");
      process.exit(1);
    }
    PROJECT_ID = pid;
  } else {
    for (const v of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]) {
      const val = process.env[v];
      if (val && val !== PROJECT_ID) {
        console.error(`Refusing to run: ${v}=${val} (expected ${PROJECT_ID}).`);
        process.exit(1);
      }
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

  // Docs the server or the apps wrote for QA tournaments (no qaSeed marker),
  // selected strictly by the id of a QA tournament: matches created by
  // generateDraw / advanceRound, registrations made in the app, and the
  // `standings` doc. Plus every subcollection of those and of QA matches
  // (live scoring: points, racketLive, balls, cricketLive). Collected before
  // the parents are deleted (they're found through them).
  {
    const tournaments = (await db.collection("tournaments").where("qaSeed", "==", true).get())
      .docs.filter((t) => t.get("qaSeed") === true);
    const variants = [...new Set(tournaments.flatMap((t) => [t.id, t.id.toUpperCase(), t.id.toLowerCase()]))];
    const titles = new Map(tournaments.map((t) => [t.id.toUpperCase(), String(t.get("title") ?? "")]));

    const linked = async (name: string) => {
      const docs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
      for (let i = 0; i < variants.length; i += 30) {
        const snap = await db.collection(name).where("tournamentId", "in", variants.slice(i, i + 30)).get();
        snap.docs.forEach((d) => docs.set(d.id, d));
      }
      return [...docs.values()];
    };

    const qaMatches = (await db.collection("matches").where("qaSeed", "==", true).get()).docs.filter((d) => d.get("qaSeed") === true);
    const allMatches = new Map(qaMatches.map((d) => [d.id, d]));
    let unmarked = 0;
    for (const name of ["matches", "registrations"]) {
      for (const d of await linked(name)) {
        if (name === "matches") allMatches.set(d.id, d);
        if (d.get("qaSeed") === true) continue;
        unmarked++;
        console.log(`  ${dryRun ? "would delete" : "delete"} ${name}/${d.id} (unmarked, in ${titles.get(String(d.get("tournamentId")).toUpperCase()) ?? "QA tournament"})`);
      }
    }

    let subDocs = 0;
    for (const m of allMatches.values()) {
      for (const sub of await m.ref.listCollections()) {
        const n = (await sub.count().get()).data().count;
        if (n === 0) continue;
        console.log(`  ${dryRun ? "would delete" : "delete"} matches/${m.id}/${sub.id} (${n} doc(s))`);
        subDocs += n;
        if (!dryRun) await db.recursiveDelete(sub);
      }
    }
    console.log(`\nmatch subcollections (live scoring): ${subDocs} doc(s)`);

    if (!dryRun) {
      for (const name of ["matches", "registrations"]) {
        const docs = (await linked(name)).filter((d) => d.get("qaSeed") !== true);
        for (let i = 0; i < docs.length; i += 400) {
          const batch = db.batch();
          docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      }
    }
    console.log(`unmarked matches/registrations of QA tournaments: ${unmarked} doc(s)`);

    let standings = 0;
    for (const id of variants) {
      const ref = db.collection("standings").doc(id);
      if (!(await ref.get()).exists) continue;
      console.log(`  ${dryRun ? "would delete" : "delete"} standings/${id}  ${titles.get(id.toUpperCase()) ?? ""}`);
      standings++;
      if (!dryRun) await ref.delete();
    }
    console.log(`standings of QA tournaments: ${standings} doc(s)`);
    total += subDocs + unmarked + standings;
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
