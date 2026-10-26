/**
 * Standings tables (round robin, groups, Swiss) — port of the iOS
 * `StandingsEntry.tally` / `StandingsEntry.ranked` (TournMate/Domain/Standings.swift).
 * The draw uses it to rank Group + Knockout groups before the knockout.
 */

import { CricketResult, CricketRules, RunRateTotals, addToRunRate, netRunRate } from "../cricket";

export type TieBreaker = "headToHead" | "pointDiff" | "gamesWon";

export interface StandingsPoints {
  win: number;
  draw: number;
  loss: number;
}

/** One finished match as a table sees it. `winnerId` null = draw / tie / no result. */
export interface StandingsResult {
  teamAId: string;
  teamBId: string;
  winnerId: string | null;
  scoreA: number;
  scoreB: number;
  setsA: number;
  setsB: number;
  cricket?: CricketResult | null;
  noResult?: boolean;
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

function ranksBySets(sport: string): boolean {
  return sport === "tennis" || sport === "padel";
}

/** Adds results to a table. Only teams already in `entries` are counted. */
export function tally(
  results: StandingsResult[],
  entries: Map<string, StandingsEntry>,
  points: StandingsPoints,
  cricketRules?: CricketRules | null,
): void {
  for (const r of results) {
    const sides: Array<[string, number, number, number, number]> = [
      [r.teamAId, r.scoreA, r.scoreB, r.setsA, r.setsB],
      [r.teamBId, r.scoreB, r.scoreA, r.setsB, r.setsA],
    ];
    for (const [id, scored, conceded, setsFor, setsAgainst] of sides) {
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
      if (r.winnerId === null || r.winnerId === undefined) {
        if (r.noResult) e.noResults += 1;
        else e.draws += 1;
        e.points += points.draw;
      } else if (r.winnerId === id) {
        e.wins += 1;
        e.points += points.win;
      } else {
        e.losses += 1;
        e.points += points.loss;
      }
    }
  }
}

function scoreDifferenceOrder(a: StandingsEntry, b: StandingsEntry, sport: string): number | null {
  const setDiff = (e: StandingsEntry) => e.setsWon - e.setsLost;
  const pointDiff = (e: StandingsEntry) => e.pointsFor - e.pointsAgainst;
  if (ranksBySets(sport) && setDiff(a) !== setDiff(b)) return setDiff(a) > setDiff(b) ? -1 : 1;
  if (pointDiff(a) !== pointDiff(b)) return pointDiff(a) > pointDiff(b) ? -1 : 1;
  return null;
}

/**
 * Table order: points; cricket net run rate; the tie-breaker (head-to-head
 * mini-table, games won, or nothing extra for point difference); the sport's
 * score difference; name (case-insensitive); registration id.
 */
export function ranked(
  entries: StandingsEntry[],
  results: StandingsResult[],
  sport: string,
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
      const mini = new Map<string, StandingsEntry>();
      for (const id of ids) mini.set(id, newEntry(id, ""));
      tally(results.filter((r) => ids.has(r.teamAId) && ids.has(r.teamBId)), mini, points);
      for (const [id, e] of mini) if (!h2h.has(id)) h2h.set(id, e);
    }
  }
  const gamesWon = (e: StandingsEntry) => (ranksBySets(sport) ? e.pointsFor : e.setsWon);
  return [...entries].sort((a, b) => {
    if (a.points !== b.points) return a.points > b.points ? -1 : 1;
    if (sport === "cricket") {
      const na = entryNetRunRate(a);
      const nb = entryNetRunRate(b);
      if (na !== nb) return na > nb ? -1 : 1;
    }
    if (tieBreaker === "headToHead") {
      const ha = h2h.get(a.registrationId);
      const hb = h2h.get(b.registrationId);
      if (ha && hb) {
        if (ha.points !== hb.points) return ha.points > hb.points ? -1 : 1;
        const o = scoreDifferenceOrder(ha, hb, sport);
        if (o !== null) return o;
      }
    } else if (tieBreaker === "gamesWon") {
      const ga = gamesWon(a);
      const gb = gamesWon(b);
      if (ga !== gb) return ga > gb ? -1 : 1;
    }
    const o = scoreDifferenceOrder(a, b, sport);
    if (o !== null) return o;
    const byName = a.teamName.localeCompare(b.teamName, "en", { sensitivity: "accent" });
    if (byName !== 0) return byName;
    return a.registrationId < b.registrationId ? -1 : a.registrationId > b.registrationId ? 1 : 0;
  });
}
