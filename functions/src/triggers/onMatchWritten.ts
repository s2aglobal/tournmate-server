import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { DocumentReference, Firestore, Timestamp, getFirestore } from "firebase-admin/firestore";
import { MatchDoc, PlayerDoc, RegistrationDoc, TournamentDoc } from "../types";
import { StandingsRegistration, computeStandings } from "../services/standings";

/**
 * Rebuilds `standings/{tournamentId}` on any match write (create, score,
 * delete), including direct writes from older app versions.
 *
 * Every run is a full, idempotent rebuild from the current documents, so
 * bursts of writes (a draw, a reset) need no debouncing. `updatedAt` is the
 * time the matches were read; a run that read older data never overwrites a
 * newer table.
 */
export const onMatchWritten = onDocumentWritten("matches/{matchId}", async (event) => {
  const before = event.data?.before.data() as MatchDoc | undefined;
  const after = event.data?.after.data() as MatchDoc | undefined;
  const ids = new Set([before?.tournamentId, after?.tournamentId].filter((id): id is string => !!id));
  const db = getFirestore();
  for (const tournamentId of ids) {
    try {
      await rebuildStandings(db, tournamentId);
    } catch (err) {
      logger.error(`Standings rebuild failed for tournament ${tournamentId}:`, err);
    }
  }
});

/** Player names by id; ids are tried as stored, then upper and lower case. */
async function playerNames(db: Firestore, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(ids)];
  const fetch = async (candidates: string[]) => {
    if (candidates.length === 0) return [];
    const refs: DocumentReference[] = candidates.map((id) => db.collection("players").doc(id));
    return db.getAll(...refs);
  };
  for (const snap of await fetch(unique)) {
    if (snap.exists) names.set(snap.id, (snap.data() as PlayerDoc).name ?? "");
  }
  const missing = unique.filter((id) => !names.has(id));
  const variants = [...new Set(missing.flatMap((id) => [id.toUpperCase(), id.toLowerCase()]))]
    .filter((v) => !unique.includes(v));
  const found = new Map<string, string>();
  for (const snap of await fetch(variants)) {
    if (snap.exists) found.set(snap.id, (snap.data() as PlayerDoc).name ?? "");
  }
  for (const id of missing) {
    const name = found.get(id.toUpperCase()) ?? found.get(id.toLowerCase());
    if (name !== undefined) names.set(id, name);
  }
  return names;
}

export async function rebuildStandings(db: Firestore, tournamentId: string): Promise<void> {
  const standingsRef = db.collection("standings").doc(tournamentId);
  const tournamentSnap = await db.collection("tournaments").doc(tournamentId).get();
  if (!tournamentSnap.exists) {
    await standingsRef.delete();
    return;
  }
  const tournament = tournamentSnap.data() as TournamentDoc;

  const matchesSnap = await db.collection("matches").where("tournamentId", "==", tournamentId).get();
  const regsSnap = await db.collection("registrations").where("tournamentId", "==", tournamentId).get();

  const regDocs = regsSnap.docs.map((d) => ({ id: d.id, doc: d.data() as RegistrationDoc }));
  const names = await playerNames(db, regDocs.flatMap((r) =>
    [r.doc.playerId, r.doc.partnerId].filter((id): id is string => typeof id === "string" && id.length > 0)));
  const registrations: StandingsRegistration[] = regDocs.map((r) => ({
    id: r.id,
    doc: r.doc,
    playerName: typeof r.doc.playerId === "string" ? names.get(r.doc.playerId) ?? null : null,
    partnerName: typeof r.doc.partnerId === "string" ? names.get(r.doc.partnerId) ?? null : null,
  }));

  const data = computeStandings(
    tournament,
    registrations,
    matchesSnap.docs.map((d) => ({ id: d.id, doc: d.data() as MatchDoc })),
  );
  const readTime: Timestamp = matchesSnap.readTime;

  await db.runTransaction(async (tx) => {
    const current = await tx.get(standingsRef);
    const stored = current.get("updatedAt");
    if (stored instanceof Timestamp && (stored.seconds > readTime.seconds ||
      (stored.seconds === readTime.seconds && stored.nanoseconds > readTime.nanoseconds))) return;
    tx.set(standingsRef, { updatedAt: readTime, ...data });
  });
}
