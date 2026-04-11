import { Router } from "express";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { validateCreateTournament, ValidationError } from "../validators";
import { CreateTournamentBody, UpdateTournamentBody, TournamentDoc } from "../types";

const router = Router();
const db = () => getFirestore();

// GET /api/tournaments — List upcoming tournaments
router.get("/", async (_req, res) => {
  try {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const snapshot = await db()
      .collection("tournaments")
      .where("date", ">=", Timestamp.fromDate(now))
      .orderBy("date")
      .get();

    const tournaments = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(tournaments);
  } catch (err) {
    console.error("List tournaments error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/tournaments/past — List past tournaments
router.get("/past", async (_req, res) => {
  try {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const snapshot = await db()
      .collection("tournaments")
      .where("date", "<", Timestamp.fromDate(now))
      .orderBy("date", "desc")
      .get();

    const tournaments = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(tournaments);
  } catch (err) {
    console.error("List past tournaments error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/tournaments/:id — Get single tournament
router.get("/:id", async (req, res) => {
  try {
    const doc = await db().collection("tournaments").doc(req.params.id).get();
    if (!doc.exists) {
      res.status(404).json({ error: "Tournament not found" });
      return;
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    console.error("Get tournament error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/tournaments — Create tournament
router.post("/", async (req, res) => {
  try {
    const body = req.body as CreateTournamentBody;

    validateCreateTournament(body);

    const tournamentDate = new Date(body.date);
    const defaultDeadline = new Date(tournamentDate);
    defaultDeadline.setDate(defaultDeadline.getDate() - 1);
    defaultDeadline.setHours(23, 59, 59, 0);

    const deadline = body.registrationDeadline
      ? new Date(body.registrationDeadline)
      : defaultDeadline;

    const id = crypto.randomUUID();
    const doc: TournamentDoc = {
      title: body.title.trim(),
      date: Timestamp.fromDate(tournamentDate),
      location: body.location.trim(),
      locationAddress: body.locationAddress?.trim() ?? "",
      locationLatitude: body.locationLatitude,
      locationLongitude: body.locationLongitude,
      participantsCount: 0,
      statusRaw: "scheduled",
      formatRaw: body.format,
      matchFormatRaw: body.matchFormat,
      randomPairing: body.randomPairing ?? false,
      registrationDeadline: Timestamp.fromDate(deadline),
      createdBy: req.uid!,
      entryFee: body.entryFee,
      currency: body.currency ?? "USD",
      paymentInfo: body.paymentInfo,
      prizeInfo: body.prizeInfo,
      durationMinutes: body.durationMinutes,
      countryCode: body.countryCode,
      postalCode: body.postalCode,
      formatConfigData: body.formatConfigData,
      createdAt: Timestamp.now(),
    };

    await db().collection("tournaments").doc(id).set(doc);

    res.status(201).json({ id, ...doc });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    console.error("Create tournament error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/tournaments/:id — Update tournament (organizer only)
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body as UpdateTournamentBody;

    const docRef = db().collection("tournaments").doc(id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Tournament not found" });
      return;
    }

    const data = snapshot.data() as TournamentDoc;

    // Only the tournament creator can edit
    if (data.createdBy !== req.uid!) {
      res.status(403).json({ error: "Only the organizer can edit this tournament" });
      return;
    }

    if (data.statusRaw === "cancelled") {
      res.status(400).json({ error: "Cannot edit a cancelled tournament" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title.trim();
    if (body.date !== undefined) updates.date = Timestamp.fromDate(new Date(body.date));
    if (body.location !== undefined) updates.location = body.location.trim();
    if (body.locationAddress !== undefined) updates.locationAddress = body.locationAddress.trim();
    if (body.locationLatitude !== undefined) updates.locationLatitude = body.locationLatitude;
    if (body.locationLongitude !== undefined) updates.locationLongitude = body.locationLongitude;
    if (body.countryCode !== undefined) updates.countryCode = body.countryCode;
    if (body.postalCode !== undefined) updates.postalCode = body.postalCode;
    if (body.format !== undefined) updates.formatRaw = body.format;
    if (body.matchFormat !== undefined) updates.matchFormatRaw = body.matchFormat;
    if (body.formatConfigData !== undefined) updates.formatConfigData = body.formatConfigData;
    if (body.randomPairing !== undefined) updates.randomPairing = body.randomPairing;
    if (body.registrationDeadline !== undefined) {
      updates.registrationDeadline = Timestamp.fromDate(new Date(body.registrationDeadline));
    }
    if (body.entryFee !== undefined) updates.entryFee = body.entryFee;
    if (body.currency !== undefined) updates.currency = body.currency;
    if (body.paymentInfo !== undefined) updates.paymentInfo = body.paymentInfo;
    if (body.prizeInfo !== undefined) updates.prizeInfo = body.prizeInfo;
    if (body.durationMinutes !== undefined) updates.durationMinutes = body.durationMinutes;

    await docRef.set(updates, { merge: true });

    res.json({ id, ...updates });
  } catch (err) {
    console.error("Update tournament error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/tournaments/:id/cancel — Cancel tournament (organizer only)
router.post("/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;

    const docRef = db().collection("tournaments").doc(id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Tournament not found" });
      return;
    }

    const data = snapshot.data() as TournamentDoc;
    if (data.createdBy !== req.uid!) {
      res.status(403).json({ error: "Only the organizer can cancel" });
      return;
    }

    const hoursUntilStart =
      (data.date.toDate().getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursUntilStart < 3) {
      res.status(400).json({
        error: "Cannot cancel within 3 hours of start time",
      });
      return;
    }

    await docRef.update({ statusRaw: "cancelled" });

    res.json({ message: "Tournament cancelled" });
  } catch (err) {
    console.error("Cancel tournament error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
