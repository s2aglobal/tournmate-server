/**
 * QA seed for cricket: creates cricket tournaments, teams, team entries (with
 * roles and guests), matches with scorecards and Player of the Match in
 * **tournmate-dev only**, so every cricket screen can be checked on iOS and
 * Android without typing in dozens of results.
 *
 * Per organizer it creates:
 *   1. "QA Cricket Open Entry": T20, single elimination, Random seeding,
 *      5 teams entered, no draw yet. Generate the draw in the app (5 teams,
 *      so 3 byes), register your own team, and try a second entry (blocked).
 *   2. "QA Cricket League": Box 6, round robin, 4 teams. 5 of 6 matches are
 *      played (a win by runs, a chase, a tie, a no result, a big win); C v D
 *      is left for you to score. Check the table (P W L T NR PTS NRR), the
 *      results, Player of the Match and Player of the Tournament.
 *   3. "QA Cricket Groups": T10, group + knockout, 8 teams in 2 groups. The
 *      group stage is played; one semi-final was decided by a super over and
 *      the other is waiting for a result.
 *
 * Played matches carry batting and bowling figures for some players (as an
 * organizer would enter them), so the Top performers leaderboards and player
 * profiles have data.
 *
 * The expected tables and results are printed at the end.
 *
 * Every document written has `qaSeed: true` (and a "QA " title prefix where
 * the doc has a title). Remove everything with cleanupQaTournaments.ts
 * (it also clears QA teams and team-entry locks).
 *
 * Needs the 20 test players from seedTestUsers.ts (test1..test20@tournmate.dev).
 *
 * Usage (from tournmate-server/functions, on a machine with dev credentials):
 *   npm run build && node lib/scripts/seedQaCricket.js --dry-run
 *   npm run build && node lib/scripts/seedQaCricket.js
 *   ... --organizers=<uid>[,<uid>]   (default: the QA simulator + emulator users)
 *
 * Credentials: Application Default Credentials
 * (`gcloud auth application-default login`).
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore, Timestamp, WriteBatch } from "firebase-admin/firestore";
import { randomUUID } from "crypto";
import {
  CRICKET_EVENT_TYPES,
  CricketEventTypeId,
  CricketResult,
  CricketRules,
  CRICKET_POINTS,
  RunRateTotals,
  addToRunRate,
  cricketOutcome,
  formatNetRunRate,
  formatOvers,
  netRunRate,
  outcomeSummary,
  validateCricketResult,
} from "../services/cricket";
import {
  BattingFigures,
  BowlingFigures,
  PlayerStats,
  battingLeaders,
  bowlingLeaders,
  formatBest,
  formatHighest,
  validatePlayerStats,
} from "../services/cricketPlayerStats";

const PROJECT_ID = "tournmate-dev";

/** Default organizers: the users signed in on the QA simulator and emulator. */
const DEFAULT_ORGANIZERS: { uid: string; label: string }[] = [
  { uid: "uMkD5gCKhXVw1TBqsooZuFRCM5A3", label: "iOS" },
  { uid: "9enzsOvCuMOHeHl3Z504SbBL9E53", label: "Android" },
];

const VENUE = {
  name: "QA Merion Cricket Ground", address: "Merion Cricket Ct, Austin, TX",
  lat: 30.1866, lng: -97.7433,
};

// ─── Helpers ─────────────────────────────────────────────

const newId = (): string => randomUUID().toUpperCase();
const DAY = 24 * 60 * 60 * 1000;

function dayOffset(days: number): Timestamp {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(23, 0, 0, 0);
  return Timestamp.fromDate(d);
}

function rulesFor(id: CricketEventTypeId): CricketRules {
  const preset = CRICKET_EVENT_TYPES.find((t) => t.id === id);
  if (!preset) throw new Error(`Unknown event type ${id}`);
  return { ...preset.rules };
}

/** JSON with sorted keys, like the iOS encoder (`.sortedKeys`). */
function sortedJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

interface Created { kind: string; id: string; title: string; note?: string }

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

interface PlayerRef { id: string; name: string; uid?: string }

/** A team entry as seeded: registration id plus who plays and their roles. */
interface Entry {
  regId: string;
  name: string;
  players: PlayerRef[];
  guests: string[];
  /** Roles keys: player id (upper case) or `guest:<name>`. */
  captain: string;
  pomKey: string;
  pomName: string;
}

const key = (p: PlayerRef) => p.id.toUpperCase();
const guestKey = (name: string) => `guest:${name}`;

// ─── Main ────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const orgArg = argv.find((a) => a.startsWith("--organizers="));
  const organizers = orgArg
    ? orgArg.slice("--organizers=".length).split(",").map((uid, i) => ({ uid, label: `Org${i + 1}` }))
    : DEFAULT_ORGANIZERS;

  for (const v of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]) {
    const val = process.env[v];
    if (val && val !== PROJECT_ID) {
      console.error(`Refusing to run: ${v}=${val} (expected ${PROJECT_ID}).`);
      process.exit(1);
    }
  }
  if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();

  const probe = await db.collection("config").doc("sports").get();
  const connected = (db as unknown as { projectId: string }).projectId;
  console.log(`Connected project: ${connected} (config/sports exists: ${probe.exists})`);
  if (connected !== PROJECT_ID) {
    console.error(`Refusing to run: connected to ${connected}, expected ${PROJECT_ID}.`);
    process.exit(1);
  }

  const existing = await db.collection("tournaments")
    .where("qaSeed", "==", true).where("sportType", "==", "cricket").limit(1).get();
  if (!existing.empty && !dryRun) {
    console.error("QA cricket docs already exist. Run cleanupQaTournaments first.");
    process.exit(1);
  }

  const orgPlayers = new Map<string, PlayerRef>();
  for (const o of organizers) {
    const snap = await db.collection("players").where("firebaseUid", "==", o.uid).limit(1).get();
    if (snap.empty) throw new Error(`No player doc for organizer uid ${o.uid}`);
    orgPlayers.set(o.uid, { id: snap.docs[0].id, name: snap.docs[0].get("name"), uid: o.uid });
    console.log(`Organizer ${o.label}: uid ${o.uid} → player ${snap.docs[0].id} (${snap.docs[0].get("name")})`);
  }

  const test: PlayerRef[] = [];
  for (let i = 1; i <= 20; i++) {
    const snap = await db.collection("players").where("email", "==", `test${i}@tournmate.dev`).limit(1).get();
    if (snap.empty) throw new Error(`No player doc for test${i}@tournmate.dev (run seedTestUsers first)`);
    test.push({ id: snap.docs[0].id, name: snap.docs[0].get("name"), uid: snap.docs[0].get("firebaseUid") });
  }
  // A seeded player must never be the organizer (one team per person).
  for (const org of orgPlayers.values()) {
    if (test.some((t) => t.id === org.id)) throw new Error(`Organizer ${org.name} is one of the test players`);
  }

  const w = new Writer(db, dryRun);
  const expectations: string[] = [];

  // ── Builders ──

  const tournament = async (o: {
    title: string; days: number; matchFormatRaw: string; eventType: CricketEventTypeId;
    formatConfig: Record<string, unknown>; organizer: string; regCount: number; note: string;
  }): Promise<{ id: string; rules: CricketRules }> => {
    const id = newId();
    const rules = rulesFor(o.eventType);
    await w.set("tournaments", id, {
      title: o.title,
      date: dayOffset(o.days),
      location: VENUE.name,
      locationAddress: VENUE.address,
      locationLatitude: VENUE.lat,
      locationLongitude: VENUE.lng,
      // No countryCode/postalCode: avoids a region push from onTournamentCreated.
      timeZone: "America/Chicago",
      participantsCount: o.regCount,
      registrationCount: o.regCount,
      statusRaw: "scheduled",
      formatRaw: "team",
      matchFormatRaw: o.matchFormatRaw,
      randomPairing: false,
      registrationDeadline: dayOffset(o.days - 1),
      currency: "USD",
      createdAt: Timestamp.fromMillis(Date.now() - 2 * DAY),
      createdBy: o.organizer,
      sportType: "cricket",
      ageGroupRaw: "open",
      eventTypeId: rules.eventTypeId,
      rulesData: sortedJson(rules),
      formatConfigData: JSON.stringify({
        seedingMode: "eloRanked", allowByes: true, bronzeMatch: false, consolationBracket: false,
        pointsPerWin: CRICKET_POINTS.win, pointsPerDraw: CRICKET_POINTS.tie, pointsPerLoss: CRICKET_POINTS.loss,
        doubleRoundRobin: false, groupCount: 2, teamsPerGroup: 4, advancingPerGroup: 2, swissRounds: 5,
        tieBreaker: "headToHead", groupTieBreaker: "headToHead", tieBreakRulesVersion: 1,
        ...o.formatConfig,
      }),
      durationMinutes: 300,
    }, { kind: "tournament", id, title: o.title, note: o.note });
    return { id, rules };
  };

  /**
   * A team (teams/{id}) and its entry: registration with roster, guests and
   * roles, plus the one-entry lock, exactly as the apps write them.
   */
  const enter = async (o: {
    tid: string; title: string; organizer: string; name: string; players: PlayerRef[]; guests: string[];
    registrant?: PlayerRef; roles: (k: { players: string[]; guests: string[] }) => {
      captain: string; vice?: string; keeper?: string; playing: Record<string, string>;
    }; minutes: number; pom: number | string;
  }): Promise<Entry> => {
    const teamId = newId();
    const registrant = o.registrant ?? o.players[0];
    await w.set("teams", teamId, {
      name: o.name, sportType: "cricket", captainId: registrant.id,
      playerIds: [...new Set([registrant, ...o.players].map((p) => p.id))],
      createdBy: registrant.uid ?? o.organizer,
      createdAt: Timestamp.fromMillis(Date.now() - 12 * DAY),
    }, { kind: "team", id: teamId, title: `${o.title}: ${o.name}` });

    const keys = { players: o.players.map(key), guests: o.guests.map(guestKey) };
    const roles = o.roles(keys);
    const regId = newId();
    const reg: Record<string, unknown> = {
      tournamentId: o.tid, playerId: registrant.id, teamId, teamName: o.name,
      rosterIds: o.players.map((p) => p.id),
      captainId: roles.captain, playerRoles: roles.playing,
      createdAt: Timestamp.fromMillis(Date.now() - 10 * DAY + o.minutes * 60_000),
    };
    if (o.guests.length) reg.guestNames = o.guests;
    if (roles.vice) reg.viceCaptainId = roles.vice;
    if (roles.keeper) reg.keeperId = roles.keeper;
    const roster = o.players.length + o.guests.length;
    await w.set("registrations", regId, reg, {
      kind: "registration", id: regId, title: `${o.title}: ${o.name}`,
      note: `${roster} players (${o.guests.length} guests), registered by ${registrant.name}`,
    });
    const lockId = `${o.tid.toLowerCase()}_${registrant.id.toLowerCase()}`;
    await w.set("teamEntries", lockId, { tournamentId: o.tid, playerId: registrant.id, registrationId: regId });

    const pomKey = typeof o.pom === "number" ? key(o.players[o.pom]) : guestKey(o.pom);
    const pomName = typeof o.pom === "number" ? o.players[o.pom].name : o.pom;
    return { regId, name: o.name, players: o.players, guests: o.guests, captain: roles.captain, pomKey, pomName };
  };

  const members = (e: Entry) => [
    ...e.players.map((p) => ({ key: key(p), name: p.name })),
    ...e.guests.map((g) => ({ key: guestKey(g), name: g })),
  ];

  /**
   * Figures that fit the scorecard: the batting side's top four share about
   * 90% of the runs (the rest are extras), the bowling side's first three
   * bowlers share the balls, most of the runs and all but one wicket.
   */
  const figuresFor = (result: CricketResult, a: Entry, b: Entry, seed: number): PlayerStats => {
    const batting: BattingFigures[] = [];
    const bowling: BowlingFigures[] = [];
    for (const [idx, innings] of result.innings.entries()) {
      const bat = innings.battingRegistrationId === a.regId ? a : b;
      const field = bat === a ? b : a;
      const batters = members(bat).slice(0, 4);
      const shares = [0.4, 0.25, 0.15, 0.1];
      let outsLeft = innings.wickets;
      batters.forEach((m, i) => {
        const out = outsLeft > 0 && i !== (seed + idx) % batters.length;
        if (out) outsLeft--;
        batting.push({
          teamRegistrationId: bat.regId, key: m.key, name: m.name,
          runs: Math.floor(innings.runs * shares[i]), balls: Math.floor(innings.balls * shares[i] * 0.9), out,
        });
      });
      const bowlers = members(field).slice(-3);
      const ballShares = [0.4, 0.3, 0.3];
      const wicketShares = [Math.ceil(innings.wickets / 2), Math.floor(innings.wickets / 3), 0];
      let ballsLeft = innings.balls;
      bowlers.forEach((m, i) => {
        const balls = i === bowlers.length - 1 ? ballsLeft : Math.floor(innings.balls * ballShares[i]);
        ballsLeft -= balls;
        bowling.push({
          teamRegistrationId: field.regId, key: m.key, name: m.name, balls,
          runs: Math.floor(innings.runs * 0.3), wickets: Math.min(wicketShares[i], innings.wickets),
        });
      });
    }
    return { batting, bowling };
  };

  /** Every seeded match's figures, for the expected leaderboards. */
  const seededStats = new Map<string, PlayerStats[]>();

  /** A finished cricket match: validated with the server rules, outcome and summary derived. */
  const played = async (o: {
    tid: string; title: string; rules: CricketRules; organizer: string; a: Entry; b: Entry;
    round: number; result: CricketResult; pom?: Entry; groupLabel?: string; bracketPosition?: number;
  }): Promise<CricketResult> => {
    const issues = validateCricketResult(o.result, o.rules, o.a.regId, o.b.regId);
    if (issues.length) throw new Error(`${o.title} ${o.a.name} v ${o.b.name}: ${issues.map((i) => i.message).join("; ")}`);
    const outcome = cricketOutcome(o.result, o.rules);
    const names = new Map([[o.a.regId, o.a.name], [o.b.regId, o.b.name]]);
    const summary = outcomeSummary(outcome, (id) => names.get(id) ?? "?");
    const runs = (id: string) => o.result.innings.find((i) => i.battingRegistrationId === id)?.runs;
    const stats = figuresFor(o.result, o.a, o.b, o.round + (o.bracketPosition ?? 0));
    const statIssues = validatePlayerStats(stats, o.result, o.a.regId, o.b.regId, (rid) => names.get(rid) ?? "?");
    if (statIssues.length) throw new Error(`${o.title} ${o.a.name} v ${o.b.name} figures: ${statIssues.map((i) => i.message).join("; ")}`);
    seededStats.set(o.tid, [...(seededStats.get(o.tid) ?? []), stats]);
    const id = newId();
    const data: Record<string, unknown> = {
      tournamentId: o.tid, teamAId: o.a.regId, teamBId: o.b.regId, statusRaw: "finished",
      createdAt: Timestamp.fromMillis(Date.now() - 5 * DAY + o.round * 60_000 + (o.bracketPosition ?? 0) * 1000),
      round: o.round, sportType: "cricket",
      resultType: outcome.resultType, resultData: sortedJson(o.result), summary,
      playerStatsData: sortedJson(stats),
      submittedBy: o.organizer, confirmedBy: o.organizer,
      // Seeded results must not move real ratings.
      eloApplied: true,
    };
    if (outcome.winnerRegistrationId) data.winnerRegistrationId = outcome.winnerRegistrationId;
    if (runs(o.a.regId) !== undefined) data.scoreA = runs(o.a.regId);
    if (runs(o.b.regId) !== undefined) data.scoreB = runs(o.b.regId);
    if (o.groupLabel) data.groupLabel = o.groupLabel;
    if (o.bracketPosition !== undefined) data.bracketPosition = o.bracketPosition;
    if (o.pom && outcome.resultType !== "noResult") {
      data.playerOfMatchKey = o.pom.pomKey;
      data.playerOfMatchName = o.pom.pomName;
      data.playerOfMatchTeamId = o.pom.regId;
    }
    const line = o.result.innings
      .map((i) => `${names.get(i.battingRegistrationId)} ${i.runs}/${i.wickets} (${formatOvers(i.balls, o.rules.ballsPerOver)})`)
      .join(", ");
    await w.set("matches", id, data, {
      kind: "match", id, title: `${o.title}: ${o.a.name} v ${o.b.name}`,
      note: `${line} → ${summary}${data.playerOfMatchName ? ` · PoM ${data.playerOfMatchName}` : ""}`,
    });
    return o.result;
  };

  const scheduled = async (o: {
    tid: string; title: string; a: Entry; b: Entry; round: number; groupLabel?: string; bracketPosition?: number;
  }) => {
    const id = newId();
    const data: Record<string, unknown> = {
      tournamentId: o.tid, teamAId: o.a.regId, teamBId: o.b.regId, statusRaw: "scheduled",
      createdAt: Timestamp.fromMillis(Date.now() - 5 * DAY + o.round * 60_000 + (o.bracketPosition ?? 0) * 1000),
      round: o.round, sportType: "cricket",
    };
    if (o.groupLabel) data.groupLabel = o.groupLabel;
    if (o.bracketPosition !== undefined) data.bracketPosition = o.bracketPosition;
    await w.set("matches", id, data, { kind: "match", id, title: `${o.title}: ${o.a.name} v ${o.b.name}`, note: "scheduled — enter this result" });
  };

  /** Expected table: points, then NRR (head-to-head isn't needed for these fixtures). */
  const table = (entries: Entry[], results: CricketResult[], rules: CricketRules): string => {
    const rows = entries.map((e) => {
      let p = 0, wins = 0, losses = 0, ties = 0, nr = 0, pts = 0;
      let rr: RunRateTotals = { runsFor: 0, ballsFaced: 0, runsAgainst: 0, ballsBowled: 0 };
      for (const r of results) {
        const ids = r.innings.map((i) => i.battingRegistrationId);
        const inMatch = (r as CricketResult & { teams?: string[] }).teams ?? ids;
        if (!inMatch.includes(e.regId)) continue;
        p++;
        const o = cricketOutcome(r, rules);
        if (o.resultType === "noResult") { nr++; pts += CRICKET_POINTS.noResult; }
        else if (o.resultType === "tie") { ties++; pts += CRICKET_POINTS.tie; }
        else if (o.winnerRegistrationId === e.regId) { wins++; pts += CRICKET_POINTS.win; }
        else losses++;
        rr = addToRunRate(rr, e.regId, r, rules);
      }
      return { name: e.name, p, wins, losses, ties, nr, pts, nrr: netRunRate(rr, rules.ballsPerOver) };
    });
    rows.sort((a, b) => b.pts - a.pts || b.nrr - a.nrr || a.name.localeCompare(b.name));
    return rows.map((r, i) =>
      `${i + 1}. ${r.name}  P${r.p} W${r.wins} L${r.losses} T${r.ties} NR${r.nr} PTS ${r.pts} NRR ${formatNetRunRate(r.nrr)}`,
    ).join("\n    ");
  };

  /** Expected Top performers card for a tournament (top 3 each). */
  const performers = (tid: string): string => {
    const all = seededStats.get(tid) ?? [];
    const bat = battingLeaders(all).slice(0, 3).map((e) => `${e.name} ${e.runs} (HS ${formatHighest(e)})`).join(", ");
    const bowl = bowlingLeaders(all).slice(0, 3).map((e) => `${e.name} ${e.wickets} wkts (best ${formatBest(e)})`).join(", ");
    return `Top performers — most runs: ${bat}; most wickets: ${bowl}`;
  };

  // Roles helper: captain = first player, vice = second, keeper = third (or a guest), roles spread.
  const standardRoles = (k: { players: string[]; guests: string[] }) => {
    const all = [...k.players, ...k.guests];
    const roleCycle = ["batter", "bowler", "allRounder", "batter", "bowler", "wicketkeeperBatter"];
    const playing: Record<string, string> = {};
    all.forEach((m, i) => { playing[m] = roleCycle[i % roleCycle.length]; });
    return { captain: k.players[0] ?? k.guests[0], vice: all[1], keeper: all[2], playing };
  };

  const guests = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} Guest ${i + 1}`);

  for (const o of organizers) {
    const tag = organizers.length > 1 ? ` · ${o.label}` : "";

    // ── 1. Open entry: T20 knockout, Random seeding, 5 teams, no draw ──
    {
      const title = `QA Cricket Open Entry${tag}`;
      const t = await tournament({
        title, days: 6, matchFormatRaw: "singleElimination", eventType: "t20",
        formatConfig: { seedingMode: "random", maxParticipants: 8 }, organizer: o.uid, regCount: 5,
        note: "T20 knockout, Random seeding, 5 teams, no draw yet",
      });
      const specs: { name: string; players: PlayerRef[]; guests: string[]; registrant?: PlayerRef }[] = [
        { name: "QA Austin Strikers", players: test.slice(0, 3), guests: guests("Strikers", 8) },
        { name: "QA Round Rock Royals", players: test.slice(3, 6), guests: guests("Royals", 9) },
        // Registered by a manager who doesn't play (test7 isn't on the roster).
        { name: "QA Cedar Park Chargers", players: test.slice(7, 9), guests: guests("Chargers", 9), registrant: test[6] },
        { name: "QA Pflugerville Panthers", players: test.slice(9, 11), guests: guests("Panthers", 2) },  // 4 of 11: short side
        { name: "QA Georgetown Giants", players: test.slice(11, 14), guests: guests("Giants", 12) },     // 11 + 4 subs: full squad
      ];
      for (const [i, s] of specs.entries()) {
        await enter({
          tid: t.id, title, organizer: o.uid, name: s.name, players: s.players, guests: s.guests,
          registrant: s.registrant, roles: standardRoles, minutes: i, pom: 0,
        });
      }
      expectations.push(
        `${title}: 5 teams, no matches. Teams tab: Panthers "4 of 11 players named" (orange), Giants 15 players, ` +
        `Chargers registered by ${test[6].name} who isn't playing (captain ${test[7].name}). ` +
        "Generate the draw: Random seeding → 3 byes, 1 first-round match; regenerating gives the same draw. " +
        `Sign in as ${test[0].name} (test1) and try to register another team: "You've already registered a team for this tournament."`,
      );
    }

    // ── 2. League: Box 6 round robin, 4 teams ──
    {
      const title = `QA Cricket League${tag}`;
      const t = await tournament({
        title, days: -2, matchFormatRaw: "roundRobin", eventType: "box6",
        formatConfig: { maxParticipants: 4 }, organizer: o.uid, regCount: 4,
        note: "Box 6 (6 overs, 6-a-side, last man stands) round robin, 5 of 6 played",
      });
      const [A, B, C, D] = [
        await enter({ tid: t.id, title, organizer: o.uid, name: "QA Lakeway Lions", players: test.slice(0, 3), guests: guests("Lions", 3), roles: standardRoles, minutes: 0, pom: 1 }),
        await enter({ tid: t.id, title, organizer: o.uid, name: "QA Bee Cave Bulls", players: test.slice(3, 6), guests: guests("Bulls", 3), roles: standardRoles, minutes: 1, pom: 0 }),
        await enter({ tid: t.id, title, organizer: o.uid, name: "QA Kyle Kings", players: test.slice(6, 8), guests: ["Ravi Kumar", "Kyle Guest 2", "Kyle Guest 3", "Kyle Guest 4"], roles: (k) => ({ ...standardRoles(k), captain: guestKey("Ravi Kumar") }), minutes: 2, pom: "Ravi Kumar" }),
        await enter({ tid: t.id, title, organizer: o.uid, name: "QA Dripping Springs Dragons", players: test.slice(8, 11), guests: guests("Dragons", 3), roles: standardRoles, minutes: 3, pom: 2 }),
      ];
      const r = t.rules; // 6 overs = 36 balls, all out = 6 wickets
      const inn = (e: Entry, runs: number, wickets: number, balls: number) => ({ battingRegistrationId: e.regId, runs, wickets, balls });
      const results: CricketResult[] = [];
      const base = { tid: t.id, title, rules: r, organizer: o.uid };
      // R1: Lions 62/4 (6) beat Dragons 48/6 (5) — won by 14 runs.
      results.push(await played({ ...base, a: A, b: D, round: 1, result: { innings: [inn(A, 62, 4, 36), inn(D, 48, 6, 30)] }, pom: A }));
      // R1: Bulls 55/5 (6); Kings 56/3 (5.3) — Kings won by 3 wickets (3 balls left).
      results.push(await played({ ...base, a: B, b: C, round: 1, result: { innings: [inn(B, 55, 5, 36), inn(C, 56, 3, 33)] }, pom: C }));
      // R2: Kings 58/2 (6); Lions 58/6 (6) — match tied (league, no super over played).
      results.push(await played({ ...base, a: A, b: C, round: 2, result: { innings: [inn(C, 58, 2, 36), inn(A, 58, 6, 36)] }, pom: A }));
      // R2: Dragons v Bulls — no result after 2 overs (rain). Kept as a partial first innings.
      const nr: CricketResult = { innings: [inn(D, 20, 1, 12)], noResult: true };
      await played({ ...base, a: D, b: B, round: 2, result: nr, pom: D });
      results.push(Object.assign({ teams: [D.regId, B.regId] }, nr));
      // R3: Lions 70/3 (6) beat Bulls 41/6 (4.4) — won by 29 runs.
      results.push(await played({ ...base, a: A, b: B, round: 3, result: { innings: [inn(A, 70, 3, 36), inn(B, 41, 6, 28)] }, pom: A }));
      // R3: Kings v Dragons — left for the tester.
      await scheduled({ tid: t.id, title, a: C, b: D, round: 3 });
      expectations.push(
        `${title} (before C v D):\n    ${table([A, B, C, D], results, r)}\n` +
        `    Player of the match: ${A.pomName} (Lions) ×3, Ravi Kumar (Kings, guest captain) ×1; none for the no result.\n` +
        `    Player of the tournament card: ${A.pomName} "3 awards", then Ravi Kumar "1 award".\n` +
        "    Score Kings v Dragons yourself (try a revised target, or the last ball) and watch the table and NRR move.\n" +
        `    ${performers(t.id)}`,
      );
    }

    // ── 3. Groups: T10 group + knockout, 8 teams ──
    {
      const title = `QA Cricket Groups${tag}`;
      const t = await tournament({
        title, days: -1, matchFormatRaw: "groupKnockout", eventType: "t10",
        formatConfig: { groupCount: 2, teamsPerGroup: 4, advancingPerGroup: 2, maxParticipants: 8 },
        organizer: o.uid, regCount: 8,
        note: "T10 group + knockout, groups played, semi-finals: one super over, one to score",
      });
      const names = ["Hornets", "Falcons", "Wolves", "Sharks", "Cobras", "Eagles", "Rhinos", "Bisons"];
      const entries: Entry[] = [];
      for (let i = 0; i < 8; i++) {
        entries.push(await enter({
          tid: t.id, title, organizer: o.uid, name: `QA ${names[i]}`, players: test.slice(2 * i, 2 * i + 2),
          guests: guests(names[i], 9), roles: standardRoles, minutes: i, pom: i % 2,
        }));
      }
      const r = t.rules; // 10 overs = 60 balls, all out = 10 wickets
      const base = { tid: t.id, title, rules: r, organizer: o.uid };
      const inn = (e: Entry, runs: number, wickets: number, balls: number) => ({ battingRegistrationId: e.regId, runs, wickets, balls });
      // Circle-method rounds inside each group; the lower index is the stronger team.
      const rounds = [[[0, 3], [1, 2]], [[0, 2], [3, 1]], [[0, 1], [2, 3]]];
      const groupResults: Record<string, CricketResult[]> = { A: [], B: [] };
      for (const [g, start] of [["A", 0], ["B", 4]] as [string, number][]) {
        for (let rd = 0; rd < 3; rd++) {
          for (const [x, y] of rounds[rd]) {
            const [a, b] = [entries[start + x], entries[start + y]];
            const [win, lose] = x < y ? [a, b] : [b, a];
            // Winner bats first and defends: 90 + 5×gap runs, loser all out short of it.
            const gap = Math.abs(x - y);
            const result = { innings: [inn(win, 90 + 5 * gap, 5, 60), inn(lose, 70 + gap, 10, 54)] };
            groupResults[g].push(await played({ ...base, a, b, round: rd + 1, groupLabel: g, result, pom: win }));
          }
        }
      }
      // Knockout seeded by group finish: A1 v B2, B1 v A2 (round 1, no group label).
      const [a1, a2, b1, b2] = [entries[0], entries[1], entries[4], entries[5]];
      // Semi 1: scores level at 75, A1 wins the super over.
      await played({
        ...base, a: a1, b: b2, round: 1, bracketPosition: 0,
        result: { innings: [inn(b2, 75, 7, 60), inn(a1, 75, 8, 60)], superOverWinnerRegistrationId: a1.regId }, pom: a1,
      });
      await scheduled({ tid: t.id, title, a: b1, b: a2, round: 1, bracketPosition: 1 });
      expectations.push(
        `${title}:\n    Group A:\n    ${table(entries.slice(0, 4), groupResults.A, r)}\n` +
        `    Group B:\n    ${table(entries.slice(4, 8), groupResults.B, r)}\n` +
        "    Knockout: QA Hornets beat QA Eagles in the super over (\"won the super over\"); " +
        "QA Cobras v QA Falcons is waiting — a tie there needs the super over (knockouts can't end level or with no result). " +
        "After both semis, Generate next round creates the final.\n" +
        `    ${performers(t.id)}`,
      );
    }
  }

  await w.flush();

  console.log(`\n${dryRun ? "[DRY RUN] would create" : "Created"} ${w.created.length} docs (plus team-entry locks):\n`);
  console.log("kind          id                                    title / note");
  for (const c of w.created) {
    console.log(`${c.kind.padEnd(13)} ${c.id}  ${c.title}${c.note ? `  [${c.note}]` : ""}`);
  }
  console.log("\nExpected results:");
  for (const e of expectations) console.log(`- ${e}`);
  console.log("\nClean up afterwards: npm run build && node lib/scripts/cleanupQaTournaments.js");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
