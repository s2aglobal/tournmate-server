import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

// ─── Sport Types ────────────────────────────────────────

// Raw values match the iOS/Android `SportType` enums exactly.
// The sport catalog (which of these are offered, and which are live) is
// `config/sports` — see `config/sportsCatalog.ts`. `football` and `generic`
// are legacy/fallback ids that are not in the catalog.
export type SportType =
  | "badminton"
  | "pickleball"
  | "tennis"
  | "padel"
  | "table_tennis"
  | "squash"
  | "volleyball"
  | "beach_volleyball"
  | "basketball"
  | "football"
  | "soccer"
  | "cricket"
  | "roundnet"
  | "golf"
  | "disc_golf"
  | "bowling"
  | "darts"
  | "generic";

export const DEFAULT_SPORT: SportType = "badminton";

export const SPORT_TYPES: readonly SportType[] = [
  "badminton", "pickleball", "tennis", "padel", "table_tennis", "squash",
  "volleyball", "beach_volleyball", "basketball", "football", "soccer",
  "cricket", "roundnet", "golf", "disc_golf", "bowling", "darts", "generic",
];

export const SPORT_LABELS: Record<SportType, { name: string; emoji: string }> = {
  badminton: { name: "Badminton", emoji: "🏸" },
  pickleball: { name: "Pickleball", emoji: "🏓" },
  tennis: { name: "Tennis", emoji: "🎾" },
  padel: { name: "Padel", emoji: "🎾" },
  table_tennis: { name: "Table Tennis", emoji: "🏓" },
  squash: { name: "Squash", emoji: "🟢" },
  volleyball: { name: "Volleyball", emoji: "🏐" },
  beach_volleyball: { name: "Beach Volleyball", emoji: "🏐" },
  basketball: { name: "Basketball", emoji: "🏀" },
  football: { name: "Football", emoji: "🏈" },
  soccer: { name: "Soccer", emoji: "⚽" },
  cricket: { name: "Cricket", emoji: "🏏" },
  roundnet: { name: "Roundnet", emoji: "🟡" },
  golf: { name: "Golf", emoji: "⛳" },
  disc_golf: { name: "Disc Golf", emoji: "🥏" },
  bowling: { name: "Bowling", emoji: "🎳" },
  darts: { name: "Darts", emoji: "🎯" },
  generic: { name: "Sports", emoji: "🏆" },
};

export function isSportType(raw: unknown): raw is SportType {
  return typeof raw === "string" && SPORT_TYPES.includes(raw as SportType);
}

export function sportName(sport: SportType): string {
  return SPORT_LABELS[sport].name;
}

export function sportEmoji(sport: SportType): string {
  return SPORT_LABELS[sport].emoji;
}

/**
 * Parses a stored sport value.
 * - Missing (undefined/null/empty) → badminton: pre-multi-sport docs have no sportType.
 * - Known id → itself.
 * - Unknown non-empty value (e.g. written by a newer app) → `generic`, with a warning.
 *   Never coerce unknown values to badminton, or they would leak into badminton
 *   topics and ratings. Callers must not broadcast region/country pushes for `generic`.
 */
export function parseSportType(raw: unknown): SportType {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SPORT;
  if (isSportType(raw)) return raw;
  logger.warn(`parseSportType: unknown sport ${JSON.stringify(raw)}; treating as generic.`);
  return "generic";
}

// ─── Enums ──────────────────────────────────────────────

export type TournamentStatus = "scheduled" | "cancelled";

export type TournamentFormat =
  | "mensSingles"
  | "womensSingles"
  | "openSingles"
  | "mensDoubles"
  | "womensDoubles"
  | "mixedDoubles"
  | "openDoubles"
  | "fixedDoubles";

export type MatchFormat = "singleElimination" | "roundRobin";

export type MatchStatus =
  | "scheduled"
  | "scoreSubmitted"
  | "finished"
  | "disputed";

export type Gender = "male" | "female";

// Matches the apps' AgeGroup raw values (BWF, USA Pickleball, and USTA divisions).
export type AgeGroup =
  | "open"
  | "u13"
  | "u15"
  | "u17"
  | "u19"
  | "u24"
  | "u12"
  | "u14"
  | "u16"
  | "u18"
  | "adult18"
  | "senior"
  | "veterans35"
  | "masters40"
  | "masters50"
  | "grandMasters55"
  | "age60"
  | "age65"
  | "age70"
  | "age75"
  | "age80";

export const AGE_GROUP_RULES: Record<AgeGroup, { min?: number; max?: number }> = {
  open: {},
  u13: { max: 13 },
  u15: { max: 15 },
  u17: { max: 17 },
  u19: { max: 19 },
  u24: { max: 24 },
  u12: { max: 13 },
  u14: { max: 15 },
  u16: { max: 17 },
  u18: { max: 19 },
  adult18: { min: 18 },
  senior: { min: 19 },
  veterans35: { min: 35 },
  masters40: { min: 40 },
  masters50: { min: 50 },
  grandMasters55: { min: 55 },
  age60: { min: 60 },
  age65: { min: 65 },
  age70: { min: 70 },
  age75: { min: 75 },
  age80: { min: 80 },
};

export function isAgeEligible(age: number, ageGroup: AgeGroup): boolean {
  const rules = AGE_GROUP_RULES[ageGroup];
  if (rules.min !== undefined && age < rules.min) return false;
  if (rules.max !== undefined && age >= rules.max) return false;
  return true;
}

// ─── Firestore Document Shapes ──────────────────────────

export interface PlayerDoc {
  name: string;
  phone: string;
  email: string;
  genderRaw: string;
  /** Legacy single rating — the badminton rating (read by app versions before multi-sport). */
  elo: number;
  /** Per-sport ratings keyed by SportType raw value. */
  eloRatings?: Record<string, number>;
  preferredSport?: string;
  streak: number;
  firebaseUid?: string;
  avatarId: string;
  homeCountryCode?: string;
  homePostalCode?: string;
  fcmToken?: string;
  weightKg?: number;
  dateOfBirth?: Timestamp;
  createdAt: Timestamp;
}

export interface TournamentDoc {
  title: string;
  /** Server-maintained count of registrations (see services/registrationCount.ts). */
  registrationCount?: number;
  date: Timestamp;
  location: string;
  locationAddress: string;
  locationLatitude?: number;
  locationLongitude?: number;
  participantsCount: number;
  statusRaw: string;
  formatRaw: string;
  matchFormatRaw: string;
  sportType?: string;
  randomPairing: boolean;
  registrationDeadline: Timestamp;
  createdBy?: string;
  entryFee?: number;
  currency: string;
  paymentInfo?: string;
  prizeInfo?: string;
  durationMinutes?: number;
  countryCode?: string;
  postalCode?: string;
  timeZone?: string;
  formatConfigData?: string;
  ageGroupRaw?: string;
  createdAt: Timestamp;
}

export interface RegistrationDoc {
  tournamentId: string;
  playerId: string;
  partnerId?: string;
  createdAt: Timestamp;
}

export interface MatchDoc {
  tournamentId: string;
  teamAId: string;
  teamBId: string;
  round?: number;
  bracketPosition?: number;
  scoreA?: number;
  scoreB?: number;
  statusRaw: string;
  winnerRegistrationId?: string;
  submittedBy?: string;
  confirmedBy?: string;
  setScores?: Array<{ teamAPoints: number; teamBPoints: number }>;
  sportType?: string;
  /** Set by onMatchFinished once Elo has been applied, so retries don't double-count. */
  eloApplied?: boolean;
  createdAt: Timestamp;
}

export interface RatingDoc {
  playerId: string;
  raterId: string;
  tournamentId?: string;
  stars: number;
  comment?: string;
  createdAt: Timestamp;
}

// ─── API Request Bodies ─────────────────────────────────

export interface CreatePlayerBody {
  name: string;
  phone: string;
  email: string;
  gender: Gender;
  avatarId?: string;
  homeCountryCode?: string;
  homePostalCode?: string;
}

export interface UpdatePlayerBody {
  name?: string;
  phone?: string;
  avatarId?: string;
  genderRaw?: string;
  homeCountryCode?: string;
  homePostalCode?: string;
  weightKg?: number;
}

export interface CreateTournamentBody {
  title: string;
  date: string; // ISO 8601
  location: string;
  locationAddress: string;
  locationLatitude?: number;
  locationLongitude?: number;
  countryCode?: string;
  postalCode?: string;
  sportType?: SportType;
  format: TournamentFormat;
  matchFormat: MatchFormat;
  formatConfigData?: string;
  randomPairing: boolean;
  registrationDeadline?: string; // ISO 8601
  entryFee?: number;
  currency?: string;
  paymentInfo?: string;
  prizeInfo?: string;
  durationMinutes?: number;
  ageGroup?: AgeGroup;
}

export interface UpdateTournamentBody extends Partial<CreateTournamentBody> {}

export interface RegisterBody {
  partnerId?: string;
}

export interface SubmitScoreBody {
  setScores: Array<{ teamAPoints: number; teamBPoints: number }>;
}

export interface RatePlayerBody {
  playerId: string;
  tournamentId?: string;
  stars: number;
  comment?: string;
}

// ─── Helpers ────────────────────────────────────────────

export const SINGLES_FORMATS: TournamentFormat[] = [
  "mensSingles",
  "womensSingles",
  "openSingles",
];

export function isSinglesFormat(format: TournamentFormat): boolean {
  return SINGLES_FORMATS.includes(format);
}
