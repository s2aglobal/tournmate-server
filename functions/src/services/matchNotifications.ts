import { Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { MatchDoc, PlayerDoc, RegistrationDoc, TournamentDoc, registrationPlayerIds } from "../types";
import { sendToPlayer } from "./notifications";
import { playerForUid } from "./identity";

/**
 * Score notifications: inbox doc (`notifications`, by auth uid) plus a push
 * to the player's device. Shared by the score callables and the
 * `onMatchFinished` trigger (old app versions write scores directly).
 */

/** Player doc by id; older docs may use the other id case. */
async function loadPlayer(db: Firestore, id: string): Promise<PlayerDoc | null> {
  for (const candidate of [...new Set([id, id.toUpperCase(), id.toLowerCase()])]) {
    const snap = await db.collection("players").doc(candidate).get();
    if (snap.exists) return snap.data() as PlayerDoc;
  }
  return null;
}

async function notifyPlayers(
  db: Firestore,
  playerIds: string[],
  message: { type: string; title: string; body: string; tournamentId: string; matchId: string },
  skipUid?: string,
): Promise<void> {
  const seen = new Set<string>();
  for (const pid of playerIds) {
    if (seen.has(pid.toUpperCase())) continue;
    seen.add(pid.toUpperCase());
    const player = await loadPlayer(db, pid);
    if (!player) continue;
    if (skipUid && player.firebaseUid === skipUid) continue;
    if (player.firebaseUid) {
      await db.collection("notifications").add({
        recipientId: player.firebaseUid,
        type: message.type,
        title: message.title,
        body: message.body,
        tournamentId: message.tournamentId,
        read: false,
        createdAt: new Date(),
      });
    }
    if (player.fcmToken) {
      await sendToPlayer(player.fcmToken, message.title, message.body, {
        type: message.type,
        matchId: message.matchId,
        tournamentId: message.tournamentId,
      });
    }
  }
}

async function registrations(db: Firestore, match: MatchDoc): Promise<[RegistrationDoc, RegistrationDoc] | null> {
  const [a, b] = await Promise.all([
    db.collection("registrations").doc(match.teamAId).get(),
    db.collection("registrations").doc(match.teamBId).get(),
  ]);
  if (!a.exists || !b.exists) return null;
  return [a.data() as RegistrationDoc, b.data() as RegistrationDoc];
}

/** Both teams: the match result. */
export async function notifyMatchFinished(db: Firestore, matchId: string, match: MatchDoc): Promise<void> {
  const regs = await registrations(db, match);
  if (!regs) return;
  // Cricket stores a sentence ("Dallas Royals won by 6 wickets"); set-based
  // sports show the games score.
  const body = match.summary ?? `Final score: ${match.scoreA ?? 0} - ${match.scoreB ?? 0}`;
  await notifyPlayers(db, [...registrationPlayerIds(regs[0]), ...registrationPlayerIds(regs[1])], {
    type: "match_finished", title: "Match Result", body, tournamentId: match.tournamentId, matchId,
  });
}

/** The other side: a score is waiting for them to confirm or dispute. */
export async function notifyScoreSubmitted(
  db: Firestore,
  matchId: string,
  match: MatchDoc,
  submitterSide: "A" | "B",
): Promise<void> {
  const regs = await registrations(db, match);
  if (!regs) return;
  const other = submitterSide === "A" ? regs[1] : regs[0];
  const line = match.summary ?? `${match.scoreA ?? 0} - ${match.scoreB ?? 0}`;
  await notifyPlayers(db, registrationPlayerIds(other), {
    type: "score_submitted",
    title: "Confirm the score",
    body: `Your opponent entered ${line}. Confirm or dispute it.`,
    tournamentId: match.tournamentId,
    matchId,
  });
}

/** The organizer: a submitted score was disputed. */
export async function notifyScoreDisputed(
  db: Firestore,
  matchId: string,
  match: MatchDoc,
  tournament: TournamentDoc,
  reason?: string,
): Promise<void> {
  const uid = tournament.createdBy;
  if (!uid) return;
  const title = "Score disputed";
  const body = reason
    ? `A score in ${tournament.title} was disputed: ${reason}`
    : `A score in ${tournament.title} was disputed. Open the match to resolve it.`;
  await db.collection("notifications").add({
    recipientId: uid,
    type: "score_disputed",
    title,
    body,
    tournamentId: match.tournamentId,
    read: false,
    createdAt: new Date(),
  });
  const token = (await playerForUid(db, uid))?.data.fcmToken;
  if (token) {
    await sendToPlayer(token, title, body, { type: "score_disputed", matchId, tournamentId: match.tournamentId });
  }
}

/** Runs a notification without failing the caller. */
export async function safely(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    logger.error(`${label} failed:`, err);
  }
}
