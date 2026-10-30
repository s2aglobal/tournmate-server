/**
 * Read-only data check before the server-authority rollout. Writes nothing.
 * Reports:
 *  - players without firebaseUid
 *  - tournaments without createdBy
 *  - playSessions without hostId / without durationMinutes
 *  - gender distribution (players.genderRaw)
 *  - player-id case problems: ids in registrations (playerId, partnerId,
 *    rosterIds) and playSessions.attendeeIds that match a player doc only in
 *    another case, are stored lower case, or match no player at all
 *
 * Target project: `--project <id>`, else GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT
 * (no default). Credentials: `gcloud auth application-default login`.
 *
 * Usage (from tournmate-server/functions):
 *   npm run check:prod-data -- --project tournmate-prod
 *   npm run check:prod-data -- --project tournmate-prod --examples 20
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let projectId: string | undefined;
  let examples = 5;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") projectId = argv[++i];
    else if (arg.startsWith("--project=")) projectId = arg.slice("--project=".length);
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
  if (getApps().length === 0) initializeApp({ projectId });
  const db = getFirestore();
  console.log(`Project ${projectId} (read-only)\n`);

  const sample = (list: string[]) => (list.length ? `  e.g. ${list.slice(0, examples).join(", ")}` : "");

  // ─── Players ──────────────────────────────────────────
  const players = await db.collection("players").get();
  const exact = new Set<string>();
  const byUpper = new Map<string, string>();
  const noUid: string[] = [];
  const genders = new Map<string, number>();
  let lowerDocIds = 0;
  for (const doc of players.docs) {
    exact.add(doc.id);
    byUpper.set(doc.id.toUpperCase(), doc.id);
    if (doc.id !== doc.id.toUpperCase()) lowerDocIds++;
    if (!doc.get("firebaseUid")) noUid.push(doc.id);
    const g = (doc.get("genderRaw") as string | undefined) ?? "(missing)";
    genders.set(g, (genders.get(g) ?? 0) + 1);
  }
  console.log(`players: ${players.size}`);
  console.log(`  without firebaseUid: ${noUid.length}${sample(noUid)}`);
  console.log(`  doc ids not upper case: ${lowerDocIds}`);
  console.log("  gender distribution:");
  for (const [g, n] of [...genders.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${g}: ${n}`);

  // ─── Tournaments ──────────────────────────────────────
  const tournaments = await db.collection("tournaments").get();
  const noCreator = tournaments.docs.filter((d) => !d.get("createdBy")).map((d) => d.id);
  console.log(`\ntournaments: ${tournaments.size}`);
  console.log(`  without createdBy: ${noCreator.length}${sample(noCreator)}`);

  // ─── Sessions ─────────────────────────────────────────
  const sessions = await db.collection("playSessions").get();
  const noHost = sessions.docs.filter((d) => !d.get("hostId")).map((d) => d.id);
  const noDuration = sessions.docs.filter((d) => typeof d.get("durationMinutes") !== "number").map((d) => d.id);
  const status = new Map<string, number>();
  for (const d of sessions.docs) {
    const s = (d.get("status") as string | undefined) ?? "(missing)";
    status.set(s, (status.get(s) ?? 0) + 1);
  }
  const oversized = sessions.docs.filter((d) => {
    const ids = d.get("attendeeIds");
    const cap = d.get("gameType") === "singles" ? 2 : 4;
    return Array.isArray(ids) && ids.length > cap;
  }).map((d) => d.id);
  console.log(`\nplaySessions: ${sessions.size} (${[...status.entries()].map(([k, v]) => `${k} ${v}`).join(", ")})`);
  console.log(`  without hostId: ${noHost.length}${sample(noHost)}`);
  console.log(`  without durationMinutes: ${noDuration.length}${sample(noDuration)}`);
  console.log(`  over the new size cap (singles 2, else 4): ${oversized.length}${sample(oversized)}`);
  const cricketSessions = sessions.docs.filter((d) => d.get("sportType") === "cricket").map((d) => d.id);
  console.log(`  cricket sessions: ${cricketSessions.length}${sample(cricketSessions)}`);

  // ─── Id case ──────────────────────────────────────────
  const caseOnly: string[] = [];
  const lowerStored: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  const check = (where: string, id: unknown) => {
    if (typeof id !== "string" || !id) return;
    checked++;
    const ref = `${where}:${id}`;
    if (id !== id.toUpperCase()) lowerStored.push(ref);
    if (exact.has(id)) return;
    if (byUpper.has(id.toUpperCase())) caseOnly.push(`${ref}→${byUpper.get(id.toUpperCase())}`);
    else missing.push(ref);
  };
  const regs = await db.collection("registrations").get();
  for (const d of regs.docs) {
    check(`registrations/${d.id}.playerId`, d.get("playerId"));
    check(`registrations/${d.id}.partnerId`, d.get("partnerId"));
    for (const r of (d.get("rosterIds") as unknown[] | undefined) ?? []) check(`registrations/${d.id}.rosterIds`, r);
  }
  for (const d of sessions.docs) {
    for (const a of (d.get("attendeeIds") as unknown[] | undefined) ?? []) check(`playSessions/${d.id}.attendeeIds`, a);
  }
  const noMemberUids = regs.docs.filter((d) => !Array.isArray(d.get("memberUids"))).length;
  console.log(`\nregistrations: ${regs.size} (without memberUids: ${noMemberUids})`);
  console.log(`player-id references checked: ${checked}`);
  console.log(`  match a player doc only in another case: ${caseOnly.length}${sample(caseOnly)}`);
  console.log(`  stored lower case: ${lowerStored.length}${sample(lowerStored)}`);
  console.log(`  no player doc in any case: ${missing.length}${sample(missing)}`);
}

main().catch((err) => {
  console.error("Check failed:", err);
  process.exit(1);
});
