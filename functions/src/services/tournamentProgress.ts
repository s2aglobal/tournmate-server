/**
 * Whether a tournament has finished. Tournaments have no stored "finished"
 * status (`statusRaw` is only "scheduled" / "cancelled", and older apps can't
 * decode anything else), so like the apps (iOS
 * `TournamentDetailViewModel.isTournamentActuallyComplete`) it is derived
 * from the matches:
 * - Round Robin, Manual Draw: every match finished;
 * - Single / Double Elimination: the last bracket round
 *   (⌈log2(formed teams)⌉) is finished;
 * - Group + Knockout: knockout matches exist and their last round
 *   (⌈log2(qualifiers)⌉, qualifiers = Σ min(advancing, group size)) is finished;
 * - Swiss: the configured number of rounds is played and the last is finished.
 * No matches (no draw) = not finished.
 */

import { MatchDoc } from "../types";

export interface ProgressInput {
  matchFormat: string;
  swissRounds: number;
  advancingPerGroup: number;
  formedTeamCount: number;
  matches: Array<MatchDoc & { groupLabel?: string | null }>;
}

function roundsFor(teams: number): number {
  let rounds = 0;
  for (let v = 1; v < teams; v *= 2) rounds++;
  return rounds;
}

const isGroup = (m: { groupLabel?: string | null }) => typeof m.groupLabel === "string";
const finished = (m: MatchDoc) => m.statusRaw === "finished";

function lastRoundDone(matches: MatchDoc[], needRounds: number): boolean {
  if (matches.length === 0 || needRounds < 1) return false;
  const last = Math.max(...matches.map((m) => (typeof m.round === "number" ? m.round : 0)));
  if (last < needRounds) return false;
  const inLast = matches.filter((m) => (typeof m.round === "number" ? m.round : 0) === last);
  return inLast.length > 0 && inLast.every(finished);
}

export function isTournamentFinished(p: ProgressInput): boolean {
  const { matches } = p;
  if (matches.length === 0) return false;
  switch (p.matchFormat) {
  case "roundRobin":
  case "manualDraw":
    return matches.every(finished);
  case "swiss":
    return lastRoundDone(matches, Math.max(1, p.swissRounds));
  case "groupKnockout": {
    const ko = matches.filter((m) => !isGroup(m));
    if (ko.length === 0) return false;
    const groups = new Map<string, Set<string>>();
    for (const m of matches.filter(isGroup)) {
      const set = groups.get(m.groupLabel as string) ?? new Set<string>();
      set.add(m.teamAId.toUpperCase());
      set.add(m.teamBId.toUpperCase());
      groups.set(m.groupLabel as string, set);
    }
    const adv = Math.max(1, p.advancingPerGroup);
    let qualifiers = [...groups.values()].reduce((s, g) => s + Math.min(adv, g.size), 0);
    if (qualifiers < 2) qualifiers = ko.filter((m) => m.round === 1).length * 2;
    return lastRoundDone(ko, roundsFor(qualifiers));
  }
  default: {
    // Single elimination; double elimination plays as single elimination.
    let teams = p.formedTeamCount;
    if (teams < 2) teams = matches.filter((m) => m.round === 1).length * 2;
    return lastRoundDone(matches, roundsFor(teams));
  }
  }
}
