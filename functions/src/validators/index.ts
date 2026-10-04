import {
  CreatePlayerBody,
  CreateTournamentBody,
  SubmitScoreBody,
  RatePlayerBody,
  TournamentFormat,
  MatchFormat,
  SportType,
  DEFAULT_SPORT,
  isSportType,
  AgeGroup,
  AGE_GROUP_RULES,
} from "../types";
import { CATALOG_SPORT_IDS } from "../config/sportsCatalog";
import {
  ResolvedScoring,
  defaultScoringConfig,
  validateMatchScores,
} from "../services/scoring";

export class ValidationError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

// ─── Player Validators ─────────────────────────────────

export function validateCreatePlayer(body: CreatePlayerBody): void {
  if (!body.name || body.name.trim().length < 2) {
    throw new ValidationError("name", "Name must be at least 2 characters");
  }
  if (body.name.trim().length > 50) {
    throw new ValidationError("name", "Name must be under 50 characters");
  }
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    throw new ValidationError("email", "Invalid email address");
  }
  if (!body.gender || !["male", "female"].includes(body.gender)) {
    throw new ValidationError("gender", "Gender must be 'male' or 'female'");
  }
}

// ─── Tournament Validators ──────────────────────────────

const VALID_FORMATS: TournamentFormat[] = [
  "mensSingles",
  "womensSingles",
  "openSingles",
  "mensDoubles",
  "womensDoubles",
  "mixedDoubles",
  "openDoubles",
];

const VALID_MATCH_FORMATS: MatchFormat[] = [
  "singleElimination",
  "roundRobin",
];

export function validateCreateTournament(body: CreateTournamentBody): void {
  if (!body.title || body.title.trim().length < 3) {
    throw new ValidationError(
      "title",
      "Title must be at least 3 characters",
    );
  }
  if (body.title.trim().length > 100) {
    throw new ValidationError("title", "Title must be under 100 characters");
  }

  if (!body.date) {
    throw new ValidationError("date", "Date is required");
  }
  const tournamentDate = new Date(body.date);
  if (isNaN(tournamentDate.getTime())) {
    throw new ValidationError("date", "Invalid date format");
  }

  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
  if (tournamentDate < oneHourFromNow) {
    throw new ValidationError(
      "date",
      "Tournament must be at least 1 hour in the future",
    );
  }

  if (!body.location || body.location.trim().length < 2) {
    throw new ValidationError("location", "Location is required");
  }

  if (!body.format || !VALID_FORMATS.includes(body.format)) {
    throw new ValidationError("format", `Invalid format. Must be one of: ${VALID_FORMATS.join(", ")}`);
  }

  if (!body.matchFormat || !VALID_MATCH_FORMATS.includes(body.matchFormat)) {
    throw new ValidationError(
      "matchFormat",
      `Invalid match format. Must be one of: ${VALID_MATCH_FORMATS.join(", ")}`,
    );
  }

  // Any catalog sport id (plus the legacy football/generic ids) is accepted
  // here. Whether a sport is currently *live* is enforced by firestore.rules
  // against config/sports, not by this validator.
  if (body.sportType !== undefined && !isSportType(body.sportType)) {
    throw new ValidationError(
      "sportType",
      `Invalid sport. Must be one of: ${CATALOG_SPORT_IDS.join(", ")}`,
    );
  }

  if (body.ageGroup && !(body.ageGroup in AGE_GROUP_RULES)) {
    throw new ValidationError(
      "ageGroup",
      `Invalid age group. Must be one of: ${Object.keys(AGE_GROUP_RULES).join(", ")}`,
    );
  }

  if (body.entryFee !== undefined && body.entryFee < 0) {
    throw new ValidationError("entryFee", "Entry fee cannot be negative");
  }

  if (body.durationMinutes !== undefined) {
    if (body.durationMinutes < 15 || body.durationMinutes > 720) {
      throw new ValidationError(
        "durationMinutes",
        "Duration must be between 15 and 720 minutes",
      );
    }
  }

  if (body.registrationDeadline) {
    const deadline = new Date(body.registrationDeadline);
    if (isNaN(deadline.getTime())) {
      throw new ValidationError(
        "registrationDeadline",
        "Invalid deadline date",
      );
    }
    if (deadline >= tournamentDate) {
      throw new ValidationError(
        "registrationDeadline",
        "Deadline must be before tournament date",
      );
    }
  }
}

// ─── Score Validators ───────────────────────────────────
// Rules come from the tournament's sport and `scoringConfigData`; see
// services/scoring.ts (a port of the iOS ScoreValidator).

/**
 * Validates submitted set scores against the tournament's scoring rules.
 * Throws a ValidationError with the first problem (same text as the apps).
 * Without `scoring`, the sport's defaults are enforced.
 */
export function validateSetScores(
  body: SubmitScoreBody,
  sportType: SportType = DEFAULT_SPORT,
  scoring: ResolvedScoring = { config: defaultScoringConfig(sportType), enforce: true },
): void {
  const issues = validateMatchScores(body?.setScores, scoring.config, scoring.enforce, sportType);
  if (issues.length > 0) {
    throw new ValidationError(issues[0].field, issues[0].message);
  }
}

// ─── Rating Validators ──────────────────────────────────

export function validateRating(body: RatePlayerBody): void {
  if (!body.playerId) {
    throw new ValidationError("playerId", "Player ID is required");
  }
  if (typeof body.stars !== "number" || body.stars < 1 || body.stars > 5) {
    throw new ValidationError("stars", "Stars must be between 1 and 5");
  }
  if (body.comment && body.comment.length > 500) {
    throw new ValidationError(
      "comment",
      "Comment must be under 500 characters",
    );
  }
}
