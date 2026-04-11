import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import express from "express";
import cors from "cors";

import { requireAuth } from "./middleware/auth";
import playersRouter from "./api/players";
import tournamentsRouter from "./api/tournaments";
import registrationsRouter from "./api/registrations";
import matchesRouter from "./api/matches";
import ratingsRouter from "./api/ratings";

// ─── Firebase Admin Init ────────────────────────────────
initializeApp();

// ─── Express App ────────────────────────────────────────
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Health check (no auth)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// All API routes require authentication
app.use("/api/players", requireAuth, playersRouter);
app.use("/api/tournaments", requireAuth, tournamentsRouter);
app.use("/api/registrations", requireAuth, registrationsRouter);
app.use("/api/matches", requireAuth, matchesRouter);
app.use("/api/ratings", requireAuth, ratingsRouter);

// ─── HTTP Cloud Function ────────────────────────────────
export const api = onRequest(
  {
    region: "us-central1",
    maxInstances: 50,
    timeoutSeconds: 60,
  },
  app,
);

// ─── Firestore Triggers ─────────────────────────────────
export { onTournamentCreated } from "./triggers/onTournamentCreated";
export { onTournamentCancelled } from "./triggers/onTournamentCancelled";
export { onRegistrationCreated } from "./triggers/onRegistrationCreated";
export { onMatchFinished } from "./triggers/onMatchFinished";

// ─── Scheduled Jobs ─────────────────────────────────────
export { hourlyCleanup, dailyReminders } from "./triggers/scheduledJobs";
