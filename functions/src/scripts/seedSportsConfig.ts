/**
 * Seed script: writes the sport catalog document `config/sports` from
 * `DEFAULT_SPORTS_CONFIG` (src/config/sportsCatalog.ts).
 *
 * Idempotent: does nothing if `config/sports` already exists, unless `--force`
 * is passed (then it overwrites the whole doc with the default).
 *
 * Target project: `--project <id>`, else GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT.
 * There is no default, so it never writes to an unintended project.
 * Credentials: Application Default Credentials (`gcloud auth application-default login`)
 * or GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>.
 *
 * Usage (from tournmate-server/functions):
 *   npm run build
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev            # dev
 *   node lib/scripts/seedSportsConfig.js --project tournmate-prod           # prod
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --force    # overwrite
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --dry-run  # print only
 *
 * Or via npm (args after `--`):
 *   npm run seed:sports-config -- --project tournmate-dev
 *
 * Against the Firestore emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node lib/scripts/seedSportsConfig.js --project demo-tournmate
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  DEFAULT_SPORTS_CONFIG,
  SPORTS_CONFIG_COLLECTION,
  SPORTS_CONFIG_DOC_ID,
} from "../config/sportsCatalog";

function parseArgs(argv: string[]): { projectId?: string; force: boolean; dryRun: boolean } {
  let projectId: string | undefined;
  let force = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") force = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--project") projectId = argv[++i];
    else if (arg.startsWith("--project=")) projectId = arg.slice("--project=".length);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  projectId = projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  return { projectId, force, dryRun };
}

async function main(): Promise<void> {
  const { projectId, force, dryRun } = parseArgs(process.argv.slice(2));
  if (!projectId) {
    console.error(
      "A project is required: pass --project <id> or set GOOGLE_CLOUD_PROJECT.\n" +
      "  e.g. node lib/scripts/seedSportsConfig.js --project tournmate-dev",
    );
    process.exit(1);
  }

  const target = `${SPORTS_CONFIG_COLLECTION}/${SPORTS_CONFIG_DOC_ID}`;
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  console.log(`Project: ${projectId}${emulator ? ` (emulator ${emulator})` : ""}`);
  console.log(`Target:  ${target}${force ? " (--force)" : ""}${dryRun ? " (--dry-run)" : ""}`);

  if (dryRun) {
    console.log(JSON.stringify(DEFAULT_SPORTS_CONFIG, null, 2));
    return;
  }

  if (getApps().length === 0) initializeApp({ projectId });
  const ref = getFirestore().collection(SPORTS_CONFIG_COLLECTION).doc(SPORTS_CONFIG_DOC_ID);

  const written = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && !force) return false;
    tx.set(ref, DEFAULT_SPORTS_CONFIG);
    return true;
  });

  if (written) {
    console.log(`Wrote ${target}: live = ${DEFAULT_SPORTS_CONFIG.live.join(", ")}`);
  } else {
    console.log(`${target} already exists; left unchanged. Pass --force to overwrite.`);
  }
}

main().catch((err) => {
  console.error("Seeding config/sports failed:", err);
  process.exit(1);
});
