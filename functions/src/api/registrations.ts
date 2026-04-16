import { Router } from "express";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  TournamentDoc,
  RegistrationDoc,
  PlayerDoc,
  isSinglesFormat,
  TournamentFormat,
  AgeGroup,
  AGE_GROUP_RULES,
  isAgeEligible,
} from "../types";

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

// POST /api/tournaments/:tournamentId/register — Register for a tournament
router.post("/:tournamentId/register", async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { partnerId } = req.body as { partnerId?: string };

    // 1. Validate tournament exists and is open
    const tDoc = await db().collection("tournaments").doc(tournamentId).get();
    if (!tDoc.exists) {
      res.status(404).json({ error: "Tournament not found" });
      return;
    }
    const tournament = tDoc.data() as TournamentDoc;

    if (tournament.statusRaw === "cancelled") {
      res.status(400).json({ error: "Tournament is cancelled" });
      return;
    }

    // 2. Check registration deadline
    const deadline = tournament.registrationDeadline.toDate();
    if (new Date() >= deadline) {
      res.status(400).json({ error: "Registration deadline has passed" });
      return;
    }

    // 3. Find the authenticated player
    const player = await findPlayerByUid(req.uid!);
    if (!player) {
      res.status(404).json({ error: "Player profile not found. Create a profile first." });
      return;
    }

    // 4. Check age group eligibility
    const ageGroup = (tournament.ageGroupRaw || "open") as AgeGroup;
    if (ageGroup !== "open") {
      const dob = player.data.dateOfBirth;
      if (!dob) {
        res.status(400).json({
          error: "This tournament has an age restriction. Please set your date of birth in your profile.",
        });
        return;
      }
      const birthDate = dob.toDate();
      const today = new Date();
      let age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
      }
      if (!isAgeEligible(age, ageGroup)) {
        const rules = AGE_GROUP_RULES[ageGroup];
        const desc = rules.min && rules.max
          ? `ages ${rules.min}–${rules.max}`
          : rules.min ? `ages ${rules.min}+` : `under ${rules.max}`;
        res.status(400).json({
          error: `This tournament is restricted to ${desc}. Your age (${age}) does not qualify.`,
        });
        return;
      }
    }

    // 5. Check for duplicate registration
    const existingRegs = await db()
      .collection("registrations")
      .where("tournamentId", "==", tournamentId)
      .where("playerId", "==", player.id)
      .get();

    if (!existingRegs.empty) {
      res.status(409).json({ error: "Already registered for this tournament" });
      return;
    }

    // 6. Also check if registered as a partner
    const asPartner = await db()
      .collection("registrations")
      .where("tournamentId", "==", tournamentId)
      .where("partnerId", "==", player.id)
      .get();

    if (!asPartner.empty) {
      res.status(409).json({ error: "Already registered as a partner in this tournament" });
      return;
    }

    // 7. Validate partner for doubles
    const format = tournament.formatRaw as TournamentFormat;
    if (!isSinglesFormat(format) && partnerId) {
      const partnerDoc = await db().collection("players").doc(partnerId).get();
      if (!partnerDoc.exists) {
        res.status(404).json({ error: "Partner player not found" });
        return;
      }

      // Check partner isn't already registered
      const partnerRegs = await db()
        .collection("registrations")
        .where("tournamentId", "==", tournamentId)
        .where("playerId", "==", partnerId)
        .get();

      const partnerAsPartner = await db()
        .collection("registrations")
        .where("tournamentId", "==", tournamentId)
        .where("partnerId", "==", partnerId)
        .get();

      if (!partnerRegs.empty || !partnerAsPartner.empty) {
        res.status(409).json({ error: "Partner is already registered for this tournament" });
        return;
      }

      // Mixed doubles: validate gender pairing
      if (format === "mixedDoubles") {
        const partnerData = partnerDoc.data() as PlayerDoc;
        if (player.data.genderRaw === partnerData.genderRaw) {
          res.status(400).json({
            error: "Mixed doubles requires one male and one female player",
          });
          return;
        }
      }
    }

    // 8. Create registration
    const regId = crypto.randomUUID();
    const reg: RegistrationDoc = {
      tournamentId,
      playerId: player.id,
      partnerId: partnerId ?? undefined,
      createdAt: Timestamp.now(),
    };

    await db().collection("registrations").doc(regId).set(reg);

    // 9. Increment participant count
    const increment = partnerId ? 2 : 1;
    await db()
      .collection("tournaments")
      .doc(tournamentId)
      .update({
        participantsCount: (tournament.participantsCount || 0) + increment,
      });

    res.status(201).json({ id: regId, ...reg });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/tournaments/:tournamentId/register — Unregister
router.delete("/:tournamentId/register", async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const player = await findPlayerByUid(req.uid!);
    if (!player) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    // Find the registration
    const regs = await db()
      .collection("registrations")
      .where("tournamentId", "==", tournamentId)
      .where("playerId", "==", player.id)
      .get();

    if (regs.empty) {
      res.status(404).json({ error: "Registration not found" });
      return;
    }

    const regDoc = regs.docs[0];
    const regData = regDoc.data() as RegistrationDoc;

    // Check deadline
    const tDoc = await db().collection("tournaments").doc(tournamentId).get();
    if (tDoc.exists) {
      const tournament = tDoc.data() as TournamentDoc;
      const deadline = tournament.registrationDeadline.toDate();
      if (new Date() >= deadline) {
        res.status(400).json({ error: "Cannot unregister after deadline" });
        return;
      }

      // Decrement count
      const decrement = regData.partnerId ? 2 : 1;
      const newCount = Math.max(0, (tournament.participantsCount || 0) - decrement);
      await db()
        .collection("tournaments")
        .doc(tournamentId)
        .update({ participantsCount: newCount });
    }

    await regDoc.ref.delete();

    res.json({ message: "Registration removed" });
  } catch (err) {
    console.error("Unregister error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/tournaments/:tournamentId/registrations — List registrations
router.get("/:tournamentId/registrations", async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const snapshot = await db()
      .collection("registrations")
      .where("tournamentId", "==", tournamentId)
      .get();

    const registrations = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(registrations);
  } catch (err) {
    console.error("List registrations error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
