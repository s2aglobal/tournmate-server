/**
 * Emulator test for the score callables and the standings trigger.
 * Run through run.sh (demo-tm project; auth, Firestore and functions emulators).
 *
 * Paths: organizer final (simple, sets, cricket), participant pending,
 * confirm by the opponent only, dispute, resolve (organizer only), Elo
 * applied exactly once (callables and old-app direct writes), validation
 * errors, uid lists vs registration fallback, standings rebuilt.
 */
const path = require("path");
const fnRequire = require("module").createRequire(path.join(__dirname, "../../functions/package.json"));
const { initializeApp } = fnRequire("firebase-admin/app");
const { getFirestore, Timestamp } = fnRequire("firebase-admin/firestore");

const PROJECT = "demo-tm";
initializeApp({ projectId: PROJECT });
const db = getFirestore();

const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9199"}`;
const FUNCTIONS = "http://127.0.0.1:5101";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

async function signUp(email) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "emulator-only-123", returnSecureToken: true }),
  });
  const json = await res.json();
  if (!json.idToken) throw new Error(`signUp failed: ${JSON.stringify(json)}`);
  return { uid: json.localId, token: json.idToken };
}

async function call(name, data, user) {
  const headers = { "Content-Type": "application/json" };
  if (user) headers.Authorization = `Bearer ${user.token}`;
  const res = await fetch(`${FUNCTIONS}/${PROJECT}/us-central1/${name}`, {
    method: "POST", headers, body: JSON.stringify({ data }),
  });
  const json = await res.json();
  if (json.error) return { error: { reason: json.error.details && json.error.details.reason, message: json.error.message } };
  return { result: json.result };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  return null;
}

const id = () => require("crypto").randomUUID().toUpperCase();
const now = Timestamp.now();

async function player(uid, name, elo = 1200) {
  const pid = id();
  await db.collection("players").doc(pid).set({
    name, phone: "", email: "", genderRaw: "male", elo, streak: 0, firebaseUid: uid, avatarId: "a", createdAt: now,
  });
  return pid;
}

async function registration(tid, playerId, extra = {}) {
  const rid = id();
  await db.collection("registrations").doc(rid).set({ tournamentId: tid, playerId, createdAt: now, ...extra });
  return rid;
}

async function match(tid, a, b, extra = {}) {
  const mid = id();
  await db.collection("matches").doc(mid).set({
    tournamentId: tid, teamAId: a, teamBId: b, statusRaw: "scheduled", round: 1, sportType: extra.sportType || "badminton",
    createdAt: Timestamp.now(), ...extra,
  });
  return mid;
}

const getMatch = async (mid) => (await db.collection("matches").doc(mid).get()).data();
const getPlayer = async (pid) => (await db.collection("players").doc(pid).get()).data();
const expectError = (name, r, reason) => check(name, r.error && r.error.reason === reason, JSON.stringify(r));

/** 1v1 Elo from 1200 each, applied once: winner +12, loser −12. */
async function expectEloOnce(name, winnerPid, loserPid, mid) {
  const applied = await waitFor(async () => (await getMatch(mid)).eloApplied === true);
  check(`${name}: eloApplied`, !!applied);
  await sleep(2500); // let onMatchFinished run; it must not rate the match again
  const w = await getPlayer(winnerPid);
  const l = await getPlayer(loserPid);
  check(`${name}: Elo applied once`, Math.abs(w.elo - 1212) < 1e-9 && Math.abs(l.elo - 1188) < 1e-9, `${w.elo} / ${l.elo}`);
  check(`${name}: streaks`, w.streak === 1 && l.streak === -1, `${w.streak} / ${l.streak}`);
}

async function main() {
  const org = await signUp("org@example.test");
  const a1 = await signUp("a1@example.test");
  const b1 = await signUp("b1@example.test");
  const x = await signUp("x@example.test");
  const noProfile = await signUp("nobody@example.test");
  await player(org.uid, "Organizer");
  await player(x.uid, "Outsider");

  const tid = id();
  await db.collection("tournaments").doc(tid).set({
    title: "Emulator Open", createdBy: org.uid, sportType: "badminton", formatRaw: "openSingles",
    matchFormatRaw: "roundRobin", statusRaw: "scheduled", date: now, registrationDeadline: now, createdAt: now,
    scoringConfigData: JSON.stringify({ gamesPerMatch: 3, pointsToWin: 21, winBy: 2, pointCap: 30, scoringSystem: "rally" }),
    formatConfigData: JSON.stringify({ pointsPerWin: 2, pointsPerDraw: 1, pointsPerLoss: 0, tieBreaker: "headToHead", tieBreakRulesVersion: 1 }),
  });
  const pair = async (k) => {
    const pa = await player(a1.uid, `A${k}`);
    const pb = await player(b1.uid, `B${k}`);
    const ra = await registration(tid, pa);
    const rb = await registration(tid, pb);
    return { pa, pb, ra, rb };
  };

  // ── Basic guards ──
  expectError("unauthenticated", await call("submitScore", { matchId: "nope" }), "UNAUTHENTICATED");
  expectError("missing match", await call("submitScore", { matchId: "NOPE", scoreA: 21, scoreB: 10 }, org), "NOT_FOUND");

  // ── 1. Organizer final, simple score ──
  {
    const p = await pair(1);
    const mid = await match(tid, p.ra, p.rb);
    expectError("organizer: invalid simple score", await call("submitScore", { matchId: mid, scoreA: 21, scoreB: 20 }, org), "INVALID_SCORE");
    const r = await call("submitScore", { matchId: mid, scoreA: 21, scoreB: 15 }, org);
    check("organizer final: finished", r.result && r.result.status === "finished", JSON.stringify(r));
    const m = await getMatch(mid);
    check("organizer final: fields", m.scoreA === 21 && m.scoreB === 15 && m.winnerRegistrationId === p.ra &&
      m.setScores === undefined && m.submittedBy === undefined, JSON.stringify(m));
    await expectEloOnce("organizer final", p.pa, p.pb, mid);
    const n = await waitFor(async () => {
      const s = await db.collection("notifications").where("recipientId", "==", b1.uid).where("type", "==", "match_finished").get();
      return s.size > 0 ? s.size : null;
    });
    check("organizer final: result notification sent once", n === 1, String(n));
  }

  // ── 2. Participant pending → confirm by the opponent only ──
  {
    const p = await pair(2);
    const mid = await match(tid, p.ra, p.rb);
    expectError("outsider can't submit", await call("submitScore", { matchId: mid, setScores: [{ teamAPoints: 21, teamBPoints: 10 }, { teamAPoints: 21, teamBPoints: 12 }] }, x), "NOT_PARTICIPANT");
    expectError("no profile", await call("submitScore", { matchId: mid, scoreA: 21, scoreB: 10 }, noProfile), "NO_PROFILE");
    expectError("participant: match not decided", await call("submitScore", { matchId: mid, setScores: [{ teamAPoints: 21, teamBPoints: 10 }] }, a1), "INVALID_SCORE");
    const r = await call("submitScore", { matchId: mid, setScores: [{ teamAPoints: 21, teamBPoints: 10 }, { teamAPoints: 21, teamBPoints: 12 }] }, a1);
    check("participant: pending", r.result && r.result.status === "scoreSubmitted", JSON.stringify(r));
    const m = await getMatch(mid);
    check("participant: fields", m.statusRaw === "scoreSubmitted" && m.submittedBy === a1.uid && m.scoreA === 2 &&
      m.scoreB === 0 && m.winnerRegistrationId === p.ra && m.setScores.length === 2, JSON.stringify(m));
    check("participant: no Elo yet", (await getPlayer(p.pa)).elo === 1200);
    const asked = await waitFor(async () => (await db.collection("notifications")
      .where("recipientId", "==", b1.uid).where("type", "==", "score_submitted").get()).size > 0);
    check("participant: opponent asked to confirm", !!asked);
    expectError("participant: resubmit locked", await call("submitScore", { matchId: mid, scoreA: 21, scoreB: 10 }, b1), "SCORE_LOCKED");
    expectError("submitter can't confirm", await call("confirmScore", { matchId: mid }, a1), "NOT_PARTICIPANT");
    expectError("outsider can't confirm", await call("confirmScore", { matchId: mid }, x), "NOT_PARTICIPANT");
    expectError("organizer can't confirm", await call("confirmScore", { matchId: mid }, org), "NOT_PARTICIPANT");
    const c = await call("confirmScore", { matchId: mid }, b1);
    check("opponent confirms: finished", c.result && c.result.status === "finished", JSON.stringify(c));
    const m2 = await getMatch(mid);
    check("confirm: fields", m2.confirmedBy === b1.uid && m2.winnerRegistrationId === p.ra);
    await expectEloOnce("confirm", p.pa, p.pb, mid);
    expectError("confirm again locked", await call("confirmScore", { matchId: mid }, b1), "SCORE_LOCKED");
  }

  // ── 3. Dispute → resolve ──
  {
    const p = await pair(3);
    const mid = await match(tid, p.ra, p.rb);
    await call("submitScore", { matchId: mid, scoreA: 21, scoreB: 10 }, b1);
    const m0 = await getMatch(mid);
    check("participant simple score stored as one game", m0.setScores.length === 1 && m0.scoreA === 1 && m0.scoreB === 0);
    expectError("submitter can't dispute", await call("disputeScore", { matchId: mid }, b1), "NOT_PARTICIPANT");
    const d = await call("disputeScore", { matchId: mid, reason: "Wrong score" }, a1);
    check("dispute: disputed", d.result && d.result.status === "disputed", JSON.stringify(d));
    const told = await waitFor(async () => (await db.collection("notifications")
      .where("recipientId", "==", org.uid).where("type", "==", "score_disputed").get()).size > 0);
    check("dispute: organizer notified", !!told);
    check("dispute: reason stored", (await getMatch(mid)).disputeReason === "Wrong score");
    expectError("resolve: participant refused", await call("resolveDispute", { matchId: mid, setScores: [{ teamAPoints: 10, teamBPoints: 21 }, { teamAPoints: 10, teamBPoints: 21 }] }, a1), "NOT_ORGANIZER");
    expectError("resolve: invalid", await call("resolveDispute", { matchId: mid, setScores: [{ teamAPoints: 21, teamBPoints: 21 }] }, org), "INVALID_SCORE");
    const r = await call("resolveDispute", { matchId: mid, setScores: [{ teamAPoints: 10, teamBPoints: 21 }, { teamAPoints: 10, teamBPoints: 21 }] }, org);
    check("resolve: finished", r.result && r.result.status === "finished", JSON.stringify(r));
    const m = await getMatch(mid);
    check("resolve: fields", m.winnerRegistrationId === p.rb && m.scoreA === 0 && m.scoreB === 2 && m.confirmedBy === undefined, JSON.stringify(m));
    check("resolve: dispute reason cleared", m.disputeReason === undefined);
    await expectEloOnce("resolve", p.pb, p.pa, mid);
    // Edit score on a finished match: no second Elo.
    const e = await call("resolveDispute", { matchId: mid, setScores: [{ teamAPoints: 10, teamBPoints: 21 }, { teamAPoints: 12, teamBPoints: 21 }] }, org);
    check("edit finished: ok", e.result && e.result.status === "finished");
    await sleep(2000);
    check("edit finished: Elo unchanged", Math.abs((await getPlayer(p.pb)).elo - 1212) < 1e-9);
  }

  // ── 4. Organizer final with set scores ──
  {
    const p = await pair(4);
    const mid = await match(tid, p.ra, p.rb);
    const r = await call("submitScore", { matchId: mid, setScores: [{ teamAPoints: 21, teamBPoints: 19 }, { teamAPoints: 18, teamBPoints: 21 }, { teamAPoints: 21, teamBPoints: 17 }] }, org);
    check("organizer sets: finished", r.result && r.result.status === "finished");
    const m = await getMatch(mid);
    check("organizer sets: submitted + confirmed by organizer", m.submittedBy === org.uid && m.confirmedBy === org.uid && m.scoreA === 2 && m.scoreB === 1);
    await expectEloOnce("organizer sets", p.pa, p.pb, mid);
  }

  // ── 5. uid lists on the match decide who plays ──
  {
    const p = await pair(5);
    const mid = await match(tid, p.ra, p.rb, { teamAUids: [a1.uid], teamBUids: [x.uid] });
    expectError("uid lists: b1 not listed", await call("submitScore", { matchId: mid, scoreA: 21, scoreB: 10 }, b1), "NOT_PARTICIPANT");
    const r = await call("submitScore", { matchId: mid, scoreA: 10, scoreB: 21 }, x);
    check("uid lists: listed player submits", r.result && r.result.status === "scoreSubmitted", JSON.stringify(r));
    const c = await call("confirmScore", { matchId: mid }, a1);
    check("uid lists: other side confirms", c.result && c.result.status === "finished", JSON.stringify(c));
  }

  // ── 6. Old app: direct write still gets Elo once (trigger) ──
  {
    const p = await pair(6);
    const mid = await match(tid, p.ra, p.rb);
    await db.collection("matches").doc(mid).update({ statusRaw: "finished", scoreA: 21, scoreB: 5, winnerRegistrationId: p.ra });
    await expectEloOnce("old app direct write", p.pa, p.pb, mid);
  }

  // ── 7. Standings rebuilt ──
  {
    const s = await waitFor(async () => {
      const d = (await db.collection("standings").doc(tid).get()).data();
      return d && d.groups[0] && d.groups[0].rows.filter((r) => r.played > 0).length === 12 ? d : null;
    });
    check("standings: built", !!s, JSON.stringify(s && s.groups));
    if (s) {
      const rows = s.groups[0].rows;
      check("standings: shape", s.format === "roundRobin" && s.groups.length === 1 && rows.every((r, i) => r.rank === i + 1) &&
        typeof s.updatedAt.toMillis === "function");
      check("standings: winners on 2 points", rows.filter((r) => r.points === 2).length === 6 && rows[0].points === 2);
    }
  }

  // ── 8. Cricket: organizer scorecard, participant scorecard, validation ──
  {
    const ct = id();
    await db.collection("tournaments").doc(ct).set({
      title: "Emulator T20", createdBy: org.uid, sportType: "cricket", formatRaw: "team", matchFormatRaw: "roundRobin",
      statusRaw: "scheduled", date: now, registrationDeadline: now, createdAt: now,
      rulesData: JSON.stringify({ eventTypeId: "t20" }),
    });
    const roster = async (uid, prefix) => Promise.all([0, 1, 2].map((i) => player(i === 0 ? uid : `nouser-${prefix}${i}`, `${prefix}${i}`)));
    const ra = await roster(a1.uid, "Roy");
    const rb = await roster(b1.uid, "Kin");
    const regA = await registration(ct, ra[0], { teamName: "Royals", rosterIds: ra, teamId: "t1" });
    const regB = await registration(ct, rb[0], { teamName: "Kings", rosterIds: rb, teamId: "t2" });
    const mid = await match(ct, regA, regB, { sportType: "cricket" });
    const card = { innings: [
      { battingRegistrationId: regA, runs: 158, wickets: 7, balls: 120 },
      { battingRegistrationId: regB, runs: 159, wickets: 4, balls: 110 },
    ] };
    expectError("cricket: set scores refused", await call("submitScore", { matchId: mid, scoreA: 1, scoreB: 0 }, org), "INVALID_ARGUMENT");
    expectError("cricket: unfinished chase", await call("submitScore", { matchId: mid, cricket: { resultData: JSON.stringify({ innings: [card.innings[0], { ...card.innings[1], runs: 100 }] }) } }, org), "INVALID_SCORE");
    const stats = { batting: [{ teamRegistrationId: regB, key: rb[1], name: "Kin1", runs: 70, balls: 40, out: false }], bowling: [] };
    expectError("cricket: stats over the scorecard", await call("submitScore", { matchId: mid, cricket: {
      resultData: JSON.stringify(card),
      playerStatsData: JSON.stringify({ batting: [{ ...stats.batting[0], runs: 200 }], bowling: [] }),
    } }, org), "INVALID_SCORE");
    const r = await call("submitScore", { matchId: mid, cricket: {
      resultData: JSON.stringify(card), playerOfMatchKey: rb[1], playerOfMatchName: "Kin1", playerOfMatchTeamId: regB,
      playerStatsData: JSON.stringify(stats),
    } }, org);
    check("cricket organizer: finished", r.result && r.result.status === "finished", JSON.stringify(r));
    const m = await getMatch(mid);
    check("cricket organizer: fields", m.resultType === "win" && m.winnerRegistrationId === regB &&
      m.summary === "Kings won by 6 wickets (10 balls left)" && m.scoreA === 158 && m.scoreB === 159 &&
      m.confirmedBy === org.uid && m.submittedBy === org.uid && m.playerOfMatchTeamId === regB &&
      m.resultData.startsWith('{"innings":[{"balls":120,"battingRegistrationId"'), JSON.stringify(m));
    const applied = await waitFor(async () => (await getMatch(mid)).eloApplied === true);
    check("cricket: eloApplied", !!applied);

    const mid2 = await match(ct, regA, regB, { sportType: "cricket", round: 2 });
    const r2 = await call("submitScore", { matchId: mid2, cricket: { resultData: card } }, a1);
    check("cricket participant (roster fallback): pending", r2.result && r2.result.status === "scoreSubmitted", JSON.stringify(r2));
    const c2 = await call("confirmScore", { matchId: mid2 }, b1);
    check("cricket participant: opponent confirms", c2.result && c2.result.status === "finished", JSON.stringify(c2));

    const s = await waitFor(async () => {
      const d = (await db.collection("standings").doc(ct).get()).data();
      return d && d.groups[0] && d.groups[0].rows.every((row) => row.played === 2) ? d : null;
    });
    check("cricket standings: nrr + awards + top performers", !!s && s.groups[0].rows[0].registrationId === regB &&
      typeof s.groups[0].rows[0].nrr === "number" && s.playerOfTournament && s.playerOfTournament.teamId === regB &&
      s.topPerformers && s.topPerformers.batting[0].runs === 70, JSON.stringify(s));

    // Registration writes rebuild standings too: team rename, then withdraw.
    await db.collection("registrations").doc(regA).update({ teamName: "Royals XI" });
    const renamed = await waitFor(async () => {
      const d = (await db.collection("standings").doc(ct).get()).data();
      return d && d.groups[0].rows.some((row) => row.teamName === "Royals XI") ? d : null;
    });
    check("standings: rebuilt on team rename", !!renamed);
    await db.collection("registrations").doc(regA).delete();
    const withdrawn = await waitFor(async () => {
      const d = (await db.collection("standings").doc(ct).get()).data();
      return d && !d.groups.some((g) => g.rows.some((row) => row.registrationId === regA)) ? d : null;
    });
    check("standings: rebuilt on withdraw", !!withdrawn, JSON.stringify(withdrawn && withdrawn.groups));
  }

  console.log(failures === 0 ? "DONE all passed" : `DONE ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.log(`FAIL crashed: ${err && err.stack}`);
  process.exit(1);
});
