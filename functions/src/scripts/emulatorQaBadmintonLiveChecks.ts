/**
 * Emulator check for the badminton live QA seed (seedQaBadmintonLive.ts) and
 * its cleanup (cleanupQaTournaments.ts). Creates fixture users (auth + player
 * docs for the default organizers and test1..test20) and turns
 * `config/sports.liveScoring.badminton` on, runs the seed with --emulator,
 * then scores seeded matches through the deployed-shape callables on the
 * functions emulator (signed-in HTTP calls, so triggers run too):
 * knockout QFs (organizer final) + advanceRound, a league match (standings
 * rebuilt), a short-games semi (Bo3 to 11), participant scoring → opponent
 * confirms, and a second-device scorer. Finally runs the cleanup and checks
 * that every seeded doc, live subcollection, standings doc and notification
 * is gone.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-qa-badminton-live
 * which runs, under
 * `firebase emulators:exec --only firestore,auth,functions --project demo-tournmate`:
 *   node functions/lib/scripts/emulatorQaBadmintonLiveChecks.js
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { spawnSync } from "child_process";
import { readFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore + Auth emulators and a demo-* project (npm run test:emulator-qa-badminton-live).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });
const db = getFirestore();
const auth = getAuth();
const FUNCTIONS = `http://${process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001"}/${projectId}/us-central1`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;
const SCRIPTS = __dirname;

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) passes++; else failures++;
}

const ORGS = [
  { uid: "uMkD5gCKhXVw1TBqsooZuFRCM5A3", email: "org-ios@example.test", name: "Org iOS" },
  { uid: "9enzsOvCuMOHeHl3Z504SbBL9E53", email: "org-android@example.test", name: "Org Android" },
];
const PASSWORD = `emu-${randomUUID()}`;
const tokens = new Map<string, string>();

async function fixtures(): Promise<void> {
  await db.collection("config").doc("sports").set({
    schemaVersion: 1, live: ["pickleball", "badminton", "tennis"], categories: [], liveScoring: { badminton: true },
  });
  const users = [
    ...ORGS,
    ...Array.from({ length: 20 }, (_, i) => ({ uid: `emu-test-${i + 1}`, email: `test${i + 1}@tournmate.dev`, name: `Test${i + 1} Player` })),
  ];
  for (const u of users) {
    await auth.createUser({ uid: u.uid, email: u.email, password: PASSWORD, displayName: u.name, emailVerified: true });
    await db.collection("players").doc(randomUUID().toUpperCase()).set({
      name: u.name, phone: "", email: u.email, genderRaw: "male", elo: 1200, streak: 0,
      firebaseUid: u.uid, avatarId: "racket", createdAt: Timestamp.now(),
    });
  }
}

async function token(email: string): Promise<string> {
  const cached = tokens.get(email);
  if (cached) return cached;
  const res = await fetch(`${AUTH}/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const body = await res.json() as { idToken?: string; error?: unknown };
  if (!body.idToken) throw new Error(`sign in ${email}: ${JSON.stringify(body.error)}`);
  tokens.set(email, body.idToken);
  return body.idToken;
}

interface CallResult { ok: boolean; result?: Record<string, unknown>; error?: { message?: string; status?: string; details?: { reason?: string } } }

async function call(name: string, email: string, data: Record<string, unknown>): Promise<CallResult> {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token(email)}` },
    body: JSON.stringify({ data }),
  });
  const body = await res.json() as { result?: Record<string, unknown>; error?: CallResult["error"] };
  return body.error ? { ok: false, error: body.error } : { ok: true, result: body.result };
}

async function expectOk(label: string, name: string, email: string, data: Record<string, unknown>, quiet = false): Promise<Record<string, unknown> | null> {
  const r = await call(name, email, data);
  if (!r.ok || !quiet) check(label, r.ok, JSON.stringify(r.ok ? r.result : r.error));
  return r.ok ? r.result ?? {} : null;
}

/** Plays `seq` ("A"/"B" per rally) as `email`. */
async function play(matchId: string, email: string, seq: string): Promise<string> {
  let status = "";
  for (const c of seq) {
    const r = await expectOk(`point ${c}`, "recordPoint", email, { matchId, pointId: randomUUID(), winner: c }, true);
    if (!r) return "error";
    status = String(r.status);
  }
  return status;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually(label: string, test: () => Promise<boolean>, detail: () => Promise<string>, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) { check(label, true); return; }
    await sleep(500);
  }
  check(label, false, await detail());
}

interface Seeded {
  id: string; tournamentId: string; tournament: string; label: string; status: string;
  teamAUids: string[]; teamBUids: string[];
}

function run(script: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: "utf8", env: process.env });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

async function main(): Promise<void> {
  await fixtures();

  // Dry run writes nothing.
  const dry = run("seedQaBadmintonLive.js", ["--emulator", "--dry-run"]);
  check("seed --dry-run exits 0", dry.status === 0, dry.status === 0 ? "" : dry.out.slice(-800));
  check("dry run writes nothing", (await db.collection("tournaments").where("qaSeed", "==", true).get()).empty);

  // Without --emulator the seed refuses (emulator host is set).
  const guarded = run("seedQaBadmintonLive.js", ["--dry-run"]);
  check("seed without --emulator refuses under FIRESTORE_EMULATOR_HOST", guarded.status === 1 && guarded.out.includes("Refusing"));

  const out = join(mkdtempSync(join(tmpdir(), "qa-bl-")), "seeded.json");
  const seed = run("seedQaBadmintonLive.js", ["--emulator", `--json-out=${out}`]);
  check("seed exits 0", seed.status === 0, seed.status === 0 ? "" : seed.out.slice(-1500));
  if (seed.status !== 0) return;
  const matches = (JSON.parse(readFileSync(out, "utf8")) as { matches: Seeded[] }).matches;
  const again = run("seedQaBadmintonLive.js", ["--emulator"]);
  check("second seed refuses while QA Live docs exist", again.status === 1);

  const tournaments = await db.collection("tournaments").where("qaSeed", "==", true).get();
  check("10 tournaments (5 per organizer)", tournaments.size === 10, `${tournaments.size}`);
  const find = (tournament: string, label: string) => {
    const m = matches.find((x) => x.tournament === tournament && x.label === label);
    if (!m) throw new Error(`no seeded match ${tournament} ${label}`);
    return m;
  };
  const org = ORGS[0].email;
  const KO = "QA Live Badminton Knockout · iOS";

  // ── Knockout: QF1 (organizer plays), QF3, QF4 live by the organizer → bracket complete → advanceRound.
  check("QF2 seeded finished", find(KO, "QF2").status === "finished");
  for (const label of ["QF1", "QF3", "QF4"]) {
    const m = find(KO, label);
    await expectOk(`${label}: startRacketScoring (organizer)`, "startRacketScoring", org, { matchId: m.id, firstServer: "A" });
    const st = await play(m.id, org, "A".repeat(21) + "B".repeat(21) + "A".repeat(21));
    check(`${label}: decided after 63 points`, st === "ended", st);
    await expectOk(`${label}: finishRacketMatch`, "finishRacketMatch", org, { matchId: m.id });
    const doc = (await db.collection("matches").doc(m.id).get()).data()!;
    check(`${label}: finished 21-0 0-21 21-0, team A wins`, doc.statusRaw === "finished" && doc.scoreA === 2 && doc.scoreB === 1 &&
      doc.winnerRegistrationId === doc.teamAId && JSON.stringify(doc.setScores) ===
      JSON.stringify([{ teamAPoints: 21, teamBPoints: 0 }, { teamAPoints: 0, teamBPoints: 21 }, { teamAPoints: 21, teamBPoints: 0 }]) &&
      doc.live?.status === "finished", `${doc.statusRaw} ${doc.scoreA}-${doc.scoreB} live=${doc.live?.status}`);
    const pts = (await db.collection("matches").doc(m.id).collection("points").count().get()).data().count;
    check(`${label}: 63 point docs`, pts === 63, `${pts}`);
  }
  const koTid = find(KO, "QF1").tournamentId;
  const adv = await expectOk("Knockout: advanceRound creates the semi-finals", "advanceRound", org, { tournamentId: koTid });
  const r2 = await db.collection("matches").where("tournamentId", "==", koTid).where("round", "==", 2).get();
  check("Knockout: 2 round-2 matches", r2.size === 2 && adv?.status === "advanced", `${r2.size} ${JSON.stringify(adv)}`);

  // ── League: R3 test-only, one game to 21 (simple) → standings rebuilt by the trigger.
  const LG = "QA Live Badminton League · iOS";
  const r3 = matches.filter((x) => x.tournament === LG && x.label === "R3" && !x.teamAUids.includes(ORGS[0].uid))[0];
  await expectOk("League R3: startRacketScoring (organizer)", "startRacketScoring", org, { matchId: r3.id, firstServer: "B" });
  const lst = await play(r3.id, org, "A".repeat(10) + "B".repeat(21));
  check("League R3: one game decides the match", lst === "ended", lst);
  await expectOk("League R3: finishRacketMatch", "finishRacketMatch", org, { matchId: r3.id });
  const ld = (await db.collection("matches").doc(r3.id).get()).data()!;
  check("League R3: simple 10-21, B wins, no setScores", ld.statusRaw === "finished" && ld.scoreA === 10 && ld.scoreB === 21 &&
    ld.setScores === undefined && ld.winnerRegistrationId === ld.teamBId, JSON.stringify({ s: ld.statusRaw, a: ld.scoreA, b: ld.scoreB }));
  const lgTid = r3.tournamentId;
  const played = async () => {
    const s = await db.collection("standings").doc(lgTid).get();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (s.get("groups") ?? []).flatMap((g: any) => g.rows ?? []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.reduce((n: number, r: any) => n + (r.played ?? 0), 0);
  };
  await eventually("League standings: 3 results (6 appearances)", async () => (await played()) === 6, async () => `played sum ${await played()}`);

  // ── Short games: Bo3 to 11 (cap 15).
  const SG = find("QA Live Badminton Short Games · iOS", "SF2");
  await expectOk("Short Games SF2: start", "startRacketScoring", org, { matchId: SG.id, firstServer: "A" });
  const sgs = await play(SG.id, org, "B".repeat(11) + "B".repeat(11));
  check("Short Games SF2: ends at 0-11 0-11", sgs === "ended", sgs);
  await expectOk("Short Games SF2: finish", "finishRacketMatch", org, { matchId: SG.id });
  const sgd = (await db.collection("matches").doc(SG.id).get()).data()!;
  check("Short Games SF2: B wins 2-0", sgd.statusRaw === "finished" && sgd.scoreB === 2 && sgd.winnerRegistrationId === sgd.teamBId);

  // ── Short games 15: Bo3 to 15 (cap 21), deuce to the cap.
  const S15 = find("QA Live Badminton Short Games 15 · iOS", "SF1");
  await expectOk("Short Games 15 SF1: start", "startRacketScoring", org, { matchId: S15.id, firstServer: "A" });
  // 14-14, then two straight points: 16-14 (win by 2 under the cap of 21); then 15-0.
  const s15 = await play(S15.id, org, "AB".repeat(14) + "AA" + "A".repeat(15));
  check("Short Games 15 SF1: 16-14 15-0 decides it", s15 === "ended", s15);
  const s15d = (await db.collection("matches").doc(S15.id).get()).data()!;
  check("Short Games 15 SF1: live games 16-14, 15-0", JSON.stringify(s15d.live?.games) === JSON.stringify([{ a: 16, b: 14 }, { a: 15, b: 0 }]),
    JSON.stringify(s15d.live?.games));

  // ── Player view: you play (not organizer) → scoreSubmitted → opponent confirms.
  const PV = "QA Live Badminton Player View · iOS";
  const sf1 = find(PV, "SF1");
  await expectOk("Player View SF1: start as a player", "startRacketScoring", org, { matchId: sf1.id, firstServer: "A" });
  await play(sf1.id, org, "A".repeat(42));
  await expectOk("Player View SF1: finish as a player", "finishRacketMatch", org, { matchId: sf1.id });
  const p1 = (await db.collection("matches").doc(sf1.id).get()).data()!;
  check("Player View SF1: scoreSubmitted", p1.statusRaw === "scoreSubmitted" && p1.submittedBy === ORGS[0].uid, p1.statusRaw);
  const own = await call("confirmScore", "test1@tournmate.dev", { matchId: sf1.id });
  check("Player View SF1: own partner (test1) can't confirm", !own.ok, JSON.stringify(own.error));
  await expectOk("Player View SF1: opponent test2 confirms", "confirmScore", "test2@tournmate.dev", { matchId: sf1.id });
  const p1b = (await db.collection("matches").doc(sf1.id).get()).data()!;
  check("Player View SF1: finished, your team wins", p1b.statusRaw === "finished" && p1b.winnerRegistrationId === p1b.teamAId);

  // ── Second device: test4 scores SF2; you (not in it, not organizer) can't.
  const sf2 = find(PV, "SF2");
  await expectOk("Player View SF2: test4 starts scoring", "startRacketScoring", "test4@tournmate.dev", { matchId: sf2.id, firstServer: "B" });
  await play(sf2.id, "test4@tournmate.dev", "BBA");
  const notMine = await call("startRacketScoring", org, { matchId: sf2.id, firstServer: "A", takeover: true });
  check("Player View SF2: you can't take over (spectator)", !notMine.ok && notMine.error?.details?.reason === "NOT_SCORER", JSON.stringify(notMine.error));
  const early = await call("startRacketScoring", "test6@tournmate.dev", { matchId: sf2.id, firstServer: "A", takeover: true });
  check("Player View SF2: opponent test6 can't take over before 3 minutes", !early.ok && early.error?.details?.reason === "SCORER_ACTIVE");

  // Android organizer's set is independent.
  const ak = find("QA Live Badminton Knockout · Android", "QF3");
  const forbidden = await call("startRacketScoring", org, { matchId: ak.id, firstServer: "A" });
  check("iOS organizer can't score the Android organizer's test-only match", !forbidden.ok);

  // ── Cleanup removes everything.
  const tids = new Set(tournaments.docs.map((d) => d.id));
  const before = (await db.collection("notifications").get()).docs.filter((d) => tids.has(d.get("tournamentId"))).length;
  check("server wrote notifications for QA tournaments (to be cleaned)", before > 0, `${before}`);
  const dryClean = run("cleanupQaTournaments.js", ["--emulator", "--dry-run", "--include-notifications"]);
  check("cleanup --dry-run exits 0 and lists live subcollections", dryClean.status === 0 && dryClean.out.includes("/points") &&
    dryClean.out.includes("/racketLive") && dryClean.out.includes("standings/"), dryClean.out.slice(-600));
  check("cleanup dry run deletes nothing", (await db.collection("tournaments").where("qaSeed", "==", true).count().get()).data().count === 10);
  const clean = run("cleanupQaTournaments.js", ["--emulator", "--include-notifications"]);
  check("cleanup exits 0", clean.status === 0, clean.status === 0 ? "" : clean.out.slice(-800));
  await sleep(4000); // let delete triggers settle

  for (const c of ["tournaments", "registrations", "matches", "notifications", "playSessions", "teams", "teamEntries"]) {
    const n = (await db.collection(c).where("qaSeed", "==", true).count().get()).data().count;
    check(`no qaSeed docs left in ${c}`, n === 0, `${n}`);
  }
  let sub = 0;
  for (const m of matches) {
    for (const name of ["points", "racketLive"]) {
      sub += (await db.collection("matches").doc(m.id).collection(name).count().get()).data().count;
    }
  }
  check("no live subcollection docs left under seeded matches", sub === 0, `${sub}`);
  const left = (await db.collection("matches").where("tournamentId", "==", koTid).count().get()).data().count;
  check("advanceRound's semi-finals (no qaSeed marker) removed too", left === 0, `${left}`);
  let standings = 0;
  for (const id of tids) if ((await db.collection("standings").doc(id).get()).exists) standings++;
  check("no standings docs left for QA tournaments", standings === 0, `${standings}`);
  const notes = (await db.collection("notifications").get()).docs.filter((d) => tids.has(d.get("tournamentId"))).length;
  check("no notifications left for QA tournaments", notes === 0, `${notes}`);
  const players = (await db.collection("players").count().get()).data().count;
  check("fixture players untouched", players === 22, `${players}`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
  });
