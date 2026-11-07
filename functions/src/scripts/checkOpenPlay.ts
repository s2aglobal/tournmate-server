/**
 * Dependency-free checks for the pure helpers in services/openPlay.ts.
 *
 * Usage (from tournmate-server/functions):
 *   npm run check:openplay
 *
 * Exits non-zero if any case fails.
 */

import { Timestamp } from "firebase-admin/firestore";
import {
  BENCH_SPOTS,
  LEGACY_DURATION_MINUTES,
  MAX_COURTS,
  capacityFor,
  createdBefore,
  formatSessionTime,
  isActiveSession,
  mixedGender,
  mixedOverflowIds,
  mixedSlotsPerGender,
  sessionCapacity,
  sessionGameType,
  sessionMixedCap,
  sessionWindow,
  windowsOverlap,
} from "../services/openPlay";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const at = (iso: string) => new Date(iso);
const mins = (w: { start: Date; end: Date }) => (w.end.getTime() - w.start.getTime()) / 60_000;

// ─── capacityFor ─────────────────────────────────────────
check("singles cap 2", capacityFor("singles") === 2);
check("doubles cap 4", capacityFor("doubles") === 4);
check("mixed cap 4", capacityFor("mixed") === 4);
check("any cap 4", capacityFor("any") === 4);
check("missing game type cap 4", capacityFor(undefined) === 4 && capacityFor(null) === 4);
check("unknown game type cap 4", capacityFor("triples") === 4);
check("constants: 4 courts, 2 bench", MAX_COURTS === 4 && BENCH_SPOTS === 2);
check("doubles 1 / 3 / 4 courts = 6 / 14 / 18",
  capacityFor("doubles", 1) === 6 && capacityFor("doubles", 3) === 14 && capacityFor("doubles", 4) === 18);
check("singles 1 / 4 courts = 4 / 10", capacityFor("singles", 1) === 4 && capacityFor("singles", 4) === 10);
check("mixed / any 2 courts = 10", capacityFor("mixed", 2) === 10 && capacityFor("any", 2) === 10);
check("explicit bench 0", capacityFor("doubles", 2, 0) === 8);
check("mixed per gender: 1 / 3 courts = 3 / 7, legacy 2",
  mixedSlotsPerGender(1) === 3 && mixedSlotsPerGender(3) === 7 && mixedSlotsPerGender(null) === 2);
check("sessionCapacity: maxPlayers wins", sessionCapacity({ gameType: "doubles", courts: 3, maxPlayers: 14 }) === 14
  && sessionCapacity({ gameType: "doubles", maxPlayers: 4 }) === 4);
check("sessionCapacity: legacy without maxPlayers", sessionCapacity({ gameType: "singles" }) === 2
  && sessionCapacity({}) === 4);
check("sessionCapacity: courts without maxPlayers", sessionCapacity({ gameType: "singles", courts: 2 }) === 6);
check("sessionMixedCap", sessionMixedCap({ courts: 2 }) === 5 && sessionMixedCap({ maxPlayers: 4 }) === 2);

// ─── sessionWindow ───────────────────────────────────────
const start = at("2030-06-01T18:00:00Z");
check("duration from durationMinutes", mins(sessionWindow({ date: start, durationMinutes: 90 })) === 90);
check("missing duration = 120", mins(sessionWindow({ date: start })) === LEGACY_DURATION_MINUTES
  && LEGACY_DURATION_MINUTES === 120);
check("zero duration = 120", mins(sessionWindow({ date: start, durationMinutes: 0 })) === 120);
check("null duration = 120", mins(sessionWindow({ date: start, durationMinutes: null })) === 120);
check("endsAt wins over duration",
  mins(sessionWindow({ date: start, durationMinutes: 60, endsAt: at("2030-06-01T21:00:00Z") })) === 180);
check("endsAt before start ignored",
  mins(sessionWindow({ date: start, durationMinutes: 60, endsAt: at("2030-06-01T17:00:00Z") })) === 60);
check("accepts Firestore Timestamps",
  mins(sessionWindow({ date: Timestamp.fromDate(start), endsAt: Timestamp.fromDate(at("2030-06-01T19:30:00Z")) })) === 90);
check("no date -> epoch start, 120 min", sessionWindow({}).start.getTime() === 0 && mins(sessionWindow({})) === 120);
check("window starts at date", sessionWindow({ date: start }).start.getTime() === start.getTime());

// ─── windowsOverlap ──────────────────────────────────────
const w = (s: string, e: string) => ({ start: at(s), end: at(e) });
const base = w("2030-06-01T18:00:00Z", "2030-06-01T20:00:00Z");
check("overlap: partial", windowsOverlap(base, w("2030-06-01T19:00:00Z", "2030-06-01T21:00:00Z")));
check("overlap: contained", windowsOverlap(base, w("2030-06-01T18:30:00Z", "2030-06-01T19:00:00Z")));
check("overlap: identical", windowsOverlap(base, base));
check("overlap: symmetric", windowsOverlap(w("2030-06-01T17:00:00Z", "2030-06-01T18:30:00Z"), base));
check("no overlap: back to back after", !windowsOverlap(base, w("2030-06-01T20:00:00Z", "2030-06-01T22:00:00Z")));
check("no overlap: back to back before", !windowsOverlap(base, w("2030-06-01T16:00:00Z", "2030-06-01T18:00:00Z")));
check("no overlap: other day", !windowsOverlap(base, w("2030-06-02T18:00:00Z", "2030-06-02T20:00:00Z")));

// ─── status / game type ──────────────────────────────────
check("missing status is active", isActiveSession({}));
check("active is active", isActiveSession({ status: "active" }));
check("cancelled/completed/flagged not active",
  !isActiveSession({ status: "cancelled" }) && !isActiveSession({ status: "completed" })
  && !isActiveSession({ status: "flagged" }));
check("game type from gameType", sessionGameType({ gameType: "mixed" }) === "mixed");
check("game type from gameTypeRaw", sessionGameType({ gameTypeRaw: "singles" }) === "singles");
check("missing game type is any", sessionGameType({}) === "any");

// ─── mixed slots ─────────────────────────────────────────
check("mixedGender", mixedGender("male") === "male" && mixedGender("female") === "female"
  && mixedGender("preferNotToSay") === null && mixedGender(undefined) === null);
const mm = (ids: Array<[string, string | undefined]>) => ids.map(([id, gender]) => ({ id, gender }));
check("mixed: 2+2 fits", mixedOverflowIds(mm([["H", "male"], ["A", "female"], ["B", "male"], ["C", "female"]]), ["C"]).length === 0);
check("mixed: 3rd man overflows",
  JSON.stringify(mixedOverflowIds(mm([["H", "male"], ["A", "male"], ["B", "male"]]), ["B"])) === '["B"]');
check("mixed: existing players keep their places (new one listed first still overflows)",
  JSON.stringify(mixedOverflowIds(mm([["N", "female"], ["A", "female"], ["B", "female"]]), ["N"])) === '["N"]');
check("mixed: two new women, one slot -> later one overflows",
  JSON.stringify(mixedOverflowIds(mm([["H", "female"], ["X", "female"], ["Y", "female"]]), ["X", "Y"])) === '["Y"]');
check("mixed 1 court: 3rd man fits, 4th overflows",
  JSON.stringify(mixedOverflowIds(mm([["H", "male"], ["A", "male"], ["B", "male"], ["C", "male"]]), ["B", "C"], 3)) === '["C"]');
check("mixed: unknown gender never overflows",
  mixedOverflowIds(mm([["H", "male"], ["A", "male"], ["U", undefined], ["P", "preferNotToSay"]]), ["U", "P"]).length === 0);

// ─── createdBefore ───────────────────────────────────────
const t1 = Timestamp.fromDate(at("2030-01-01T00:00:00Z"));
const t2 = Timestamp.fromDate(at("2030-01-02T00:00:00Z"));
check("createdBefore: earlier createdAt", createdBefore({ id: "Z", createdAt: t1 }, { id: "A", createdAt: t2 }));
check("createdBefore: later createdAt", !createdBefore({ id: "A", createdAt: t2 }, { id: "Z", createdAt: t1 }));
check("createdBefore: tie broken by id", createdBefore({ id: "A", createdAt: t1 }, { id: "B", createdAt: t1 })
  && !createdBefore({ id: "B", createdAt: t1 }, { id: "A", createdAt: t1 }));
check("createdBefore: missing createdAt is oldest", createdBefore({ id: "Z" }, { id: "A", createdAt: t1 }));

// ─── formatSessionTime ───────────────────────────────────
check("format in session time zone",
  formatSessionTime(start, "America/Chicago") === "Sat, Jun 1 at 1:00 PM",
  formatSessionTime(start, "America/Chicago"));
check("format falls back to UTC", formatSessionTime(start) === "Sat, Jun 1 at 6:00 PM", formatSessionTime(start));
check("format with a bad time zone falls back to UTC",
  formatSessionTime(start, "Not/AZone") === "Sat, Jun 1 at 6:00 PM", formatSessionTime(start, "Not/AZone"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Open Play checks passed");
