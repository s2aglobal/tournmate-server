/**
 * Seed script: creates 20 test player accounts and pairs them into 10 doubles teams.
 *
 * Usage:
 *   npm run seed:test-users
 *
 * Target: tournmate-dev (default Firebase project).
 * Safe to run multiple times — skips accounts that already exist.
 *
 * Credentials follow pattern:
 *   Email:    test1@tournmate.dev … test20@tournmate.dev
 *   Password: TournMate1! … TournMate20!
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

if (getApps().length === 0) {
  initializeApp();
}

const auth = getAuth();
const db = getFirestore();

// ─── Test Player Definitions ─────────────────────────────

interface TestPlayer {
  index: number;
  name: string;
  gender: "male" | "female";
  avatarId: string;
  elo: number;
  weightKg: number;
  dobYear: number; // birth year — age derived from this
}

const avatars = [
  "shuttlecock", "racket", "champion", "flame", "bolt",
  "ace", "smash", "rally", "drop", "serve",
  "leaf", "star", "heart", "moon", "sun",
  "phoenix", "eagle", "tiger", "panda", "ninja",
];

const TEST_PLAYERS: TestPlayer[] = [
  { index: 1,  name: "Aiden Test",     gender: "male",   avatarId: avatars[0],  elo: 1350, weightKg: 75, dobYear: 1995 },
  { index: 2,  name: "Riley Test",     gender: "female", avatarId: avatars[1],  elo: 1280, weightKg: 60, dobYear: 1998 },
  { index: 3,  name: "Marcus Test",    gender: "male",   avatarId: avatars[2],  elo: 1420, weightKg: 82, dobYear: 1992 },
  { index: 4,  name: "Sophia Test",    gender: "female", avatarId: avatars[3],  elo: 1310, weightKg: 58, dobYear: 1997 },
  { index: 5,  name: "Leo Test",       gender: "male",   avatarId: avatars[4],  elo: 1200, weightKg: 70, dobYear: 2000 },
  { index: 6,  name: "Mika Test",      gender: "female", avatarId: avatars[5],  elo: 1250, weightKg: 55, dobYear: 1999 },
  { index: 7,  name: "Jaden Test",     gender: "male",   avatarId: avatars[6],  elo: 1500, weightKg: 78, dobYear: 1990 },
  { index: 8,  name: "Nora Test",      gender: "female", avatarId: avatars[7],  elo: 1380, weightKg: 62, dobYear: 1996 },
  { index: 9,  name: "Felix Test",     gender: "male",   avatarId: avatars[8],  elo: 1150, weightKg: 68, dobYear: 2002 },
  { index: 10, name: "Luna Test",      gender: "female", avatarId: avatars[9],  elo: 1330, weightKg: 57, dobYear: 1994 },
  { index: 11, name: "Elijah Test",    gender: "male",   avatarId: avatars[10], elo: 1270, weightKg: 85, dobYear: 1988 },
  { index: 12, name: "Harper Test",    gender: "female", avatarId: avatars[11], elo: 1400, weightKg: 63, dobYear: 1993 },
  { index: 13, name: "Roman Test",     gender: "male",   avatarId: avatars[12], elo: 1220, weightKg: 73, dobYear: 2001 },
  { index: 14, name: "Aria Test",      gender: "female", avatarId: avatars[13], elo: 1360, weightKg: 56, dobYear: 1997 },
  { index: 15, name: "Dante Test",     gender: "male",   avatarId: avatars[14], elo: 1450, weightKg: 80, dobYear: 1991 },
  { index: 16, name: "Chloe Test",     gender: "female", avatarId: avatars[15], elo: 1190, weightKg: 54, dobYear: 2000 },
  { index: 17, name: "Skyler Test",    gender: "male",   avatarId: avatars[16], elo: 1340, weightKg: 77, dobYear: 1994 },
  { index: 18, name: "Sadie Test",     gender: "female", avatarId: avatars[17], elo: 1300, weightKg: 59, dobYear: 1996 },
  { index: 19, name: "Miles Test",     gender: "male",   avatarId: avatars[18], elo: 1260, weightKg: 71, dobYear: 1999 },
  { index: 20, name: "Olive Test",     gender: "female", avatarId: avatars[19], elo: 1230, weightKg: 61, dobYear: 1998 },
];

// Doubles teams: pairs of player indices (1-based)
const TEAMS: [number, number][] = [
  [1, 2],   // Team 1: Aiden + Riley  (mixed)
  [3, 4],   // Team 2: Marcus + Sophia (mixed)
  [5, 6],   // Team 3: Leo + Mika (mixed)
  [7, 8],   // Team 4: Jaden + Nora (mixed)
  [9, 10],  // Team 5: Felix + Luna (mixed)
  [11, 12], // Team 6: Elijah + Harper (mixed)
  [13, 14], // Team 7: Roman + Aria (mixed)
  [15, 16], // Team 8: Dante + Chloe (mixed)
  [17, 18], // Team 9: Skyler + Sadie (mixed)
  [19, 20], // Team 10: Miles + Olive (mixed)
];

// ─── Helpers ─────────────────────────────────────────────

function emailFor(index: number): string {
  return `test${index}@tournmate.dev`;
}

function passwordFor(index: number): string {
  return `TournMate${index}!`;
}

function dobTimestamp(year: number): Timestamp {
  return Timestamp.fromDate(new Date(year, 5, 15)); // June 15 of birth year
}

// ─── Main ────────────────────────────────────────────────

async function seedTestUsers() {
  console.log("🏸 TournMate Test User Seed Script");
  console.log("══════════════════════════════════════════\n");

  const playerIdMap = new Map<number, string>(); // index -> Firestore doc ID

  for (const tp of TEST_PLAYERS) {
    const email = emailFor(tp.index);
    const password = passwordFor(tp.index);

    // 1. Create or find Firebase Auth user
    let uid: string;
    try {
      const existing = await auth.getUserByEmail(email);
      uid = existing.uid;
      console.log(`  ✓ Auth exists: ${email} (${uid})`);
    } catch {
      const created = await auth.createUser({
        email,
        password,
        displayName: tp.name,
        emailVerified: true,
      });
      uid = created.uid;
      console.log(`  + Auth created: ${email} (${uid})`);
    }

    // 2. Create or find Firestore player doc
    const existingSnap = await db
      .collection("players")
      .where("firebaseUid", "==", uid)
      .limit(1)
      .get();

    let playerId: string;
    if (!existingSnap.empty) {
      playerId = existingSnap.docs[0].id;
      console.log(`  ✓ Player exists: ${tp.name} (${playerId})`);
    } else {
      playerId = crypto.randomUUID();
      await db.collection("players").doc(playerId).set({
        name: tp.name,
        phone: "",
        email: email,
        genderRaw: tp.gender,
        elo: tp.elo,
        streak: 0,
        firebaseUid: uid,
        avatarId: tp.avatarId,
        weightKg: tp.weightKg,
        dateOfBirth: dobTimestamp(tp.dobYear),
        createdAt: Timestamp.now(),
      });
      console.log(`  + Player created: ${tp.name} (${playerId}) ELO ${tp.elo}`);
    }

    playerIdMap.set(tp.index, playerId);
  }

  // 3. Print team pairings
  console.log("\n── Doubles Teams ──────────────────────────\n");
  for (let i = 0; i < TEAMS.length; i++) {
    const [a, b] = TEAMS[i];
    const pa = TEST_PLAYERS.find((p) => p.index === a)!;
    const pb = TEST_PLAYERS.find((p) => p.index === b)!;
    const idA = playerIdMap.get(a)!;
    const idB = playerIdMap.get(b)!;
    console.log(
      `  Team ${i + 1}: ${pa.name} (${idA.slice(0, 8)}…) + ${pb.name} (${idB.slice(0, 8)}…)`
    );
  }

  // 4. Print login credentials
  console.log("\n── Login Credentials ──────────────────────\n");
  console.log("  #   Email                        Password");
  console.log("  ─── ──────────────────────────── ──────────────");
  for (const tp of TEST_PLAYERS) {
    const num = String(tp.index).padStart(2, " ");
    const email = emailFor(tp.index).padEnd(28);
    console.log(`  ${num}  ${email} ${passwordFor(tp.index)}`);
  }

  console.log("\n══════════════════════════════════════════");
  console.log("✅ Seed complete: 20 players, 10 teams ready.");
  console.log("   Use these credentials to log in on Release-Dev builds.\n");
}

seedTestUsers()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  });
