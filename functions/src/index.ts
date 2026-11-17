import { initializeApp } from "firebase-admin/app";

// ─── Firebase Admin Init ────────────────────────────────
// The legacy REST `api` function (Express) was removed (player privacy S8):
// no app called it, and its players route was an email-enumeration path.
initializeApp();

// ─── Firestore Triggers ─────────────────────────────────
export { onTournamentCreated } from "./triggers/onTournamentCreated";
export { onTournamentCancelled } from "./triggers/onTournamentCancelled";
export { onRegistrationCreated } from "./triggers/onRegistrationCreated";
export { onRegistrationDeleted } from "./triggers/onRegistrationDeleted";
export { onMatchFinished } from "./triggers/onMatchFinished";
export { onPlaySessionCreated } from "./triggers/onPlaySessionCreated";
export { onSessionJoined } from "./triggers/onSessionJoined";
export { onMatchWritten } from "./triggers/onMatchWritten";
export { onRegistrationWrittenStandings } from "./triggers/onRegistrationWrittenStandings";
export { onRegistrationWrittenMemberUids, onMatchWrittenMemberUids } from "./triggers/memberUids";
export { onPlayerWritten } from "./triggers/onPlayerWritten";

// ─── Callables (server authority) ───────────────────────
export { createSession, updateSession, joinSession, leaveSession, cancelSession, finishSession, deleteSession } from "./callables/openPlay";
export { setGender, setProfilePhoto, removeProfilePhoto } from "./callables/profile";
export { deleteAccount } from "./callables/account";
export { findPlayerByContact, updatePrivateProfile } from "./callables/playerPrivate";
export { submitFeedback } from "./callables/feedback";
export { ratePlayer, deleteRating, reportRating } from "./callables/ratings";
export { onRatingCreated } from "./triggers/onRatingCreated";
export { ratingReportDigest } from "./triggers/ratingReportEmails";
export { onFeedbackCreated, feedbackDailyDigest } from "./triggers/feedbackEmails";
export { orphanAccountSweep } from "./triggers/orphanAccountSweep";
export { register, withdraw, joinAsPartner, changePartner, updateRoster, setRoles } from "./callables/registrations";
export { generateDraw, advanceRound, resetDraw, generateRandomPairs, createManualMatches } from "./callables/draw";
export { submitScore, confirmScore, disputeScore, resolveDispute } from "./callables/scores";
export { setTournamentAwards } from "./callables/awards";
export {
  setLineup, startScoring, setToss, startInnings, recordBall, undoBall, setRevisedTarget, endInnings, abandonMatch,
  finishLiveMatch, stopLiveScoring,
} from "./callables/cricketLive";
export { startRacketScoring, recordPoint, undoPoint, setServer, finishRacketMatch } from "./callables/racketLive";

// ─── Scheduled Jobs ─────────────────────────────────────
export { hourlyCleanup, dailyReminders, spamCleanup } from "./triggers/scheduledJobs";
export { autoDrawJob } from "./triggers/autoDrawJob";
export { autoCloseSessions } from "./triggers/autoCloseSessions";
export { photoUploadSweep } from "./triggers/photoUploadSweep";
