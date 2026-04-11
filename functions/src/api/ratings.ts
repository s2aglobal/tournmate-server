import { Router } from "express";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { validateRating, ValidationError } from "../validators";
import { RatePlayerBody, RatingDoc } from "../types";

const router = Router();
const db = () => getFirestore();

// POST /api/ratings — Rate a player
router.post("/", async (req, res) => {
  try {
    const body = req.body as RatePlayerBody;

    validateRating(body);

    // Find the rater's player profile
    const raterSnap = await db()
      .collection("players")
      .where("firebaseUid", "==", req.uid!)
      .limit(1)
      .get();

    if (raterSnap.empty) {
      res.status(404).json({ error: "Your player profile not found" });
      return;
    }
    const raterId = raterSnap.docs[0].id;

    // No self-rating
    if (raterId === body.playerId) {
      res.status(400).json({ error: "Cannot rate yourself" });
      return;
    }

    // Check target player exists
    const targetDoc = await db().collection("players").doc(body.playerId).get();
    if (!targetDoc.exists) {
      res.status(404).json({ error: "Target player not found" });
      return;
    }

    // Check for duplicate rating (same rater + player + tournament)
    let dupQuery = db()
      .collection("ratings")
      .where("playerId", "==", body.playerId)
      .where("raterId", "==", raterId) as FirebaseFirestore.Query;

    if (body.tournamentId) {
      dupQuery = dupQuery.where("tournamentId", "==", body.tournamentId);
    }

    const existing = await dupQuery.limit(1).get();
    if (!existing.empty) {
      res.status(409).json({ error: "You already rated this player for this tournament" });
      return;
    }

    const id = crypto.randomUUID();
    const doc: RatingDoc = {
      playerId: body.playerId,
      raterId,
      tournamentId: body.tournamentId,
      stars: body.stars,
      comment: body.comment,
      createdAt: Timestamp.now(),
    };

    await db().collection("ratings").doc(id).set(doc);

    res.status(201).json({ id, ...doc });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    console.error("Rate player error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/ratings/:playerId — Get ratings for a player
router.get("/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;

    const snapshot = await db()
      .collection("ratings")
      .where("playerId", "==", playerId)
      .get();

    const ratings = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
        const aTime = a.createdAt as Timestamp;
        const bTime = b.createdAt as Timestamp;
        return bTime.toMillis() - aTime.toMillis();
      });

    res.json(ratings);
  } catch (err) {
    console.error("List ratings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
