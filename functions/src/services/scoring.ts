/**
 * Sport-specific scoring rules and score validation.
 *
 * A port of the iOS reference (TournMate/Domain/ScoringRules.swift:
 * `ScoringConfig`, `SportType.scoringRules`, `ScoreValidator`) and the matching
 * Android `ScoringRules.kt`. Defaults, validation semantics and error messages
 * must stay identical to the apps, so a score the app accepts is accepted here
 * and vice versa.
 *
 * The organizer's choice is stored on the tournament as `scoringConfigData`,
 * a JSON string such as
 *   {"gamesPerMatch":3,"pointsToWin":21,"winBy":2,"pointCap":30,"scoringSystem":"rally"}
 * Tournaments without it predate scoring settings and are validated leniently
 * (`enforcesScoringRules` is false), exactly like the apps.
 */

import type { SportType } from "../types";

// ─── Config ─────────────────────────────────────────────

export type ScoringSystem = "rally" | "sideOut";

export interface ScoringConfig {
  /** Maximum games in a match ("best of"). */
  gamesPerMatch: number;
  /** Points needed to win a game. 0 = no target (free-form score). */
  pointsToWin: number;
  /** Required winning margin. */
  winBy: number;
  /** Hard ceiling on a game score. null = no cap. */
  pointCap: number | null;
  scoringSystem: ScoringSystem;
}

export interface SetScore {
  teamAPoints: number;
  teamBPoints: number;
}

/** Games a side must win to take the match (e.g. 2 in a best of 3). */
export function gamesToWin(config: ScoringConfig): number {
  return Math.floor(config.gamesPerMatch / 2) + 1;
}

function cfg(
  gamesPerMatch: number,
  pointsToWin: number,
  winBy: number,
  pointCap: number | null,
  scoringSystem: ScoringSystem,
): ScoringConfig {
  return { gamesPerMatch, pointsToWin, winBy, pointCap, scoringSystem };
}

/** Per-sport default config (iOS `SportType.scoringRules.defaultConfig`). */
export function defaultScoringConfig(sport: SportType): ScoringConfig {
  switch (sport) {
    case "badminton":
      return cfg(3, 21, 2, 30, "rally");
    case "pickleball":
      return cfg(3, 11, 2, null, "sideOut");
    case "table_tennis":
      return cfg(5, 11, 2, null, "rally");
    case "tennis":
    case "padel":
      return cfg(3, 6, 2, 7, "rally");
    case "squash":
      return cfg(5, 11, 2, null, "rally");
    case "beach_volleyball":
      return cfg(3, 21, 2, null, "rally");
    case "volleyball":
      return cfg(5, 25, 2, null, "rally");
    case "roundnet":
      return cfg(3, 21, 2, null, "rally");
    default:
      // basketball, football, soccer, cricket, golf, disc_golf, bowling, darts, generic:
      // a single result with no target score.
      return cfg(1, 0, 1, null, "rally");
  }
}

/** JSON integer check matching Swift's `JSONDecoder` decoding into `Int`. */
function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * Decodes `scoringConfigData` like iOS `ScoringConfig.init(from:)`: missing or
 * null keys fall back to best of 3, to 21, win by 2, no cap, rally. Returns
 * null when the JSON can't be decoded (bad JSON, not an object, a key of the
 * wrong type, an unknown scoring system).
 */
export function decodeScoringConfig(json: string): ScoringConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const intOr = (key: string, fallback: number | null): number | null | undefined => {
    const v = o[key];
    if (v === undefined || v === null) return fallback;
    return isInt(v) ? v : undefined;
  };

  const gamesPerMatch = intOr("gamesPerMatch", 3);
  const pointsToWin = intOr("pointsToWin", 21);
  const winBy = intOr("winBy", 2);
  const pointCap = intOr("pointCap", null);
  if (gamesPerMatch == null || pointsToWin == null || winBy == null || pointCap === undefined) {
    return null;
  }

  const ss = o.scoringSystem;
  let scoringSystem: ScoringSystem;
  if (ss === undefined || ss === null) scoringSystem = "rally";
  else if (ss === "rally" || ss === "sideOut") scoringSystem = ss;
  else return null;

  return { gamesPerMatch, pointsToWin, winBy, pointCap, scoringSystem };
}

export interface ResolvedScoring {
  config: ScoringConfig;
  /** Strict rules apply only when the tournament has `scoringConfigData`. */
  enforce: boolean;
}

/**
 * Resolves a tournament's scoring rules: its `scoringConfigData`, or the
 * sport's defaults when that is missing or can't be decoded. Mirrors iOS
 * `Tournament.scoringConfig` and `Tournament.enforcesScoringRules`.
 */
export function resolveScoring(scoringConfigData: unknown, sport: SportType): ResolvedScoring {
  // iOS stores a String; any other stored type is treated as absent.
  const data = typeof scoringConfigData === "string" ? scoringConfigData : undefined;
  const decoded = data !== undefined ? decodeScoringConfig(data) : null;
  return {
    config: decoded ?? defaultScoringConfig(sport),
    enforce: data !== undefined,
  };
}

// ─── Messages ───────────────────────────────────────────

/** Plural name of a game subdivision (iOS `SportType.setName`). */
export function setName(sport: SportType): string {
  switch (sport) {
    case "badminton": case "table_tennis": case "pickleball": case "squash": case "roundnet": case "bowling":
      return "games";
    case "tennis": case "padel": case "volleyball": case "beach_volleyball": case "generic":
      return "sets";
    case "basketball": case "football":
      return "quarters";
    case "soccer":
      return "halves";
    case "cricket":
      return "innings";
    case "golf": case "disc_golf":
      return "rounds";
    case "darts":
      return "legs";
  }
}

/** Singular name of a game subdivision (iOS `SportType.setNameSingular`). */
export function setNameSingular(sport: SportType): string {
  switch (sport) {
    case "badminton": case "table_tennis": case "pickleball": case "squash": case "roundnet": case "bowling":
      return "game";
    case "tennis": case "padel": case "volleyball": case "beach_volleyball": case "generic":
      return "set";
    case "basketball": case "football":
      return "quarter";
    case "soccer":
      return "half";
    case "cricket":
      return "innings";
    case "golf": case "disc_golf":
      return "round";
    case "darts":
      return "leg";
  }
}

export type ScoreValidationError =
  | { kind: "negative" }
  | { kind: "tied" }
  | { kind: "belowTarget"; target: number }
  | { kind: "marginTooSmall"; winBy: number }
  | { kind: "gameShouldHaveEnded"; target: number; winBy: number }
  | { kind: "exceedsCap"; cap: number }
  | { kind: "tooManyGames"; max: number }
  | { kind: "matchNotDecided"; gamesToWin: number }
  | { kind: "gamesAfterMatchDecided" };

function capitalized(s: string): string {
  // Swift `String.capitalized` (unit names are single lowercase words).
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** User-facing message, word for word as iOS `ScoreValidationError.message(for:)`. */
export function scoreErrorMessage(error: ScoreValidationError, sport: SportType): string {
  const scoreWord = sport === "tennis" ? "games" : "points";
  const scoreWordSingular = sport === "tennis" ? "game" : "point";
  const unit = setNameSingular(sport);
  switch (error.kind) {
    case "negative":
      return "Scores can't be negative";
    case "tied":
      return `A ${unit} can't end in a tie`;
    case "belowTarget":
      return `Winner needs at least ${error.target} ${scoreWord}`;
    case "marginTooSmall":
      return `Must win by ${error.winBy}`;
    case "gameShouldHaveEnded":
      return `${capitalized(unit)} ends at ${error.target} with a ${error.winBy}-${scoreWordSingular} lead`;
    case "exceedsCap":
      return `Max score is ${error.cap}`;
    case "tooManyGames":
      return `A match has at most ${error.max} ${setName(sport)}`;
    case "matchNotDecided":
      return `One side must win ${error.gamesToWin} ${unit}${error.gamesToWin === 1 ? "" : "s"}`;
    case "gamesAfterMatchDecided":
      return `Match was already won before the last ${unit}`;
  }
}

// ─── Validation ─────────────────────────────────────────

/** Validates one finished game (iOS `ScoreValidator.validateGame`). null = legal. */
export function validateGame(score: SetScore, config: ScoringConfig): ScoreValidationError | null {
  const a = score.teamAPoints;
  const b = score.teamBPoints;
  if (a < 0 || b < 0) return { kind: "negative" };
  if (a === b) return { kind: "tied" };

  const target = config.pointsToWin;
  if (!(target > 0)) return null;

  const winner = Math.max(a, b);
  const loser = Math.min(a, b);
  const winBy = Math.max(config.winBy, 1);
  const cap = config.pointCap;

  if (cap !== null && winner > cap) return { kind: "exceedsCap", cap };
  if (winner < target) return { kind: "belowTarget", target };

  if (winner === target) {
    return winner - loser >= winBy ? null : { kind: "marginTooSmall", winBy };
  }

  // Winner went past the target: only legal through extended play.
  if (cap !== null && winner === cap) {
    return loser >= cap - winBy ? null : { kind: "gameShouldHaveEnded", target, winBy };
  }
  if (winBy === 1) return { kind: "gameShouldHaveEnded", target, winBy };
  if (winner - loser < winBy) return { kind: "marginTooSmall", winBy };
  if (winner - loser > winBy) return { kind: "gameShouldHaveEnded", target, winBy };
  return null;
}

export interface MatchValidation {
  /** Per-game errors keyed by game index. */
  gameErrors: Map<number, ScoreValidationError>;
  /** At most one match-level error. */
  matchError: ScoreValidationError | null;
}

/** Validates a full match (iOS `ScoreValidator.validateMatch`). */
export function validateMatch(scores: SetScore[], config: ScoringConfig): MatchValidation {
  const gameErrors = new Map<number, ScoreValidationError>();
  scores.forEach((score, index) => {
    const error = validateGame(score, config);
    if (error) gameErrors.set(index, error);
  });

  if (scores.length > config.gamesPerMatch) {
    return { gameErrors, matchError: { kind: "tooManyGames", max: config.gamesPerMatch } };
  }

  const toWin = gamesToWin(config);
  let winsA = 0;
  let winsB = 0;
  for (const score of scores) {
    if (winsA === toWin || winsB === toWin) {
      // A game was played after the match was already decided.
      return { gameErrors, matchError: { kind: "gamesAfterMatchDecided" } };
    }
    if (score.teamAPoints > score.teamBPoints) winsA += 1;
    else if (score.teamBPoints > score.teamAPoints) winsB += 1;
  }

  if (winsA !== toWin && winsB !== toWin) {
    return { gameErrors, matchError: { kind: "matchNotDecided", gamesToWin: toWin } };
  }
  return { gameErrors, matchError: null };
}

/** One validation failure, ready for an API error response. */
export interface ScoreIssue {
  /** "setScores", "setScores[i]", or "score". */
  field: string;
  message: string;
}

/**
 * Validates submitted set scores. Returns every problem found (empty = valid).
 *
 * - `enforce` true: per-game rules plus the match rules (a side won the
 *   required number of games, nothing played after the match was decided).
 * - `enforce` false (legacy tournament without `scoringConfigData`): the
 *   apps' original checks — non-negative, no tied game, and a winner (one
 *   side won more games).
 *
 * Input shape (array of objects with integer points) is checked first in
 * both modes, since this is a server boundary.
 */
export function validateMatchScores(
  sets: unknown,
  config: ScoringConfig,
  enforce: boolean,
  sport: SportType,
): ScoreIssue[] {
  if (!Array.isArray(sets) || sets.length === 0) {
    return [{ field: "setScores", message: "Set scores are required" }];
  }
  // Hard ceiling for malformed input; the apps never offer more than 7 games.
  if (sets.length > 7) {
    return [{ field: "setScores", message: `A match has at most 7 ${setName(sport)}` }];
  }
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i] as Partial<SetScore> | null;
    if (!s || typeof s !== "object" || !isInt(s.teamAPoints) || !isInt(s.teamBPoints)) {
      return [{ field: `setScores[${i}]`, message: "Points must be whole numbers" }];
    }
  }
  const scores = sets as SetScore[];

  if (!enforce) {
    const issues: ScoreIssue[] = [];
    scores.forEach((s, i) => {
      if (s.teamAPoints < 0 || s.teamBPoints < 0) {
        issues.push({ field: `setScores[${i}]`, message: scoreErrorMessage({ kind: "negative" }, sport) });
      } else if (s.teamAPoints === s.teamBPoints) {
        issues.push({ field: `setScores[${i}]`, message: scoreErrorMessage({ kind: "tied" }, sport) });
      }
    });
    if (issues.length > 0) return issues;
    const winsA = scores.filter((s) => s.teamAPoints > s.teamBPoints).length;
    const winsB = scores.filter((s) => s.teamBPoints > s.teamAPoints).length;
    if (winsA === winsB) {
      return [{ field: "setScores", message: "One side must win more " + setName(sport) }];
    }
    return [];
  }

  const result = validateMatch(scores, config);
  const issues: ScoreIssue[] = [];
  for (const [index, error] of [...result.gameErrors.entries()].sort((x, y) => x[0] - y[0])) {
    issues.push({ field: `setScores[${index}]`, message: scoreErrorMessage(error, sport) });
  }
  if (result.matchError) {
    issues.push({ field: "setScores", message: scoreErrorMessage(result.matchError, sport) });
  }
  return issues;
}

/**
 * Validates a single-result score (iOS `SimpleScoreEntryView`, round-robin):
 * one game played to the tournament's target, i.e. the config with
 * `gamesPerMatch = 1`. Legacy tournaments: non-negative, not tied, not 0-0.
 */
export function validateSimpleScore(
  scoreA: unknown,
  scoreB: unknown,
  config: ScoringConfig,
  enforce: boolean,
  sport: SportType,
): ScoreIssue[] {
  if (!isInt(scoreA) || !isInt(scoreB)) {
    return [{ field: "score", message: "Points must be whole numbers" }];
  }
  if (scoreA < 0 || scoreB < 0) return [{ field: "score", message: scoreErrorMessage({ kind: "negative" }, sport) }];
  if (scoreA === scoreB) return [{ field: "score", message: scoreErrorMessage({ kind: "tied" }, sport) }];
  if (!enforce) return [];
  const error = validateGame({ teamAPoints: scoreA, teamBPoints: scoreB }, { ...config, gamesPerMatch: 1 });
  return error ? [{ field: "score", message: scoreErrorMessage(error, sport) }] : [];
}

/**
 * The winning side of a validated set-score match: the side that won more
 * games. For scores that passed `validateMatchScores` this is the side that
 * reached the required number of games.
 */
export function matchWinner(scores: SetScore[]): "A" | "B" | null {
  let a = 0;
  let b = 0;
  for (const s of scores) {
    if (s.teamAPoints > s.teamBPoints) a += 1;
    else if (s.teamBPoints > s.teamAPoints) b += 1;
  }
  if (a === b) return null;
  return a > b ? "A" : "B";
}
