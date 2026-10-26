import { Firestore, Timestamp, Transaction, QueryDocumentSnapshot } from "firebase-admin/firestore";

/** Duration assumed for sessions written without one (old apps). */
export const LEGACY_SESSION_MINUTES = 120;

/** Open Play size by game type: singles 2, everything else (doubles/mixed/any) 4. */
export function capacityFor(gameTypeRaw: unknown): number {
  return gameTypeRaw === "singles" ? 2 : 4;
}

/**
 * When a session runs. Uses `endsAt` when the server wrote it, else
 * `date + durationMinutes` (missing duration = 120 min).
 */
export function sessionWindow(session: FirebaseFirestore.DocumentData): { start: Date; end: Date } {
  const start = toDate(session.date) ?? new Date(0);
  const endsAt = toDate(session.endsAt);
  if (endsAt) return { start, end: endsAt };
  const minutes = typeof session.durationMinutes === "number" && session.durationMinutes > 0
    ? session.durationMinutes
    : LEGACY_SESSION_MINUTES;
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
}

/**
 * Active sessions the player attends whose window overlaps [start, end),
 * excluding `excludeSessionId`. Matches the player id in either case.
 * Pass `tx` to read inside a transaction.
 */
export async function findClashingSessions(
  db: Firestore,
  playerId: string,
  start: Date,
  end: Date,
  excludeSessionId?: string | null,
  tx?: Transaction,
): Promise<QueryDocumentSnapshot[]> {
  const ids = [...new Set([playerId, playerId.toUpperCase(), playerId.toLowerCase()])];
  const q = db.collection("playSessions").where("attendeeIds", "array-contains-any", ids);
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.docs.filter((doc) => {
    if (doc.id === excludeSessionId) return false;
    const data = doc.data();
    if ((data.status ?? "active") !== "active") return false;
    const w = sessionWindow(data);
    return w.start < end && start < w.end;
  });
}

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}
