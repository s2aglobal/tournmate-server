import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { DocumentData, getFirestore } from "firebase-admin/firestore";
import { rebuildStandings } from "./onMatchWritten";

/** Registration fields the standings never read (server bookkeeping). */
const IGNORED_FIELDS = new Set(["memberUids"]);

/**
 * Rebuilds `standings/{tournamentId}` when a registration is created,
 * updated (team rename, roster, partner) or deleted (withdraw), from the
 * callables and older apps alike. Writes that only touch server bookkeeping
 * (`memberUids`) are skipped, so the memberUids trigger's own update doesn't
 * rebuild twice.
 */
export const onRegistrationWrittenStandings = onDocumentWritten(
  "registrations/{registrationId}",
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (before && after && sameIgnoring(before, after)) return;
    const ids = new Set([before?.tournamentId, after?.tournamentId]
      .filter((id): id is string => typeof id === "string" && id.length > 0));
    const db = getFirestore();
    for (const tournamentId of ids) {
      try {
        await rebuildStandings(db, tournamentId);
      } catch (err) {
        logger.error(`Standings rebuild failed for tournament ${tournamentId}:`, err);
      }
    }
  },
);

function sameIgnoring(a: DocumentData, b: DocumentData): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}
