/**
 * Read-only profile photo report. Writes nothing.
 * Reports:
 *  - players: total, with a photo (photoURL set), without
 *  - approved photo files (approvedPhotos/) and their total size
 *  - photos set in the last 7 / 30 days (players.photoUpdatedAt)
 *  - players whose photoPath has no file, and folders with more than one file
 *
 * Target project: `--project <id>`, else GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT
 * (no default). Bucket: `--bucket <name>`, default `<project>.firebasestorage.app`.
 * Credentials: `gcloud auth application-default login`.
 *
 * Usage (from tournmate-server/functions):
 *   npm run check:profile-photos -- --project tournmate-dev
 *   npm run check:profile-photos -- --project tournmate-prod --bucket tournmate-prod.appspot.com
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const DAY = 24 * 3600_000;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let projectId: string | undefined;
  let bucketName: string | undefined;
  let examples = 5;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") projectId = argv[++i];
    else if (arg.startsWith("--project=")) projectId = arg.slice("--project=".length);
    else if (arg === "--bucket") bucketName = argv[++i];
    else if (arg.startsWith("--bucket=")) bucketName = arg.slice("--bucket=".length);
    else if (arg === "--examples") examples = Number(argv[++i]) || 5;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  projectId = projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    console.error("A project is required: --project <id>.");
    process.exit(1);
  }
  bucketName = bucketName || `${projectId}.firebasestorage.app`;
  if (getApps().length === 0) initializeApp({ projectId, storageBucket: bucketName });
  const db = getFirestore();
  console.log(`Project ${projectId}, bucket ${bucketName} (read-only)\n`);

  const sample = (list: string[]) => (list.length ? `  e.g. ${list.slice(0, examples).join(", ")}` : "");

  // ─── Files ────────────────────────────────────────────
  const [files] = await getStorage().bucket().getFiles({ prefix: "approvedPhotos/" });
  const names = new Set<string>();
  const perUid = new Map<string, number>();
  let bytes = 0;
  for (const f of files) {
    names.add(f.name);
    bytes += Number(f.metadata.size ?? 0);
    const uid = f.name.split("/")[1] ?? "";
    perUid.set(uid, (perUid.get(uid) ?? 0) + 1);
  }

  // ─── Players ──────────────────────────────────────────
  const players = await db.collection("players").get();
  const now = Date.now();
  let withPhoto = 0;
  let last7 = 0;
  let last30 = 0;
  const missingFile: string[] = [];
  for (const doc of players.docs) {
    const url = doc.get("photoURL");
    if (typeof url !== "string" || !url) continue;
    withPhoto++;
    const at = doc.get("photoUpdatedAt");
    if (at instanceof Timestamp) {
      if (now - at.toMillis() <= 7 * DAY) last7++;
      if (now - at.toMillis() <= 30 * DAY) last30++;
    }
    const path = doc.get("photoPath");
    if (typeof path !== "string" || !names.has(path)) missingFile.push(doc.id);
  }
  const extra = [...perUid.entries()].filter(([, n]) => n > 1).map(([uid, n]) => `${uid} (${n})`);

  console.log(`players: ${players.size}`);
  console.log(`  with photo: ${withPhoto}`);
  console.log(`  without photo: ${players.size - withPhoto}`);
  console.log(`  photo set in the last 7 days: ${last7}`);
  console.log(`  photo set in the last 30 days: ${last30}`);
  console.log(`  photoPath with no file: ${missingFile.length}${sample(missingFile)}`);
  console.log(`\napproved photo files (approvedPhotos/): ${files.length} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  folders: ${perUid.size}`);
  console.log(`  folders with more than one file: ${extra.length}${sample(extra)}`);
}

main().catch((err) => {
  console.error("Check failed:", err);
  process.exit(1);
});
