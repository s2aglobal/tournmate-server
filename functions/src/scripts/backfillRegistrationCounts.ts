/**
 * One-off backfill: sets `registrationCount` on every tournament from the
 * registrations collection. Safe to re-run (it recounts). New registrations
 * keep the field current via the onRegistrationCreated/Deleted triggers.
 *
 * Target project: `--project <id>`, else GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT
 * (no default). Credentials: `gcloud auth application-default login`.
 *
 * Usage (from tournmate-server/functions):
 *   npm run backfill:registration-counts -- --project tournmate-dev
 *   npm run backfill:registration-counts -- --project tournmate-dev --dry-run
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { refreshRegistrationCount } from "../services/registrationCount";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let projectId: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--project") projectId = argv[++i];
    else if (arg.startsWith("--project=")) projectId = arg.slice("--project=".length);
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

  if (getApps().length === 0) initializeApp({ projectId });
  const db = getFirestore();
  const tournaments = await db.collection("tournaments").select().get();
  console.log(`Project ${projectId}: ${tournaments.size} tournaments${dryRun ? " (dry run)" : ""}`);

  for (const doc of tournaments.docs) {
    if (dryRun) {
      const n = (await db.collection("registrations").where("tournamentId", "==", doc.id).count().get()).data().count;
      console.log(`  ${doc.id}: ${n}`);
    } else {
      const n = await refreshRegistrationCount(db, doc.id);
      console.log(`  ${doc.id}: ${n ?? "skipped"}`);
    }
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
