import { onCall, CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { fail } from "./errors";
import {
  advanceRoundAction,
  generateDrawAction,
  generateRandomPairsAction,
  resetDrawAction,
} from "../services/draw/actions";

/**
 * Draw callables (organizer only). The draw logic is the TypeScript port of
 * the apps' PairingService (services/draw/), proven identical by
 * `npm run check:draw`. Every call takes `{ tournamentId }`.
 */

const OPTIONS = { region: "us-central1", timeoutSeconds: 120 } as const;

function callerUid(request: CallableRequest): string {
  const uid = request.auth?.uid;
  if (!uid) fail("unauthenticated", "UNAUTHENTICATED", "Please sign in to continue.");
  return uid;
}

function tournamentIdOf(request: CallableRequest): unknown {
  return (request.data as { tournamentId?: unknown } | null)?.tournamentId;
}

/** Creates the first round (or the whole schedule) for the tournament's format. */
export const generateDraw = onCall(OPTIONS, async (request) =>
  generateDrawAction(getFirestore(), { uid: callerUid(request) }, tournamentIdOf(request)));

/** Knockout: next round from the winners (round 1 adds the byes). Group + Knockout: groups → bracket. Swiss: next round. */
export const advanceRound = onCall(OPTIONS, async (request) =>
  advanceRoundAction(getFirestore(), { uid: callerUid(request) }, tournamentIdOf(request)));

/** Deletes every match; refused once any score was entered (DRAW_LOCKED). */
export const resetDraw = onCall(OPTIONS, async (request) =>
  resetDrawAction(getFirestore(), { uid: callerUid(request) }, tournamentIdOf(request)));

/** Pairs solo doubles registrations (mixed: man + woman); merges each pair into one registration. */
export const generateRandomPairs = onCall(OPTIONS, async (request) => {
  const r = await generateRandomPairsAction(getFirestore(), { uid: callerUid(request) }, tournamentIdOf(request));
  return { status: r.status, pairs: r.pairs, leftover: r.leftover, matchesCreated: 0, message: r.message };
});
