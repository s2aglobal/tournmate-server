import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import {
  memberUidsFor, sameMembers, syncMatchMemberUids, syncMatchesForRegistration,
} from "../services/memberUids";

/**
 * Keeps `registrations.memberUids` current on any registration write
 * (callables and old apps alike), then the `teamAUids`/`teamBUids` of the
 * matches it plays in. Writes only when the set changed, so its own update
 * ends the loop.
 */
export const onRegistrationWrittenMemberUids = onDocumentWritten(
  "registrations/{registrationId}",
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const db = getFirestore();
    const uids = await memberUidsFor(db, after.data()!);
    if (!sameMembers(after.get("memberUids"), uids)) {
      await after.ref.update({ memberUids: uids });
      return; // the update re-fires this trigger, which syncs the matches
    }
    const before = event.data?.before;
    if (!before?.exists || !sameMembers(before.get("memberUids"), uids)) {
      await syncMatchesForRegistration(db, event.params.registrationId);
    }
  },
);

/** Sets `teamAUids`/`teamBUids` when a match is created or its sides change. */
export const onMatchWrittenMemberUids = onDocumentWritten(
  "matches/{matchId}",
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const before = event.data?.before;
    const sidesChanged = !before?.exists
      || before.get("teamAId") !== after.get("teamAId")
      || before.get("teamBId") !== after.get("teamBId");
    const missing = !Array.isArray(after.get("teamAUids")) || !Array.isArray(after.get("teamBUids"));
    if (!sidesChanged && !missing) return;
    await syncMatchMemberUids(getFirestore(), event.params.matchId);
  },
);
