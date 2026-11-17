/**
 * Showcase seed: realistic-looking tournaments (20+ players) and open play
 * sessions (up to 10 players) in **tournmate-dev**, for store / social
 * screenshots of the tournament details redesign (bracket tree, standings,
 * Info, Teams) and open play.
 *
 * What it creates (all marked `showcaseSeed: true`, friendly names, no "QA"):
 *  - 40 players without sign-in accounts (organizer-style players).
 *  - "Austin Fall Open" (badminton, open doubles, single elimination,
 *    16 teams / 32 players): round of 16 finished, quarter-finals half played.
 *  - "Hill Country Tennis Championship" (tennis, singles, single elimination,
 *    24 players → 8 byes): finished, champion decided.
 *  - "Round Rock Pickleball Classic" (pickleball, open doubles, group +
 *    knockout, 3 groups × 4 teams / 24 players): group stage in progress.
 *  - "Pflugerville Winter Doubles" (badminton, open doubles, round robin,
 *    upcoming, registration open, 11 of 16 teams / 22 players).
 *  - 4 open play sessions, 2 courts each: badminton doubles 10/10 (full),
 *    pickleball doubles 8/10, tennis singles 6/6, badminton doubles 4/10.
 *
 * Knockout matches follow the server draw exactly (services/draw/pairing.ts):
 * round 1 pairs seeds outside-in after the byes, later rounds pair the
 * advancing teams outside-in (byes first into round 2), `bracketPosition` = i.
 *
 * Usage (from tournmate-server/functions; Application Default Credentials):
 *   npm run seed:showcase -- --dry-run
 *   npm run seed:showcase
 *   npm run seed:showcase -- --me=<your firebase uid>       also registers you
 *       (with a partner) in "Pflugerville Winter Doubles" and adds you to
 *       "Pickleball Social Night" (so you see Registered / joined states)
 *   npm run seed:showcase -- --organizer=<firebase uid>     you organize the
 *       tournaments and host the sessions (shows ADMIN MODE / Manage)
 *   npm run seed:showcase -- --cleanup [--dry-run]          deletes everything
 *       this script created (and the server-written standings / matches /
 *       registrations / notifications of showcase tournaments and sessions)
 *   --emulator   run against the Firestore emulator (FIRESTORE_EMULATOR_HOST
 *                and a demo-* project id required)
 *
 * Writes nothing outside tournmate-dev (or a demo-* emulator).
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { Firestore, Timestamp, WriteBatch, getFirestore } from "firebase-admin/firestore";
import { randomUUID } from "crypto";

const DEV_PROJECT_ID = "tournmate-dev";
const MARK = "showcaseSeed";
const DAY = 24 * 60 * 60 * 1000;
const SHOWCASE_ORGANIZER_UID = "showcase-organizer-1";

const BADMINTON_SCORING = JSON.stringify({ gamesPerMatch: 3, pointsToWin: 21, winBy: 2, pointCap: 30, scoringSystem: "rally" });
const TENNIS_SCORING = JSON.stringify({ gamesPerMatch: 3, pointsToWin: 6, winBy: 2, pointCap: 7, scoringSystem: "rally" });
const PICKLEBALL_SCORING = JSON.stringify({ gamesPerMatch: 3, pointsToWin: 11, winBy: 2, pointCap: 15, scoringSystem: "rally" });

const newId = (): string => randomUUID().toUpperCase();

/** `days` from now at 18:00 Austin time (23:00 UTC), as a Timestamp. */
function dayAt(days: number, hourUtc = 23): Timestamp {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return Timestamp.fromDate(d);
}

interface Venue { name: string; address: string; lat: number; lng: number }
const VENUES: Record<string, Venue> = {
  austin: { name: "Austin Badminton Center", address: "10401 Anderson Mill Rd, Austin, TX", lat: 30.4469, lng: -97.7949 },
  hillCountry: { name: "Hill Country Tennis Club", address: "2500 W Parmer Ln, Austin, TX", lat: 30.4280, lng: -97.7120 },
  roundRock: { name: "Round Rock Sports Center", address: "2400 Chisholm Trail Rd, Round Rock, TX", lat: 30.5083, lng: -97.6789 },
  pflugerville: { name: "Pflugerville Rec Center", address: "400 Immanuel Rd, Pflugerville, TX", lat: 30.4394, lng: -97.6200 },
  cedarPark: { name: "Cedar Park Pickleball Courts", address: "1701 Cypress Creek Rd, Cedar Park, TX", lat: 30.4920, lng: -97.8220 },
  zilker: { name: "Zilker Park Tennis Center", address: "2220 Barton Springs Rd, Austin, TX", lat: 30.2669, lng: -97.7729 },
};

// 40 players: name, gender, Elo. Strongest first (used for seeding).
const PEOPLE: [string, "male" | "female", number][] = [
  ["Arjun Mehta", "male", 1620], ["Sofia Ramirez", "female", 1605], ["Ethan Brooks", "male", 1590], ["Priya Nair", "female", 1575],
  ["Marcus Lee", "male", 1560], ["Hannah Kim", "female", 1545], ["Daniel Okafor", "male", 1530], ["Mia Torres", "female", 1515],
  ["Ryan Patel", "male", 1500], ["Emily Chen", "female", 1490], ["Jordan Hayes", "male", 1480], ["Ava Nguyen", "female", 1470],
  ["Noah Williams", "male", 1460], ["Isabella Rossi", "female", 1450], ["Kevin Zhang", "male", 1440], ["Chloe Martin", "female", 1430],
  ["Lucas Silva", "male", 1420], ["Grace Johnson", "female", 1410], ["Omar Haddad", "male", 1400], ["Lily Anderson", "female", 1390],
  ["Samuel Wright", "male", 1380], ["Zoe Campbell", "female", 1370], ["Vikram Rao", "male", 1360], ["Ella Thompson", "female", 1350],
  ["Mateo Garcia", "male", 1340], ["Nora Davis", "female", 1330], ["Caleb Foster", "male", 1320], ["Maya Singh", "female", 1310],
  ["Owen Parker", "male", 1300], ["Leah Robinson", "female", 1290], ["Adrian Lopez", "male", 1280], ["Ruby Clarke", "female", 1270],
  ["Tyler Bennett", "male", 1260], ["Aisha Khan", "female", 1250], ["Jason Wu", "male", 1240], ["Olivia Scott", "female", 1230],
  ["Henry Moore", "male", 1220], ["Sara Ali", "female", 1210], ["Felix Turner", "male", 1200], ["Naomi Reed", "female", 1190],
];
const AVATARS = ["shuttlecock", "racket", "champion", "flame", "bolt", "ace", "smash", "rally", "drop", "serve",
  "leaf", "star", "heart", "moon", "sun", "phoenix", "eagle", "tiger", "panda", "ninja"];

interface Player { id: string; name: string }
interface Team { regId: string; name: string }
type Sets = [number, number][];

class Writer {
  private batch: WriteBatch;
  private ops = 0;
  readonly lines: string[] = [];
  constructor(private db: Firestore, private dryRun: boolean) { this.batch = db.batch(); }
  async set(collection: string, id: string, data: Record<string, unknown>, line?: string) {
    if (line) this.lines.push(line);
    if (this.dryRun) return;
    this.batch.set(this.db.collection(collection).doc(id), { ...data, [MARK]: true });
    if (++this.ops >= 400) await this.flush();
  }
  async flush() {
    if (this.dryRun || this.ops === 0) return;
    await this.batch.commit();
    this.batch = this.db.batch();
    this.ops = 0;
  }
}

// ─── Knockout pairing, same as services/draw/pairing.ts ─────

const nextPow2 = (n: number) => { let p = 1; while (p < n) p *= 2; return p; };

/** Outside-in pairs: i vs n-1-i. */
function outsideIn<T>(list: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < Math.floor(list.length / 2); i++) out.push([list[i], list[list.length - 1 - i]]);
  return out;
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const cleanup = argv.includes("--cleanup");
  const emulator = argv.includes("--emulator");
  const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const meUid = arg("me");
  const organizerArg = arg("organizer");

  let projectId = DEV_PROJECT_ID;
  if (emulator) {
    const pid = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
    if (!process.env.FIRESTORE_EMULATOR_HOST || !pid.startsWith("demo-")) {
      console.error("Refusing to run: --emulator needs FIRESTORE_EMULATOR_HOST and a demo-* project id.");
      process.exit(1);
    }
    projectId = pid;
  } else {
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
  await db.collection("config").doc("sports").get();
  const connected = (db as unknown as { projectId: string }).projectId;
  console.log(`Connected project: ${connected}${dryRun ? "  [DRY RUN]" : ""}`);
  if (connected !== projectId) {
    console.error(`Refusing to run: connected to ${connected}, expected ${projectId}.`);
    process.exit(1);
  }

  if (cleanup) return runCleanup(db, dryRun);

  const existing = await db.collection("tournaments").where(MARK, "==", true).limit(1).get();
  if (!existing.empty && !dryRun) {
    console.error("Showcase data already exists. Run with --cleanup first.");
    process.exit(1);
  }

  const w = new Writer(db, dryRun);
  const now = Date.now();

  // ── Players ──
  const people: Player[] = [];
  for (let i = 0; i < PEOPLE.length; i++) {
    const [name, gender, elo] = PEOPLE[i];
    const id = newId();
    people.push({ id, name });
    await w.set("players", id, {
      name, email: "", phone: "", genderRaw: gender, elo, streak: 0, firebaseUid: null,
      avatarId: AVATARS[i % AVATARS.length], homeCountryCode: "US", preferredSport: "badminton",
      createdAt: Timestamp.fromMillis(now - 60 * DAY),
    });
  }
  // Showcase organizer (shows in "Organized by" when --organizer isn't given).
  let organizerUid = organizerArg ?? SHOWCASE_ORGANIZER_UID;
  if (!organizerArg) {
    const id = newId();
    await w.set("players", id, {
      name: "Coach Daniel Reyes", email: "", phone: "", genderRaw: "male", elo: 1500, streak: 0,
      firebaseUid: SHOWCASE_ORGANIZER_UID, avatarId: "champion", homeCountryCode: "US",
      createdAt: Timestamp.fromMillis(now - 120 * DAY),
    }, "player   Coach Daniel Reyes (organizer)");
  } else {
    const snap = await db.collection("players").where("firebaseUid", "==", organizerArg).limit(1).get();
    if (snap.empty) throw new Error(`No player doc for --organizer uid ${organizerArg}`);
    console.log(`Organizer: ${snap.docs[0].get("name")} (${organizerArg})`);
    organizerUid = organizerArg;
  }
  let me: Player | undefined;
  if (meUid) {
    const snap = await db.collection("players").where("firebaseUid", "==", meUid).limit(1).get();
    if (snap.empty) throw new Error(`No player doc for --me uid ${meUid}`);
    me = { id: snap.docs[0].id, name: snap.docs[0].get("name") };
    console.log(`You: ${me.name} (${me.id})`);
  }
  w.lines.push(`players  ${people.length} showcase players`);

  // ── Builders ──
  const tournament = async (o: {
    title: string; days: number; venue: Venue; sport: string; formatRaw: string; matchFormatRaw: string;
    formatConfig: Record<string, unknown>; scoring: string; regCount: number; entryFee?: number;
    payment?: string; prize?: string; deadlineDays: number;
  }): Promise<string> => {
    const id = newId();
    const data: Record<string, unknown> = {
      title: o.title, date: dayAt(o.days, 15), location: o.venue.name, locationAddress: o.venue.address,
      locationLatitude: o.venue.lat, locationLongitude: o.venue.lng,
      // No countryCode/postalCode: avoids onTournamentCreated pushing to region topics.
      timeZone: "America/Chicago", participantsCount: o.regCount, registrationCount: o.regCount,
      statusRaw: "scheduled", formatRaw: o.formatRaw, matchFormatRaw: o.matchFormatRaw, randomPairing: false,
      registrationDeadline: dayAt(o.deadlineDays), currency: "USD",
      createdAt: Timestamp.fromMillis(now - 21 * DAY), createdBy: organizerUid, sportType: o.sport,
      ageGroupRaw: "open", formatConfigData: JSON.stringify(o.formatConfig), scoringConfigData: o.scoring,
      durationMinutes: 360,
    };
    if (o.entryFee !== undefined) data.entryFee = o.entryFee;
    if (o.payment) data.paymentInfo = o.payment;
    if (o.prize) data.prizeInfo = o.prize;
    await w.set("tournaments", id, data, `tournament ${o.title}`);
    return id;
  };

  const register = async (tid: string, a: Player, b?: Player, minute = 0): Promise<Team> => {
    const regId = newId();
    const data: Record<string, unknown> = { tournamentId: tid, playerId: a.id, createdAt: Timestamp.fromMillis(now - 14 * DAY + minute * 60_000) };
    if (b) data.partnerId = b.id;
    await w.set("registrations", regId, data);
    return { regId, name: b ? `${a.name.split(" ")[0]} & ${b.name.split(" ")[0]}` : a.name };
  };

  let matchMinute = 0;
  const match = async (tid: string, sport: string, a: Team, b: Team, f: { round: number; bracketPosition?: number; groupLabel?: string; sets?: Sets }) => {
    const id = newId();
    const data: Record<string, unknown> = {
      tournamentId: tid, teamAId: a.regId, teamBId: b.regId, statusRaw: f.sets ? "finished" : "scheduled",
      createdAt: Timestamp.fromMillis(now - 2 * DAY + (matchMinute++) * 60_000), round: f.round, sportType: sport,
    };
    if (f.bracketPosition !== undefined) data.bracketPosition = f.bracketPosition;
    if (f.groupLabel) data.groupLabel = f.groupLabel;
    if (f.sets) {
      const wa = f.sets.filter(([x, y]) => x > y).length;
      const wb = f.sets.length - wa;
      data.setScores = f.sets.map(([x, y]) => ({ teamAPoints: x, teamBPoints: y }));
      data.scoreA = wa; data.scoreB = wb;
      data.winnerRegistrationId = wa > wb ? a.regId : b.regId;
      data.eloApplied = true; // seeded results must not move ratings
    }
    await w.set("matches", id, data);
  };

  /** Scores where the first team wins; `close` makes it go to three. */
  const win = (sport: string, k: number): Sets => {
    if (sport === "tennis") return k % 3 === 0 ? [[6, 4], [3, 6], [7, 5]] : [[6, 3 + (k % 2)], [6, 2 + (k % 3)]];
    if (sport === "pickleball") return k % 3 === 0 ? [[11, 8], [9, 11], [11, 7]] : [[11, 6 + (k % 3)], [11, 5 + (k % 4)]];
    return k % 3 === 0 ? [[21, 18], [19, 21], [21, 16]] : [[21, 14 + (k % 5)], [21, 12 + (k % 6)]];
  };
  const flip = (s: Sets): Sets => s.map(([x, y]) => [y, x]) as Sets;

  /**
   * Single elimination like the server. `seeds` strongest first. Plays
   * `playRounds` full rounds, then `extra` matches of the next round.
   * Higher seed wins except where `upsets` has "round:position".
   */
  const knockout = async (tid: string, sport: string, seeds: Team[], playRounds: number, extra: number, upsets: Set<string>) => {
    const byes = nextPow2(seeds.length) - seeds.length;
    const byeTeams = seeds.slice(0, byes);
    let pairs = outsideIn(seeds.slice(byes));
    let round = 1;
    let k = 0;
    for (;;) {
      const winners: Team[] = [];
      const full = round <= playRounds;
      for (let i = 0; i < pairs.length; i++) {
        const [a, b] = pairs[i];
        const played = full || (round === playRounds + 1 && i < extra);
        if (!played) { await match(tid, sport, a, b, { round, bracketPosition: i }); continue; }
        const upset = upsets.has(`${round}:${i}`);
        await match(tid, sport, a, b, { round, bracketPosition: i, sets: upset ? flip(win(sport, k++)) : win(sport, k++) });
        winners.push(upset ? b : a);
      }
      if (!full) return;
      const advancing = round === 1 ? byeTeams.concat(winners) : winners;
      if (advancing.length < 2) return; // champion decided
      pairs = outsideIn(advancing);
      round += 1;
    }
  };

  const ko = (extra: Record<string, unknown>) => ({
    seedingMode: "eloRanked", allowByes: true, bronzeMatch: false, consolationBracket: false,
    pointsPerWin: 2, pointsPerDraw: 1, pointsPerLoss: 0, doubleRoundRobin: false,
    groupCount: 2, teamsPerGroup: 4, advancingPerGroup: 2, swissRounds: 5,
    tieBreaker: "headToHead", groupTieBreaker: "headToHead", tieBreakRulesVersion: 1, ...extra,
  });

  // 1. Austin Fall Open: badminton doubles knockout, 16 teams, R16 done, QF 2 of 4 played.
  {
    const tid = await tournament({
      title: "Austin Fall Open", days: 0, deadlineDays: -3, venue: VENUES.austin, sport: "badminton",
      formatRaw: "openDoubles", matchFormatRaw: "singleElimination", formatConfig: ko({ maxParticipants: 16 }),
      scoring: BADMINTON_SCORING, regCount: 16, entryFee: 30, payment: "Venmo @austin-badminton",
      prize: "$500 to the champions · trophies for finalists",
    });
    const teams: Team[] = [];
    for (let i = 0; i < 16; i++) teams.push(await register(tid, people[2 * i], people[2 * i + 1], i));
    await knockout(tid, "badminton", teams, 1, 2, new Set(["1:3", "1:6", "2:1"]));
  }

  // 2. Hill Country Tennis Championship: tennis singles, 24 players (8 byes), finished.
  {
    const tid = await tournament({
      title: "Hill Country Tennis Championship", days: -4, deadlineDays: -8, venue: VENUES.hillCountry, sport: "tennis",
      formatRaw: "openSingles", matchFormatRaw: "singleElimination", formatConfig: ko({ maxParticipants: 32 }),
      scoring: TENNIS_SCORING, regCount: 24, entryFee: 40, prize: "$400 + champion's plate",
    });
    const players: Team[] = [];
    for (let i = 0; i < 24; i++) players.push(await register(tid, people[(i + 4) % PEOPLE.length], undefined, i));
    await knockout(tid, "tennis", players, 5, 0, new Set(["1:2", "2:5", "3:1", "4:1"]));
  }

  // 3. Round Rock Pickleball Classic: 3 groups × 4 doubles teams (24 players); group stage 2 of 3 rounds played.
  {
    const tid = await tournament({
      title: "Round Rock Pickleball Classic", days: 0, deadlineDays: -2, venue: VENUES.roundRock, sport: "pickleball",
      formatRaw: "openDoubles", matchFormatRaw: "groupKnockout",
      formatConfig: ko({ groupCount: 3, teamsPerGroup: 4, advancingPerGroup: 2, maxParticipants: 12 }),
      scoring: PICKLEBALL_SCORING, regCount: 12, entryFee: 25, payment: "Zelle: rrpickleball@example.com",
    });
    const teams: Team[] = [];
    for (let i = 0; i < 12; i++) teams.push(await register(tid, people[(2 * i + 8) % 40], people[(2 * i + 9) % 40], i));
    const rounds = [[[0, 3], [1, 2]], [[0, 2], [3, 1]], [[0, 1], [2, 3]]];
    let k = 0;
    for (const [g, base] of [["A", 0], ["B", 4], ["C", 8]] as [string, number][]) {
      for (let r = 0; r < 3; r++) {
        for (const [x, y] of rounds[r]) {
          const a = teams[base + x], b = teams[base + y];
          if (r === 2) { await match(tid, "pickleball", a, b, { round: r + 1, groupLabel: g }); continue; }
          const upset = (g === "B" && r === 1 && x === 0) || (g === "C" && r === 0 && x === 1);
          const s = win("pickleball", k++);
          await match(tid, "pickleball", a, b, { round: r + 1, groupLabel: g, sets: (x < y) !== upset ? s : flip(s) });
        }
      }
    }
  }

  // 4. Pflugerville Winter Doubles: upcoming, registration open, 11 of 16 teams (22 players).
  let wintersId = "";
  {
    wintersId = await tournament({
      title: "Pflugerville Winter Doubles", days: 9, deadlineDays: 6, venue: VENUES.pflugerville, sport: "badminton",
      formatRaw: "openDoubles", matchFormatRaw: "roundRobin", formatConfig: ko({ seedingMode: "random", maxParticipants: 16 }),
      scoring: BADMINTON_SCORING, regCount: me ? 12 : 11, entryFee: 20, payment: "Venmo @pflug-badminton",
      prize: "Medals for the top 3 teams",
    });
    for (let i = 0; i < 11; i++) await register(wintersId, people[(2 * i + 18) % 40], people[(2 * i + 19) % 40], i);
    if (me) await register(wintersId, me, people[39], 30);
  }

  // ── Open play: 2 courts of doubles = 8 + 2 bench = 10 spots ──
  const session = async (o: { title: string; days: number; hour: number; venue: Venue; sport: string; gameType: string; courts: number; max: number; cost: number; skill: string; attendees: Player[]; notes?: string }) => {
    const id = newId();
    const data: Record<string, unknown> = {
      title: o.title, venue: o.venue.name, venueAddress: o.venue.address, venueLatitude: o.venue.lat, venueLongitude: o.venue.lng,
      date: dayAt(o.days, o.hour), durationMinutes: 120, endsAt: Timestamp.fromMillis(dayAt(o.days, o.hour).toMillis() + 120 * 60_000),
      skillLevel: o.skill, gameType: o.gameType, courts: o.courts, maxPlayers: o.max,
      costPerPerson: o.cost, currency: "USD", preferredAgeGroup: "open", status: "active",
      attendeeIds: o.attendees.map((p) => p.id), hostId: organizerUid,
      createdAt: Timestamp.fromMillis(now - 3 * DAY), timeZone: "America/Chicago", sportType: o.sport,
    };
    if (o.notes) data.notes = o.notes;
    await w.set("playSessions", id, data, `session  ${o.title} (${o.attendees.length}/${o.max})`);
  };
  await session({ title: "Saturday Morning Smash", days: 2, hour: 15, venue: VENUES.austin, sport: "badminton", gameType: "doubles", courts: 2, max: 10, cost: 8, skill: "intermediate", attendees: people.slice(0, 10), notes: "Bring your own racket. Shuttles provided." });
  const social = people.slice(10, me ? 17 : 18);
  await session({ title: "Pickleball Social Night", days: 3, hour: 0, venue: VENUES.cedarPark, sport: "pickleball", gameType: "doubles", courts: 2, max: 10, cost: 5, skill: "allLevels", attendees: me ? [me, ...social] : social, notes: "All levels welcome. Paddles to borrow." });
  await session({ title: "Tennis Singles Meetup", days: 4, hour: 14, venue: VENUES.zilker, sport: "tennis", gameType: "singles", courts: 2, max: 6, cost: 10, skill: "advanced", attendees: people.slice(20, 26) });
  await session({ title: "Lunchtime Badminton Rally", days: 1, hour: 17, venue: VENUES.pflugerville, sport: "badminton", gameType: "doubles", courts: 2, max: 10, cost: 6, skill: "beginner", attendees: people.slice(30, 34) });

  await w.flush();
  console.log(`\n${dryRun ? "[DRY RUN] would create" : "Created"}:`);
  for (const l of w.lines) console.log(`  ${l}`);
  console.log("\nScreenshots:");
  console.log("  Austin Fall Open › Matches › Bracket   bracket tree (16 teams, R16 done, QF half played)");
  console.log("  Hill Country Tennis Championship        finished bracket with byes + champion; Standings");
  console.log("  Round Rock Pickleball Classic           group standings in progress (pickleball colours)");
  console.log("  Pflugerville Winter Doubles             Info (Register footer) and Teams (11–12 teams)");
  console.log("  Play › Open Play                        4 sessions: 10/10 full, 8/10, 6/6, 4/10");
  console.log("\nRemove later with: npm run seed:showcase -- --cleanup");
}

// ─── Cleanup ─────────────────────────────────────────────

async function runCleanup(db: Firestore, dryRun: boolean) {
  const del: FirebaseFirestore.DocumentReference[] = [];
  const add = (refs: FirebaseFirestore.DocumentReference[]) => { for (const r of refs) if (!del.some((d) => d.path === r.path)) del.push(r); };

  const tournaments = (await db.collection("tournaments").where(MARK, "==", true).get()).docs;
  const sessions = (await db.collection("playSessions").where(MARK, "==", true).get()).docs;
  const players = (await db.collection("players").where(MARK, "==", true).get()).docs;
  add(tournaments.map((d) => d.ref));
  add(sessions.map((d) => d.ref));
  add(players.map((d) => d.ref));
  add(players.map((d) => db.collection("playerPrivate").doc(d.id)));
  for (const c of ["registrations", "matches"]) add((await db.collection(c).where(MARK, "==", true).get()).docs.map((d) => d.ref));

  for (const t of tournaments) {
    for (const c of ["registrations", "matches", "notifications"]) {
      add((await db.collection(c).where("tournamentId", "==", t.id).get()).docs.map((d) => d.ref));
    }
    add([db.collection("standings").doc(t.id)]);
  }
  for (const s of sessions) add((await db.collection("notifications").where("sessionId", "==", s.id).get()).docs.map((d) => d.ref));

  console.log(`${dryRun ? "[DRY RUN] would delete" : "Deleting"} ${del.length} docs: ${tournaments.length} tournaments, ${sessions.length} sessions, ${players.length} players (+ their registrations, matches, standings, notifications, playerPrivate).`);
  if (dryRun) return;
  // Matches first, recursively: live-scoring subcollections if anyone scored a showcase match in the app.
  for (const r of del.filter((d) => d.parent.id === "matches")) await db.recursiveDelete(r);
  const rest = del.filter((d) => d.parent.id !== "matches");
  for (let i = 0; i < rest.length; i += 400) {
    const batch = db.batch();
    for (const r of rest.slice(i, i + 400)) batch.delete(r);
    await batch.commit();
  }
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Showcase seed failed:", err);
    process.exit(1);
  });
