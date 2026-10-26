/**
 * Server-computed standings (`standings/{tournamentId}`).
 *
 * A port of the iOS reference: `Domain/Standings.swift` (`StandingsEntry.tally`
 * and `ranked`), `TournamentDetailViewModel` (`standings`, `groupStandings`,
 * `standingsResult`, tie-breaker choice), `FormatConfig` decoding,
 * `Match.winnerRegistration`, `PlayerAwardTally` and `CricketLeaderboards`.
 * Android mirrors the same rules. Ranking and tie-breaks must stay identical:
 * `scripts/checkStandings.ts` replays the iOS DrawTests tables.
 *
 * Pure functions only; the trigger (`triggers/onMatchWritten.ts`) loads the
 * documents and writes the result.
 */

import { MatchDoc, RegistrationDoc, SportType, parseSportType } from "../types";
import {
  CricketResult,
  CricketRules,
  RunRateTotals,
  addToRunRate,
  decodeCricketResult,
  netRunRate,
  resolveCricketRules,
} from "./cricket";
import { BattingLeader, BowlingLeader, PlayerStats, battingLeaders, bowlingLeaders, decodePlayerStats } from "./cricketPlayerStats";

// ─── Inputs ─────────────────────────────────────────────

export interface StandingsTournament {
  sportType?: string;
  formatRaw?: string;
  matchFormatRaw?: string;
  formatConfigData?: unknown;
  rulesData?: unknown;
}

/** A registration with its player and partner resolved (null = no such player doc). */
export interface StandingsRegistration {
  id: string;
  doc: RegistrationDoc;
  playerName: string | null;
  /** null when there is no partner or the partner's player doc is missing. */
  partnerName: string | null;
}

export interface StandingsMatch {
  id: string;
  doc: MatchDoc;
}

// ─── Output ─────────────────────────────────────────────

export interface StandingsRow {
  registrationId: string;
  teamName: string;
  played: number;
  won: number;
  lost: number;
  tied: number;
  noResult: number;
  points: number;
  /** Cricket only. */
  nrr?: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Games (sets for tennis/padel) won and lost, for the difference columns. */
  setsWon: number;
  setsLost: number;
  rank: number;
}

export interface StandingsGroup {
  /** Group label ("A", "B", …) for Group + Knockout; "" for a single league table. */
  name: string;
  rows: StandingsRow[];
}

export interface PlayerOfTournament {
  key: string;
  name: string;
  teamId: string;
  awards: number;
}

export interface StandingsData {
  format: string;
  groups: StandingsGroup[];
  topPerformers?: { batting: BattingLeader[]; bowling: BowlingLeader[] };
  playerOfTournament?: PlayerOfTournament;
}

// ─── Tournament settings ────────────────────────────────

export type MatchFormat = "singleElimination" | "doubleElimination" | "roundRobin" | "groupKnockout" | "swiss" | "manualDraw";
const MATCH_FORMATS: readonly MatchFormat[] = ["singleElimination", "doubleElimination", "roundRobin", "groupKnockout", "swiss", "manualDraw"];

/** iOS `Tournament.matchFormat`: missing or unknown → single elimination. */
export function parseMatchFormat(raw: unknown): MatchFormat {
  return MATCH_FORMATS.includes(raw as MatchFormat) ? (raw as MatchFormat) : "singleElimination";
}

/** iOS `Tournament.isTeamEvent`: cricket, or the team format. */
export function isTeamEvent(t: StandingsTournament): boolean {
  return parseSportType(t.sportType) === "cricket" || t.formatRaw === "team";
}

const SINGLES_FORMATS = ["mensSingles", "womensSingles", "openSingles"];

export type TieBreaker = "headToHead" | "pointDiff" | "gamesWon";
const TIE_BREAKERS: readonly TieBreaker[] = ["headToHead", "pointDiff", "gamesWon"];
/** `FormatConfig.legacyTieBreaker`: the order standings used before tie-breakers were applied. */
export const LEGACY_TIE_BREAKER: TieBreaker = "pointDiff";

export interface StandingsConfig {
  pointsPerWin: number;
  pointsPerDraw: number;
  pointsPerLoss: number;
  tieBreaker: TieBreaker;
  groupTieBreaker: TieBreaker;
  tieBreakRulesVersion: number;
}

const FALLBACK_CONFIG: StandingsConfig = {
  pointsPerWin: 2, pointsPerDraw: 1, pointsPerLoss: 0,
  tieBreaker: LEGACY_TIE_BREAKER, groupTieBreaker: LEGACY_TIE_BREAKER, tieBreakRulesVersion: 0,
};

/**
 * iOS `Tournament.formatConfig`: decodes `formatConfigData` leniently (missing
 * keys keep defaults, missing or unknown tie-breakers are the legacy one), but
 * JSON that can't be read, or a key of the wrong type, falls back to the
 * defaults for the format with legacy tie-breakers.
 */
export function decodeStandingsConfig(data: unknown): StandingsConfig {
  if (typeof data !== "string") return FALLBACK_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return FALLBACK_CONFIG;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return FALLBACK_CONFIG;
  const o = raw as Record<string, unknown>;
  const present = (k: string) => o[k] !== undefined && o[k] !== null;
  const ints = ["pointsPerWin", "pointsPerDraw", "pointsPerLoss", "groupCount", "teamsPerGroup",
    "advancingPerGroup", "swissRounds", "maxParticipants"];
  const bools = ["allowByes", "bronzeMatch", "consolationBracket", "doubleRoundRobin"];
  if (ints.some((k) => present(k) && !Number.isInteger(o[k]))) return FALLBACK_CONFIG;
  if (bools.some((k) => present(k) && typeof o[k] !== "boolean")) return FALLBACK_CONFIG;
  const tb = (k: string): TieBreaker =>
    TIE_BREAKERS.includes(o[k] as TieBreaker) ? (o[k] as TieBreaker) : LEGACY_TIE_BREAKER;
  return {
    pointsPerWin: present("pointsPerWin") ? (o.pointsPerWin as number) : 2,
    pointsPerDraw: present("pointsPerDraw") ? (o.pointsPerDraw as number) : 1,
    pointsPerLoss: present("pointsPerLoss") ? (o.pointsPerLoss as number) : 0,
    tieBreaker: tb("tieBreaker"),
    groupTieBreaker: tb("groupTieBreaker"),
    tieBreakRulesVersion: Number.isInteger(o.tieBreakRulesVersion) ? (o.tieBreakRulesVersion as number) : 0,
  };
}

export function effectiveTieBreaker(c: StandingsConfig): TieBreaker {
  return c.tieBreakRulesVersion >= 1 ? c.tieBreaker : LEGACY_TIE_BREAKER;
}

export function effectiveGroupTieBreaker(c: StandingsConfig): TieBreaker {
  return c.tieBreakRulesVersion >= 1 ? c.groupTieBreaker : LEGACY_TIE_BREAKER;
}

// ─── Registrations ──────────────────────────────────────

/** iOS `Registration.displayName()`: team name, else "Player & Partner". */
export function registrationDisplayName(r: StandingsRegistration): string {
  if (r.doc.teamName) return r.doc.teamName;
  return [r.playerName ?? "", r.partnerName].filter((n): n is string => n !== null).join(" & ");
}

/** iOS `Registration.isTeamFormed`. */
export function isTeamFormed(r: StandingsRegistration, t: StandingsTournament): boolean {
  if (isTeamEvent(t)) {
    const ids = new Set((r.doc.rosterIds ?? []).map((id) => id.toUpperCase()));
    return ids.size + (r.doc.guestNames ?? []).length >= 2;
  }
  if (SINGLES_FORMATS.includes(t.formatRaw ?? "openDoubles")) return true;
  return r.partnerName !== null;
}

// ─── Match results ──────────────────────────────────────

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

/** iOS decodes each set leniently and drops sets without both numbers. */
export function matchSets(m: MatchDoc): Array<{ teamAPoints: number; teamBPoints: number }> {
  if (!Array.isArray(m.setScores)) return [];
  const out: Array<{ teamAPoints: number; teamBPoints: number }> = [];
  for (const s of m.setScores) {
    const a = num(s?.teamAPoints);
    const b = num(s?.teamBPoints);
    if (a !== undefined && b !== undefined) out.push({ teamAPoints: a, teamBPoints: b });
  }
  return out;
}

/**
 * iOS `Match.winnerRegistration`: the winning registration id, or null (not
 * finished/submitted, a draw, a tie or a no result).
 */
export function matchWinnerId(m: MatchDoc): string | null {
  if (m.statusRaw !== "finished" && m.statusRaw !== "scoreSubmitted") return null;
  const inMatch = (id: unknown) => (id === m.teamAId || id === m.teamBId ? (id as string) : null);
  // Team sports store the winner explicitly (a super over or revised target
  // can't be derived from runs). Ties and no results have none.
  if (typeof m.resultData === "string" || typeof m.resultType === "string") {
    return m.resultType === "win" ? inMatch(m.winnerRegistrationId) : null;
  }
  const sets = matchSets(m);
  if (sets.length > 0) {
    const a = sets.filter((s) => s.teamAPoints > s.teamBPoints).length;
    const b = sets.filter((s) => s.teamBPoints > s.teamAPoints).length;
    if (a === b) return null;
    return a > b ? m.teamAId : m.teamBId;
  }
  const a = num(m.scoreA);
  const b = num(m.scoreB);
  if (a !== undefined && b !== undefined) {
    // An equal simple score is a draw — never a winner left over from an earlier score.
    if (a === b) return null;
    return a > b ? m.teamAId : m.teamBId;
  }
  return inMatch(m.winnerRegistrationId);
}

/** One finished match as a standings table sees it (iOS `StandingsResult`). */
export interface StandingsResult {
  teamAId: string;
  teamBId: string;
  winnerId: string | null;
  scoreA: number;
  scoreB: number;
  setsA: number;
  setsB: number;
  cricket: CricketResult | null;
  noResult: boolean;
}

/** iOS `TournamentDetailViewModel.standingsResult` (+ `matchScorePair` / `matchSetPair`). */
export function standingsResult(m: MatchDoc): StandingsResult {
  const sets = matchSets(m);
  let scoreA: number;
  let scoreB: number;
  let setsA: number;
  let setsB: number;
  if (sets.length > 0) {
    scoreA = sets.reduce((s, x) => s + x.teamAPoints, 0);
    scoreB = sets.reduce((s, x) => s + x.teamBPoints, 0);
    setsA = sets.filter((s) => s.teamAPoints > s.teamBPoints).length;
    setsB = sets.filter((s) => s.teamBPoints > s.teamAPoints).length;
  } else {
    scoreA = num(m.scoreA) ?? 0;
    scoreB = num(m.scoreB) ?? 0;
    setsA = scoreA === scoreB ? 0 : scoreA > scoreB ? 1 : 0;
    setsB = scoreA === scoreB ? 0 : scoreA > scoreB ? 0 : 1;
  }
  return {
    teamAId: m.teamAId, teamBId: m.teamBId, winnerId: matchWinnerId(m),
    scoreA, scoreB, setsA, setsB,
    cricket: decodeCricketResult(m.resultData),
    noResult: m.resultType === "noResult",
  };
}

// ─── Tables ─────────────────────────────────────────────

export interface StandingsPoints {
  win: number;
  draw: number;
  loss: number;
}

export interface StandingsEntry {
  registrationId: string;
  teamName: string;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  points: number;
  pointsFor: number;
  pointsAgainst: number;
  setsWon: number;
  setsLost: number;
  noResults: number;
  runRate: RunRateTotals;
  ballsPerOver: number;
}

export function newEntry(registrationId: string, teamName: string): StandingsEntry {
  return {
    registrationId, teamName, played: 0, wins: 0, losses: 0, draws: 0, points: 0,
    pointsFor: 0, pointsAgainst: 0, setsWon: 0, setsLost: 0, noResults: 0,
    runRate: { runsFor: 0, ballsFaced: 0, runsAgainst: 0, ballsBowled: 0 }, ballsPerOver: 6,
  };
}

export function entryNetRunRate(e: StandingsEntry): number {
  return netRunRate(e.runRate, e.ballsPerOver);
}

/** iOS `SportType.ranksStandingsBySets`. */
function ranksBySets(sport: SportType): boolean {
  return sport === "tennis" || sport === "padel";
}

/**
 * iOS `StandingsEntry.tally`: adds finished results to a table. Only teams
 * already in `entries` are counted, so a group table ignores matches against
 * other groups.
 */
export function tally(
  results: StandingsResult[],
  entries: Map<string, StandingsEntry>,
  points: StandingsPoints,
  cricketRules: CricketRules | null = null,
): void {
  for (const r of results) {
    const pairs: Array<[string, number, number, number, number]> = [
      [r.teamAId, r.scoreA, r.scoreB, r.setsA, r.setsB],
      [r.teamBId, r.scoreB, r.scoreA, r.setsB, r.setsA],
    ];
    for (const [id, scored, conceded, setsFor, setsAgainst] of pairs) {
      const e = entries.get(id);
      if (!e) continue;
      e.played += 1;
      e.pointsFor += scored;
      e.pointsAgainst += conceded;
      e.setsWon += setsFor;
      e.setsLost += setsAgainst;
      if (cricketRules && r.cricket) {
        e.runRate = addToRunRate(e.runRate, id, r.cricket, cricketRules);
        e.ballsPerOver = cricketRules.ballsPerOver;
      }
      if (r.winnerId === null && r.noResult) { e.noResults += 1; e.points += points.draw; }
      else if (r.winnerId === null) { e.draws += 1; e.points += points.draw; }
      else if (r.winnerId === id) { e.wins += 1; e.points += points.win; }
      else { e.losses += 1; e.points += points.loss; }
    }
  }
}

/** Swift `localizedCaseInsensitiveCompare`. */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "accent" });
}

/** Swift `String <` on upper-case UUIDs (code-point order). */
function compareIds(a: string, b: string): number {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** <0: a first; >0: b first; 0: the sport's score difference doesn't separate them. */
function scoreDifferenceOrder(a: StandingsEntry, b: StandingsEntry, sport: SportType): number {
  const setDiff = (e: StandingsEntry) => e.setsWon - e.setsLost;
  const pointDiff = (e: StandingsEntry) => e.pointsFor - e.pointsAgainst;
  if (ranksBySets(sport) && setDiff(a) !== setDiff(b)) return setDiff(b) - setDiff(a);
  if (pointDiff(a) !== pointDiff(b)) return pointDiff(b) - pointDiff(a);
  return 0;
}

/**
 * iOS `StandingsEntry.ranked` (identical on Android):
 * 1. standings points; cricket: net run rate next;
 * 2. the tie-breaker — head-to-head (mini-table of the matches between teams
 *    level on points: H2H points, then H2H score difference), games won, or
 *    point difference (no extra step);
 * 3. the sport's score difference (tennis/padel: sets then games);
 * 4. name, then registration id.
 */
export function ranked(
  entries: StandingsEntry[],
  results: StandingsResult[],
  sport: SportType,
  tieBreaker: TieBreaker,
  points: StandingsPoints,
): StandingsEntry[] {
  const h2h = new Map<string, StandingsEntry>();
  if (tieBreaker === "headToHead") {
    const levels = new Map<number, StandingsEntry[]>();
    for (const e of entries) levels.set(e.points, [...(levels.get(e.points) ?? []), e]);
    for (const level of levels.values()) {
      if (level.length < 2) continue;
      const ids = new Set(level.map((e) => e.registrationId));
      const mini = new Map([...ids].map((id) => [id, newEntry(id, "")]));
      const between = results.filter((r) => ids.has(r.teamAId) && ids.has(r.teamBId));
      tally(between, mini, points);
      for (const [id, e] of mini) if (!h2h.has(id)) h2h.set(id, e);
    }
  }
  const gamesWon = (e: StandingsEntry) => (ranksBySets(sport) ? e.pointsFor : e.setsWon);
  return [...entries].sort((a, b) => {
    if (a.points !== b.points) return b.points - a.points;
    if (sport === "cricket") {
      const na = entryNetRunRate(a);
      const nb = entryNetRunRate(b);
      if (na !== nb) return na > nb ? -1 : 1;
    }
    if (tieBreaker === "headToHead") {
      const ha = h2h.get(a.registrationId);
      const hb = h2h.get(b.registrationId);
      if (ha && hb) {
        if (ha.points !== hb.points) return hb.points - ha.points;
        const order = scoreDifferenceOrder(ha, hb, sport);
        if (order !== 0) return order;
      }
    } else if (tieBreaker === "gamesWon") {
      if (gamesWon(a) !== gamesWon(b)) return gamesWon(b) - gamesWon(a);
    }
    const order = scoreDifferenceOrder(a, b, sport);
    if (order !== 0) return order;
    const byName = compareNames(a.teamName, b.teamName);
    if (byName !== 0) return byName;
    return compareIds(a.registrationId, b.registrationId);
  });
}

function toRows(entries: StandingsEntry[], cricket: boolean): StandingsRow[] {
  return entries.map((e, i) => {
    const row: StandingsRow = {
      registrationId: e.registrationId,
      teamName: e.teamName,
      played: e.played,
      won: e.wins,
      lost: e.losses,
      tied: e.draws,
      noResult: e.noResults,
      points: e.points,
      pointsFor: e.pointsFor,
      pointsAgainst: e.pointsAgainst,
      setsWon: e.setsWon,
      setsLost: e.setsLost,
      rank: i + 1,
    };
    if (cricket) row.nrr = entryNetRunRate(e);
    return row;
  });
}

// ─── Awards ─────────────────────────────────────────────

/** iOS `TeamRoles.key`: upper-cased player id, or `guest:<name>` as is. */
function roleKey(raw: string): string {
  return raw.startsWith("guest:") ? raw : raw.toUpperCase();
}

/** iOS `PlayerAwardTally.tally`: Player of the Match winners, most awards first, then name, then id. */
export function playerAwards(matches: MatchDoc[]): PlayerOfTournament[] {
  const byId = new Map<string, PlayerOfTournament>();
  for (const m of matches) {
    if (m.statusRaw !== "finished") continue;
    const { playerOfMatchKey: key, playerOfMatchName: name, playerOfMatchTeamId: team } = m;
    if (typeof key !== "string" || typeof name !== "string" || typeof team !== "string") continue;
    const k = roleKey(key);
    const id = `${team}|${k}`;
    const entry = byId.get(id) ?? { key: k, name, teamId: team, awards: 0 };
    entry.awards += 1;
    byId.set(id, entry);
  }
  const idOf = (e: PlayerOfTournament) => `${e.teamId}|${e.key}`;
  return [...byId.values()].sort((a, b) => {
    if (a.awards !== b.awards) return b.awards - a.awards;
    const byName = compareNames(a.name, b.name);
    if (byName !== 0) return byName;
    return idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0;
  });
}

// ─── Whole tournament ───────────────────────────────────

const TOP_PERFORMERS = 5;

function sortMatches(matches: StandingsMatch[]): StandingsMatch[] {
  const created = (m: MatchDoc) => {
    const c = m.createdAt as unknown as { toMillis?: () => number } | undefined;
    return typeof c?.toMillis === "function" ? c.toMillis() : Number.MAX_SAFE_INTEGER;
  };
  return [...matches].sort((x, y) => {
    const r0 = num(x.doc.round) ?? Number.MAX_SAFE_INTEGER;
    const r1 = num(y.doc.round) ?? Number.MAX_SAFE_INTEGER;
    if (r0 !== r1) return r0 - r1;
    const b0 = num(x.doc.bracketPosition) ?? Number.MAX_SAFE_INTEGER;
    const b1 = num(y.doc.bracketPosition) ?? Number.MAX_SAFE_INTEGER;
    if (b0 !== b1) return b0 - b1;
    return created(x.doc) - created(y.doc);
  });
}

/**
 * Standings for a tournament, as the iOS Standings tab shows them:
 * - Round Robin, Swiss, Manual Draw: one table (`name: ""`) once a match is finished;
 * - Group + Knockout: one table per group, sorted by label;
 * - elimination brackets: no tables (`groups: []`).
 * Cricket also gets Top performers (top 5 batting and bowling) and the
 * Player of the Tournament (most Player of the Match awards).
 */
export function computeStandings(
  tournament: StandingsTournament,
  registrations: StandingsRegistration[],
  rawMatches: StandingsMatch[],
): StandingsData {
  const format = parseMatchFormat(tournament.matchFormatRaw);
  const sport = parseSportType(tournament.sportType);
  const team = isTeamEvent(tournament);
  const config = decodeStandingsConfig(tournament.formatConfigData);
  const points: StandingsPoints = { win: config.pointsPerWin, draw: config.pointsPerDraw, loss: config.pointsPerLoss };
  const cricketRules = team ? resolveCricketRules(tournament.rulesData) : null;

  // Like the apps: registrations whose player is gone, and matches whose
  // registrations are gone, are left out. Ids match in any case.
  const regs = registrations.filter((r) => r.playerName !== null);
  const regById = new Map(regs.map((r) => [r.id.toUpperCase(), r]));
  const matches: MatchDoc[] = [];
  for (const m of sortMatches(rawMatches)) {
    const a = regById.get(String(m.doc.teamAId ?? "").toUpperCase());
    const b = regById.get(String(m.doc.teamBId ?? "").toUpperCase());
    if (!a || !b) continue;
    const doc = { ...m.doc, teamAId: a.id, teamBId: b.id };
    if (doc.winnerRegistrationId) {
      const w = regById.get(doc.winnerRegistrationId.toUpperCase());
      if (w) doc.winnerRegistrationId = w.id;
    }
    matches.push(doc);
  }
  const formed = regs.filter((r) => isTeamFormed(r, tournament));
  const finished = matches.filter((m) => m.statusRaw === "finished");

  const groups: StandingsGroup[] = [];
  if (format === "groupKnockout") {
    const byGroup = new Map<string, Map<string, StandingsEntry>>();
    for (const r of formed) {
      const first = matches.find((m) => (m.teamAId === r.id || m.teamBId === r.id) && typeof m.groupLabel === "string");
      if (!first) continue;
      const label = first.groupLabel as string;
      if (!byGroup.has(label)) byGroup.set(label, new Map());
      byGroup.get(label)!.set(r.id, newEntry(r.id, registrationDisplayName(r)));
    }
    const tieBreaker = effectiveGroupTieBreaker(config);
    for (const label of [...byGroup.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) {
      const entries = byGroup.get(label)!;
      const results = finished.filter((m) => m.groupLabel === label).map(standingsResult);
      tally(results, entries, points, cricketRules);
      groups.push({ name: label, rows: toRows(ranked([...entries.values()], results, sport, tieBreaker, points), team) });
    }
  } else if (format !== "singleElimination" && format !== "doubleElimination" && finished.length > 0) {
    const entries = new Map(formed.map((r) => [r.id, newEntry(r.id, registrationDisplayName(r))]));
    const results = finished.map(standingsResult);
    tally(results, entries, points, cricketRules);
    const tieBreaker = format === "roundRobin" ? effectiveTieBreaker(config) : LEGACY_TIE_BREAKER;
    groups.push({ name: "", rows: toRows(ranked([...entries.values()], results, sport, tieBreaker, points), team) });
  }

  const data: StandingsData = { format, groups };
  if (team) {
    const stats = finished.map((m) => decodePlayerStats(m.playerStatsData)).filter((s): s is PlayerStats => s !== null);
    const batting = battingLeaders(stats).slice(0, TOP_PERFORMERS);
    const bowling = bowlingLeaders(stats).slice(0, TOP_PERFORMERS);
    if (batting.length > 0 || bowling.length > 0) data.topPerformers = { batting, bowling };
    const awards = playerAwards(matches);
    if (awards.length > 0) data.playerOfTournament = awards[0];
  }
  return data;
}
