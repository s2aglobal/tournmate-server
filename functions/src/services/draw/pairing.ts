/**
 * Draw generation — TypeScript port of the iOS `DefaultPairingService`
 * (TournMate/Services/PairingService.swift). iOS is the reference; Android
 * mirrors it. Every function here must produce exactly what the apps produce:
 * `npm run check:draw` compares this port's parity dump byte for byte with
 * `test-fixtures/draw-parity-fixture.txt` (a copy of the iOS
 * `Tools/DrawTests/parity-fixture.txt`).
 *
 * Teams are plain values: a registration id (as stored, any case) and the
 * team's average rating in the tournament's sport (`services/draw/teams.ts`
 * computes it like the apps' `avgElo`). Ids are compared upper-cased, like the
 * apps' `UUID.uuidString`.
 */

import { randomInt } from "crypto";

export interface DrawTeam {
  /** Registration id. */
  id: string;
  /** Average rating of the team's players in the tournament's sport. */
  rating: number;
}

export interface ScheduledPair<T extends DrawTeam> {
  teamA: T;
  teamB: T;
  round: number;
}

export interface GroupPair<T extends DrawTeam> extends ScheduledPair<T> {
  group: string;
}

export interface BracketPair<T extends DrawTeam> {
  teamA: T;
  teamB: T;
  bracketPosition: number;
}

export interface BracketFirstRound<T extends DrawTeam> {
  matches: BracketPair<T>[];
  byeTeams: T[];
  totalRounds: number;
}

/** A finished match as Swiss pairing sees it. */
export interface SwissMatch {
  teamAId: string;
  teamBId: string;
  /** Winning registration id (`matchWinnerId`), null for a tie / no result. */
  winnerId: string | null;
  finished: boolean;
  round?: number | null;
}

/** "eloRanked" | "random" | "manual" (manual seeds by rating, like eloRanked). */
export type SeedingMode = "eloRanked" | "random" | "manual";

const up = (id: string) => id.toUpperCase();

// ─── Round robin ────────────────────────────────────────

/**
 * Circle method (Berger tables): fix the first slot and rotate the rest one
 * step per round. Odd N gets a bye slot, so every team sits out once.
 */
export function generateRoundRobinSchedule<T extends DrawTeam>(
  teams: T[],
  doubleRoundRobin = false,
): ScheduledPair<T>[] {
  const leg = roundRobinLeg(teams);
  if (!doubleRoundRobin || leg.length === 0) return leg;
  const legRounds = Math.max(...leg.map((e) => e.round));
  return leg.concat(leg.map((e) => ({ teamA: e.teamB, teamB: e.teamA, round: e.round + legRounds })));
}

function roundRobinLeg<T extends DrawTeam>(teams: T[]): ScheduledPair<T>[] {
  if (teams.length < 2) return [];
  const slots: Array<T | null> = [...teams];
  if (slots.length % 2 !== 0) slots.push(null);
  const m = slots.length;
  const schedule: ScheduledPair<T>[] = [];
  for (let round = 0; round < m - 1; round++) {
    for (let i = 0; i < m / 2; i++) {
      const a = slots[i];
      const b = slots[m - 1 - i];
      if (a === null || b === null) continue; // bye
      const flip = i === 0 ? round % 2 === 1 : i % 2 === 1;
      schedule.push({ teamA: flip ? b : a, teamB: flip ? a : b, round: round + 1 });
    }
    const last = slots.pop() as T | null;
    slots.splice(1, 0, last);
  }
  return schedule;
}

// ─── Seeding ────────────────────────────────────────────

/** Highest rating first; equal ratings keep input (registration) order. */
export function seededByRating<T extends DrawTeam>(teams: T[]): T[] {
  return teams
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.rating !== b.t.rating ? b.t.rating - a.t.rating : a.i - b.i))
    .map((x) => x.t);
}

/**
 * Seeding for the organizer's choice. Random: a fixed shuffle keyed on `salt`
 * (the tournament id) — SplitMix64(FNV-1a64(SALT|REGID)) ascending, ties by
 * input order — so every rebuild (and every platform) gets the same order.
 */
export function seeded<T extends DrawTeam>(teams: T[], mode: SeedingMode, salt: string): T[] {
  if (mode !== "random") return seededByRating(teams);
  const key = salt.toUpperCase();
  const hashes = teams.map((t) => mix64(fnv1a64(key + "|" + up(t.id))));
  const order = teams.map((_, i) => i).sort((a, b) =>
    hashes[a] !== hashes[b] ? (hashes[a] < hashes[b] ? -1 : 1) : a - b);
  return order.map((i) => teams[i]);
}

const MASK64 = (1n << 64n) - 1n;

/** SplitMix64 finalizer. */
export function mix64(value: bigint): bigint {
  let z = value & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

/** FNV-1a, 64-bit, over the UTF-8 bytes. */
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

// ─── Knockout ───────────────────────────────────────────

function nextPowerOf2(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}

/** First knockout round for teams already in seeding order (no re-sorting). */
export function generateBracketFirstRound<T extends DrawTeam>(seededTeams: T[]): BracketFirstRound<T> {
  if (seededTeams.length < 2) return { matches: [], byeTeams: [], totalRounds: 0 };
  const bracketSize = nextPowerOf2(seededTeams.length);
  const totalRounds = Math.round(Math.log2(bracketSize));
  const byeCount = bracketSize - seededTeams.length;
  const byeTeams = seededTeams.slice(0, byeCount);
  const playing = seededTeams.slice(byeCount);
  const half = Math.floor(playing.length / 2);
  const matches: BracketPair<T>[] = [];
  for (let i = 0; i < half; i++) {
    matches.push({ teamA: playing[i], teamB: playing[playing.length - 1 - i], bracketPosition: i });
  }
  return { matches, byeTeams, totalRounds };
}

/** Legacy entry point: seeds by rating, then `generateBracketFirstRound`. */
export function generateBracketFirstRoundByRating<T extends DrawTeam>(teams: T[]): BracketFirstRound<T> {
  return generateBracketFirstRound(seededByRating(teams));
}

/** Seeded teams that aren't in any round-1 match, in seeding order. */
export function knockoutByeTeams<T extends DrawTeam>(seededTeams: T[], roundOneTeamIds: Iterable<string>): T[] {
  const playing = new Set([...roundOneTeamIds].map(up));
  return seededTeams.filter((t) => !playing.has(up(t.id)));
}

/** First vs last, second vs second-last… */
export function nextRoundPairs<T extends DrawTeam>(advancing: T[]): Array<{ teamA: T; teamB: T }> {
  const half = Math.floor(advancing.length / 2);
  const pairs: Array<{ teamA: T; teamB: T }> = [];
  for (let i = 0; i < half; i++) pairs.push({ teamA: advancing[i], teamB: advancing[advancing.length - 1 - i] });
  return pairs;
}

/**
 * Group + Knockout seeding: winners of every group (A, B…), then runners-up…,
 * with lower seeds swapped so no first-round match is a same-group rematch
 * when that can be avoided. `groups` are ranked tables in label order.
 */
export function knockoutSeedingFromGroups<T extends DrawTeam>(groups: T[][], advancingPerGroup: number): T[] {
  const perGroup = Math.max(1, advancingPerGroup);
  const result: T[] = [];
  const groupOf = new Map<string, number>();
  for (let tier = 0; tier < perGroup; tier++) {
    groups.forEach((table, gi) => {
      if (tier < table.length) {
        result.push(table[tier]);
        groupOf.set(up(table[tier].id), gi);
      }
    });
  }
  const q = result.length;
  if (q < 2 || groups.length < 2) return result;
  const byes = nextPowerOf2(q) - q;
  const pairCount = Math.floor((q - byes) / 2);
  const sameGroup = (x: number, y: number) => groupOf.get(up(result[x].id)) === groupOf.get(up(result[y].id));
  const swap = (x: number, y: number) => {
    const t = result[x];
    result[x] = result[y];
    result[y] = t;
  };
  for (let i = 0; i < pairCount; i++) {
    const hi = byes + i;
    const lo = q - 1 - i;
    if (!sameGroup(hi, lo)) continue;
    for (let j = pairCount - 1; j >= 0; j--) {
      if (j === i) continue;
      const hj = byes + j;
      const lj = q - 1 - j;
      swap(lo, lj);
      if (!sameGroup(hi, lo) && !sameGroup(hj, lj)) break;
      swap(lo, lj);
    }
  }
  return result;
}

// ─── Group + Knockout ───────────────────────────────────

/**
 * Fewest groups (≥ 2) whose qualifiers make a power-of-2 bracket, each group
 * bigger than the advancing count; else the most groups that still eliminate;
 * 1 when two groups can't both eliminate someone.
 */
export function optimalGroupCount(totalTeams: number, advancingPerGroup: number): number {
  if (totalTeams < 4 || advancingPerGroup < 1) return 2;
  const minGroupSize = advancingPerGroup + 1;
  const maxGroups = Math.floor(totalTeams / minGroupSize);
  if (maxGroups < 2) return 1;
  for (let candidate = 2; candidate <= maxGroups; candidate++) {
    const groupSize = Math.floor(totalTeams / candidate);
    if (groupSize < minGroupSize) break;
    const advancingTotal = candidate * advancingPerGroup;
    if (advancingTotal > 0 && (advancingTotal & (advancingTotal - 1)) === 0) return candidate;
  }
  return maxGroups;
}

/** Snake-seeded groups (by rating) with a round robin inside each. The organizer's group count is ignored. */
export function generateGroupStageSchedule<T extends DrawTeam>(
  teams: T[],
  groupCount: number,
  advancingPerGroup = 2,
): GroupPair<T>[] {
  if (teams.length < 4 || groupCount < 1) return [];
  const effective = optimalGroupCount(teams.length, advancingPerGroup);
  const groups: T[][] = Array.from({ length: effective }, () => []);
  seededByRating(teams).forEach((team, index) => {
    const row = Math.floor(index / effective);
    const col = index % effective;
    groups[row % 2 === 0 ? col : effective - 1 - col].push(team);
  });
  const schedule: GroupPair<T>[] = [];
  groups.forEach((group, gi) => {
    const label = String.fromCharCode(65 + gi);
    for (const e of generateRoundRobinSchedule(group)) {
      schedule.push({ teamA: e.teamA, teamB: e.teamB, round: e.round, group: label });
    }
  });
  return schedule;
}

// ─── Swiss ──────────────────────────────────────────────

/** Pairing attempts before the Swiss search gives up and pairs greedily (same on every platform). */
export const SWISS_SEARCH_BUDGET = 200_000;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Teams with similar records meet; no rematches. Wins from finished matches
 * (ties / no results aren't wins), sorted by wins, rating, input order. Odd
 * field: the bye goes to the lowest-ranked team with the fewest byes for which
 * the rest can be paired. Backtracking search, greedy fallback.
 */
export function generateSwissPairings<T extends DrawTeam>(
  teams: T[],
  finishedMatches: SwissMatch[],
  _swissRound: number,
): Array<{ teamA: T; teamB: T }> {
  if (teams.length < 2) return [];

  const wins = new Map<string, number>();
  const played = new Map<string, number>();
  for (const t of teams) wins.set(up(t.id), 0);
  for (const m of finishedMatches) {
    if (m.finished && m.winnerId) wins.set(up(m.winnerId), (wins.get(up(m.winnerId)) ?? 0) + 1);
  }
  const playedPairs = new Set<string>();
  for (const m of finishedMatches) {
    const a = up(m.teamAId);
    const b = up(m.teamBId);
    playedPairs.add(pairKey(a, b));
    played.set(a, (played.get(a) ?? 0) + 1);
    played.set(b, (played.get(b) ?? 0) + 1);
  }
  const roundsSoFar = new Set(
    finishedMatches.map((m) => m.round).filter((r): r is number => r !== undefined && r !== null),
  ).size;

  const sorted = teams
    .map((t, i) => ({ t, i }))
    .sort((x, y) => {
      const wA = wins.get(up(x.t.id)) ?? 0;
      const wB = wins.get(up(y.t.id)) ?? 0;
      if (wA !== wB) return wB - wA;
      if (x.t.rating !== y.t.rating) return y.t.rating - x.t.rating;
      return x.i - y.i;
    })
    .map((x) => x.t);
  const ids = sorted.map((t) => up(t.id));
  const n = sorted.length;
  const canMeet = (i: number, j: number) => !playedPairs.has(pairKey(ids[i], ids[j]));

  let budget = SWISS_SEARCH_BUDGET;
  let partner: number[] = new Array(n).fill(-1);
  const pairRest = (excluded: number): boolean => {
    let a = -1;
    for (let k = 0; k < n; k++) {
      if (k !== excluded && partner[k] < 0) { a = k; break; }
    }
    if (a < 0) return true;
    for (let b = a + 1; b < n; b++) {
      if (b === excluded || partner[b] >= 0 || !canMeet(a, b)) continue;
      budget -= 1;
      if (budget < 0) return false;
      partner[a] = b;
      partner[b] = a;
      if (pairRest(excluded)) return true;
      partner[a] = -1;
      partner[b] = -1;
    }
    return false;
  };

  let found = false;
  if (n % 2 === 0) {
    found = pairRest(-1);
  } else {
    const byes = ids.map((id) => roundsSoFar - (played.get(id) ?? 0));
    const candidates = ids.map((_, i) => i).sort((p, q) => (byes[p] !== byes[q] ? byes[p] - byes[q] : q - p));
    for (const c of candidates) {
      partner = new Array(n).fill(-1);
      if (pairRest(c)) { found = true; break; }
      if (budget < 0) break;
    }
  }

  if (found) {
    const pairs: Array<{ teamA: T; teamB: T }> = [];
    for (let i = 0; i < n; i++) if (partner[i] > i) pairs.push({ teamA: sorted[i], teamB: sorted[partner[i]] });
    return pairs;
  }

  // Greedy fallback: pair top-down, skipping rematches.
  const used = new Set<string>();
  const pairs: Array<{ teamA: T; teamB: T }> = [];
  for (let i = 0; i < n; i++) {
    if (used.has(ids[i])) continue;
    for (let j = i + 1; j < n; j++) {
      if (used.has(ids[j])) continue;
      if (playedPairs.has(pairKey(ids[i], ids[j]))) continue;
      pairs.push({ teamA: sorted[i], teamB: sorted[j] });
      used.add(ids[i]);
      used.add(ids[j]);
      break;
    }
  }
  return pairs;
}

// ─── Random doubles pairing ─────────────────────────────

/** A solo registration for random pairing. */
export interface SoloEntry {
  id: string;
  gender?: string | null;
}

/** Fisher–Yates with a caller-supplied random in [0, 1) (default: crypto). */
export function shuffled<T>(items: T[], random: () => number = cryptoRandom): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

function cryptoRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

/** Mixed doubles: shuffles men and women separately and zips them. Extras stay unpaired. */
export function generateMixedDoublesPairs<T extends SoloEntry>(
  solo: T[],
  random?: () => number,
): Array<{ male: T; female: T }> {
  const males = shuffled(solo.filter((r) => r.gender === "male"), random);
  const females = shuffled(solo.filter((r) => r.gender === "female"), random);
  const count = Math.min(males.length, females.length);
  const pairs: Array<{ male: T; female: T }> = [];
  for (let i = 0; i < count; i++) pairs.push({ male: males[i], female: females[i] });
  return pairs;
}

/** Any doubles: shuffles everyone and pairs neighbours. An odd one out stays unpaired. */
export function generateRandomDoublesPairs<T extends SoloEntry>(
  solo: T[],
  random?: () => number,
): Array<{ playerA: T; playerB: T }> {
  const s = shuffled(solo, random);
  const pairs: Array<{ playerA: T; playerB: T }> = [];
  for (let i = 0; i + 1 < s.length; i += 2) pairs.push({ playerA: s[i], playerB: s[i + 1] });
  return pairs;
}
