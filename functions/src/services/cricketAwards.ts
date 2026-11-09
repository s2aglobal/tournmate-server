/**
 * Cricket tournament awards: Player of the Series, Best Batter, Best Bowler.
 * Pure functions (the reference; iOS and Android port `seriesAwards` for the
 * shared parity fixture). Stored on the tournament as `awards` plus
 * `awardPlayerIds`, written only by the server (services/tournamentAwards.ts).
 *
 * - Best Batter: batting leaderboard #1 (most runs, then strike rate, then
 *   name, team and key: `battingLeaders`).
 * - Best Bowler: bowling leaderboard #1 (most wickets, then economy, then
 *   name, team and key: `bowlingLeaders`).
 * - Player of the Series: highest `potm × 25 + runs + wickets × 20`, where
 *   potm is the player's Player of the Match count. Ties: more potm, then
 *   more runs, then name, team id and key (plain code-point order).
 *
 * Players are identified by team registration id + key (upper-cased player
 * id or `guest:<name>`), like the leaderboards. An award with no candidate
 * (no player stats; for Player of the Series also no Player of the Match) is
 * left out.
 */

import { BattingLeader, BowlingLeader, PlayerStats, battingLeaders, bowlingLeaders } from "./cricketPlayerStats";

export const POTS_POTM_POINTS = 25;
export const POTS_WICKET_POINTS = 20;

/** One Player of the Match award (finished match). */
export interface PotmAward {
  key: string;
  name: string;
  teamId: string;
}

export interface PlayerOfSeriesPick {
  key: string;
  name: string;
  teamId: string;
  potm: number;
  runs: number;
  wickets: number;
  score: number;
}

export interface SeriesAwards {
  playerOfSeries?: PlayerOfSeriesPick;
  bestBatter?: BattingLeader;
  bestBowler?: BowlingLeader;
}

const normKey = (k: string) => (k.startsWith("guest:") ? k : k.toUpperCase());

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Player of the Series ranking (best first); see the file comment. */
export function playerOfSeriesRanking(stats: PlayerStats[], potm: PotmAward[]): PlayerOfSeriesPick[] {
  const map = new Map<string, PlayerOfSeriesPick>();
  const entry = (teamId: string, key: string, name: string) => {
    const k = normKey(key);
    const id = `${teamId}|${k}`;
    let e = map.get(id);
    if (!e) {
      e = { key: k, name, teamId, potm: 0, runs: 0, wickets: 0, score: 0 };
      map.set(id, e);
    }
    return e;
  };
  for (const b of battingLeaders(stats)) entry(b.teamRegistrationId, b.key, b.name).runs += b.runs;
  for (const b of bowlingLeaders(stats)) entry(b.teamRegistrationId, b.key, b.name).wickets += b.wickets;
  for (const p of potm) entry(p.teamId, p.key, p.name).potm += 1;
  for (const e of map.values()) e.score = e.potm * POTS_POTM_POINTS + e.runs + e.wickets * POTS_WICKET_POINTS;
  return [...map.values()].sort((a, b) =>
    b.score - a.score || b.potm - a.potm || b.runs - a.runs ||
    compareText(a.name, b.name) || compareText(a.teamId, b.teamId) || compareText(a.key, b.key));
}

/** The three awards from finished matches' player stats and Player of the Match picks. */
export function seriesAwards(stats: PlayerStats[], potm: PotmAward[]): SeriesAwards {
  const out: SeriesAwards = {};
  const pots = playerOfSeriesRanking(stats, potm)[0];
  if (pots) out.playerOfSeries = pots;
  const bat = battingLeaders(stats)[0];
  if (bat) out.bestBatter = bat;
  const bowl = bowlingLeaders(stats)[0];
  if (bowl) out.bestBowler = bowl;
  return out;
}
