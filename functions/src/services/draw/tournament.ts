/**
 * The apps' view of a tournament for drawing: tournament settings, formed
 * teams with their ratings, and existing matches — the same reads and rules
 * as the iOS `TournamentDetailViewModel` (formedTeams, avgElo, bracketSeeding,
 * groupStandings, winnerRegistration) and the repositories it uses.
 */

import {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";
import { CricketRules, decodeCricketResult, resolveCricketRules } from "../cricket";
import { resolveEloRatings } from "../elo";
import { MatchDoc, PlayerDoc, RegistrationDoc, TournamentDoc, parseSportType } from "../../types";
import { DrawTeam, SeedingMode, SwissMatch } from "./pairing";
import { StandingsEntry, StandingsPoints, StandingsResult, TieBreaker, newEntry, ranked, tally } from "./standings";

// ─── Format config (FormatConfig.swift) ─────────────────

export type MatchFormat =
  | "singleElimination" | "doubleElimination" | "roundRobin" | "groupKnockout" | "swiss" | "manualDraw";

const MATCH_FORMATS: readonly MatchFormat[] =
  ["singleElimination", "doubleElimination", "roundRobin", "groupKnockout", "swiss", "manualDraw"];

export interface FormatConfig {
  seedingMode: SeedingMode;
  pointsPerWin: number;
  pointsPerDraw: number;
  pointsPerLoss: number;
  tieBreaker: TieBreaker;
  doubleRoundRobin: boolean;
  groupCount: number;
  advancingPerGroup: number;
  groupTieBreaker: TieBreaker;
  tieBreakRulesVersion: number;
  swissRounds: number;
}

const LEGACY_TIE_BREAKER: TieBreaker = "pointDiff";
const SEEDING_MODES: readonly SeedingMode[] = ["eloRanked", "random", "manual"];
const TIE_BREAKERS: readonly TieBreaker[] = ["headToHead", "pointDiff", "gamesWon"];

function defaultConfig(): FormatConfig {
  return {
    seedingMode: "eloRanked", pointsPerWin: 2, pointsPerDraw: 1, pointsPerLoss: 0,
    tieBreaker: "headToHead", doubleRoundRobin: false, groupCount: 2, advancingPerGroup: 2,
    groupTieBreaker: "headToHead", tieBreakRulesVersion: 0, swissRounds: 5,
  };
}

/** `FormatConfig.fallback(for:)`: used when `formatConfigData` is missing or unreadable. */
function fallbackConfig(format: MatchFormat): FormatConfig {
  const c = defaultConfig();
  if (format === "roundRobin") c.seedingMode = "random";
  if (format === "manualDraw") c.seedingMode = "manual";
  c.tieBreaker = LEGACY_TIE_BREAKER;
  c.groupTieBreaker = LEGACY_TIE_BREAKER;
  return c;
}

/** Lenient decode like iOS: missing keys / unknown enum values keep defaults; a wrongly typed value fails the decode. */
export function decodeFormatConfig(json: unknown, format: MatchFormat): FormatConfig {
  if (typeof json !== "string") return fallbackConfig(format);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fallbackConfig(format);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallbackConfig(format);
  const o = raw as Record<string, unknown>;
  const c = defaultConfig();
  let bad = false;
  const int = (k: string, d: number): number => {
    const v = o[k];
    if (v === undefined || v === null) return d;
    if (typeof v !== "number" || !Number.isInteger(v)) { bad = true; return d; }
    return v;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = o[k];
    if (v === undefined || v === null) return d;
    if (typeof v !== "boolean") { bad = true; return d; }
    return v;
  };
  const oneOf = <T extends string>(k: string, all: readonly T[], d: T): T =>
    (typeof o[k] === "string" && all.includes(o[k] as T) ? (o[k] as T) : d);
  c.seedingMode = oneOf("seedingMode", SEEDING_MODES, c.seedingMode);
  bool("allowByes", true);
  bool("bronzeMatch", false);
  bool("consolationBracket", false);
  c.pointsPerWin = int("pointsPerWin", c.pointsPerWin);
  c.pointsPerDraw = int("pointsPerDraw", c.pointsPerDraw);
  c.pointsPerLoss = int("pointsPerLoss", c.pointsPerLoss);
  c.tieBreaker = oneOf("tieBreaker", TIE_BREAKERS, LEGACY_TIE_BREAKER);
  c.doubleRoundRobin = bool("doubleRoundRobin", c.doubleRoundRobin);
  c.groupCount = int("groupCount", c.groupCount);
  int("teamsPerGroup", 4);
  c.advancingPerGroup = int("advancingPerGroup", c.advancingPerGroup);
  c.groupTieBreaker = oneOf("groupTieBreaker", TIE_BREAKERS, LEGACY_TIE_BREAKER);
  const v = o.tieBreakRulesVersion;
  c.tieBreakRulesVersion = typeof v === "number" && Number.isInteger(v) ? v : 0;
  c.swissRounds = int("swissRounds", c.swissRounds);
  if (o.maxParticipants !== undefined && o.maxParticipants !== null) int("maxParticipants", 0);
  return bad ? fallbackConfig(format) : c;
}

// ─── Tournament ─────────────────────────────────────────

export interface TournamentInfo {
  id: string;
  doc: TournamentDoc;
  /** Raw sport id as the apps write it on matches (`storageValue`). */
  sportRaw: string;
  /** Sport key for ratings (`SportType.decoding`). */
  sport: string;
  formatRaw: string;
  matchFormat: MatchFormat;
  config: FormatConfig;
  isTeamEvent: boolean;
  isSingles: boolean;
  isDoubles: boolean;
  cricketRules: CricketRules | null;
}

const SINGLES = ["mensSingles", "womensSingles", "openSingles"];
const DOUBLES = ["mensDoubles", "womensDoubles", "mixedDoubles", "openDoubles", "fixedDoubles"];
const KNOWN_FORMATS = [...SINGLES, ...DOUBLES, "team"];

export function tournamentInfo(id: string, doc: TournamentDoc): TournamentInfo {
  const rawSport = typeof doc.sportType === "string" ? doc.sportType.trim() : "";
  const sport = parseSportType(rawSport);
  const formatRaw = KNOWN_FORMATS.includes(doc.formatRaw) ? doc.formatRaw : "openDoubles";
  const matchFormat = MATCH_FORMATS.includes(doc.matchFormatRaw as MatchFormat)
    ? doc.matchFormatRaw as MatchFormat : "singleElimination";
  const isTeamEvent = sport === "cricket" || formatRaw === "team";
  return {
    id,
    doc,
    sportRaw: rawSport === "" ? "badminton" : rawSport,
    sport,
    formatRaw,
    matchFormat,
    config: decodeFormatConfig(doc.formatConfigData, matchFormat),
    isTeamEvent,
    isSingles: SINGLES.includes(formatRaw),
    isDoubles: DOUBLES.includes(formatRaw),
    cricketRules: isTeamEvent ? resolveCricketRules(doc.rulesData) : null,
  };
}

/** Registration deadline; a tournament without one closes at 23:59:59 UTC the day before (else an hour before start). */
export function registrationDeadline(doc: TournamentDoc): Date {
  const stored = doc.registrationDeadline;
  if (stored instanceof Timestamp) return stored.toDate();
  const start = doc.date instanceof Timestamp ? doc.date.toDate() : new Date(0);
  const dayBefore = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - 1, 23, 59, 59));
  return dayBefore.getTime() > Date.now() ? dayBefore : new Date(start.getTime() - 3600_000);
}

// ─── Teams ──────────────────────────────────────────────

export interface Entry extends DrawTeam {
  /** Registration doc id as stored. */
  docId: string;
  ref: DocumentReference;
  doc: RegistrationDoc;
  player: PlayerDoc & { id: string };
  partner: (PlayerDoc & { id: string }) | null;
  roster: Array<PlayerDoc & { id: string }>;
  isTeamFormed: boolean;
  displayName: string;
  createdAtMillis: number;
}

export interface DrawState {
  tournament: TournamentInfo;
  tournamentRef: DocumentReference;
  /** Every resolvable registration, oldest first (like `listRegistrations`). */
  entries: Entry[];
  formedTeams: Entry[];
  matches: Array<{ id: string; ref: DocumentReference; doc: MatchDoc }>;
}

type Reader = {
  get(ref: DocumentReference): Promise<DocumentSnapshot>;
  query(q: Query): Promise<QuerySnapshot>;
  getAll(refs: DocumentReference[]): Promise<DocumentSnapshot[]>;
};

function reader(db: Firestore, tx?: Transaction): Reader {
  if (tx) {
    return {
      get: (ref) => tx.get(ref),
      query: (q) => tx.get(q),
      getAll: (refs) => (refs.length ? tx.getAll(...refs) : Promise.resolve([])),
    };
  }
  return {
    get: (ref) => ref.get(),
    query: (q) => q.get(),
    getAll: (refs) => (refs.length ? db.getAll(...refs) : Promise.resolve([])),
  };
}

/** `tournamentId` values that registrations / matches of this tournament may carry. */
export function tournamentIdVariants(id: string): string[] {
  return [...new Set([id.toUpperCase(), id, id.toLowerCase()])];
}

function isPlayer(data: unknown): data is PlayerDoc {
  const d = data as Record<string, unknown> | undefined;
  return !!d && typeof d.name === "string" && typeof d.phone === "string" && typeof d.email === "string";
}

function playerRating(p: PlayerDoc, sport: string): number {
  const legacy = typeof p.elo === "number" ? p.elo : undefined;
  const ratings = resolveEloRatings(legacy, p.eloRatings as Record<string, unknown> | undefined,
    parseSportType(p.preferredSport));
  return ratings[sport] ?? 1200;
}

/** `avgElo`: team entries average their (de-duplicated) roster; doubles average both players. */
function averageRating(e: Omit<Entry, "rating" | "id">, sport: string, isTeamEntry: boolean): number {
  if (isTeamEntry && e.roster.length > 0) {
    const seen = new Set<string>();
    const roster = e.roster.filter((p) => !seen.has(p.id.toUpperCase()) && !!seen.add(p.id.toUpperCase()));
    return roster.reduce((sum, p) => sum + playerRating(p, sport), 0) / roster.length;
  }
  const r1 = playerRating(e.player, sport);
  return e.partner ? (r1 + playerRating(e.partner, sport)) / 2 : r1;
}

/** Loads the tournament, its registrations (with players) and matches, in `tx` when given. */
export async function loadDrawState(db: Firestore, tournamentId: string, tx?: Transaction): Promise<DrawState | null> {
  const r = reader(db, tx);
  const tournamentRef = db.collection("tournaments").doc(tournamentId);
  const tSnap = await r.get(tournamentRef);
  if (!tSnap.exists) return null;
  const tournament = tournamentInfo(tSnap.id, tSnap.data() as TournamentDoc);
  const variants = tournamentIdVariants(tSnap.id);

  const [regSnap, matchSnap] = await Promise.all([
    r.query(db.collection("registrations").where("tournamentId", "in", variants)),
    r.query(db.collection("matches").where("tournamentId", "in", variants)),
  ]);

  // Players referenced by any registration; ids as stored, then other cases.
  const ids = new Set<string>();
  for (const d of regSnap.docs) {
    const reg = d.data() as RegistrationDoc;
    for (const id of [reg.playerId, reg.partnerId, ...(reg.rosterIds ?? [])]) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  const players = new Map<string, PlayerDoc & { id: string }>();
  const fetch = async (list: string[]) => {
    const snaps = await r.getAll(list.map((id) => db.collection("players").doc(id)));
    snaps.forEach((s) => {
      const data = s.data();
      if (s.exists && isPlayer(data)) players.set(s.id.toUpperCase(), { ...data, id: s.id });
    });
  };
  await fetch([...ids]);
  const missing = [...ids].filter((id) => !players.has(id.toUpperCase()));
  await fetch([...new Set(missing.flatMap((id) => [id.toUpperCase(), id.toLowerCase()]))]
    .filter((id) => !ids.has(id)));
  const playerFor = (id: string | undefined) =>
    (typeof id === "string" && id.length > 0 ? players.get(id.toUpperCase()) ?? null : null);

  const entries: Entry[] = [];
  for (const d of regSnap.docs) {
    const doc = d.data() as RegistrationDoc;
    const player = playerFor(doc.playerId);
    if (!player) continue;
    const partner = playerFor(doc.partnerId);
    const rosterIds = Array.isArray(doc.rosterIds) ? doc.rosterIds : [];
    const guestNames = Array.isArray(doc.guestNames) ? doc.guestNames : [];
    const roster = rosterIds.map((id) => playerFor(id)).filter((p): p is PlayerDoc & { id: string } => p !== null);
    const isTeamEntry = doc.teamName != null || doc.teamId != null;
    const rosterCount = new Set(rosterIds.map((id) => id.toUpperCase())).size + guestNames.length;
    const isTeamFormed = tournament.isTeamEvent ? rosterCount >= 2 : tournament.isSingles ? true : partner !== null;
    const displayName = doc.teamName ? doc.teamName : [player.name, partner?.name].filter((n) => n != null).join(" & ");
    const created = doc.createdAt instanceof Timestamp ? doc.createdAt.toMillis() : 0;
    const base = { docId: d.id, ref: d.ref, doc, player, partner, roster, isTeamFormed, displayName, createdAtMillis: created };
    entries.push({ ...base, id: d.id, rating: averageRating(base, tournament.sport, isTeamEntry) });
  }
  entries.sort((a, b) => a.createdAtMillis - b.createdAtMillis || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));

  return {
    tournament,
    tournamentRef,
    entries,
    formedTeams: entries.filter((e) => e.isTeamFormed),
    matches: matchSnap.docs.map((d) => ({ id: d.id, ref: d.ref, doc: d.data() as MatchDoc })),
  };
}

// ─── Matches ────────────────────────────────────────────

const up = (id: string | undefined | null) => (id ?? "").toUpperCase();

/** `Match.winnerRegistration`: the winning registration id, or null (not done, tie, no result). */
export function matchWinnerId(m: MatchDoc): string | null {
  if (m.statusRaw !== "finished" && m.statusRaw !== "scoreSubmitted") return null;
  const pick = (id: string | undefined) =>
    (up(id) === up(m.teamAId) ? m.teamAId : up(id) === up(m.teamBId) ? m.teamBId : null);
  if (m.resultData != null || m.resultType != null) {
    return m.resultType === "win" && m.winnerRegistrationId ? pick(m.winnerRegistrationId) : null;
  }
  const sets = Array.isArray(m.setScores) ? m.setScores : [];
  if (sets.length > 0) {
    const a = sets.filter((s) => s.teamAPoints > s.teamBPoints).length;
    const b = sets.filter((s) => s.teamBPoints > s.teamAPoints).length;
    if (a === b) return null;
    return a > b ? m.teamAId : m.teamBId;
  }
  if (typeof m.scoreA === "number" && typeof m.scoreB === "number") {
    if (m.scoreA === m.scoreB) return null;
    return m.scoreA > m.scoreB ? m.teamAId : m.teamBId;
  }
  return m.winnerRegistrationId ? pick(m.winnerRegistrationId) : null;
}

export function isGroupMatch(m: MatchDoc & { groupLabel?: string | null }): boolean {
  return typeof m.groupLabel === "string";
}

/** True once anything was scored on a match (it then can't be reset). */
export function hasScore(m: MatchDoc): boolean {
  return m.statusRaw !== "scheduled" || m.scoreA != null || m.scoreB != null ||
    (Array.isArray(m.setScores) && m.setScores.length > 0) || m.resultData != null || m.resultType != null ||
    m.winnerRegistrationId != null;
}

export function toSwissMatch(m: MatchDoc): SwissMatch {
  return {
    teamAId: m.teamAId, teamBId: m.teamBId, winnerId: matchWinnerId(m),
    finished: m.statusRaw === "finished", round: typeof m.round === "number" ? m.round : null,
  };
}

/** `TournamentDetailViewModel.standingsResult`. */
function standingsResult(m: MatchDoc): StandingsResult {
  const sets = Array.isArray(m.setScores) ? m.setScores : [];
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
    scoreA = m.scoreA ?? 0;
    scoreB = m.scoreB ?? 0;
    [setsA, setsB] = scoreA === scoreB ? [0, 0] : scoreA > scoreB ? [1, 0] : [0, 1];
  }
  const winner = matchWinnerId(m);
  return {
    teamAId: up(m.teamAId), teamBId: up(m.teamBId), winnerId: winner === null ? null : up(winner),
    scoreA, scoreB, setsA, setsB, cricket: decodeCricketResult(m.resultData), noResult: m.resultType === "noResult",
  };
}

/** Group tables in label order, each ranked (`groupStandings` + `qualifiedKnockoutTeams`). */
export function groupTables(state: DrawState): Entry[][] {
  const { tournament } = state;
  const groupMatches = state.matches.map((m) => m.doc as MatchDoc & { groupLabel?: string })
    .filter((m) => typeof m.groupLabel === "string");
  const byGroup = new Map<string, Map<string, StandingsEntry>>();
  const entryById = new Map<string, Entry>();
  for (const reg of state.formedTeams) {
    const id = up(reg.id);
    const first = groupMatches.find((m) => up(m.teamAId) === id || up(m.teamBId) === id);
    if (!first) continue;
    const label = first.groupLabel as string;
    if (!byGroup.has(label)) byGroup.set(label, new Map());
    byGroup.get(label)!.set(id, newEntry(id, reg.displayName));
    entryById.set(id, reg);
  }
  const c = tournament.config;
  const points: StandingsPoints = { win: c.pointsPerWin, draw: c.pointsPerDraw, loss: c.pointsPerLoss };
  const tieBreaker = c.tieBreakRulesVersion >= 1 ? c.groupTieBreaker : LEGACY_TIE_BREAKER;
  return [...byGroup.keys()].sort().map((label) => {
    const entries = byGroup.get(label)!;
    const results = groupMatches.filter((m) => m.groupLabel === label && m.statusRaw === "finished").map(standingsResult);
    tally(results, entries, points, tournament.cricketRules);
    return ranked([...entries.values()], results, tournament.sport, tieBreaker, points)
      .map((e) => entryById.get(e.registrationId)!)
      .filter((e) => e !== undefined);
  });
}
