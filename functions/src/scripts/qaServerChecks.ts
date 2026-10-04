/**
 * Server-side QA checks against **tournmate-dev only**, using the data from
 * seedQaTournaments.ts. Prints PASS/FAIL per check.
 *
 *  1. registrationCount trigger: add a QA registration to "QA RegCount Trigger",
 *     expect registrationCount 1; delete it, expect 0.
 *  2. Elo on finish: clone a scheduled QA match in "QA RR Head-to-Head", move it
 *     to finished, expect eloApplied and winners' eloRatings.badminton up /
 *     losers' down. (Changes Elo of the QA test players only.)
 *
 * Firestore rules can't be checked here (the Admin SDK bypasses rules); test
 * creates from the apps instead.
 *
 * Usage (from tournmate-server/functions, after seeding):
 *   npm run build && node lib/scripts/qaServerChecks.js
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Firestore } from "firebase-admin/firestore";
import { randomUUID } from "crypto";

const PROJECT_ID = "tournmate-dev";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 45000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(2000);
  }
  return false;
}

async function qaTournament(db: Firestore, title: string) {
  const snap = await db.collection("tournaments").where("qaSeed", "==", true).where("title", "==", title).limit(1).get();
  if (snap.empty) throw new Error(`QA tournament "${title}" not found — run seedQaTournaments first.`);
  return snap.docs[0];
}

async function checkRegistrationCount(db: Firestore): Promise<boolean> {
  const t = await qaTournament(db, "QA RegCount Trigger");
  const template = (await db.collection("registrations").where("qaSeed", "==", true).limit(1).get()).docs[0];
  if (!template) throw new Error("No QA registration to copy.");
  const regId = randomUUID().toUpperCase();
  const data = { ...template.data(), tournamentId: t.id, qaSeed: true };
  delete (data as Record<string, unknown>).partnerId;
  await db.collection("registrations").doc(regId).set(data);
  const up = await waitFor(async () => (await t.ref.get()).get("registrationCount") === 1);
  console.log(`  after create: registrationCount=${(await t.ref.get()).get("registrationCount")}`);
  await db.collection("registrations").doc(regId).delete();
  const down = await waitFor(async () => (await t.ref.get()).get("registrationCount") === 0);
  console.log(`  after delete: registrationCount=${(await t.ref.get()).get("registrationCount")}`);
  return up && down;
}

async function checkElo(db: Firestore): Promise<boolean> {
  const t = await qaTournament(db, "QA RR Head-to-Head");
  const template = (await db.collection("matches").where("tournamentId", "==", t.id).where("qaSeed", "==", true).limit(1).get()).docs[0];
  if (!template) throw new Error("No QA match to copy.");
  const m = template.data();
  const regA = (await db.collection("registrations").doc(m.teamAId).get()).data();
  const regB = (await db.collection("registrations").doc(m.teamBId).get()).data();
  if (!regA || !regB) throw new Error("QA match registrations missing.");
  const winners = [regA.playerId, regA.partnerId].filter(Boolean) as string[];
  const losers = [regB.playerId, regB.partnerId].filter(Boolean) as string[];
  const rating = async (id: string) => {
    const d = (await db.collection("players").doc(id).get()).data() ?? {};
    return (d.eloRatings?.badminton as number | undefined) ?? (d.elo as number | undefined) ?? 1200;
  };
  const before = new Map<string, number>();
  for (const id of [...winners, ...losers]) before.set(id, await rating(id));

  const matchId = randomUUID().toUpperCase();
  const ref = db.collection("matches").doc(matchId);
  const scheduled: Record<string, unknown> = { ...m, statusRaw: "scheduled", qaSeed: true };
  for (const k of ["setScores", "scoreA", "scoreB", "winnerRegistrationId", "eloApplied"]) delete scheduled[k];
  await ref.set(scheduled);
  await sleep(3000);
  await ref.update({
    statusRaw: "finished",
    setScores: [{ teamAPoints: 21, teamBPoints: 10 }, { teamAPoints: 21, teamBPoints: 12 }],
    scoreA: 2, scoreB: 0,
    winnerRegistrationId: m.teamAId,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const applied = await waitFor(async () => (await ref.get()).get("eloApplied") === true);
  let ok = applied;
  for (const id of winners) {
    const after = await rating(id);
    console.log(`  winner ${id}: ${before.get(id)?.toFixed(1)} → ${after.toFixed(1)}`);
    ok = ok && after > (before.get(id) ?? 0);
  }
  for (const id of losers) {
    const after = await rating(id);
    console.log(`  loser  ${id}: ${before.get(id)?.toFixed(1)} → ${after.toFixed(1)}`);
    ok = ok && after < (before.get(id) ?? Infinity);
  }
  console.log(`  eloApplied=${applied} (match ${matchId}, cleaned up by cleanupQaTournaments)`);
  return ok;
}

async function main() {
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
  if (connected !== PROJECT_ID) {
    console.error(`Refusing to run: connected to ${connected}.`);
    process.exit(1);
  }

  const results: [string, boolean][] = [];
  for (const [name, fn] of [["registrationCount trigger", checkRegistrationCount], ["Elo on finish", checkElo]] as const) {
    console.log(`\n${name}`);
    try {
      results.push([name, await fn(db)]);
    } catch (err) {
      console.log(`  error: ${(err as Error).message}`);
      results.push([name, false]);
    }
  }
  console.log("");
  for (const [name, ok] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
}

main();
