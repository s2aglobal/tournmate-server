import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { Firestore, Timestamp, getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { TournamentDoc } from "../types";
import {
  Actor,
  generateDrawAction,
  generateRandomPairsAction,
  minimumTeams,
  usesRandomPairing,
} from "../services/draw/actions";
import { notifyUids } from "../services/draw/notify";
import { Entry, loadDrawState, registrationDeadline, tournamentInfo } from "../services/draw/tournament";

/** Only deadlines this recent are drawn automatically (older ones are the organizer's call). */
const LOOKBACK_MS = 48 * 3600_000;
/** Reminder window: deadline between 1 h and 24 h from now. */
const REMINDER_MIN_MS = 3600_000;
const REMINDER_MAX_MS = 24 * 3600_000;

const SYSTEM: Actor = { system: true };

type AutoDrawMark = { deadline?: Timestamp; status?: string };

function sameInstant(a: Timestamp | undefined, b: Date): boolean {
  return a instanceof Timestamp && a.toMillis() === b.getTime();
}

/** Auth uids of everyone on these entries. */
function uidsOf(entries: Entry[]): string[] {
  return entries.flatMap((e) => [e.player, e.partner, ...e.roster])
    .map((p) => p?.firebaseUid)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
}

/**
 * Every 15 minutes:
 * - Registration closed (deadline in the last 48 h), tournament scheduled and
 *   not yet handled for this deadline, no matches: random pairing (doubles
 *   with random pairing), then the draw. Organizer and players are notified.
 *   Fewer entries than the format needs: no draw, the organizer is asked to
 *   extend the deadline or cancel. Players left without a partner are told.
 * - Deadline 1–24 h away: one reminder to the organizer.
 * Handled tournaments get `autoDraw: { deadline, status, at }` /
 * `deadlineReminderFor`, so an extended deadline is handled again.
 */
export const autoDrawJob = onSchedule({ schedule: "every 15 minutes", region: "us-central1", timeoutSeconds: 540 },
  async () => {
    const db = getFirestore();
    await runAutoDraw(db, new Date());
  });

export async function runAutoDraw(db: Firestore, now: Date): Promise<void> {
  const closed = await db.collection("tournaments")
    .where("registrationDeadline", "<=", Timestamp.fromDate(now))
    .where("registrationDeadline", ">=", Timestamp.fromMillis(now.getTime() - LOOKBACK_MS))
    .get();
  for (const doc of closed.docs) {
    const t = doc.data() as TournamentDoc & { autoDraw?: AutoDrawMark };
    if (t.statusRaw !== "scheduled") continue;
    if (sameInstant(t.autoDraw?.deadline, registrationDeadline(t))) continue;
    try {
      await autoDrawTournament(db, doc.id);
    } catch (err) {
      logger.error(`autoDrawJob: tournament ${doc.id} failed`, err);
    }
  }

  const soon = await db.collection("tournaments")
    .where("registrationDeadline", ">", Timestamp.fromMillis(now.getTime() + REMINDER_MIN_MS))
    .where("registrationDeadline", "<=", Timestamp.fromMillis(now.getTime() + REMINDER_MAX_MS))
    .get();
  for (const doc of soon.docs) {
    const t = doc.data() as TournamentDoc & { deadlineReminderFor?: Timestamp };
    if (t.statusRaw !== "scheduled" || !t.createdBy) continue;
    if (sameInstant(t.deadlineReminderFor, registrationDeadline(t))) continue;
    try {
      await remindOrganizer(db, doc.id);
    } catch (err) {
      logger.error(`autoDrawJob: reminder for ${doc.id} failed`, err);
    }
  }
}

async function mark(db: Firestore, tournamentId: string, deadline: Date, status: string): Promise<void> {
  await db.collection("tournaments").doc(tournamentId).update({
    autoDraw: { deadline: Timestamp.fromDate(deadline), status, at: Timestamp.now() },
  });
}

export async function autoDrawTournament(db: Firestore, tournamentId: string): Promise<string> {
  let state = await loadDrawState(db, tournamentId);
  if (!state) return "missing";
  const deadline = registrationDeadline(state.tournament.doc);
  const title = state.tournament.doc.title ?? "your tournament";
  const organizer = state.tournament.doc.createdBy ? [state.tournament.doc.createdBy] : [];
  if (state.matches.length > 0) {
    await mark(db, tournamentId, deadline, "exists");
    return "exists";
  }

  // 1. Random pairing.
  const t = state.tournament;
  let unpaired: Entry[] = [];
  if (t.isDoubles && !t.isTeamEvent && usesRandomPairing(t) && state.entries.some((e) => e.partner === null)) {
    try {
      await generateRandomPairsAction(db, SYSTEM, tournamentId);
    } catch (err) {
      if (!(err instanceof HttpsError)) throw err;
      logger.info(`autoDrawJob: ${tournamentId} pairing skipped: ${err.message}`);
    }
    state = await loadDrawState(db, tournamentId);
    if (!state) return "missing";
  }
  if (state.tournament.isDoubles && !state.tournament.isTeamEvent) {
    unpaired = state.entries.filter((e) => e.partner === null);
  }

  // 2. Draw.
  let status: string;
  const teams = state.formedTeams.length;
  const tid = state.tournament.id.toUpperCase();
  if (state.tournament.matchFormat === "manualDraw") {
    status = "manual";
    await mark(db, tournamentId, deadline, status);
    await notifyUids(db, organizer, {
      type: "draw_manual", tournamentId: tid, title: "Registration closed",
      body: `Registration for ${title} has closed with ${teams} entries. Create the matches for your manual draw.`,
    });
  } else if (teams < minimumTeams(state.tournament)) {
    status = "tooFew";
    await mark(db, tournamentId, deadline, status);
    await notifyUids(db, organizer, {
      type: "draw_too_few", tournamentId: tid, title: "Not enough entries for a draw",
      body: `${title} has ${teams} complete ${teams === 1 ? "entry" : "entries"}, fewer than the ` +
        `${minimumTeams(state.tournament)} needed. Extend the registration deadline or cancel the tournament.`,
    });
  } else {
    try {
      await generateDrawAction(db, SYSTEM, tournamentId);
    } catch (err) {
      if (!(err instanceof HttpsError)) throw err;
      await mark(db, tournamentId, deadline, "failed");
      await notifyUids(db, organizer, {
        type: "draw_failed", tournamentId: tid, title: "Couldn't generate the draw",
        body: `${title}: ${err.message}`,
      });
      return "failed";
    }
    status = "generated";
    await notifyUids(db, organizer, {
      type: "draw_generated", tournamentId: tid, title: "The draw is out 🎉",
      body: `Registration for ${title} has closed and the draw was generated with ${teams} entries.`,
    });
    await notifyUids(db, uidsOf(state.formedTeams), {
      type: "draw_generated", tournamentId: tid, title: "The draw is out 🎉",
      body: `The draw for ${title} is out. Check your first match!`,
    });
  }

  // 3. Players still without a partner.
  if (unpaired.length > 0) {
    await notifyUids(db, uidsOf(unpaired), {
      type: "pairing_unmatched", tournamentId: tid, title: "No partner found",
      body: `We couldn't find you a partner for ${title}, so you aren't in the draw. Contact the organizer.`,
    });
  }
  logger.info(`autoDrawJob: ${tournamentId} → ${status} (${teams} teams, ${unpaired.length} unpaired)`);
  return status;
}

async function remindOrganizer(db: Firestore, tournamentId: string): Promise<void> {
  const ref = db.collection("tournaments").doc(tournamentId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const doc = snap.data() as TournamentDoc;
  const info = tournamentInfo(snap.id, doc);
  const state = await loadDrawState(db, tournamentId);
  const entries = state?.entries.length ?? 0;
  const deadline = registrationDeadline(doc);
  await ref.update({ deadlineReminderFor: Timestamp.fromDate(deadline) });
  const auto = info.matchFormat === "manualDraw" ? "" : " The draw will be generated automatically when it closes.";
  await notifyUids(db, [doc.createdBy as string], {
    type: "registration_closing", tournamentId: snap.id.toUpperCase(), title: "Registration closes in 24 hours",
    body: `${doc.title} has ${entries} ${entries === 1 ? "entry" : "entries"} so far.${auto}`,
  });
}
