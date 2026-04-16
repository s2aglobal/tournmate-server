import { Timestamp } from "firebase-admin/firestore";

// ─── Sport Types ────────────────────────────────────────

export type SportType =
  | "badminton"
  | "pickleball"
  | "tennis"
  | "tableTennis";

export const DEFAULT_SPORT: SportType = "badminton";

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

export type AgeGroup =
  | "open"
  | "u13"
  | "u15"
  | "u17"
  | "u19"
  | "u24"
  | "senior"
  | "veterans35"
  | "masters40"
  | "masters50"
  | "grandMasters55";

export const AGE_GROUP_RULES: Record<AgeGroup, { min?: number; max?: number }> = {
  open: {},
  u13: { max: 13 },
  u15: { max: 15 },
  u17: { max: 17 },
  u19: { max: 19 },
  u24: { max: 24 },
  senior: { min: 19 },
  veterans35: { min: 35 },
  masters40: { min: 40 },
  masters50: { min: 50 },
  grandMasters55: { min: 55 },
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
  elo: number;
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
