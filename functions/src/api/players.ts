import { Router } from "express";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { validateCreatePlayer, ValidationError } from "../validators";
import { CreatePlayerBody, UpdatePlayerBody, PlayerDoc } from "../types";

const router = Router();
const db = () => getFirestore();

// POST /api/players — Create profile
router.post("/", async (req, res) => {
  try {
    const body = req.body as CreatePlayerBody;

    validateCreatePlayer(body);

    // Check if player already exists for this Firebase UID
    const existing = await db()
      .collection("players")
      .where("firebaseUid", "==", req.uid!)
      .limit(1)
      .get();

    if (!existing.empty) {
      res.status(409).json({ error: "Player profile already exists" });
      return;
    }

    // Check for duplicate email
    const emailCheck = await db()
      .collection("players")
      .where("email", "==", body.email.toLowerCase())
      .limit(1)
      .get();

    if (!emailCheck.empty) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const id = crypto.randomUUID();
    const doc: PlayerDoc = {
      name: body.name.trim(),
      phone: body.phone?.trim() ?? "",
      email: body.email.toLowerCase().trim(),
      genderRaw: body.gender,
      elo: 1200,
      streak: 0,
      firebaseUid: req.uid!,
      avatarId: body.avatarId ?? "defaultAvatar",
      homeCountryCode: body.homeCountryCode,
      homePostalCode: body.homePostalCode,
      createdAt: Timestamp.now(),
    };

    await db().collection("players").doc(id).set(doc);

    res.status(201).json({ id, ...doc });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    console.error("Create player error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/players/:id — Update profile (owner only)
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body as UpdatePlayerBody;

    const docRef = db().collection("players").doc(id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    const data = snapshot.data() as PlayerDoc;
    if (data.firebaseUid !== req.uid!) {
      res.status(403).json({ error: "You can only update your own profile" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (body.name.trim().length < 2) {
        res.status(400).json({ error: "Name must be at least 2 characters" });
        return;
      }
      updates.name = body.name.trim();
    }
    if (body.phone !== undefined) updates.phone = body.phone.trim();
    if (body.avatarId !== undefined) updates.avatarId = body.avatarId;
    if (body.genderRaw !== undefined) updates.genderRaw = body.genderRaw;
    if (body.homeCountryCode !== undefined) updates.homeCountryCode = body.homeCountryCode;
    if (body.homePostalCode !== undefined) updates.homePostalCode = body.homePostalCode;
    if (body.weightKg !== undefined) updates.weightKg = body.weightKg;

    await docRef.set(updates, { merge: true });

    res.json({ id, ...updates });
  } catch (err) {
    console.error("Update player error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/players/me — Get current player profile
router.get("/me", async (req, res) => {
  try {
    const snapshot = await db()
      .collection("players")
      .where("firebaseUid", "==", req.uid!)
      .limit(1)
      .get();

    if (snapshot.empty) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    const doc = snapshot.docs[0];
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    console.error("Get player error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
