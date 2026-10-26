import { onCall } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { fail } from "./errors";
import { CALLABLE_OPTS, dataOf, requirePlayer, requireUid } from "./shared";

/**
 * setGender({ gender: "male" | "female" }) -> { gender }
 * One-time: allowed only while the stored gender is missing or
 * `preferNotToSay` (GENDER_LOCKED otherwise; same value again is a no-op).
 */
export const setGender = onCall(CALLABLE_OPTS, async (req) => {
  const uid = requireUid(req);
  const gender = dataOf(req).gender;
  if (gender !== "male" && gender !== "female") {
    fail("invalid-argument", "INVALID_ARGUMENT", "Choose male or female.");
  }
  const db = getFirestore();
  await db.runTransaction(async (tx) => {
    const me = await requirePlayer(db, uid, tx);
    const current = me.data.genderRaw;
    if (current === gender) return;
    if (current && current !== "preferNotToSay") {
      fail("failed-precondition", "GENDER_LOCKED", "Your gender is already set and can't be changed.");
    }
    tx.update(me.ref, { genderRaw: gender });
  });
  return { gender };
});
