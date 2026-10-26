/**
 * One-off backfill: sets `registrations.memberUids` (auth uids of player,
 * partner, roster) and `matches.teamAUids` / `teamBUids`. Safe to re-run:
 * it recomputes and writes only what changed. New writes are kept current
 * by the triggers in triggers/memberUids.ts.
 *
 * Target project: `--project <id>`, else GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT
 * (no default). Credentials: `gcloud auth application-default login`.
 *
 * Usage (from tournmate-server/functions):
 *   npm run backfill:member-uids -- --project tournmate-dev --dry-run
 *   npm run backfill:member-uids -- --project tournmate-dev
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { syncMatchMemberUids, syncRegistrationMemberUids } from "../services/memberUids";

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
  console.log(`Project ${projectId}${dryRun ? " (dry run)" : ""}`);

  // Registrations first: matches copy their memberUids.
  const regs = await db.collection("registrations").select().get();
  let regChanged = 0;
  for (const doc of regs.docs) {
    if (await syncRegistrationMemberUids(db, doc.id, dryRun)) regChanged++;
  }
  console.log(`registrations: ${regs.size} scanned, ${regChanged} ${dryRun ? "would change" : "updated"}`);

  // In a dry run matches read the registrations' old memberUids (or compute them).
  const matches = await db.collection("matches").select().get();
  let matchChanged = 0;
  for (const doc of matches.docs) {
    if (await syncMatchMemberUids(db, doc.id, dryRun)) matchChanged++;
  }
  console.log(`matches: ${matches.size} scanned, ${matchChanged} ${dryRun ? "would change" : "updated"}`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
