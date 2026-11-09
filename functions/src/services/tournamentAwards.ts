import { DocumentData, Firestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { MatchDoc, parseSportType } from "../types";
import { PlayerStats, battingLeaders, bowlingLeaders, decodePlayerStats } from "./cricketPlayerStats";
import { PotmAward, seriesAwards } from "./cricketAwards";
import { DrawState, loadDrawState } from "./draw/tournament";
import { playerById } from "./identity";
import { notifyPlayer } from "./notifyPlayer";
import { guestKey, roleKey } from "./teamRoles";
import { finishIsFinal, isTournamentFinished } from "./tournamentProgress";

/*
 * Tournament awards (cricket only), stored on the tournament doc and written
 * only by the server (firestore.rules locks `awards` / `awardPlayerIds` /
 * `awardsNotified`):
 *
 *   awards: {
 *     playerOfSeries?: { key, name, teamId },
 *     bestBatter?:     { key, name, teamId, runs, balls, innings, notOuts, highest, highestNotOut },
 *     bestBowler?:     { key, name, teamId, wickets, runs, balls, innings },
 *     source: { playerOfSeries, bestBatter, bestBowler: "auto" | "organizer" },
 *     computedAt, updatedAt,
 *   }
 *   awardPlayerIds: registered player ids holding any award (no guests).
 *
 *   awardsNotified: { playerOfSeries, bestBatter, bestBowler: [player ids] }
 *     who has been sent `award_won` for which award (each at most once).
 *
 * `teamId` is the team's registration id; `key` a player id (upper case) or
 * `guest:<name>`, like `playerOfMatchKey`. Auto awards (services/cricketAwards.ts)
 * are refreshed on every match write once the tournament has finished
 * (triggers/onMatchWritten.ts); an award the organizer set or cleared
 * (setTournamentAwards) is never overwritten.
 */

export const AWARD_SLOTS = ["playerOfSeries", "bestBatter", "bestBowler"] as const;
export type AwardSlot = (typeof AWARD_SLOTS)[number];
export type AwardSource = "auto" | "organizer";

export const AWARD_TITLES: Record<AwardSlot, string> = {
  playerOfSeries: "Player of the Series",
  bestBatter: "Best Batter",
  bestBowler: "Best Bowler",
};

export interface AwardsDoc {
  playerOfSeries?: DocumentData;
  bestBatter?: DocumentData;
  bestBowler?: DocumentData;
  source: Record<AwardSlot, AwardSource>;
  computedAt: Timestamp;
  updatedAt: Timestamp;
}

/** Everything the awards are computed from, read in one go. */
export interface AwardContext {
  state: DrawState;
  isCricket: boolean;
  finished: boolean;
  stats: PlayerStats[];
  potm: PotmAward[];
}

export async function loadAwardContext(db: Firestore, tournamentId: string, tx?: Transaction): Promise<AwardContext | null> {
  const state = await loadDrawState(db, tournamentId, tx);
  if (!state) return null;
  const t = state.tournament;
  const docs = state.matches.map((m) => m.doc as MatchDoc & { groupLabel?: string });
  const done = docs.filter((m) => m.statusRaw === "finished");
  const potm: PotmAward[] = [];
  for (const m of done) {
    const { playerOfMatchKey: key, playerOfMatchName: name, playerOfMatchTeamId: teamId } = m;
    if (typeof key === "string" && key && typeof name === "string" && typeof teamId === "string" && teamId) {
      potm.push({ key, name, teamId });
    }
  }
  return {
    state,
    isCricket: parseSportType(t.doc.sportType) === "cricket",
    finished: t.doc.statusRaw !== "cancelled" && isTournamentFinished({
      matchFormat: t.matchFormat,
      swissRounds: t.config.swissRounds,
      advancingPerGroup: t.config.advancingPerGroup,
      formedTeamCount: state.formedTeams.length,
      matches: docs,
    }),
    stats: done.map((m) => decodePlayerStats(m.playerStatsData)).filter((s): s is PlayerStats => s !== null),
    potm,
  };
}

// ─── Award values ───────────────────────────────────────

function batterValue(key: string, name: string, teamId: string, ctx: AwardContext): DocumentData {
  const e = battingLeaders(ctx.stats).find((b) => b.key === key && b.teamRegistrationId === teamId);
  return {
    key, name, teamId,
    runs: e?.runs ?? 0, balls: e?.balls ?? 0, innings: e?.innings ?? 0, notOuts: e?.notOuts ?? 0,
    highest: e?.highest ?? 0, highestNotOut: e?.highestNotOut ?? false,
  };
}

function bowlerValue(key: string, name: string, teamId: string, ctx: AwardContext): DocumentData {
  const e = bowlingLeaders(ctx.stats).find((b) => b.key === key && b.teamRegistrationId === teamId);
  return { key, name, teamId, wickets: e?.wickets ?? 0, runs: e?.runs ?? 0, balls: e?.balls ?? 0, innings: e?.innings ?? 0 };
}

function slotValue(slot: AwardSlot, key: string, name: string, teamId: string, ctx: AwardContext): DocumentData {
  if (slot === "bestBatter") return batterValue(key, name, teamId, ctx);
  if (slot === "bestBowler") return bowlerValue(key, name, teamId, ctx);
  return { key, name, teamId };
}

/** Auto awards from the finished matches. */
export function autoAwards(ctx: AwardContext): Partial<Record<AwardSlot, DocumentData>> {
  const a = seriesAwards(ctx.stats, ctx.potm);
  const out: Partial<Record<AwardSlot, DocumentData>> = {};
  if (a.playerOfSeries) {
    const p = a.playerOfSeries;
    out.playerOfSeries = slotValue("playerOfSeries", p.key, p.name, p.teamId, ctx);
  }
  if (a.bestBatter) {
    const b = a.bestBatter;
    out.bestBatter = slotValue("bestBatter", b.key, b.name, b.teamRegistrationId, ctx);
  }
  if (a.bestBowler) {
    const b = a.bestBowler;
    out.bestBowler = slotValue("bestBowler", b.key, b.name, b.teamRegistrationId, ctx);
  }
  return out;
}

/** The team (registration id) and display name of a roster member, or null if `key` is on no roster. */
export function rosterMember(ctx: AwardContext, rawKey: string): { key: string; name: string; teamId: string } | null {
  const key = roleKey(rawKey.trim());
  for (const e of ctx.state.entries) {
    const rosterIds = Array.isArray(e.doc.rosterIds) ? e.doc.rosterIds : [];
    if (rosterIds.some((id) => roleKey(id) === key)) {
      const p = e.roster.find((r) => roleKey(r.id) === key);
      return { key, name: p?.name ?? "", teamId: e.docId };
    }
    const guestNames = Array.isArray(e.doc.guestNames) ? e.doc.guestNames : [];
    const guest = guestNames.find((g) => guestKey(g) === key);
    if (guest !== undefined) return { key, name: guest, teamId: e.docId };
  }
  return null;
}

/** An organizer's pick as stored (stats from the leaderboard, zeros if none). */
export function organizerValue(slot: AwardSlot, m: { key: string; name: string; teamId: string }, ctx: AwardContext): DocumentData {
  return slotValue(slot, m.key, m.name, m.teamId, ctx);
}

// ─── Merge + write ──────────────────────────────────────

/**
 * The new awards: organizer picks in `overrides` (null = cleared), earlier
 * organizer picks kept, everything else auto.
 */
export function mergeAwards(
  existing: DocumentData | undefined,
  auto: Partial<Record<AwardSlot, DocumentData>>,
  overrides: Partial<Record<AwardSlot, DocumentData | null>> = {},
): { slots: Partial<Record<AwardSlot, DocumentData>>; source: Record<AwardSlot, AwardSource> } {
  const slots: Partial<Record<AwardSlot, DocumentData>> = {};
  const source = {} as Record<AwardSlot, AwardSource>;
  for (const slot of AWARD_SLOTS) {
    if (slot in overrides) {
      source[slot] = "organizer";
      const v = overrides[slot];
      if (v) slots[slot] = v;
    } else if (existing?.source?.[slot] === "organizer") {
      source[slot] = "organizer";
      if (existing[slot]) slots[slot] = existing[slot];
    } else {
      source[slot] = "auto";
      if (auto[slot]) slots[slot] = auto[slot];
    }
  }
  return { slots, source };
}

/** Registered (non-guest) player ids holding any award, in slot order. */
export function awardPlayerIdsOf(slots: Partial<Record<AwardSlot, DocumentData>>): string[] {
  const out: string[] = [];
  for (const slot of AWARD_SLOTS) {
    const key = slots[slot]?.key;
    if (typeof key === "string" && key && !key.startsWith("guest:") && !out.includes(key.toUpperCase())) {
      out.push(key.toUpperCase());
    }
  }
  return out;
}

function sameAwards(existing: DocumentData | undefined, next: ReturnType<typeof mergeAwards>): boolean {
  if (!existing) return false;
  const strip = (o: DocumentData | undefined) => JSON.stringify(o ?? null, Object.keys(o ?? {}).sort());
  for (const slot of AWARD_SLOTS) {
    if (existing.source?.[slot] !== next.source[slot]) return false;
    if (strip(existing[slot]) !== strip(next.slots[slot])) return false;
  }
  return true;
}

/** Award slots each registered player has been told about: `awardsNotified` (server-only). */
export type AwardsNotified = Record<AwardSlot, string[]>;

function notifiedOf(doc: DocumentData): AwardsNotified {
  const raw = doc.awardsNotified as DocumentData | undefined;
  const out = {} as AwardsNotified;
  for (const slot of AWARD_SLOTS) {
    const list = raw?.[slot];
    out[slot] = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase()) : [];
  }
  return out;
}

/** One `award_won` notification: a registered player and the awards it announces. */
export interface AwardNotice {
  playerId: string;
  slots: AwardSlot[];
}

/**
 * Notices owed for `slots`: each registered (non-guest) holder not yet told
 * about that award in this tournament. A player is told about a given award
 * at most once (moving it away and back, or clearing and resetting it, tells
 * no one again); a different award is told once too. Returns the notices
 * (one per player, slot order) and the updated `awardsNotified`.
 */
export function dueNotices(
  held: Partial<Record<AwardSlot, DocumentData>>,
  notified: AwardsNotified,
  slots: readonly AwardSlot[],
): { notices: AwardNotice[]; notified: AwardsNotified } {
  const next = {} as AwardsNotified;
  for (const slot of AWARD_SLOTS) next[slot] = [...notified[slot]];
  const notices: AwardNotice[] = [];
  for (const slot of AWARD_SLOTS) {
    if (!slots.includes(slot)) continue;
    const key = held[slot]?.key;
    if (typeof key !== "string" || !key || key.startsWith("guest:")) continue;
    const id = key.toUpperCase();
    if (next[slot].includes(id)) continue;
    next[slot].push(id);
    const n = notices.find((x) => x.playerId === id);
    if (n) n.slots.push(slot);
    else notices.push({ playerId: id, slots: [slot] });
  }
  return { notices, notified: next };
}

export interface AwardsWrite {
  /** Null when the awards didn't change. */
  awards: AwardsDoc | null;
  /** Notifications to send once the transaction has committed. */
  notices: AwardNotice[];
}

/**
 * Writes merged awards in `tx` if they changed, and records (in
 * `awardsNotified`) the notices owed for `notifySlots`, which the caller
 * sends after the commit.
 */
export function writeAwards(
  tx: Transaction,
  ctx: AwardContext,
  overrides: Partial<Record<AwardSlot, DocumentData | null>> = {},
  notifySlots: readonly AwardSlot[] = AWARD_SLOTS,
): AwardsWrite {
  const doc = ctx.state.tournament.doc as unknown as DocumentData;
  const existing = doc.awards as DocumentData | undefined;
  const next = mergeAwards(existing, autoAwards(ctx), overrides);
  const changed = !sameAwards(existing, next);
  const due = dueNotices(next.slots, notifiedOf(doc), notifySlots);
  const update: DocumentData = {};
  let awards: AwardsDoc | null = null;
  if (changed) {
    const now = Timestamp.now();
    awards = { ...next.slots, source: next.source, computedAt: now, updatedAt: now };
    update.awards = awards;
    update.awardPlayerIds = awardPlayerIdsOf(next.slots);
  }
  if (due.notices.length > 0) update.awardsNotified = due.notified;
  if (Object.keys(update).length > 0) tx.update(ctx.state.tournamentRef, update);
  return { awards, notices: due.notices };
}

/** `award_won` to each player in `notices` (one per player, listing the awards). */
export async function notifyWinners(
  db: Firestore,
  tournamentId: string,
  title: string,
  notices: AwardNotice[],
): Promise<void> {
  const name = title ? `"${title}"` : "the tournament";
  for (const n of notices) {
    const held = n.slots.map((s) => AWARD_TITLES[s]);
    if (held.length === 0) continue;
    const list = held.length === 1 ? held[0] : `${held.slice(0, -1).join(", ")} and ${held[held.length - 1]}`;
    const player = await playerById(db, n.playerId);
    await notifyPlayer(db, player?.data, {
      type: "award_won",
      title: "You won an award",
      body: `${list} in ${name}`,
      data: { tournamentId },
    });
  }
}

/**
 * Refreshes the auto awards of a finished cricket tournament (match trigger).
 * No-op for other sports, unfinished tournaments, or when nothing changed.
 * Manual Draw tournaments get awards for display but no notifications (their
 * "finished" is provisional: tournamentProgress.ts `finishIsFinal`).
 */
export async function refreshAutoAwards(db: Firestore, tournamentId: string): Promise<void> {
  const result = await db.runTransaction(async (tx) => {
    const ctx = await loadAwardContext(db, tournamentId, tx);
    if (!ctx || !ctx.isCricket || !ctx.finished) return null;
    const notify = finishIsFinal(ctx.state.tournament.matchFormat) ? AWARD_SLOTS : [];
    const w = writeAwards(tx, ctx, {}, notify);
    return { w, title: ctx.state.tournament.doc.title, id: ctx.state.tournament.id };
  });
  if (!result) return;
  if (result.w.awards) logger.info(`Awards refreshed for ${tournamentId}: ${JSON.stringify(result.w.awards.source)}`);
  await notifyWinners(db, result.id, result.title, result.w.notices);
}
