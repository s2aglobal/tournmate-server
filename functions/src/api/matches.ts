import { Router } from "express";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { validateSetScores, ValidationError } from "../validators";
import {
  SubmitScoreBody,
  MatchDoc,
  TournamentDoc,
  RegistrationDoc,
  PlayerDoc,
  parseSportType,
} from "../types";
import { matchWinner, resolveScoring } from "../services/scoring";

const router = Router();
const db = () => getFirestore();

/**
 * Finds the player document linked to the authenticated Firebase UID.
 */
async function findPlayerByUid(uid: string) {
  const snap = await db()
    .collection("players")
    .where("firebaseUid", "==", uid)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, data: snap.docs[0].data() as PlayerDoc };
}

/**
 * Checks if the given player ID is part of a registration (as player or partner).
 */
function isPlayerInRegistration(reg: RegistrationDoc, playerId: string): boolean {
  return reg.playerId === playerId || reg.partnerId === playerId;
}

// GET /api/tournaments/:tournamentId/matches — List matches
router.get("/:tournamentId/matches", async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const snapshot = await db()
      .collection("matches")
      .where("tournamentId", "==", tournamentId)
      .get();

    const matches = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
        const roundA = (a.round as number) ?? Infinity;
        const roundB = (b.round as number) ?? Infinity;
        if (roundA !== roundB) return roundA - roundB;
        const bpA = (a.bracketPosition as number) ?? Infinity;
        const bpB = (b.bracketPosition as number) ?? Infinity;
        return bpA - bpB;
      });

    res.json(matches);
  } catch (err) {
    console.error("List matches error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/matches/:matchId/submit-score — Submit set scores
router.post("/:matchId/submit-score", async (req, res) => {
  try {
    const { matchId } = req.params;
    const body = req.body as SubmitScoreBody;

    const matchDoc = await db().collection("matches").doc(matchId).get();
    if (!matchDoc.exists) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    const match = matchDoc.data() as MatchDoc;

    if (match.statusRaw !== "scheduled") {
      res.status(400).json({ error: "Score already submitted for this match" });
      return;
    }

    // Scores are validated against the tournament's sport and scoring rules
    // (scoringConfigData), exactly as the apps validate them.
    const tDoc = await db().collection("tournaments").doc(match.tournamentId).get();
    if (!tDoc.exists) {
      res.status(404).json({ error: "Tournament not found" });
      return;
    }
    const tournament = tDoc.data() as TournamentDoc;
    const sport = parseSportType(tournament.sportType);
    validateSetScores(body, sport, resolveScoring(tournament.scoringConfigData, sport));

    // Verify the submitter is part of this match
    const player = await findPlayerByUid(req.uid!);
    if (!player) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    const teamADoc = await db().collection("registrations").doc(match.teamAId).get();
    const teamBDoc = await db().collection("registrations").doc(match.teamBId).get();

    if (!teamADoc.exists || !teamBDoc.exists) {
      res.status(400).json({ error: "Match registration data missing" });
      return;
    }

    const teamA = teamADoc.data() as RegistrationDoc;
    const teamB = teamBDoc.data() as RegistrationDoc;

    const isInMatch =
      isPlayerInRegistration(teamA, player.id) ||
      isPlayerInRegistration(teamB, player.id);

    // Also allow the tournament organizer to submit
    if (!isInMatch && tournament.createdBy !== req.uid!) {
      res.status(403).json({ error: "Only match participants or the organizer can submit scores" });
      return;
    }

    // Games won per side (validation guarantees no tied games).
    let setsWonA = 0;
    let setsWonB = 0;
    for (const set of body.setScores) {
      if (set.teamAPoints > set.teamBPoints) setsWonA++;
      else if (set.teamBPoints > set.teamAPoints) setsWonB++;
    }

    // Winner: the side that won the match (same rule as services/elo.ts).
    const winnerSide = matchWinner(body.setScores);
    const winnerRegistrationId =
      winnerSide === "A" ? match.teamAId : winnerSide === "B" ? match.teamBId : undefined;

    const updateData: Record<string, unknown> = {
      setScores: body.setScores,
      scoreA: setsWonA,
      scoreB: setsWonB,
      statusRaw: "scoreSubmitted",
      submittedBy: player.id,
    };
    if (winnerRegistrationId) {
      updateData.winnerRegistrationId = winnerRegistrationId;
    }

    await matchDoc.ref.update(updateData);

    res.json({ message: "Score submitted, awaiting confirmation", ...updateData });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    console.error("Submit score error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/matches/:matchId/confirm — Confirm score (opponent or organizer)
router.post("/:matchId/confirm", async (req, res) => {
  try {
    const { matchId } = req.params;

    const matchDoc = await db().collection("matches").doc(matchId).get();
    if (!matchDoc.exists) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    const match = matchDoc.data() as MatchDoc;

    if (match.statusRaw !== "scoreSubmitted") {
      res.status(400).json({ error: "No pending score to confirm" });
      return;
    }

    const player = await findPlayerByUid(req.uid!);
    if (!player) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    // Confirmer must be from the opposing team or the organizer
    // (cannot confirm your own submission)
    if (match.submittedBy === player.id) {
      res.status(400).json({ error: "Cannot confirm your own score submission" });
      return;
    }

    const updateData: Record<string, unknown> = {
      confirmedBy: player.id,
      statusRaw: "finished",
    };

    // Elo and streaks are applied by the onMatchFinished trigger.
    await matchDoc.ref.update(updateData);

    res.json({ message: "Score confirmed, match finalized" });
  } catch (err) {
    console.error("Confirm score error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/matches/:matchId/dispute — Dispute a score
router.post("/:matchId/dispute", async (req, res) => {
  try {
    const { matchId } = req.params;

    const matchDoc = await db().collection("matches").doc(matchId).get();
    if (!matchDoc.exists) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    const match = matchDoc.data() as MatchDoc;
    if (match.statusRaw !== "scoreSubmitted") {
      res.status(400).json({ error: "No pending score to dispute" });
      return;
    }

    const player = await findPlayerByUid(req.uid!);
    if (!player) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    await matchDoc.ref.update({ statusRaw: "disputed" });

    res.json({ message: "Score disputed. Organizer will resolve." });
  } catch (err) {
    console.error("Dispute error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
