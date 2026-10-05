/**
 * QA seed: creates test tournaments, registrations, matches and open play
 * sessions in **tournmate-dev only**, for manually checking standings
 * tie-breakers, tennis tables, Group + Knockout, list sorting and score
 * correction on iOS and Android.
 *
 * Every document written has `qaSeed: true` and a "QA " title prefix (where
 * the doc has a title). Remove them with cleanupQaTournaments.ts.
 *
 * Usage (from tournmate-server/functions):
 *   npm run build && node lib/scripts/seedQaTournaments.js --dry-run
 *   npm run build && node lib/scripts/seedQaTournaments.js
 *   ... --organizers <uid>[,<uid>]   (default: the simulator + emulator users)
 *
 * Credentials: Application Default Credentials
 * (`gcloud auth application-default login`).
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore, Timestamp, WriteBatch } from "firebase-admin/firestore";
import { randomUUID } from "crypto";

const PROJECT_ID = "tournmate-dev";

/** Default organizers: the users signed in on the QA simulator and emulator. */
const DEFAULT_ORGANIZERS: { uid: string; label: string }[] = [
  { uid: "uMkD5gCKhXVw1TBqsooZuFRCM5A3", label: "iOS" },
  { uid: "9enzsOvCuMOHeHl3Z504SbBL9E53", label: "Android" },
];

const STRICT_BADMINTON_SCORING = JSON.stringify({
  gamesPerMatch: 3, pointsToWin: 21, winBy: 2, pointCap: 30, scoringSystem: "rally",
});
const TENNIS_SCORING = JSON.stringify({
  gamesPerMatch: 3, pointsToWin: 6, winBy: 2, pointCap: 7, scoringSystem: "rally",
});

// ─── Helpers ─────────────────────────────────────────────

const newId = (): string => randomUUID().toUpperCase();
const DAY = 24 * 60 * 60 * 1000;

/** `days` from now at 18:00 UTC-5 (Austin evening), as a Timestamp. */
function dayOffset(days: number): Timestamp {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(23, 0, 0, 0);
  return Timestamp.fromDate(d);
}

type Sets = [number, number][];

interface Venue { name: string; address: string; lat: number; lng: number; postal: string }

const VENUES: Record<string, Venue> = {
  austin: { name: "QA Austin Downtown Courts", address: "500 E Cesar Chavez St, Austin, TX", lat: 30.2632, lng: -97.7404, postal: "78701" },
  roundRock: { name: "QA Round Rock Sports Center", address: "2400 Chisholm Trail Rd, Round Rock, TX", lat: 30.5083, lng: -97.6789, postal: "78681" },
  pflugerville: { name: "QA Pflugerville Rec Center", address: "400 Immanuel Rd, Pflugerville, TX", lat: 30.4394, lng: -97.6200, postal: "78660" },
  sanAntonio: { name: "QA San Antonio Badminton Hall", address: "100 Montana St, San Antonio, TX", lat: 29.4241, lng: -98.4936, postal: "78203" },
  houston: { name: "QA Houston Shuttle Club", address: "1001 Avenida De Las Americas, Houston, TX", lat: 29.7522, lng: -95.3586, postal: "77010" },
  dallas: { name: "QA Dallas Smash Arena", address: "650 S Griffin St, Dallas, TX", lat: 32.7767, lng: -96.7970, postal: "75202" },
};

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

// ─── Standings (port of iOS StandingsEntry.ranked, for printing expectations) ─

interface Result { a: string; b: string; sets: Sets }
interface Entry { id: string; name: string; pts: number; pf: number; pa: number; sw: number; sl: number }

function tally(results: Result[], entries: Map<string, Entry>) {
  for (const r of results) {
    const winsA = r.sets.filter(([x, y]) => x > y).length;
    const winsB = r.sets.filter(([x, y]) => y > x).length;
    const ga = r.sets.reduce((s, [x]) => s + x, 0);
    const gb = r.sets.reduce((s, [, y]) => s + y, 0);
    const winner = winsA === winsB ? null : (winsA > winsB ? r.a : r.b);
    for (const [id, f, ag, sf, sa] of [[r.a, ga, gb, winsA, winsB], [r.b, gb, ga, winsB, winsA]] as [string, number, number, number, number][]) {
      const e = entries.get(id);
      if (!e) continue;
      e.pf += f; e.pa += ag; e.sw += sf; e.sl += sa;
      e.pts += winner === null ? 1 : (winner === id ? 2 : 0);
    }
  }
}

function ranked(entries: Entry[], results: Result[], tieBreaker: "headToHead" | "pointDiff", bySets: boolean): Entry[] {
  const h2h = new Map<string, Entry>();
  if (tieBreaker === "headToHead") {
    const levels = new Map<number, Entry[]>();
    for (const e of entries) levels.set(e.pts, [...(levels.get(e.pts) ?? []), e]);
    for (const level of levels.values()) {
      if (level.length < 2) continue;
      const ids = new Set(level.map((e) => e.id));
      const mini = new Map(level.map((e) => [e.id, { id: e.id, name: "", pts: 0, pf: 0, pa: 0, sw: 0, sl: 0 }]));
      tally(results.filter((r) => ids.has(r.a) && ids.has(r.b)), mini);
      mini.forEach((v, k) => h2h.set(k, v));
    }
  }
  const diff = (a: Entry, b: Entry): number => {
    if (bySets && (a.sw - a.sl) !== (b.sw - b.sl)) return (b.sw - b.sl) - (a.sw - a.sl);
    return (b.pf - b.pa) - (a.pf - a.pa);
  };
  return [...entries].sort((a, b) => {
    if (a.pts !== b.pts) return b.pts - a.pts;
    if (tieBreaker === "headToHead") {
      const ha = h2h.get(a.id), hb = h2h.get(b.id);
      if (ha && hb) {
        if (ha.pts !== hb.pts) return hb.pts - ha.pts;
        const d = diff(ha, hb);
        if (d !== 0) return d;
      }
    }
    const d = diff(a, b);
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });
}

function expectation(names: Map<string, string>, results: Result[], tb: "headToHead" | "pointDiff", bySets: boolean): string {
  const entries = [...names].map(([id, name]) => ({ id, name, pts: 0, pf: 0, pa: 0, sw: 0, sl: 0 }));
  const map = new Map(entries.map((e) => [e.id, e]));
  tally(results, map);
  return ranked(entries, results, tb, bySets)
    .map((e) => `${e.name} (pts ${e.pts}, ${bySets ? `sets ${e.sw - e.sl >= 0 ? "+" : ""}${e.sw - e.sl}, games` : "+/-"} ${e.pf - e.pa >= 0 ? "+" : ""}${e.pf - e.pa})`)
    .join("  >  ");
}

// ─── Main ────────────────────────────────────────────────

interface PlayerRef { id: string; name: string }

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

  // Confirm the project with a real read before writing anything.
  const probe = await db.collection("config").doc("sports").get();
  const connected = (db as unknown as { projectId: string }).projectId;
  console.log(`Connected project: ${connected} (config/sports exists: ${probe.exists})`);
  if (connected !== PROJECT_ID) {
    console.error(`Refusing to run: connected to ${connected}, expected ${PROJECT_ID}.`);
    process.exit(1);
  }

  const existing = await db.collection("tournaments").where("qaSeed", "==", true).limit(1).get();
  if (!existing.empty && !dryRun) {
    console.error("QA seed docs already exist. Run cleanupQaTournaments first.");
    process.exit(1);
  }

  // Organizers' player docs (read only).
  const orgPlayers = new Map<string, PlayerRef>();
  for (const o of organizers) {
    const snap = await db.collection("players").where("firebaseUid", "==", o.uid).limit(1).get();
    if (snap.empty) throw new Error(`No player doc for organizer uid ${o.uid}`);
    orgPlayers.set(o.uid, { id: snap.docs[0].id, name: snap.docs[0].get("name") });
    console.log(`Organizer ${o.label}: uid ${o.uid} → player ${snap.docs[0].id} (${snap.docs[0].get("name")})`);
  }

  // Test players test1..test20 (read only).
  const test: PlayerRef[] = [];
  for (let i = 1; i <= 20; i++) {
    const snap = await db.collection("players").where("email", "==", `test${i}@tournmate.dev`).limit(1).get();
    if (snap.empty) throw new Error(`No player doc for test${i}@tournmate.dev`);
    test.push({ id: snap.docs[0].id, name: snap.docs[0].get("name") });
  }
  console.log(`Test players: ${test.map((p) => p.name).join(", ")}`);

  const w = new Writer(db, dryRun);
  const expectations: string[] = [];

  // ── Builders ──

  const tournament = async (o: {
    title: string; days: number; venue: Venue; sport: string; formatRaw: string; matchFormatRaw: string;
    formatConfig: Record<string, unknown>; scoring: string; organizer: string; regCount: number;
    entryFee?: number; note?: string; setRegistrationCount?: boolean;
  }): Promise<string> => {
    const id = newId();
    const date = dayOffset(o.days);
    const data: Record<string, unknown> = {
      title: o.title,
      date,
      location: o.venue.name,
      locationAddress: o.venue.address,
      locationLatitude: o.venue.lat,
      locationLongitude: o.venue.lng,
      // No countryCode/postalCode: with server triggers deployed, those make
      // onTournamentCreated broadcast a push to the US topics. Clients treat a
      // missing country as "matches every region", so the lists still show it.
      timeZone: "America/Chicago",
      participantsCount: o.regCount,
      statusRaw: "scheduled",
      formatRaw: o.formatRaw,
      matchFormatRaw: o.matchFormatRaw,
      randomPairing: false,
      registrationDeadline: dayOffset(o.days - 1),
      currency: "USD",
      // Backdated past the 24h window of the create-rate check, which would
      // otherwise flag (statusRaw "flagged") an organizer's 6th tournament.
      createdAt: Timestamp.fromMillis(Date.now() - 2 * DAY),
      createdBy: o.organizer,
      sportType: o.sport,
      ageGroupRaw: "open",
      formatConfigData: JSON.stringify(o.formatConfig),
      scoringConfigData: o.scoring,
      durationMinutes: 180,
    };
    if (o.entryFee !== undefined) data.entryFee = o.entryFee;
    // Admin-written count (the registration triggers recount tournaments that get registrations).
    if (o.setRegistrationCount !== false) data.registrationCount = o.regCount;
    await w.set("tournaments", id, data, { kind: "tournament", id, title: o.title, note: o.note });
    return id;
  };

  const register = async (tid: string, title: string, player: PlayerRef, partner?: PlayerRef, minutes = 0): Promise<string> => {
    const id = newId();
    const data: Record<string, unknown> = {
      tournamentId: tid, playerId: player.id,
      createdAt: Timestamp.fromMillis(Date.now() - 10 * DAY + minutes * 60_000),
    };
    if (partner) data.partnerId = partner.id;
    const name = partner ? `${player.name} & ${partner.name}` : player.name;
    await w.set("registrations", id, data, { kind: "registration", id, title: `${title}: ${name}` });
    return id;
  };

  const match = async (o: {
    tid: string; title: string; sport: string; a: string; b: string; round: number;
    sets?: Sets; status?: string; bracketPosition?: number; groupLabel?: string; label: string;
  }): Promise<string> => {
    const id = newId();
    const status = o.status ?? (o.sets ? "finished" : "scheduled");
    const data: Record<string, unknown> = {
      tournamentId: o.tid, teamAId: o.a, teamBId: o.b, statusRaw: status,
      createdAt: Timestamp.fromMillis(Date.now() - 5 * DAY + o.round * 60_000),
      round: o.round, sportType: o.sport,
    };
    if (o.bracketPosition !== undefined) data.bracketPosition = o.bracketPosition;
    if (o.groupLabel) data.groupLabel = o.groupLabel;
    if (o.sets) {
      const wa = o.sets.filter(([x, y]) => x > y).length;
      const wb = o.sets.filter(([x, y]) => y > x).length;
      data.setScores = o.sets.map(([x, y]) => ({ teamAPoints: x, teamBPoints: y }));
      data.scoreA = wa;
      data.scoreB = wb;
      if (wa !== wb) data.winnerRegistrationId = wa > wb ? o.a : o.b;
      // Seeded results must not trigger Elo if server triggers are deployed later.
      data.eloApplied = true;
    }
    await w.set("matches", id, data, { kind: "match", id, title: `${o.title}: ${o.label}`, note: o.sets ? o.sets.map((s) => s.join("-")).join(" ") : status });
    return id;
  };

  const rrConfig = (extra: Record<string, unknown>) => ({
    seedingMode: "random", allowByes: true, bronzeMatch: false, consolationBracket: false,
    pointsPerWin: 2, pointsPerDraw: 1, pointsPerLoss: 0, doubleRoundRobin: false,
    groupCount: 2, teamsPerGroup: 4, advancingPerGroup: 2, swissRounds: 5, ...extra,
  });

  // ── Per-organizer sets ──

  for (const o of organizers) {
    const tag = organizers.length > 1 ? ` · ${o.label}` : "";

    // 1 + 2: Round robin head-to-head and legacy (same matches).
    const rrMatches: { a: number; b: number; sets: Sets; round: number }[] = [
      { a: 0, b: 1, sets: [[21, 15], [21, 15]], round: 1 },  // A beat B
      { a: 2, b: 3, sets: [[21, 10], [21, 10]], round: 1 },  // C beat D
      { a: 1, b: 2, sets: [[21, 10], [21, 10]], round: 2 },  // B beat C
      { a: 0, b: 3, sets: [[21, 5], [21, 5]], round: 2 },    // A beat D
      { a: 2, b: 0, sets: [[21, 19], [21, 19]], round: 3 },  // C beat A
      { a: 1, b: 3, sets: [[21, 19], [21, 19]], round: 3 },  // B beat D
    ];
    for (const variant of ["h2h", "legacy"] as const) {
      const title = variant === "h2h" ? `QA RR Head-to-Head${tag}` : `QA RR Legacy${tag}`;
      const fc = variant === "h2h"
        ? rrConfig({ tieBreaker: "headToHead", groupTieBreaker: "headToHead", tieBreakRulesVersion: 1, maxParticipants: 4 })
        : rrConfig({ maxParticipants: 4 }); // no tieBreakRulesVersion / tieBreaker: legacy
      const tid = await tournament({
        title, days: -3, venue: VENUES.austin, sport: "badminton", formatRaw: "openDoubles",
        matchFormatRaw: "roundRobin", formatConfig: fc, scoring: STRICT_BADMINTON_SCORING,
        organizer: o.uid, regCount: 4,
      });
      const teams = [[0, 1], [2, 3], [4, 5], [6, 7]];
      const letters = ["A", "B", "C", "D"];
      const regIds: string[] = [];
      const names = new Map<string, string>();
      for (let i = 0; i < 4; i++) {
        const [p, q] = teams[i];
        const rid = await register(tid, title, test[p], test[q], i);
        regIds.push(rid);
        names.set(rid, `${letters[i]} (${test[p].name} & ${test[q].name})`);
      }
      const results: Result[] = [];
      for (const m of rrMatches) {
        await match({ tid, title, sport: "badminton", a: regIds[m.a], b: regIds[m.b], round: m.round, sets: m.sets, label: `${letters[m.a]} v ${letters[m.b]}` });
        results.push({ a: regIds[m.a], b: regIds[m.b], sets: m.sets });
      }
      const tb = variant === "h2h" ? "headToHead" : "pointDiff";
      expectations.push(`${title}: ${expectation(names, results, tb, false)}  | caption "${variant === "h2h" ? "Ties: head-to-head, then point difference" : "Ties: point difference"}"`);
    }

    // 3: Tennis round robin, singles, 4 players.
    {
      const title = `QA Tennis RR${tag}`;
      const tid = await tournament({
        title, days: -3, venue: VENUES.austin, sport: "tennis", formatRaw: "openSingles",
        matchFormatRaw: "roundRobin",
        formatConfig: rrConfig({ tieBreaker: "pointDiff", groupTieBreaker: "pointDiff", tieBreakRulesVersion: 1, maxParticipants: 4 }),
        scoring: TENNIS_SCORING, organizer: o.uid, regCount: 4,
      });
      const players = [test[10], test[12], test[14], test[16]];
      const regIds: string[] = [];
      const names = new Map<string, string>();
      for (let i = 0; i < 4; i++) {
        const rid = await register(tid, title, players[i], undefined, i);
        regIds.push(rid);
        names.set(rid, `T${i + 1} (${players[i].name})`);
      }
      const tm: { a: number; b: number; sets: Sets; round: number }[] = [
        { a: 0, b: 1, sets: [[6, 4], [3, 6], [7, 5]], round: 1 },
        { a: 2, b: 3, sets: [[6, 4], [6, 4]], round: 1 },
        { a: 0, b: 2, sets: [[6, 2], [6, 3]], round: 2 },
        { a: 1, b: 3, sets: [[7, 5], [6, 4]], round: 2 },
        { a: 0, b: 3, sets: [[4, 6], [4, 6]], round: 3 },
        { a: 1, b: 2, sets: [[6, 1], [6, 1]], round: 3 },
      ];
      const results: Result[] = [];
      for (const m of tm) {
        await match({ tid, title, sport: "tennis", a: regIds[m.a], b: regIds[m.b], round: m.round, sets: m.sets, label: `T${m.a + 1} v T${m.b + 1}` });
        results.push({ a: regIds[m.a], b: regIds[m.b], sets: m.sets });
      }
      expectations.push(`${title}: ${expectation(names, results, "pointDiff", true)}  | caption "Ties: set difference, then game difference"`);
    }

    // 4: Group + Knockout, 8 teams, 2 groups; group stage finished, semis generated.
    {
      const title = `QA Group + Knockout${tag}`;
      const tid = await tournament({
        title, days: -2, venue: VENUES.roundRock, sport: "badminton", formatRaw: "openDoubles",
        matchFormatRaw: "groupKnockout",
        formatConfig: rrConfig({ seedingMode: "eloRanked", tieBreaker: "headToHead", groupTieBreaker: "headToHead", tieBreakRulesVersion: 1, groupCount: 2, teamsPerGroup: 4, advancingPerGroup: 2, maxParticipants: 8 }),
        scoring: STRICT_BADMINTON_SCORING, organizer: o.uid, regCount: 8,
      });
      const regIds: string[] = [];
      const label = (i: number) => `${i < 4 ? "A" : "B"}${(i % 4) + 1}`;
      for (let i = 0; i < 8; i++) {
        regIds.push(await register(tid, title, test[2 * i], test[2 * i + 1], i));
      }
      // Round-robin schedule inside each group (circle method, 3 rounds).
      const rounds = [[[0, 3], [1, 2]], [[0, 2], [3, 1]], [[0, 1], [2, 3]]];
      const win: Sets = [[21, 12], [21, 14]];
      for (const [g, base] of [["A", 0], ["B", 4]] as [string, number][]) {
        for (let r = 0; r < 3; r++) {
          for (const [x, y] of rounds[r]) {
            // Lower index = stronger team: 1 > 2 > 3 > 4 in each group.
            const [a, b] = [base + x, base + y];
            const aWins = x < y;
            await match({
              tid, title, sport: "badminton", a: regIds[a], b: regIds[b], round: r + 1, groupLabel: g,
              sets: aWins ? win : win.map(([p, q]) => [q, p]) as Sets, label: `Group ${g} R${r + 1} ${label(a)} v ${label(b)}`,
            });
          }
        }
      }
      // Knockout semi-finals: A1 v B2 (finished), B1 v A2 (scheduled). Round 1, no groupLabel.
      await match({ tid, title, sport: "badminton", a: regIds[0], b: regIds[5], round: 1, bracketPosition: 0, sets: [[21, 18], [19, 21], [21, 17]], label: "SF A1 v B2" });
      await match({ tid, title, sport: "badminton", a: regIds[4], b: regIds[1], round: 1, bracketPosition: 1, label: "SF B1 v A2" });
      expectations.push(`${title}: Group A order A1, A2, A3, A4; Group B order B1, B2, B3, B4 (A1=${test[0].name}&${test[1].name}, B1=${test[8].name}&${test[9].name}); knockout = Semi Finals: A1 beat B2 21-18 19-21 21-17, B1 v A2 scheduled`);
    }

    // 6: Score correction.
    {
      const title = `QA Correction${tag}`;
      const tid = await tournament({
        title, days: -1, venue: VENUES.austin, sport: "badminton", formatRaw: "openDoubles",
        matchFormatRaw: "roundRobin",
        formatConfig: rrConfig({ tieBreaker: "headToHead", groupTieBreaker: "headToHead", tieBreakRulesVersion: 1, maxParticipants: 4 }),
        scoring: STRICT_BADMINTON_SCORING, organizer: o.uid, regCount: 4,
      });
      const regIds: string[] = [];
      for (let i = 0; i < 4; i++) regIds.push(await register(tid, title, test[2 * i + 8], test[2 * i + 9], i));
      await match({ tid, title, sport: "badminton", a: regIds[0], b: regIds[1], round: 1, sets: [[21, 15], [21, 18]], label: "Correct me: team1 v team2 (A won by sets)" });
      await match({ tid, title, sport: "badminton", a: regIds[2], b: regIds[3], round: 1, label: "team3 v team4" });
      expectations.push(`${title}: match 1 is ${test[8].name}&${test[9].name} v ${test[10].name}&${test[11].name}, finished 21-15 21-18 (A). Correct to simple 18-21: expect setScores removed, scoreA=18, scoreB=21, winnerRegistrationId=${regIds[1]}`);
    }
  }

  // 5: Sort-test set (organizer = first organizer), upcoming.
  {
    const org = organizers[0].uid;
    const sortSpecs = [
      { title: "QA Sort Alpha", days: 2, venue: VENUES.roundRock, fee: undefined, max: 16, count: 4 },
      { title: "QA Sort Bravo", days: 5, venue: VENUES.houston, fee: 5, max: 8, count: 7 },
      { title: "QA Sort Charlie", days: 9, venue: VENUES.austin, fee: 50, max: undefined, count: 10 },
      { title: "QA Sort Delta", days: 14, venue: VENUES.sanAntonio, fee: 20, max: 12, count: 6 },
      { title: "QA Sort Echo", days: 20, venue: VENUES.dallas, fee: 20, max: undefined, count: 2 },
    ];
    for (const s of sortSpecs) {
      const fc = rrConfig({ tieBreaker: "headToHead", groupTieBreaker: "headToHead", tieBreakRulesVersion: 1 });
      if (s.max !== undefined) (fc as Record<string, unknown>).maxParticipants = s.max;
      await tournament({
        title: s.title, days: s.days, venue: s.venue, sport: "badminton", formatRaw: "openDoubles",
        matchFormatRaw: "roundRobin", formatConfig: fc, scoring: STRICT_BADMINTON_SCORING,
        organizer: org, regCount: s.count, entryFee: s.fee,
        note: `+${s.days}d, ${s.venue.name}, fee ${s.fee ?? "free"}, ${s.count}/${s.max ?? "∞"}`,
      });
    }
    expectations.push("Sort (QA Sort only): Soonest Alpha, Bravo, Charlie, Delta, Echo | Latest Echo, Delta, Charlie, Bravo, Alpha | Lowest price Alpha(free), Bravo($5), Delta($20,+14d), Echo($20,+20d), Charlie($50) | Filling fast Bravo 7/8, Delta 6/12, Alpha 4/16, then no-cap by count Charlie 10, Echo 2 | Nearest from Austin Charlie(~1km), Alpha(~28km), Delta(~120km), Bravo(~235km), Echo(~290km)");

    // Open play sessions.
    const sessions = [
      { title: "QA Open Play Low", days: 3, venue: VENUES.pflugerville, cost: 3, attendees: [test[0], test[1]] },
      { title: "QA Open Play Mid", days: 6, venue: VENUES.austin, cost: 8, attendees: test.slice(2, 8) },
      { title: "QA Open Play High", days: 1, venue: VENUES.houston, cost: 15, attendees: test.slice(8, 12) },
    ];
    for (const s of sessions) {
      const id = newId();
      await w.set("playSessions", id, {
        title: s.title, venue: s.venue.name, venueAddress: s.venue.address,
        venueLatitude: s.venue.lat, venueLongitude: s.venue.lng, // no country/postal: avoids a topic push

        date: dayOffset(s.days), durationMinutes: 120, skillLevel: "allLevels", gameType: "any",
        costPerPerson: s.cost, currency: "USD", preferredAgeGroup: "open", status: "active",
        attendeeIds: s.attendees.map((p) => p.id), hostId: org, createdAt: Timestamp.fromMillis(Date.now() - 2 * DAY),
        timeZone: "America/Chicago", sportType: "badminton",
      }, { kind: "playSession", id, title: s.title, note: `+${s.days}d, $${s.cost}, ${s.attendees.length} attendees, ${s.venue.name}` });
    }
    expectations.push("Open play (QA only): Soonest High(+1d), Low(+3d), Mid(+6d) | Latest Mid, Low, High | Lowest price Low $3, Mid $8, High $15 | Filling fast Mid 6, High 4, Low 2 | Nearest from Austin Mid, Low, High");
  }

  // Trigger test target: no registrations, no registrationCount (set by the server only).
  await tournament({
    title: "QA RegCount Trigger", days: 25, venue: VENUES.pflugerville, sport: "badminton", formatRaw: "openDoubles",
    matchFormatRaw: "roundRobin",
    formatConfig: rrConfig({ tieBreaker: "headToHead", groupTieBreaker: "headToHead", tieBreakRulesVersion: 1, maxParticipants: 8 }),
    scoring: STRICT_BADMINTON_SCORING, organizer: organizers[0].uid, regCount: 0, setRegistrationCount: false,
    note: "registrationCount trigger test",
  });

  await w.flush();

  console.log(`\n${dryRun ? "[DRY RUN] would create" : "Created"} ${w.created.length} docs:\n`);
  console.log("kind          id                                    title / note");
  for (const c of w.created) {
    console.log(`${c.kind.padEnd(13)} ${c.id}  ${c.title}${c.note ? `  [${c.note}]` : ""}`);
  }
  console.log("\nExpected results:");
  for (const e of expectations) console.log(`- ${e}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
