/**
 * Read-only: prints recent in-app feedback (`feedback` collection), newest first.
 *
 * Target project: `--project <id>`, else GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT
 * (no default). Credentials: `gcloud auth application-default login`.
 *
 * Usage (from tournmate-server/functions):
 *   npm run list:feedback -- --project tournmate-dev
 *   npm run list:feedback -- --project tournmate-prod --days 7
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const MOODS = ["", "Awful", "Meh", "Okay", "Good", "Great"];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let projectId: string | undefined;
  let days = 7;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") projectId = argv[++i];
    else if (arg.startsWith("--project=")) projectId = arg.slice("--project=".length);
    else if (arg === "--days") days = Number(argv[++i]);
    else if (arg.startsWith("--days=")) days = Number(arg.slice("--days=".length));
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  projectId = projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    console.error("A project is required: --project <id> (e.g. tournmate-dev).");
    process.exit(1);
  }
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days must be a positive number.");
    process.exit(1);
  }

  if (getApps().length === 0) initializeApp({ projectId });
  const since = Timestamp.fromMillis(Date.now() - days * 24 * 60 * 60 * 1000);
  const snap = await getFirestore().collection("feedback")
    .where("createdAt", ">=", since).orderBy("createdAt", "desc").get();

  console.log(`${snap.size} feedback entries in the last ${days} day(s) (${projectId})\n`);
  for (const doc of snap.docs) {
    const f = doc.data();
    const when = (f.createdAt as Timestamp | undefined)?.toDate().toISOString() ?? "?";
    console.log(`${when}  ${f.sport}  ${MOODS[f.mood] ?? f.mood} (${f.mood}/5)  ${f.appPlatform ?? "?"} ${f.appVersion ?? ""}`);
    console.log(`  player ${f.playerId}  uid ${f.uid}`);
    if (Array.isArray(f.tags) && f.tags.length) console.log(`  tags: ${f.tags.join(", ")}`);
    if (f.text) console.log(`  "${String(f.text).replace(/\n/g, "\n   ")}"`);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
