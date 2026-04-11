import { Router } from "express";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { validateSetScores, ValidationError } from "../validators";
import {
  SubmitScoreBody,
  MatchDoc,
  TournamentDoc,
  RegistrationDoc,
  PlayerDoc,
} from "../types";
import { calculateEloChange } from "../services/elo";

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

    validateSetScores(body);

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

    if (!isInMatch) {
      // Also allow tournament organizer to submit
      const tDoc = await db().collection("tournaments").doc(match.tournamentId).get();
      const tournament = tDoc.data() as TournamentDoc;
      if (tournament.createdBy !== req.uid!) {
        res.status(403).json({ error: "Only match participants or the organizer can submit scores" });
        return;
      }
    }

    // Calculate sets won
    let setsWonA = 0;
    let setsWonB = 0;
    for (const set of body.setScores) {
      if (set.teamAPoints > set.teamBPoints) setsWonA++;
      else setsWonB++;
    }

    // Determine winner
    let winnerRegistrationId: string | undefined;
    if (setsWonA > setsWonB) winnerRegistrationId = match.teamAId;
    else if (setsWonB > setsWonA) winnerRegistrationId = match.teamBId;

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

    await matchDoc.ref.update(updateData);

    // Apply ELO changes
    if (match.winnerRegistrationId) {
      await applyEloChanges(match);
    }

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

/**
 * Applies ELO rating changes after a confirmed match.
 * Collects all players from winning and losing teams, updates ratings and streaks.
 */
async function applyEloChanges(match: MatchDoc): Promise<void> {
  if (!match.winnerRegistrationId) return;

  const winnerTeamId = match.winnerRegistrationId;
  const loserTeamId =
    winnerTeamId === match.teamAId ? match.teamBId : match.teamAId;

  const winnerReg = await db().collection("registrations").doc(winnerTeamId).get();
  const loserReg = await db().collection("registrations").doc(loserTeamId).get();

  if (!winnerReg.exists || !loserReg.exists) return;

  const wData = winnerReg.data() as RegistrationDoc;
  const lData = loserReg.data() as RegistrationDoc;

  // Collect all player IDs
  const winnerIds = [wData.playerId, wData.partnerId].filter(Boolean) as string[];
  const loserIds = [lData.playerId, lData.partnerId].filter(Boolean) as string[];

  // Fetch all players
  const allIds = [...winnerIds, ...loserIds];
  const playerDocs = await Promise.all(
    allIds.map((id) => db().collection("players").doc(id).get()),
  );
  const playerMap = new Map<string, { ref: FirebaseFirestore.DocumentReference; data: PlayerDoc }>();
  for (const doc of playerDocs) {
    if (doc.exists) {
      playerMap.set(doc.id, { ref: doc.ref, data: doc.data() as PlayerDoc });
    }
  }

  // Calculate and apply ELO for each winner-loser pair
  for (const wId of winnerIds) {
    for (const lId of loserIds) {
      const winner = playerMap.get(wId);
      const loser = playerMap.get(lId);
      if (!winner || !loser) continue;

      const { winnerDelta, loserDelta } = calculateEloChange(
        winner.data.elo,
        loser.data.elo,
      );
      winner.data.elo += winnerDelta;
      loser.data.elo += loserDelta;
    }
  }

  // Update streaks and persist
  const batch = db().batch();
  for (const wId of winnerIds) {
    const p = playerMap.get(wId);
    if (!p) continue;
    p.data.streak = Math.max(p.data.streak, 0) + 1;
    batch.update(p.ref, { elo: p.data.elo, streak: p.data.streak });
  }
  for (const lId of loserIds) {
    const p = playerMap.get(lId);
    if (!p) continue;
    p.data.streak = Math.min(p.data.streak, 0) - 1;
    batch.update(p.ref, { elo: p.data.elo, streak: p.data.streak });
  }

  await batch.commit();
}

export default router;
