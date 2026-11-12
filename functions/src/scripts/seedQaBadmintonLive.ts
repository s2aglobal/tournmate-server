/**
 * QA seed for badminton LIVE scoring: creates badminton tournaments in
 * **tournmate-dev only** with the draw already made, so matches can be scored
 * live straight away ("Score live" on the match card; the sport must be on in
 * `config/sports.liveScoring`, see racket-live-contract.md).
 *
 * Per organizer it creates (titles get " · iOS" / " · Android" with two organizers):
 *   1. "QA Live Badminton Knockout": doubles, single elimination, best of 3 to
 *      21 (cap 30), 8 teams. Quarter-finals drawn; QF2 already finished
 *      (entered manually) so the bracket shows progress. QF1 has YOU (the
 *      organizer) playing with a test partner; QF3 and QF4 are test players only.
 *   2. "QA Live Badminton League": singles round robin (one game to 21 per
 *      match, as the apps score round robin), 4 players incl. you. 2 of 6
 *      results in; the rest (3 with you, 1 test-only) to score.
 *   3. "QA Live Badminton Short Games": doubles knockout, best of 3 to 11
 *      (cap 15), 4 teams, semi-finals ready (one with you).
 *   4. "QA Live Badminton Short Games 15": singles knockout, best of 3 to 15
 *      (cap 21), 4 test players, semi-finals ready.
 *   5. "QA Live Badminton Player View": doubles knockout, best of 3 to 21,
 *      ORGANIZED BY test20 (Olive Test), with you playing SF1 with a test
 *      partner: score it live as a participant, Finish → "score submitted",
 *      then confirm as an opponent (test2 / test3) on a second device. SF2 is
 *      test players only (watch it live while test4..test7 score it).
 *
 * Organizer path: in 1-4 you are the organizer, so your live result is final
 * at once, also in matches you play in. Second device: sign in as any test
 * player in a match (testN@tournmate.dev) to spectate, score, or take over
 * (players: after 3 minutes without a point; the organizer: any time).
 *
 * Finishing a seeded match applies Elo to the dev players in it, exactly like
 * any manual result. Seeded finished results are marked `eloApplied`.
 *
 * Every document written has `qaSeed: true` and a "QA " title prefix (where
 * the doc has a title). Remove everything with cleanupQaTournaments.ts (it
 * also deletes the live `points` / `racketLive` subcollections and the
 * server-built `standings` docs of QA tournaments).
 *
 * Needs the 20 test players from seedTestUsers.ts (test1..test20@tournmate.dev)
 * and a player profile for each organizer.
 *
 * Usage (from tournmate-server/functions, on the personal laptop with dev credentials):
 *   npm run build && node lib/scripts/seedQaBadmintonLive.js --dry-run
 *   npm run seed:qa-badminton-live
 *   npm run build && node lib/scripts/cleanupQaTournaments.js --include-notifications
 *   ... --organizers=<uid>[,<uid>]   (default: the QA simulator + emulator users)
 *   ... --json-out=<file>            (writes the created ids, used by the emulator check)
 *   ... --emulator                   (only with FIRESTORE_EMULATOR_HOST and a demo-* project:
 *                                     npm run test:emulator-qa-badminton-live)
 *
 * Credentials: Application Default Credentials
 * (`gcloud auth application-default login`).
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore, Timestamp, WriteBatch } from "firebase-admin/firestore";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";

const DEV_PROJECT_ID = "tournmate-dev";
const TITLE_PREFIX = "QA Live Badminton";

/** Default organizers: the users signed in on the QA simulator and emulator. */
const DEFAULT_ORGANIZERS: { uid: string; label: string }[] = [
  { uid: "uMkD5gCKhXVw1TBqsooZuFRCM5A3", label: "iOS" },
  { uid: "9enzsOvCuMOHeHl3Z504SbBL9E53", label: "Android" },
];

const scoring = (gamesPerMatch: number, pointsToWin: number, pointCap: number) =>
  JSON.stringify({ gamesPerMatch, pointsToWin, winBy: 2, pointCap, scoringSystem: "rally" });

const BO3_21 = scoring(3, 21, 30);
const ONE_GAME_21 = scoring(1, 21, 30);
const BO3_11 = scoring(3, 11, 15);
const BO3_15 = scoring(3, 15, 21);

const newId = (): string => randomUUID().toUpperCase();
const DAY = 24 * 60 * 60 * 1000;

/** `days` from now at 18:00 Austin time, as a Timestamp. */
function dayOffset(days: number): Timestamp {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(23, 0, 0, 0);
  return Timestamp.fromDate(d);
}

const VENUE = { name: "QA Austin Downtown Courts", address: "500 E Cesar Chavez St, Austin, TX", lat: 30.2632, lng: -97.7404 };

type Sets = [number, number][];

interface PlayerRef { id: string; name: string; uid: string; email?: string }

interface Created { kind: string; id: string; title: string; note?: string }

/** Machine-readable summary (--json-out). */
interface SeededMatch {
  id: string; tournamentId: string; tournament: string; label: string; status: string;
  scoredBy: string; teamAUids: string[]; teamBUids: string[];
}

class Writer {
  private batch: WriteBatch;
  private ops = 0;
  readonly created: Created[] = [];
  constructor(private db: Firestore, private dryRun: boolean) { this.batch = db.batch(); }

  async set(collection: string, id: string, data: Record<string, unknown>, summary?: Created) {
    const doc = { ...data, qaSeed: true };
    if (summary) this.created.push(summary);
    if (this.dryRun) return;
    this.batch.set(this.db.collection(collection).doc(id), doc);
    if (++this.ops >= 400) await this.flush();
  }

  async flush() {
    if (this.dryRun || this.ops === 0) return;
    await this.batch.commit();
    this.batch = this.db.batch();
    this.ops = 0;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const emulator = argv.includes("--emulator");
  const orgArg = argv.find((a) => a.startsWith("--organizers="));
  const jsonOut = argv.find((a) => a.startsWith("--json-out="))?.slice("--json-out=".length);
  const organizers = orgArg
    ? orgArg.slice("--organizers=".length).split(",").filter(Boolean).map((uid, i) => ({ uid, label: `Org${i + 1}` }))
    : DEFAULT_ORGANIZERS;

  // ── Project guard ──
  let projectId = DEV_PROJECT_ID;
  if (emulator) {
    const pid = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
    if (!process.env.FIRESTORE_EMULATOR_HOST || !pid.startsWith("demo-")) {
      console.error("Refusing to run: --emulator needs FIRESTORE_EMULATOR_HOST and a demo-* project id.");
      process.exit(1);
    }
    projectId = pid;
  } else {
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      console.error("Refusing to run: FIRESTORE_EMULATOR_HOST is set; pass --emulator for an emulator run.");
      process.exit(1);
    }
    for (const v of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]) {
      const val = process.env[v];
      if (val && val !== DEV_PROJECT_ID) {
        console.error(`Refusing to run: ${v}=${val} (expected ${DEV_PROJECT_ID}).`);
        process.exit(1);
      }
    }
  }
  if (getApps().length === 0) initializeApp({ projectId });
  const db = getFirestore();

  // Confirm the project with a real read before writing anything.
  const probe = await db.collection("config").doc("sports").get();
  const connected = (db as unknown as { projectId: string }).projectId;
  const liveScoring = probe.exists ? probe.get("liveScoring") : undefined;
  console.log(`Connected project: ${connected}${emulator ? " (emulator)" : ""} (config/sports.liveScoring: ${JSON.stringify(liveScoring ?? null)})`);
  if (connected !== projectId) {
    console.error(`Refusing to run: connected to ${connected}, expected ${projectId}.`);
    process.exit(1);
  }
  if (!liveScoring || liveScoring.badminton !== true) {
    console.warn("WARNING: config/sports.liveScoring.badminton is not true: the apps won't show \"Score live\" and startRacketScoring will refuse new sessions.");
  }

  const existing = await db.collection("tournaments").where("qaSeed", "==", true).get();
  const mine = existing.docs.filter((d) => String(d.get("title") ?? "").startsWith(TITLE_PREFIX));
  if (mine.length > 0 && !dryRun) {
    console.error(`${mine.length} "${TITLE_PREFIX}" tournament(s) already exist. Run cleanupQaTournaments first.`);
    process.exit(1);
  }

  const playerByQuery = async (field: string, value: string, what: string): Promise<PlayerRef> => {
    const snap = await db.collection("players").where(field, "==", value).limit(1).get();
    if (snap.empty) throw new Error(`No player doc for ${what}`);
    const d = snap.docs[0];
    return { id: d.id, name: d.get("name"), uid: d.get("firebaseUid") ?? "", email: d.get("email") };
  };

  // Organizers' player docs (read only).
  const orgPlayers = new Map<string, PlayerRef>();
  for (const o of organizers) {
    const p = await playerByQuery("firebaseUid", o.uid, `organizer uid ${o.uid}`);
    orgPlayers.set(o.uid, p);
    console.log(`Organizer ${o.label}: uid ${o.uid} → player ${p.id} (${p.name})`);
  }

  // Test players test1..test20 (read only). test[0] = test1.
  const test: PlayerRef[] = [];
  for (let i = 1; i <= 20; i++) {
    const p = await playerByQuery("email", `test${i}@tournmate.dev`, `test${i}@tournmate.dev`);
    if (!p.uid) throw new Error(`test${i}@tournmate.dev has no firebaseUid (run seedTestUsers.ts)`);
    test.push(p);
  }
  console.log(`Test players: ${test.map((p, i) => `test${i + 1}=${p.name}`).join(", ")}`);
  const emailOf = (p: PlayerRef) => {
    const i = test.findIndex((t) => t.id === p.id);
    return i >= 0 ? `test${i + 1}` : "you";
  };

  const w = new Writer(db, dryRun);
  const guide: string[] = [];
  const seeded: SeededMatch[] = [];

  // ── Builders ──

  const tournament = async (o: {
    title: string; formatRaw: "openDoubles" | "openSingles"; matchFormatRaw: string; scoring: string;
    organizer: string; regCount: number; note: string;
  }): Promise<string> => {
    const id = newId();
    const deadline = dayOffset(-1);
    const fc = {
      seedingMode: "random", allowByes: true, bronzeMatch: false, consolationBracket: false,
      pointsPerWin: 2, pointsPerDraw: 1, pointsPerLoss: 0, doubleRoundRobin: false,
      groupCount: 2, teamsPerGroup: 4, advancingPerGroup: 2, swissRounds: 5,
      tieBreaker: "headToHead", groupTieBreaker: "headToHead", tieBreakRulesVersion: 1,
      maxParticipants: o.regCount,
    };
    await w.set("tournaments", id, {
      title: o.title,
      date: dayOffset(0),
      location: VENUE.name,
      locationAddress: VENUE.address,
      locationLatitude: VENUE.lat,
      locationLongitude: VENUE.lng,
      // No countryCode/postalCode: avoids onTournamentCreated topic pushes.
      timeZone: "America/Chicago",
      participantsCount: o.regCount,
      registrationCount: o.regCount,
      statusRaw: "scheduled",
      formatRaw: o.formatRaw,
      matchFormatRaw: o.matchFormatRaw,
      randomPairing: false,
      registrationDeadline: deadline,
      currency: "USD",
      // Backdated past the 24h create-rate window (see seedQaTournaments.ts).
      createdAt: Timestamp.fromMillis(Date.now() - 2 * DAY),
      createdBy: o.organizer,
      sportType: "badminton",
      ageGroupRaw: "open",
      formatConfigData: JSON.stringify(fc),
      scoringConfigData: o.scoring,
      durationMinutes: 180,
      // As generateDraw leaves it (services/draw/actions.ts).
      drawMade: true,
      autoDraw: { deadline, status: "generated", at: Timestamp.fromMillis(Date.now() - DAY) },
    }, { kind: "tournament", id, title: o.title, note: o.note });
    return id;
  };

  interface Reg { id: string; name: string; uids: string[]; players: PlayerRef[] }

  const register = async (tid: string, title: string, player: PlayerRef, partner: PlayerRef | undefined, i: number): Promise<Reg> => {
    const id = newId();
    const players = partner ? [player, partner] : [player];
    const uids = [...new Set(players.map((p) => p.uid).filter(Boolean))];
    const data: Record<string, unknown> = {
      tournamentId: tid, playerId: player.id,
      createdAt: Timestamp.fromMillis(Date.now() - 10 * DAY + i * 60_000),
      memberUids: uids, // as triggers/memberUids.ts keeps it
    };
    if (partner) data.partnerId = partner.id;
    const name = players.map((p) => p.name).join(" & ");
    await w.set("registrations", id, data, { kind: "registration", id, title: `${title}: ${name}` });
    return { id, name, uids, players };
  };

  const match = async (o: {
    tid: string; title: string; a: Reg; b: Reg; round: number; bracketPosition?: number; label: string;
    organizer: string; sets?: Sets; simple?: [number, number]; scoredBy: string;
  }): Promise<string> => {
    const id = newId();
    const finished = !!(o.sets || o.simple);
    const data: Record<string, unknown> = {
      tournamentId: o.tid, teamAId: o.a.id, teamBId: o.b.id, statusRaw: finished ? "finished" : "scheduled",
      createdAt: Timestamp.fromMillis(Date.now() - DAY + o.round * 60_000 + (o.bracketPosition ?? 0) * 1000),
      round: o.round, sportType: "badminton",
      teamAUids: o.a.uids, teamBUids: o.b.uids, // as triggers/memberUids.ts keeps them
    };
    if (o.bracketPosition !== undefined) data.bracketPosition = o.bracketPosition;
    let note = "ready to score live";
    if (o.sets) {
      // Organizer's manual game-by-game result (callables/scores.ts applyGames, final).
      const wa = o.sets.filter(([x, y]) => x > y).length;
      const wb = o.sets.filter(([x, y]) => y > x).length;
      Object.assign(data, {
        setScores: o.sets.map(([x, y]) => ({ teamAPoints: x, teamBPoints: y })),
        scoreA: wa, scoreB: wb, winnerRegistrationId: wa > wb ? o.a.id : o.b.id,
        submittedBy: o.organizer, confirmedBy: o.organizer, eloApplied: true,
      });
      note = `finished ${o.sets.map((s) => s.join("-")).join(" ")}`;
    } else if (o.simple) {
      // Organizer's simple result (applyFinalScore).
      const [x, y] = o.simple;
      Object.assign(data, { scoreA: x, scoreB: y, winnerRegistrationId: x > y ? o.a.id : o.b.id, eloApplied: true });
      note = `finished ${x}-${y}`;
    }
    const label = `${o.label}: ${o.a.name} v ${o.b.name}`;
    await w.set("matches", id, data, { kind: "match", id, title: `${o.title}: ${label}`, note });
    seeded.push({
      id, tournamentId: o.tid, tournament: o.title, label: o.label, status: data.statusRaw as string,
      scoredBy: finished ? "-" : o.scoredBy, teamAUids: o.a.uids, teamBUids: o.b.uids,
    });
    if (!finished) guide.push(`  ${o.title} · ${label}  →  ${o.scoredBy}`);
    return id;
  };

  const scorers = (org: PlayerRef, a: Reg, b: Reg, organizerIsYou: boolean): string => {
    const youPlay = [...a.players, ...b.players].some((p) => p.id === org.id);
    const testers = [...a.players, ...b.players].filter((p) => p.id !== org.id).map(emailOf).join("/");
    if (organizerIsYou) {
      return youPlay
        ? `you play + organize (your result is final); 2nd device: ${testers}`
        : `organizer-final path; 2nd device player/takeover: ${testers}`;
    }
    return youPlay
      ? `you score as a PLAYER → Finish = score submitted; opponent confirms on 2nd device: ${b.players.map(emailOf).join(" or ")}`
      : `spectate (you are not in it); 2nd device scores: ${testers}`;
  };

  // ── Per-organizer sets ──

  for (const o of organizers) {
    const tag = organizers.length > 1 ? ` · ${o.label}` : "";
    const me = orgPlayers.get(o.uid)!;
    const t = (n: number) => test[n - 1]; // t(1) = test1

    // 1. Knockout: doubles, single elimination, Bo3 to 21 (cap 30), 8 teams.
    {
      const title = `${TITLE_PREFIX} Knockout${tag}`;
      const tid = await tournament({
        title, formatRaw: "openDoubles", matchFormatRaw: "singleElimination", scoring: BO3_21,
        organizer: o.uid, regCount: 8, note: "doubles, single elim, Bo3 to 21 (cap 30), 8 teams, QFs drawn",
      });
      const pairs: [PlayerRef, PlayerRef][] = [
        [me, t(1)], [t(2), t(3)], [t(4), t(5)], [t(6), t(7)], [t(8), t(9)], [t(10), t(11)], [t(12), t(13)], [t(14), t(15)],
      ];
      const regs: Reg[] = [];
      for (let i = 0; i < pairs.length; i++) regs.push(await register(tid, title, pairs[i][0], pairs[i][1], i));
      // Bracket first round as generateBracketFirstRound pairs seeds: i v n-1-i.
      const qf: [number, number][] = [[0, 7], [1, 6], [2, 5], [3, 4]];
      for (let pos = 0; pos < 4; pos++) {
        const [a, b] = qf[pos];
        const done = pos === 1;
        await match({
          tid, title, a: regs[a], b: regs[b], round: 1, bracketPosition: pos, label: `QF${pos + 1}`, organizer: o.uid,
          sets: done ? [[21, 17], [18, 21], [21, 15]] : undefined, scoredBy: scorers(me, regs[a], regs[b], true),
        });
      }
    }

    // 2. League: singles round robin (one game per match), 4 players incl. you.
    {
      const title = `${TITLE_PREFIX} League${tag}`;
      const tid = await tournament({
        title, formatRaw: "openSingles", matchFormatRaw: "roundRobin", scoring: ONE_GAME_21,
        organizer: o.uid, regCount: 4, note: "singles round robin, 1 game to 21 (cap 30), 4 players, 2/6 played",
      });
      const players = [me, t(16), t(17), t(18)];
      const regs: Reg[] = [];
      for (let i = 0; i < players.length; i++) regs.push(await register(tid, title, players[i], undefined, i));
      // Circle schedule (as generateRoundRobinSchedule): 3 rounds of 2 matches.
      const rr: { a: number; b: number; round: number; simple?: [number, number] }[] = [
        { a: 0, b: 3, round: 1 },
        { a: 1, b: 2, round: 1, simple: [21, 18] },
        { a: 0, b: 2, round: 2 },
        { a: 3, b: 1, round: 2, simple: [15, 21] },
        { a: 0, b: 1, round: 3 },
        { a: 2, b: 3, round: 3 },
      ];
      for (const m of rr) {
        await match({
          tid, title, a: regs[m.a], b: regs[m.b], round: m.round, label: `R${m.round}`, organizer: o.uid,
          simple: m.simple, scoredBy: scorers(me, regs[m.a], regs[m.b], true),
        });
      }
    }

    // 3. Short games: doubles knockout, Bo3 to 11 (cap 15), 4 teams.
    {
      const title = `${TITLE_PREFIX} Short Games${tag}`;
      const tid = await tournament({
        title, formatRaw: "openDoubles", matchFormatRaw: "singleElimination", scoring: BO3_11,
        organizer: o.uid, regCount: 4, note: "doubles, single elim, Bo3 to 11 (cap 15), SFs drawn",
      });
      const pairs: [PlayerRef, PlayerRef][] = [[me, t(19)], [t(2), t(4)], [t(6), t(8)], [t(10), t(12)]];
      const regs: Reg[] = [];
      for (let i = 0; i < pairs.length; i++) regs.push(await register(tid, title, pairs[i][0], pairs[i][1], i));
      await match({ tid, title, a: regs[0], b: regs[3], round: 1, bracketPosition: 0, label: "SF1", organizer: o.uid, scoredBy: scorers(me, regs[0], regs[3], true) });
      await match({ tid, title, a: regs[1], b: regs[2], round: 1, bracketPosition: 1, label: "SF2", organizer: o.uid, scoredBy: scorers(me, regs[1], regs[2], true) });
    }

    // 4. Short games 15: singles knockout, Bo3 to 15 (cap 21), 4 test players.
    {
      const title = `${TITLE_PREFIX} Short Games 15${tag}`;
      const tid = await tournament({
        title, formatRaw: "openSingles", matchFormatRaw: "singleElimination", scoring: BO3_15,
        organizer: o.uid, regCount: 4, note: "singles, single elim, Bo3 to 15 (cap 21), SFs drawn",
      });
      const players = [t(3), t(5), t(7), t(9)];
      const regs: Reg[] = [];
      for (let i = 0; i < players.length; i++) regs.push(await register(tid, title, players[i], undefined, i));
      await match({ tid, title, a: regs[0], b: regs[3], round: 1, bracketPosition: 0, label: "SF1", organizer: o.uid, scoredBy: scorers(me, regs[0], regs[3], true) });
      await match({ tid, title, a: regs[1], b: regs[2], round: 1, bracketPosition: 1, label: "SF2", organizer: o.uid, scoredBy: scorers(me, regs[1], regs[2], true) });
    }

    // 5. Player view: organized by test20, you play SF1 (participant scoring → opponent confirms).
    {
      const host = t(20);
      const title = `${TITLE_PREFIX} Player View${tag}`;
      const tid = await tournament({
        title, formatRaw: "openDoubles", matchFormatRaw: "singleElimination", scoring: BO3_21,
        organizer: host.uid, regCount: 4, note: `organized by test20 (${host.name}); you play SF1`,
      });
      const pairs: [PlayerRef, PlayerRef][] = [[me, t(1)], [t(4), t(5)], [t(6), t(7)], [t(2), t(3)]];
      const regs: Reg[] = [];
      for (let i = 0; i < pairs.length; i++) regs.push(await register(tid, title, pairs[i][0], pairs[i][1], i));
      await match({ tid, title, a: regs[0], b: regs[3], round: 1, bracketPosition: 0, label: "SF1", organizer: host.uid, scoredBy: scorers(me, regs[0], regs[3], false) });
      await match({ tid, title, a: regs[1], b: regs[2], round: 1, bracketPosition: 1, label: "SF2", organizer: host.uid, scoredBy: scorers(me, regs[1], regs[2], false) });
    }
  }

  await w.flush();

  console.log(`\n${dryRun ? "[DRY RUN] would create" : "Created"} ${w.created.length} docs:\n`);
  console.log("kind          id                                    title / note");
  for (const c of w.created) console.log(`${c.kind.padEnd(13)} ${c.id}  ${c.title}${c.note ? `  [${c.note}]` : ""}`);
  console.log("\nMatches to score live (who can score):");
  for (const g of guide) console.log(g);
  console.log("\nTest accounts: testN@tournmate.dev (passwords: see seedTestUsers.ts). Remove with cleanupQaTournaments.js --include-notifications.");

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ projectId, dryRun, matches: seeded }, null, 2));
    console.log(`Wrote ${jsonOut}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
