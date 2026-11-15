import { randomInt } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { TournamentDoc } from "../types";

/**
 * Tournament crew (contract: live-stream-contract.md "Tournament crew").
 *
 * The organizer adds helpers to a per-tournament crew:
 * - `tournaments/{id}.crew`: `{ [uid]: CrewMember }`, public like the rest of
 *   the tournament (apps render the crew list without extra reads), written
 *   only by the crew callables (firestore.rules: server-only field).
 * - `crewInvites/{code}`: the invite link / QR code (server only).
 *
 * Roles are a string enum so scorer / referee / co-organizer can be added
 * later; only `camera` is accepted now. A `joined` camera member may go live
 * on any match of the tournament (startStream), on the organizer's YouTube
 * channel (createCrewBroadcast). Access ends when the tournament finishes or
 * is cancelled.
 */

export const CREW_ROLES = ["camera", "scorer", "referee", "coOrganizer"] as const;
export type CrewRole = (typeof CREW_ROLES)[number];
/** Roles the callables accept today. */
export const ACCEPTED_CREW_ROLES: readonly CrewRole[] = ["camera"];

export type CrewStatus = "invited" | "joined";

/** One entry of `tournaments/{id}.crew`. */
export interface CrewMember {
  role: CrewRole;
  status: CrewStatus;
  /** Player name at the time they were added / joined. */
  name: string;
  /** Canonical (UPPER case) player id, for the avatar. */
  playerId: string;
  /** uid of whoever added them (the organizer), or of the member themselves when they joined by link. */
  invitedBy: string;
  invitedAt: Timestamp;
  joinedAt?: Timestamp;
  /** How they came in: picked from the registered players, or by invite link / QR code. */
  via: "player" | "link";
}

/** `crewInvites/{code}` (server only). */
export interface CrewInviteDoc {
  tournamentId: string;
  createdBy: string;
  createdAt: Timestamp;
  role: CrewRole;
}

export const CREW_INVITES = "crewInvites";
export const MAX_CREW = 20;
export const CREW_URL_BASE = "https://www.tournmate.com/crew/";
/** No 0/O, 1/I/L: easy to read out or type. 31^10 ≈ 8e14 codes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 10;

export function newInviteCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** The code as typed / scanned ("abcd-efgh23" or the full URL) → stored form, or null. */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const last = raw.trim().replace(/\/+$/, "").split("/").pop() ?? "";
  const code = last.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CODE_ALPHABET.includes(c)) return null;
  return code;
}

export function crewUrl(code: string): string {
  return `${CREW_URL_BASE}${code}`;
}

export function crewOf(t: TournamentDoc | undefined): Record<string, CrewMember> {
  const c = (t as { crew?: unknown } | undefined)?.crew;
  if (!c || typeof c !== "object" || Array.isArray(c)) return {};
  const out: Record<string, CrewMember> = {};
  for (const [uid, m] of Object.entries(c as Record<string, unknown>)) {
    if (m && typeof m === "object" && typeof (m as CrewMember).role === "string" && typeof (m as CrewMember).status === "string") {
      out[uid] = m as CrewMember;
    }
  }
  return out;
}

/** Why crew access is closed: "finished" / "cancelled", or null while the tournament is open. */
export function tournamentClosed(t: TournamentDoc | undefined): "finished" | "cancelled" | null {
  if (t?.statusRaw === "cancelled") return "cancelled";
  if ((t as { finished?: unknown } | undefined)?.finished === true) return "finished";
  return null;
}

/** A joined member with `role` on an open tournament. */
export function hasCrewRole(t: TournamentDoc | undefined, uid: string, role: CrewRole): boolean {
  if (!t || tournamentClosed(t)) return false;
  const m = crewOf(t)[uid];
  return !!m && m.status === "joined" && m.role === role;
}
