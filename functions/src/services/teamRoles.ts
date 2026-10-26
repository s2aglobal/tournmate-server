/**
 * Port of iOS `TeamRoles` (TournMate/Domain/TeamRoles.swift; Android
 * `TeamRoles.kt`). Who leads a team in one tournament and what each player
 * does, stored on the registration. Members are keyed by player id (upper
 * case) or `guest:<name>`.
 */

export const GUEST_PREFIX = "guest:";
export const PLAYING_ROLES = ["batter", "bowler", "allRounder", "wicketkeeperBatter"] as const;
export type PlayingRole = (typeof PLAYING_ROLES)[number];

export interface TeamRoles {
  captain?: string;
  viceCaptain?: string;
  keeper?: string;
  playing: Record<string, PlayingRole>;
}

export function guestKey(name: string): string {
  return GUEST_PREFIX + name;
}

/** Normalized key: player ids in upper case, guest keys unchanged. */
export function roleKey(raw: string): string {
  return raw.startsWith(GUEST_PREFIX) ? raw : raw.toUpperCase();
}

export function isPlayingRole(raw: unknown): raw is PlayingRole {
  return typeof raw === "string" && (PLAYING_ROLES as readonly string[]).includes(raw);
}

/** Roster keys in iOS order: named players, then guests. */
export function rosterKeys(rosterIds: string[], guestNames: string[]): string[] {
  return [...rosterIds.map(roleKey), ...guestNames.map(guestKey)];
}

/** Reads roles from registration fields (unknown playing roles are dropped). */
export function rolesFromFirestore(data: Record<string, unknown>): TeamRoles {
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? roleKey(v) : undefined);
  const playing: Record<string, PlayingRole> = {};
  const raw = data.playerRoles;
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (isPlayingRole(v)) playing[roleKey(k)] = v;
    }
  }
  return { captain: str(data.captainId), viceCaptain: str(data.viceCaptainId), keeper: str(data.keeperId), playing };
}

/**
 * Roles for the side as it stands: anyone no longer playing loses their
 * role, and there is always a captain while anyone plays (the preferred
 * member if they play, otherwise the first one). Vice-captain is never the
 * captain. Same as `TeamRoles.normalized(roster:preferredCaptain:)`.
 */
export function normalizeRoles(roles: TeamRoles, keys: string[], preferredCaptain?: string): TeamRoles {
  const roster = keys.map(roleKey);
  const inSide = new Set(roster);
  if (roster.length === 0) return { playing: {} };
  const keep = (k?: string) => (k !== undefined && inSide.has(roleKey(k)) ? roleKey(k) : undefined);
  const captain = keep(roles.captain) ?? keep(preferredCaptain) ?? roster[0];
  const vc = keep(roles.viceCaptain);
  const out: TeamRoles = {
    captain,
    viceCaptain: vc === captain ? undefined : vc,
    keeper: keep(roles.keeper),
    playing: {},
  };
  for (const [k, role] of Object.entries(roles.playing)) {
    if (inSide.has(roleKey(k))) out.playing[roleKey(k)] = role;
  }
  return out;
}

/** Fields written on the registration. Empty roles write nothing (iOS `firestoreFields`). */
export function rolesToFirestore(r: TeamRoles): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (r.captain) data.captainId = r.captain;
  if (r.viceCaptain) data.viceCaptainId = r.viceCaptain;
  if (r.keeper) data.keeperId = r.keeper;
  if (Object.keys(r.playing).length > 0) data.playerRoles = { ...r.playing };
  return data;
}

export function isCaptain(r: TeamRoles, key: string): boolean {
  return r.captain !== undefined && r.captain === roleKey(key);
}
