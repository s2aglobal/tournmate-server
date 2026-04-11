import {
  CreatePlayerBody,
  CreateTournamentBody,
  SubmitScoreBody,
  RatePlayerBody,
  TournamentFormat,
  MatchFormat,
  SportType,
  DEFAULT_SPORT,
} from "../types";

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
// Dispatches to sport-specific rules. Add new sports here.

export function validateSetScores(
  body: SubmitScoreBody,
  sportType: SportType = DEFAULT_SPORT,
): void {
  if (!body.setScores || !Array.isArray(body.setScores)) {
    throw new ValidationError("setScores", "Set scores are required");
  }

  switch (sportType) {
    case "badminton":
      validateBadmintonScores(body);
      break;
    case "pickleball":
      validatePickleballScores(body);
      break;
    case "tennis":
    case "tableTennis":
      // Placeholder: accept any valid scores for now
      validateGenericScores(body);
      break;
    default:
      validateGenericScores(body);
  }
}

function validateGenericScores(body: SubmitScoreBody): void {
  if (body.setScores.length < 1 || body.setScores.length > 5) {
    throw new ValidationError("setScores", "Must have between 1 and 5 sets");
  }
  for (let i = 0; i < body.setScores.length; i++) {
    const set = body.setScores[i];
    if (typeof set.teamAPoints !== "number" || typeof set.teamBPoints !== "number") {
      throw new ValidationError(`setScores[${i}]`, "Points must be numbers");
    }
    if (set.teamAPoints < 0 || set.teamBPoints < 0) {
      throw new ValidationError(`setScores[${i}]`, "Points cannot be negative");
    }
  }
}

function validateBadmintonScores(body: SubmitScoreBody): void {
  if (body.setScores.length < 1 || body.setScores.length > 3) {
    throw new ValidationError("setScores", "Badminton: must have 1-3 sets");
  }

  for (let i = 0; i < body.setScores.length; i++) {
    const set = body.setScores[i];
    if (typeof set.teamAPoints !== "number" || typeof set.teamBPoints !== "number") {
      throw new ValidationError(`setScores[${i}]`, "Points must be numbers");
    }
    if (set.teamAPoints < 0 || set.teamBPoints < 0) {
      throw new ValidationError(`setScores[${i}]`, "Points cannot be negative");
    }
    if (set.teamAPoints > 30 || set.teamBPoints > 30) {
      throw new ValidationError(`setScores[${i}]`, "Points cannot exceed 30");
    }

    const maxScore = Math.max(set.teamAPoints, set.teamBPoints);
    const minScore = Math.min(set.teamAPoints, set.teamBPoints);

    if (maxScore < 21) {
      throw new ValidationError(`setScores[${i}]`, "Winner must reach at least 21 points");
    }
    if (maxScore === 30 && minScore !== 29) {
      if (set.teamAPoints !== 30 && set.teamBPoints !== 30) {
        throw new ValidationError(`setScores[${i}]`, "Invalid score at 30-point cap");
      }
    }
    if (maxScore < 30 && maxScore - minScore < 2) {
      throw new ValidationError(`setScores[${i}]`, "Must win by at least 2 points");
    }
  }
}

function validatePickleballScores(body: SubmitScoreBody): void {
  if (body.setScores.length < 1 || body.setScores.length > 3) {
    throw new ValidationError("setScores", "Pickleball: must have 1-3 games");
  }

  for (let i = 0; i < body.setScores.length; i++) {
    const set = body.setScores[i];
    if (typeof set.teamAPoints !== "number" || typeof set.teamBPoints !== "number") {
      throw new ValidationError(`setScores[${i}]`, "Points must be numbers");
    }
    if (set.teamAPoints < 0 || set.teamBPoints < 0) {
      throw new ValidationError(`setScores[${i}]`, "Points cannot be negative");
    }

    const maxScore = Math.max(set.teamAPoints, set.teamBPoints);
    const minScore = Math.min(set.teamAPoints, set.teamBPoints);

    // Standard pickleball: first to 11, win by 2
    if (maxScore < 11) {
      throw new ValidationError(`setScores[${i}]`, "Winner must reach at least 11 points");
    }
    if (maxScore - minScore < 2) {
      throw new ValidationError(`setScores[${i}]`, "Must win by at least 2 points");
    }
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
