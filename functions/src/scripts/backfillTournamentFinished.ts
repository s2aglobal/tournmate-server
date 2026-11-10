/**
 * One-off backfill: sets the server-only `finished` (and `finishedAt` when
 * true) on every tournament from its matches (services/tournamentFinished.ts,
 * the same computation as the match trigger). Docs whose stored value already
 * matches are left alone, so it is safe to re-run. New match writes keep the
 * field current via onMatchWritten.
 *
 * Dry run by default (prints what would change); `--apply` writes.
 * `finishedAt` of a backfilled tournament is the backfill time.
 *
 * Target project: `--project <id>` (required; or GOOGLE_CLOUD_PROJECT /
 * GCLOUD_PROJECT, e.g. the emulator). Credentials:
 * `gcloud auth application-default login`.
 *
 * Usage (from tournmate-server/functions):
 *   npm run backfill:tournament-finished -- --project tournmate-dev
 *   npm run backfill:tournament-finished -- --project tournmate-dev --apply
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FinishedSync, syncTournamentFinished } from "../services/tournamentFinished";

export async function backfillTournamentFinished(apply: boolean, log: (line: string) => void = console.log):
  Promise<Record<FinishedSync, number>> {
  const db = getFirestore();
  const tournaments = await db.collection("tournaments").select().get();
  const counts: Record<FinishedSync, number> = { set: 0, unset: 0, unchanged: 0, missing: 0 };
  for (const doc of tournaments.docs) {
    const r = await syncTournamentFinished(db, doc.id, !apply);
    counts[r]++;
    if (r === "set" || r === "unset") log(`  ${doc.id}: ${apply ? "" : "would "}set finished = ${r === "set"}`);
  }
  log(`${tournaments.size} tournaments: ${counts.set} -> true, ${counts.unset} -> false, ${counts.unchanged} unchanged` +
    `${apply ? "" : " (dry run; --apply to write)"}`);
  return counts;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let projectId: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--project") projectId = argv[++i];
    else if (arg.startsWith("--project=")) projectId = arg.slice("--project=".length);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  projectId = projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    console.error("A project is required: --project tournmate-dev|tournmate-prod.");
    process.exit(1);
  }
  if (getApps().length === 0) initializeApp({ projectId });
  console.log(`Project ${projectId}${process.env.FIRESTORE_EMULATOR_HOST ? " (emulator)" : ""}: ` +
    `${apply ? "applying" : "dry run"}`);
  await backfillTournamentFinished(apply);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
}
