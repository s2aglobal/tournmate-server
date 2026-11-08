/**
 * Draw callables against the local emulators (demo project only).
 *
 *   cd tournmate-server
 *   firebase emulators:exec --only firestore,functions --project demo-tournmate \
 *     "node functions/lib/scripts/emulatorDrawTest.js"
 *
 * Seeds players / tournaments / registrations, calls generateRandomPairs,
 * generateDraw, advanceRound and resetDraw over HTTP as callables (unsigned
 * emulator tokens), checks the match docs and the error reasons, then runs
 * the auto draw job once. Refuses to run unless every Firebase host points
 * at an emulator and the project id starts with "demo-".
 */

import { initializeApp } from "firebase-admin/app";
import { Firestore, Timestamp, getFirestore } from "firebase-admin/firestore";
import { randomUUID } from "crypto";

const PROJECT = process.env.GCLOUD_PROJECT ?? "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !PROJECT.startsWith("demo-")) {
  console.error("Refusing to run: needs FIRESTORE_EMULATOR_HOST and a demo-* project (use firebase emulators:exec).");
  process.exit(2);
}
const FUNCTIONS = `http://${process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001"}/${PROJECT}/us-central1`;

initializeApp({ projectId: PROJECT });
const db = getFirestore();

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

function token(uid: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: now, iat: now, exp: now + 3600,
    sub: uid, user_id: uid, firebase: { sign_in_provider: "custom", identities: {} },
  })}.`;
}

interface CallResult { result?: Record<string, unknown>; error?: { message: string; status: string; details?: { reason?: string } } }

async function call(name: string, uid: string | null, data: unknown): Promise<CallResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (uid) headers.Authorization = `Bearer ${token(uid)}`;
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: "POST", headers, body: JSON.stringify({ data }) });
  return await res.json() as CallResult;
}

const ORGANIZER = "uid-organizer";
const id = () => randomUUID().toUpperCase();

async function seedPlayer(name: string, gender: string, elo: number): Promise<string> {
  const pid = id();
  await db.collection("players").doc(pid).set({
    name, phone: "", email: `${name.toLowerCase()}@example.com`, genderRaw: gender, elo,
    eloRatings: { badminton: elo }, streak: 0, firebaseUid: `uid-${name.toLowerCase()}`, avatarId: "a",
    createdAt: Timestamp.now(),
  });
  return pid;
}

async function seedTournament(fields: Record<string, unknown>): Promise<string> {
  const tid = id();
  await db.collection("tournaments").doc(tid).set({
    title: "Emulator Cup", date: Timestamp.fromMillis(Date.now() + 7 * 86400_000), location: "Hall",
    locationAddress: "", participantsCount: 0, statusRaw: "scheduled", formatRaw: "openSingles",
    matchFormatRaw: "singleElimination", sportType: "badminton", randomPairing: false,
    registrationDeadline: Timestamp.fromMillis(Date.now() + 3 * 86400_000), createdBy: ORGANIZER,
    currency: "USD", createdAt: Timestamp.now(), ...fields,
  });
  return tid;
}

async function register(tid: string, playerId: string, at: number, partnerId?: string): Promise<string> {
  const rid = id();
  await db.collection("registrations").doc(rid).set({
    tournamentId: tid, playerId, ...(partnerId ? { partnerId } : {}), createdAt: Timestamp.fromMillis(at),
  });
  return rid;
}

async function matchesOf(dbx: Firestore, tid: string) {
  const snap = await dbx.collection("matches").where("tournamentId", "==", tid).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }));
}

/** Polls until `fn` is truthy (triggers run asynchronously), up to `ms`. */
async function waitFor<T>(fn: () => Promise<T>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 300));
    v = await fn();
  }
  return v;
}

const tournamentDoc = async (tid: string) => (await db.collection("tournaments").doc(tid).get()).data() ?? {};

async function main(): Promise<void> {
  // ── Singles knockout, 6 players: 2 byes, 2 first-round matches ──
  const players: string[] = [];
  for (let i = 0; i < 6; i++) players.push(await seedPlayer(`P${i}`, i % 2 ? "female" : "male", 1000 + i * 50));
  const ko = await seedTournament({});
  const regs: string[] = [];
  for (let i = 0; i < 6; i++) regs.push(await register(ko, players[i], 1_000_000 + i));

  check("unauthenticated refused", (await call("generateDraw", null, { tournamentId: ko })).error?.details?.reason === "UNAUTHENTICATED");
  const notOrg = await call("generateDraw", "uid-p0", { tournamentId: ko });
  check("non-organizer refused", notOrg.error?.details?.reason === "NOT_ORGANIZER", JSON.stringify(notOrg.error));
  check("unknown tournament", (await call("generateDraw", ORGANIZER, { tournamentId: "nope" })).error?.details?.reason === "NOT_FOUND");

  const gen = await call("generateDraw", ORGANIZER, { tournamentId: ko });
  check("generateDraw ok", gen.result?.status === "generated" && gen.result?.matchesCreated === 2, JSON.stringify(gen));
  let ms = await matchesOf(db, ko);
  check("2 round-1 matches", ms.length === 2);
  const m0 = ms.find((m) => m.bracketPosition === 0)!;
  check("match doc shape", m0 !== undefined &&
    JSON.stringify(Object.keys(m0).filter((k) => k !== "id").sort()) ===
      JSON.stringify(["bracketPosition", "createdAt", "round", "sportType", "statusRaw", "teamAId", "teamBId", "tournamentId"]) &&
    m0.statusRaw === "scheduled" && m0.round === 1 && m0.sportType === "badminton" && m0.tournamentId === ko &&
    m0.createdAt instanceof Timestamp && m0.id === m0.id.toUpperCase(), JSON.stringify(m0));
  // Seeds by rating: P5 P4 have byes; P3 v P0, P2 v P1.
  check("seeding", m0.teamAId === regs[3] && m0.teamBId === regs[0], `${m0.teamAId} v ${m0.teamBId}`);
  check("second generate refused", (await call("generateDraw", ORGANIZER, { tournamentId: ko })).error?.details?.reason === "DRAW_EXISTS");
  check("drawMade set by generateDraw", (await tournamentDoc(ko)).drawMade === true);
  check("advance before results refused", (await call("advanceRound", ORGANIZER, { tournamentId: ko })).error?.status === "FAILED_PRECONDITION");

  // Finish round 1 (team A wins), then advance: byes first → P5 v P2-winner, P4 v P3.
  for (const m of ms) {
    await db.collection("matches").doc(m.id).update({ statusRaw: "finished", scoreA: 21, scoreB: 10, winnerRegistrationId: m.teamAId });
  }
  check("reset refused after scores", (await call("resetDraw", ORGANIZER, { tournamentId: ko })).error?.details?.reason === "DRAW_LOCKED");
  const adv = await call("advanceRound", ORGANIZER, { tournamentId: ko });
  check("advanceRound ok", adv.result?.status === "advanced" && adv.result?.round === 2 && adv.result?.matchesCreated === 2, JSON.stringify(adv));
  ms = (await matchesOf(db, ko)).filter((m) => m.round === 2).sort((a, b) => (a.bracketPosition as number) - (b.bracketPosition as number));
  check("round 2 pairs", ms.length === 2 && ms[0].teamAId === regs[5] && ms[0].teamBId === regs[2] &&
    ms[1].teamAId === regs[4] && ms[1].teamBId === regs[3], ms.map((m) => `${m.teamAId}-${m.teamBId}`).join(" "));

  // ── Round robin + reset ──
  const rr = await seedTournament({ matchFormatRaw: "roundRobin", formatConfigData: JSON.stringify({ doubleRoundRobin: true }) });
  for (let i = 0; i < 4; i++) await register(rr, players[i], 2_000_000 + i);
  const rrGen = await call("generateDraw", ORGANIZER, { tournamentId: rr.toLowerCase() });
  check("double round robin: 12 matches (lower-case id accepted)", rrGen.result?.matchesCreated === 12, JSON.stringify(rrGen));
  const rrMatch = (await matchesOf(db, rr))[0];
  check("RR doc has no bracketPosition/groupLabel", rrMatch.bracketPosition === undefined && rrMatch.groupLabel === undefined && typeof rrMatch.round === "number");
  check("advance RR refused", (await call("advanceRound", ORGANIZER, { tournamentId: rr })).error?.details?.reason === "INVALID_ARGUMENT");
  const reset = await call("resetDraw", ORGANIZER, { tournamentId: rr });
  check("resetDraw ok", reset.result?.status === "reset" && (await matchesOf(db, rr)).length === 0, JSON.stringify(reset));
  check("drawMade cleared by resetDraw", (await waitFor(async () => (await tournamentDoc(rr)).drawMade === false)) === true);

  // ── Group + Knockout: groups, then the knockout ──
  const gk = await seedTournament({ matchFormatRaw: "groupKnockout", formatConfigData: JSON.stringify({ advancingPerGroup: 1 }) });
  const gkRegs: string[] = [];
  for (let i = 0; i < 6; i++) gkRegs.push(await register(gk, players[i], 3_000_000 + i));
  check("too few for GK", (await call("generateDraw", ORGANIZER, { tournamentId: (await seedTournament({ matchFormatRaw: "groupKnockout" })) })).error?.details?.reason === "TOO_FEW_ENTRIES");
  const gkGen = await call("generateDraw", ORGANIZER, { tournamentId: gk });
  ms = await matchesOf(db, gk);
  check("GK groups", gkGen.result?.status === "generated" && ms.length === 6 && new Set(ms.map((m) => m.groupLabel)).size === 2, JSON.stringify(gkGen));
  for (const m of ms) {
    await db.collection("matches").doc(m.id).update({ statusRaw: "finished", setScores: [{ teamAPoints: 21, teamBPoints: 15 }] });
  }
  const gkAdv = await call("advanceRound", ORGANIZER, { tournamentId: gk });
  ms = (await matchesOf(db, gk)).filter((m) => m.groupLabel === undefined);
  check("GK knockout final", gkAdv.result?.status === "advanced" && ms.length === 1 && ms[0].round === 1 && ms[0].bracketPosition === 0, JSON.stringify(gkAdv));

  // ── Group + Knockout: the organizer's group count (9 teams, 1 advancing) ──
  for (let i = players.length; i < 9; i++) players.push(await seedPlayer(`P${i}`, "male", 1000 + i * 50));
  for (const [groupCount, expected] of [[3, 3], [4, 4], [5, 2]] as const) {
    const g = await seedTournament({ matchFormatRaw: "groupKnockout", formatConfigData: JSON.stringify({ advancingPerGroup: 1, groupCount }) });
    for (let i = 0; i < 9; i++) await register(g, players[i], 9_000_000 + i);
    const r = await call("generateDraw", ORGANIZER, { tournamentId: g });
    const labels = new Set((await matchesOf(db, g)).map((m) => m.groupLabel));
    check(`GK groupCount ${groupCount} → ${expected} groups`, labels.size === expected, `${JSON.stringify(r.result)} ${[...labels]}`);
  }

  // ── Swiss: round 1 then round 2 ──
  const sw = await seedTournament({ matchFormatRaw: "swiss", formatConfigData: JSON.stringify({ swissRounds: 2 }) });
  for (let i = 0; i < 5; i++) await register(sw, players[i], 4_000_000 + i);
  const sw1 = await call("generateDraw", ORGANIZER, { tournamentId: sw });
  check("Swiss round 1", sw1.result?.matchesCreated === 2, JSON.stringify(sw1));
  for (const m of await matchesOf(db, sw)) await db.collection("matches").doc(m.id).update({ statusRaw: "finished", scoreA: 1, scoreB: 0 });
  const sw2 = await call("advanceRound", ORGANIZER, { tournamentId: sw });
  check("Swiss round 2", sw2.result?.round === 2 && sw2.result?.matchesCreated === 2, JSON.stringify(sw2));
  for (const m of (await matchesOf(db, sw)).filter((x) => x.round === 2)) {
    await db.collection("matches").doc(m.id).update({ statusRaw: "finished", scoreA: 1, scoreB: 0 });
  }
  check("Swiss max rounds", (await call("advanceRound", ORGANIZER, { tournamentId: sw })).error?.message === "All 2 Swiss rounds have been completed.");
  // 5 teams, 2 rounds: every team either played or had the bye in each round (a bye is a win).
  const swRows = await waitFor(async () => {
    const rows = (await db.collection("standings").doc(sw).get()).data()?.groups?.[0]?.rows as Array<Record<string, number>> | undefined;
    return rows && rows.length === 5 && rows.every((r) => r.played === 2) ? rows : null;
  });
  check("Swiss standings: byes counted as wins", !!swRows && swRows.reduce((n, r) => n + r.won, 0) === 4 + 2,
    JSON.stringify(swRows?.map((r) => `${r.played}/${r.won}/${r.points}`)));

  // ── Cricket awards (match trigger once the tournament finishes) ──
  const ct = await seedTournament({ sportType: "cricket", formatRaw: "team", matchFormatRaw: "roundRobin", title: "Award Cup" });
  const teamReg = async (name: string, roster: string[], at: number) => {
    const rid = id();
    await db.collection("registrations").doc(rid).set({ tournamentId: ct, playerId: roster[0], teamName: name, rosterIds: roster, createdAt: Timestamp.fromMillis(at) });
    return rid;
  };
  const ta = await teamReg("Kings", [players[0], players[1]], 10_000_000);
  const tb = await teamReg("Royals", [players[2], players[3]], 10_000_001);
  const cg = await call("generateDraw", ORGANIZER, { tournamentId: ct });
  check("cricket RR drawn", cg.result?.matchesCreated === 1, JSON.stringify(cg));
  const cm = (await matchesOf(db, ct))[0];
  const stats = {
    batting: [
      { teamRegistrationId: ta, key: players[0], name: "P0", runs: 70, balls: 40, out: false },
      { teamRegistrationId: tb, key: players[2], name: "P2", runs: 30, balls: 25, out: true },
    ],
    bowling: [{ teamRegistrationId: tb, key: players[3], name: "P3", balls: 24, runs: 20, wickets: 3 }],
  };
  await db.collection("matches").doc(cm.id).update({
    statusRaw: "finished", resultType: "win", winnerRegistrationId: cm.teamAId,
    playerOfMatchKey: players[3], playerOfMatchName: "P3", playerOfMatchTeamId: tb,
    playerStatsData: JSON.stringify(stats),
  });
  const ad = await waitFor(async () => { const t = await tournamentDoc(ct); return t.awards ? t : null; });
  const aw = ad?.awards;
  check("awards: auto computed", aw?.bestBatter?.key === players[0] && aw?.bestBatter?.runs === 70 &&
    aw?.bestBowler?.key === players[3] && aw?.bestBowler?.wickets === 3 &&
    aw?.playerOfSeries?.key === players[3] && aw?.source?.playerOfSeries === "auto" && aw?.computedAt instanceof Timestamp,
    JSON.stringify(aw));
  check("awards: awardPlayerIds", JSON.stringify([...(ad?.awardPlayerIds ?? [])].sort()) === JSON.stringify([players[3], players[0]].sort()),
    JSON.stringify(ad?.awardPlayerIds));
  const won = await waitFor(async () => !(await db.collection("notifications").where("type", "==", "award_won").get()).empty);
  check("awards: winners notified", won === true);

  // ── Random pairing (mixed doubles): 3 men + 2 women → 2 pairs, 1 left ──
  const mx = await seedTournament({ formatRaw: "mixedDoubles", randomPairing: true });
  const mxRegs: string[] = [];
  for (let i = 0; i < 5; i++) mxRegs.push(await register(mx, players[i], 5_000_000 + i));
  const pair = await call("generateRandomPairs", ORGANIZER, { tournamentId: mx });
  check("mixed pairing", pair.result?.pairs === 2 && pair.result?.leftover === 1, JSON.stringify(pair));
  const mxSnap = await db.collection("registrations").where("tournamentId", "==", mx).get();
  const withPartner = mxSnap.docs.filter((d) => d.data().partnerId);
  check("merged registrations", mxSnap.size === 3 && withPartner.length === 2);
  const genderOf = async (pid: string) => (await db.collection("players").doc(pid).get()).data()?.genderRaw;
  check("man + woman", (await Promise.all(withPartner.map(async (d) =>
    (await genderOf(d.data().playerId)) === "male" && (await genderOf(d.data().partnerId)) === "female"))).every(Boolean));
  check("pairing refused for singles", (await call("generateRandomPairs", ORGANIZER, { tournamentId: ko })).error?.details?.reason === "INVALID_ARGUMENT");

  // ── Manual draw ──
  const md = await seedTournament({ matchFormatRaw: "manualDraw" });
  const mdRegs: string[] = [];
  for (let i = 0; i < 4; i++) mdRegs.push(await register(md, players[i], 8_000_000 + i));
  check("manual: generateDraw refused", (await call("generateDraw", ORGANIZER, { tournamentId: md })).error?.details?.reason === "INVALID_ARGUMENT");
  check("manual: non-organizer refused", (await call("createManualMatches", "uid-p0",
    { tournamentId: md, pairs: [{ teamAId: mdRegs[0], teamBId: mdRegs[1] }] })).error?.details?.reason === "NOT_ORGANIZER");
  check("manual: self pair refused", (await call("createManualMatches", ORGANIZER,
    { tournamentId: md, pairs: [{ teamAId: mdRegs[0], teamBId: mdRegs[0].toLowerCase() }] })).error?.details?.reason === "INVALID_ARGUMENT");
  check("manual: other tournament's team refused", (await call("createManualMatches", ORGANIZER,
    { tournamentId: md, pairs: [{ teamAId: mdRegs[0], teamBId: regs[1] }] })).error?.details?.reason === "NOT_FOUND");
  check("manual: wrong format refused", (await call("createManualMatches", ORGANIZER,
    { tournamentId: rr, pairs: [{ teamAId: mdRegs[0], teamBId: mdRegs[1] }] })).error?.details?.reason === "INVALID_ARGUMENT");
  check("manual: bad round refused", (await call("createManualMatches", ORGANIZER,
    { tournamentId: md, pairs: [{ teamAId: mdRegs[0], teamBId: mdRegs[1], round: 0 }] })).error?.details?.reason === "INVALID_ARGUMENT");
  const mc = await call("createManualMatches", ORGANIZER, { tournamentId: md, pairs: [
    { teamAId: mdRegs[0].toLowerCase(), teamBId: mdRegs[1] }, { teamAId: mdRegs[2], teamBId: mdRegs[3], round: 1 }] });
  ms = await matchesOf(db, md);
  check("manual: 2 matches", mc.result?.matchesCreated === 2 && ms.length === 2, JSON.stringify(mc));
  const mm = ms.find((m) => m.teamBId === mdRegs[1]);
  check("manual: doc shape", mm !== undefined && mm.teamAId === mdRegs[0] && mm.round === 1 && mm.statusRaw === "scheduled" &&
    JSON.stringify(Object.keys(mm).filter((k) => k !== "id").sort()) ===
      JSON.stringify(["createdAt", "round", "sportType", "statusRaw", "teamAId", "teamBId", "tournamentId"]), JSON.stringify(mm));
  await db.collection("matches").doc(ms[0].id).update({ statusRaw: "finished", scoreA: 21, scoreB: 3 });
  const later = await call("createManualMatches", ORGANIZER, { tournamentId: md, pairs: [{ teamAId: mdRegs[0], teamBId: mdRegs[2], round: 2 }] });
  check("manual: next round added while round 1 is scored", later.result?.matchesCreated === 1, JSON.stringify(later));
  check("manual: reset refused after scores", (await call("resetDraw", ORGANIZER, { tournamentId: md })).error?.details?.reason === "DRAW_LOCKED");

  // ── Auto draw job (run in-process): closed doubles tournament with solos ──
  const { runAutoDraw } = await import("../triggers/autoDrawJob");
  const auto = await seedTournament({ formatRaw: "openDoubles", randomPairing: true, registrationDeadline: Timestamp.fromMillis(Date.now() - 60_000) });
  for (let i = 0; i < 5; i++) await register(auto, players[i], 6_000_000 + i);
  const few = await seedTournament({ registrationDeadline: Timestamp.fromMillis(Date.now() - 60_000) });
  await register(few, players[0], 7_000_000);
  const remind = await seedTournament({ registrationDeadline: Timestamp.fromMillis(Date.now() + 12 * 3600_000) });
  await runAutoDraw(db, new Date());
  const autoDoc = (await db.collection("tournaments").doc(auto).get()).data();
  check("auto: paired and drawn", autoDoc?.autoDraw?.status === "generated" && (await matchesOf(db, auto)).length === 1,
    JSON.stringify(autoDoc?.autoDraw));
  check("auto: too few", (await db.collection("tournaments").doc(few).get()).data()?.autoDraw?.status === "tooFew");
  check("auto: reminder", (await db.collection("tournaments").doc(remind).get()).data()?.deadlineReminderFor instanceof Timestamp);
  const notes = await db.collection("notifications").get();
  const types = notes.docs.map((d) => `${d.data().type}:${d.data().recipientId}`);
  check("auto: organizer notified", types.includes(`draw_generated:${ORGANIZER}`) && types.includes(`draw_too_few:${ORGANIZER}`) &&
    types.includes(`registration_closing:${ORGANIZER}`), types.join(" "));
  check("auto: leftover told", notes.docs.some((d) => d.data().type === "pairing_unmatched"));
  // Other triggers (new_registration, match_finished) write notifications too; count only the job's.
  const jobTypes = ["draw_generated", "draw_too_few", "draw_manual", "draw_failed", "pairing_unmatched", "registration_closing"];
  const jobNotes = async () => (await db.collection("notifications").where("type", "in", jobTypes).get()).size;
  const before = await jobNotes();
  await runAutoDraw(db, new Date());
  check("auto: second run does nothing", (await jobNotes()) === before);

  console.log(failures === 0 ? "\nAll emulator draw checks passed." : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
