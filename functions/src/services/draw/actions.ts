/**
 * Draw actions shared by the callables (callables/draw.ts) and the scheduled
 * auto draw (triggers/autoDrawJob.ts). Each runs in one transaction and
 * writes matches in exactly the shape the apps write them today
 * (iOS FirestoreMatchRepository.encode / Android Match.toFirestoreMap), so
 * app versions that predate server authority read them unchanged.
 */

import { randomUUID } from "crypto";
import { Firestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { fail } from "../../callables/errors";
import { MatchDoc } from "../../types";
import {
  generateBracketFirstRound,
  generateGroupStageSchedule,
  generateMixedDoublesPairs,
  generateRandomDoublesPairs,
  generateRoundRobinSchedule,
  generateSwissPairings,
  knockoutByeTeams,
  knockoutSeedingFromGroups,
  nextRoundPairs,
  seeded,
} from "./pairing";
import {
  DrawState,
  Entry,
  TournamentInfo,
  groupTables,
  hasScore,
  loadDrawState,
  matchWinnerId,
  registrationDeadline,
  toSwissMatch,
} from "./tournament";

/** Who is acting: an organizer (auth uid) or the scheduled job. */
export type Actor = { uid: string } | { system: true };

export interface DrawResult {
  /** "generated" | "advanced" | "complete" | "reset" | "paired" */
  status: string;
  matchesCreated: number;
  round?: number;
  byes?: number;
  message: string;
}

// ─── Match docs ─────────────────────────────────────────

/** Fields of a new match, exactly as the apps write them. */
export interface NewMatchFields {
  round?: number;
  bracketPosition?: number;
  groupLabel?: string;
}

/**
 * New match doc: `tournamentId`, `teamAId`, `teamBId` upper-case (the apps
 * write `UUID.uuidString`), `statusRaw` "scheduled", `createdAt` Timestamp,
 * optional `round` / `bracketPosition` / `groupLabel`, `sportType` = the
 * tournament's stored sport id ("badminton" when missing). Doc id: upper-case UUID.
 */
export function newMatchDoc(t: TournamentInfo, a: Entry, b: Entry, f: NewMatchFields, createdAt: Timestamp)
  : Record<string, unknown> {
  const data: Record<string, unknown> = {
    tournamentId: t.id.toUpperCase(),
    teamAId: a.docId.toUpperCase(),
    teamBId: b.docId.toUpperCase(),
    statusRaw: "scheduled",
    createdAt,
  };
  if (f.round !== undefined) data.round = f.round;
  if (f.bracketPosition !== undefined) data.bracketPosition = f.bracketPosition;
  if (f.groupLabel !== undefined) data.groupLabel = f.groupLabel;
  data.sportType = t.sportRaw;
  return data;
}

function writeMatches(
  db: Firestore,
  tx: Transaction,
  t: TournamentInfo,
  list: Array<{ a: Entry; b: Entry; f: NewMatchFields }>,
): void {
  const base = Date.now();
  list.forEach(({ a, b, f }, i) => {
    // createdAt one millisecond apart keeps the generation order readable.
    tx.set(db.collection("matches").doc(randomUUID().toUpperCase()), newMatchDoc(t, a, b, f, Timestamp.fromMillis(base + i)));
  });
}

// ─── Guards ─────────────────────────────────────────────

async function resolveTournamentRef(db: Firestore, tournamentId: unknown): Promise<string> {
  if (typeof tournamentId !== "string" || tournamentId.trim() === "" || tournamentId.includes("/")) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Missing tournament.");
  }
  const id = tournamentId.trim();
  for (const candidate of [...new Set([id, id.toUpperCase(), id.toLowerCase()])]) {
    if ((await db.collection("tournaments").doc(candidate).get()).exists) return candidate;
  }
  fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
}

function load(state: DrawState | null): DrawState {
  if (!state) fail("not-found", "NOT_FOUND", "This tournament no longer exists.");
  return state;
}

function requireOrganizer(state: DrawState, actor: Actor): void {
  if ("system" in actor) return;
  if (!state.tournament.doc.createdBy || state.tournament.doc.createdBy !== actor.uid) {
    fail("permission-denied", "NOT_ORGANIZER", "Only the organizer can manage the draw.");
  }
}

function requireActive(state: DrawState): void {
  if (state.tournament.doc.statusRaw === "cancelled") {
    fail("failed-precondition", "INVALID_ARGUMENT", "This tournament has been cancelled.");
  }
}

/** Marks the tournament so the scheduled auto draw leaves it alone for this deadline. */
function markAutoDraw(tx: Transaction, state: DrawState, status: string): void {
  tx.update(state.tournamentRef, {
    autoDraw: {
      deadline: Timestamp.fromDate(registrationDeadline(state.tournament.doc)),
      status,
      at: Timestamp.now(),
    },
  });
}

function seeding(state: DrawState, teams: Entry[]): Entry[] {
  return seeded(teams, state.tournament.config.seedingMode, state.tournament.id);
}

// ─── generateDraw ───────────────────────────────────────

/** Minimum formed teams for the tournament's format. */
export function minimumTeams(t: TournamentInfo): number {
  return t.matchFormat === "groupKnockout" ? 4 : 2;
}

export async function generateDrawAction(db: Firestore, actor: Actor, tournamentId: unknown): Promise<DrawResult> {
  const tid = await resolveTournamentRef(db, tournamentId);
  return db.runTransaction(async (tx) => {
    const state = load(await loadDrawState(db, tid, tx));
    requireOrganizer(state, actor);
    requireActive(state);
    const t = state.tournament;
    if (state.matches.length > 0) {
      fail("already-exists", "DRAW_EXISTS", "The draw has already been generated.");
    }
    if (t.matchFormat === "manualDraw") {
      fail("failed-precondition", "INVALID_ARGUMENT", "This tournament uses a manual draw: create the matches yourself.");
    }
    const teams = state.formedTeams;
    const min = minimumTeams(t);
    if (teams.length < min) {
      fail("failed-precondition", "TOO_FEW_ENTRIES", t.matchFormat === "groupKnockout"
        ? "Need at least 4 teams for Group + Knockout."
        : "Need at least 2 complete teams to generate the draw.");
    }

    const list: Array<{ a: Entry; b: Entry; f: NewMatchFields }> = [];
    let message: string;
    let byes = 0;
    switch (t.matchFormat) {
    case "roundRobin": {
      const schedule = generateRoundRobinSchedule(teams, t.config.doubleRoundRobin);
      for (const e of schedule) list.push({ a: e.teamA, b: e.teamB, f: { round: e.round } });
      message = `Generated ${schedule.length} round-robin matches across ${schedule[schedule.length - 1]?.round ?? 0} rounds!`;
      break;
    }
    case "groupKnockout": {
      const schedule = generateGroupStageSchedule(teams, Math.max(2, t.config.groupCount),
        Math.max(1, t.config.advancingPerGroup));
      for (const e of schedule) list.push({ a: e.teamA, b: e.teamB, f: { round: e.round, groupLabel: e.group } });
      message = `Generated ${schedule.length} group-stage matches across ${new Set(schedule.map((e) => e.group)).size} groups!`;
      break;
    }
    case "swiss": {
      const pairs = generateSwissPairings(teams, [], 1);
      if (pairs.length === 0) {
        fail("failed-precondition", "TOO_FEW_ENTRIES", "Could not generate pairings (all possible matchups exhausted).");
      }
      for (const p of pairs) list.push({ a: p.teamA, b: p.teamB, f: { round: 1 } });
      message = `Swiss Round 1 generated with ${pairs.length} matches!`;
      break;
    }
    default: {
      // Single elimination; double elimination plays as single elimination.
      const first = generateBracketFirstRound(seeding(state, teams));
      for (const m of first.matches) list.push({ a: m.teamA, b: m.teamB, f: { round: 1, bracketPosition: m.bracketPosition } });
      byes = first.byeTeams.length;
      message = `Bracket generated! ${first.matches.length} first-round matches.` +
        (byes > 0 ? ` ${byes} team(s) received a bye.` : "");
    }
    }
    writeMatches(db, tx, t, list);
    markAutoDraw(tx, state, "generated");
    return { status: "generated", matchesCreated: list.length, round: 1, byes, message };
  });
}

// ─── advanceRound ───────────────────────────────────────

export async function advanceRoundAction(db: Firestore, actor: Actor, tournamentId: unknown): Promise<DrawResult> {
  const tid = await resolveTournamentRef(db, tournamentId);
  return db.runTransaction(async (tx) => {
    const state = load(await loadDrawState(db, tid, tx));
    requireOrganizer(state, actor);
    requireActive(state);
    const t = state.tournament;
    if (state.matches.length === 0) {
      fail("failed-precondition", "INVALID_ARGUMENT", "Generate the draw first.");
    }
    switch (t.matchFormat) {
    case "singleElimination":
    case "doubleElimination":
      return advanceKnockout(db, tx, state, () => seeding(state, state.formedTeams));
    case "groupKnockout":
      return advanceGroupKnockout(db, tx, state);
    case "swiss":
      return advanceSwiss(db, tx, state);
    default:
      fail("failed-precondition", "INVALID_ARGUMENT", "This format has no next round to generate.");
    }
  });
}

type StoredMatch = MatchDoc & { groupLabel?: string };

function knockoutMatches(state: DrawState): StoredMatch[] {
  return state.matches.map((m) => m.doc as StoredMatch).filter((m) => typeof m.groupLabel !== "string");
}

function entryLookup(state: DrawState): (id: string) => Entry | undefined {
  const map = new Map(state.entries.map((e) => [e.docId.toUpperCase(), e]));
  return (id) => map.get(id.toUpperCase());
}

function qualifiedKnockoutTeams(state: DrawState): Entry[] {
  return knockoutSeedingFromGroups(groupTables(state), Math.max(1, state.tournament.config.advancingPerGroup));
}

function advanceKnockout(db: Firestore, tx: Transaction, state: DrawState, seededTeams: () => Entry[]): DrawResult {
  const ko = knockoutMatches(state);
  if (ko.length === 0) fail("failed-precondition", "INVALID_ARGUMENT", "Generate the draw first.");
  const currentRound = Math.max(...ko.map((m) => m.round ?? 0));
  const last = ko.filter((m) => (m.round ?? 0) === currentRound)
    .sort((a, b) => (a.bracketPosition ?? 0) - (b.bracketPosition ?? 0));
  if (!last.every((m) => m.statusRaw === "finished")) {
    fail("failed-precondition", "INVALID_ARGUMENT", "Not all matches in the current round are finished yet.");
  }
  const find = entryLookup(state);
  let winners: Entry[] = [];
  for (const m of last) {
    const w = matchWinnerId(m);
    const entry = w ? find(w) : undefined;
    if (!entry) {
      fail("failed-precondition", "INVALID_ARGUMENT",
        `Every match in round ${currentRound} needs a winner before the next round.`);
    }
    winners.push(entry);
  }
  if (currentRound === 1) {
    // Byes: the seeded teams that didn't play round 1 (never re-seeded on new ratings).
    const roundOne = last.flatMap((m) => [m.teamAId, m.teamBId]);
    winners = knockoutByeTeams(seededTeams(), roundOne).concat(winners);
  }
  if (winners.length < 2) {
    return { status: "complete", matchesCreated: 0, message: "Tournament complete! 🏆" };
  }
  const nextRound = currentRound + 1;
  const pairs = nextRoundPairs(winners);
  writeMatches(db, tx, state.tournament, pairs.map((p, i) => ({ a: p.teamA, b: p.teamB, f: { round: nextRound, bracketPosition: i } })));
  return {
    status: "advanced", matchesCreated: pairs.length, round: nextRound,
    message: winners.length % 2 !== 0
      ? `Round ${nextRound} generated! 1 team received a bye.`
      : `Round ${nextRound} matches generated!`,
  };
}

function advanceGroupKnockout(db: Firestore, tx: Transaction, state: DrawState): DrawResult {
  if (knockoutMatches(state).length > 0) {
    return advanceKnockout(db, tx, state, () => qualifiedKnockoutTeams(state));
  }
  const groupMatches = state.matches.filter((m) => typeof (m.doc as StoredMatch).groupLabel === "string");
  if (groupMatches.length === 0 || !groupMatches.every((m) => m.doc.statusRaw === "finished")) {
    fail("failed-precondition", "INVALID_ARGUMENT", "Group stage is not complete yet.");
  }
  const qualified = qualifiedKnockoutTeams(state);
  if (qualified.length < 2) {
    fail("failed-precondition", "TOO_FEW_ENTRIES", "Not enough teams to form a knockout bracket.");
  }
  // Seeded by group finish (not re-sorted by rating), so group partners don't meet again in round 1.
  const first = generateBracketFirstRound(qualified);
  writeMatches(db, tx, state.tournament,
    first.matches.map((m) => ({ a: m.teamA, b: m.teamB, f: { round: 1, bracketPosition: m.bracketPosition } })));
  return {
    status: "advanced", matchesCreated: first.matches.length, round: 1, byes: first.byeTeams.length,
    message: `Knockout bracket generated with ${qualified.length} teams!`,
  };
}

function advanceSwiss(db: Firestore, tx: Transaction, state: DrawState): DrawResult {
  const matches = state.matches.map((m) => m.doc);
  const current = Math.max(0, ...matches.map((m) => (typeof m.round === "number" ? m.round : 0)));
  const roundMatches = matches.filter((m) => m.round === current);
  if (current > 0 && !(roundMatches.length > 0 && roundMatches.every((m) => m.statusRaw === "finished"))) {
    fail("failed-precondition", "INVALID_ARGUMENT", "Current round is not complete yet.");
  }
  const nextRound = current + 1;
  const maxRounds = state.tournament.config.swissRounds;
  if (nextRound > maxRounds) {
    fail("failed-precondition", "INVALID_ARGUMENT", `All ${maxRounds} Swiss rounds have been completed.`);
  }
  const finished = matches.filter((m) => m.statusRaw === "finished").map(toSwissMatch);
  const pairs = generateSwissPairings(state.formedTeams, finished, nextRound);
  if (pairs.length === 0) {
    fail("failed-precondition", "INVALID_ARGUMENT", "Could not generate pairings (all possible matchups exhausted).");
  }
  writeMatches(db, tx, state.tournament, pairs.map((p) => ({ a: p.teamA, b: p.teamB, f: { round: nextRound } })));
  return {
    status: "advanced", matchesCreated: pairs.length, round: nextRound,
    message: `Swiss Round ${nextRound} generated with ${pairs.length} matches!`,
  };
}

// ─── resetDraw ──────────────────────────────────────────

export async function resetDrawAction(db: Firestore, actor: Actor, tournamentId: unknown): Promise<DrawResult> {
  const tid = await resolveTournamentRef(db, tournamentId);
  return db.runTransaction(async (tx) => {
    const state = load(await loadDrawState(db, tid, tx));
    requireOrganizer(state, actor);
    if (state.matches.some((m) => hasScore(m.doc))) {
      fail("failed-precondition", "DRAW_LOCKED", "Scores have been entered, so the draw can't be reset.");
    }
    for (const m of state.matches) tx.delete(m.ref);
    return {
      status: "reset", matchesCreated: 0,
      message: "All matches cleared. You can regenerate the bracket.",
    };
  });
}

// ─── createManualMatches ────────────────────────────────

/**
 * Manual draw: the organizer adds matches (the apps' "Create match": one
 * match with a round, no bracket position). Both registrations must belong
 * to the tournament; a team can't play itself. Matches may be added while
 * earlier rounds are being played, like the apps allow.
 */
export async function createManualMatchesAction(db: Firestore, actor: Actor, data: unknown): Promise<DrawResult> {
  const input = (data ?? {}) as { tournamentId?: unknown; pairs?: unknown };
  const tid = await resolveTournamentRef(db, input.tournamentId);
  if (!Array.isArray(input.pairs) || input.pairs.length === 0 || input.pairs.length > 200) {
    fail("invalid-argument", "INVALID_ARGUMENT", "Pick two teams for each match.");
  }
  const pairs = input.pairs.map((p) => {
    const x = (p ?? {}) as { teamAId?: unknown; teamBId?: unknown; round?: unknown };
    if (typeof x.teamAId !== "string" || typeof x.teamBId !== "string") {
      fail("invalid-argument", "INVALID_ARGUMENT", "Pick two teams for each match.");
    }
    const round = x.round === undefined || x.round === null ? 1 : x.round;
    if (typeof round !== "number" || !Number.isInteger(round) || round < 1 || round > 100) {
      fail("invalid-argument", "INVALID_ARGUMENT", "Round must be a whole number from 1.");
    }
    return { teamAId: x.teamAId, teamBId: x.teamBId, round };
  });
  return db.runTransaction(async (tx) => {
    const state = load(await loadDrawState(db, tid, tx));
    requireOrganizer(state, actor);
    requireActive(state);
    if (state.tournament.matchFormat !== "manualDraw") {
      fail("failed-precondition", "INVALID_ARGUMENT", "Matches can only be added by hand in a manual draw.");
    }
    const find = entryLookup(state);
    const list = pairs.map((p) => {
      const a = find(p.teamAId);
      const b = find(p.teamBId);
      if (!a || !b) fail("not-found", "NOT_FOUND", "That team isn't registered for this tournament.");
      if (a.docId.toUpperCase() === b.docId.toUpperCase()) {
        fail("invalid-argument", "INVALID_ARGUMENT", "Pick two different teams.");
      }
      return { a, b, f: { round: p.round } };
    });
    writeMatches(db, tx, state.tournament, list);
    return {
      status: "created", matchesCreated: list.length,
      message: list.length === 1 ? "Match created!" : `${list.length} matches created!`,
    };
  });
}

// ─── generateRandomPairs ────────────────────────────────

export interface PairingResult extends DrawResult {
  pairs: number;
  /** Solo registrations still without a partner. */
  leftover: number;
  /** Those leftover registrations (for notifications). */
  leftoverEntries: Entry[];
}

export async function generateRandomPairsAction(
  db: Firestore,
  actor: Actor,
  tournamentId: unknown,
  random?: () => number,
): Promise<PairingResult> {
  const tid = await resolveTournamentRef(db, tournamentId);
  return db.runTransaction(async (tx) => {
    const state = load(await loadDrawState(db, tid, tx));
    requireOrganizer(state, actor);
    requireActive(state);
    const t = state.tournament;
    if (!t.isDoubles || t.isTeamEvent) {
      fail("failed-precondition", "INVALID_ARGUMENT", "Random pairing is only available for doubles events.");
    }
    if (state.matches.length > 0) {
      fail("already-exists", "DRAW_EXISTS", "The draw has already been generated.");
    }
    const solo = state.entries.filter((e) => e.partner === null);
    const merges: Array<{ keep: Entry; drop: Entry }> = [];
    if (t.formatRaw === "mixedDoubles") {
      const withGender = solo.map((e) => Object.assign(e, { gender: e.player.genderRaw }));
      for (const p of generateMixedDoublesPairs(withGender, random)) merges.push({ keep: p.male, drop: p.female });
      if (merges.length === 0) {
        const male = withGender.filter((e) => e.gender === "male").length;
        const female = withGender.filter((e) => e.gender === "female").length;
        fail("failed-precondition", "TOO_FEW_ENTRIES",
          `Need at least 1 male and 1 female player. Currently: ${male} male, ${female} female. ` +
          "Players who selected 'Skip' for gender cannot be auto-paired in mixed doubles.");
      }
    } else {
      for (const p of generateRandomDoublesPairs(solo, random)) merges.push({ keep: p.playerA, drop: p.playerB });
      if (merges.length === 0) fail("failed-precondition", "TOO_FEW_ENTRIES", "Not enough solo players to pair.");
    }
    for (const { keep, drop } of merges) {
      tx.update(keep.ref, { partnerId: drop.player.id.toUpperCase() });
      tx.delete(drop.ref);
    }
    const paired = new Set(merges.flatMap((m) => [m.keep.docId, m.drop.docId]));
    const leftoverEntries = solo.filter((e) => !paired.has(e.docId));
    const n = merges.length;
    const leftover = leftoverEntries.length;
    return {
      status: "paired", matchesCreated: 0, pairs: n, leftover, leftoverEntries,
      message: leftover > 0
        ? `Paired ${n} teams. ${leftover} player(s) still need a partner.`
        : t.formatRaw === "mixedDoubles" ? `Successfully paired ${n} mixed doubles teams!` : `Successfully paired ${n} teams!`,
    };
  });
}

/** Legacy tournaments without `randomPairing`: mixed doubles always paired randomly. */
export function usesRandomPairing(t: TournamentInfo): boolean {
  return typeof t.doc.randomPairing === "boolean" ? t.doc.randomPairing : t.formatRaw === "mixedDoubles";
}
