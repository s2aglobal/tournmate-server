/**
 * Seed script: creates 20 test player accounts and pairs them into 10 doubles teams.
 *
 * Usage:
 *   FIREBASE_API_KEY=<web-api-key> npm run seed:test-users
 *
 * Get the Web API key from Firebase Console > tournmate-dev > Project Settings > General.
 *
 * Target: tournmate-dev (via GCLOUD_PROJECT env var or default Firebase project).
 * Safe to run multiple times — skips accounts that already exist.
 *
 * Credentials follow pattern:
 *   Email:    test1@tournmate.dev … test20@tournmate.dev
 *   Password: TournMate1! … TournMate20!
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

if (getApps().length === 0) {
  initializeApp();
}

const db = getFirestore();

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
if (!FIREBASE_API_KEY) {
  console.error(
    "❌ FIREBASE_API_KEY is required.\n" +
    "   Find it at: Firebase Console > tournmate-dev > Project Settings > General > Web API Key\n" +
    "   Usage: FIREBASE_API_KEY=<key> npm run seed:test-users"
  );
  process.exit(1);
}

const AUTH_SIGNUP_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
const AUTH_LOOKUP_URL = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`;
const AUTH_SIGNIN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const AUTH_UPDATE_URL = `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${FIREBASE_API_KEY}`;

// ─── Test Player Definitions ─────────────────────────────

interface TestPlayer {
  index: number;
  name: string;
  gender: "male" | "female";
  avatarId: string;
  elo: number;
  weightKg: number;
  dobYear: number;
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

const TEAMS: [number, number][] = [
  [1, 2], [3, 4], [5, 6], [7, 8], [9, 10],
  [11, 12], [13, 14], [15, 16], [17, 18], [19, 20],
];

// ─── Helpers ─────────────────────────────────────────────

function emailFor(index: number): string {
  return `test${index}@tournmate.dev`;
}

function passwordFor(index: number): string {
  return `TournMate${index}!`;
}

function dobTimestamp(year: number): Timestamp {
  return Timestamp.fromDate(new Date(year, 5, 15));
}

/** Create a Firebase Auth user via REST API (no Admin SDK needed). */
async function createAuthUser(
  email: string, password: string, displayName: string
): Promise<string> {
  const res = await fetch(AUTH_SIGNUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  const data = await res.json();

  if (!res.ok) {
    if (data.error?.message === "EMAIL_EXISTS") {
      return signInAndGetUid(email, password);
    }
    throw new Error(`Auth signup failed: ${data.error?.message || res.statusText}`);
  }

  const uid = data.localId as string;

  // Mark email as verified + set display name
  await fetch(AUTH_UPDATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idToken: data.idToken,
      displayName,
      emailVerified: true,
    }),
  });

  return uid;
}

/** Sign in an existing user to retrieve their UID. */
async function signInAndGetUid(email: string, password: string): Promise<string> {
  const res = await fetch(AUTH_SIGNIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Auth signin failed for ${email}: ${data.error?.message || res.statusText}`);
  }

  return data.localId as string;
}

// ─── Main ────────────────────────────────────────────────

async function seedTestUsers() {
  console.log("🏸 TournMate Test User Seed Script");
  console.log("══════════════════════════════════════════\n");

  const playerIdMap = new Map<number, string>();

  for (const tp of TEST_PLAYERS) {
    const email = emailFor(tp.index);
    const password = passwordFor(tp.index);

    // 1. Create or find Firebase Auth user (via REST API)
    let uid: string;
    try {
      uid = await createAuthUser(email, password, tp.name);
    } catch (err: any) {
      console.error(`  ✗ Failed auth for ${email}: ${err.message}`);
      continue;
    }

    // 2. Clean up any existing player docs for this firebaseUid
    //    (handles re-runs, duplicates from profile setup, or lowercase UUID docs)
    const existingSnap = await db
      .collection("players")
      .where("firebaseUid", "==", uid)
      .get();

    for (const doc of existingSnap.docs) {
      await doc.ref.delete();
      console.log(`  🗑 Deleted old player doc: ${doc.id}`);
    }

    // Also clean up docs matching the email (catches profile-setup duplicates)
    const emailSnap = await db
      .collection("players")
      .where("email", "==", email)
      .get();

    for (const doc of emailSnap.docs) {
      await doc.ref.delete();
      console.log(`  🗑 Deleted duplicate by email: ${doc.id}`);
    }

    // 3. Create fresh Firestore player doc with uppercase UUID (matches iOS convention)
    const playerId = crypto.randomUUID().toUpperCase();
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
      homeCountryCode: "US",
      homePostalCode: "78641",
      createdAt: Timestamp.now(),
    });

    playerIdMap.set(tp.index, playerId);
    console.log(`  ✓ ${tp.name} — ${email}  uid:${uid.slice(0, 8)}…  doc:${playerId.slice(0, 8)}…  ELO ${tp.elo}`);
  }

  // 3. Print team pairings
  console.log("\n── Doubles Teams ──────────────────────────\n");
  for (let i = 0; i < TEAMS.length; i++) {
    const [a, b] = TEAMS[i];
    const pa = TEST_PLAYERS.find((p) => p.index === a)!;
    const pb = TEST_PLAYERS.find((p) => p.index === b)!;
    const idA = playerIdMap.get(a);
    const idB = playerIdMap.get(b);
    console.log(
      `  Team ${i + 1}: ${pa.name} (${idA?.slice(0, 8) ?? "??"}…) + ${pb.name} (${idB?.slice(0, 8) ?? "??"}…)`
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
