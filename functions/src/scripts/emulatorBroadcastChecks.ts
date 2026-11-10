/**
 * Emulator checks for sendBroadcast: seeds demo players and runs the audience
 * logic with a FAKE FCM sender (nothing is ever sent). Firestore emulator and
 * a demo-* project only.
 *
 * Usage (from tournmate-server/functions): npm run test:emulator-broadcast
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Message } from "firebase-admin/messaging";
import { runBroadcast, DEFAULT_TITLE, DEFAULT_BODY, Sender } from "./sendBroadcast";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore emulator and a demo-* project (use npm run test:emulator-broadcast).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });
const db = getFirestore();

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

class FakeSender implements Sender {
  batches: Message[][] = [];
  constructor(private failTokens: Record<string, string> = {}) {}
  async sendEach(messages: Message[]) {
    this.batches.push(messages);
    return {
      responses: messages.map((m) => {
        const code = this.failTokens[(m as { token: string }).token];
        return code ? { success: false, error: { code } } : { success: true };
      }),
    };
  }
}
const quiet = () => undefined;
const base = { title: DEFAULT_TITLE, body: DEFAULT_BODY, apply: false };

async function main(): Promise<void> {
  const players: Array<Record<string, unknown>> = [
    { name: "Alice", firebaseUid: "u1", fcmToken: "tok-a", preferredSport: "badminton" },
    { name: "Bob", firebaseUid: "u2", fcmToken: "tok-b", preferredSport: "pickleball" },
    { name: "Cara", firebaseUid: "u3", preferredSport: "badminton" },               // no token
    { name: "Dan", firebaseUid: "u4", fcmToken: null, preferredSport: "tennis" },   // null token
    { name: "Eve", firebaseUid: "u5", fcmToken: "tok-a", preferredSport: "badminton" }, // dup of Alice
    { name: "Fay", firebaseUid: "u6", fcmToken: "tok-f", marketingOptOut: true },  // opt-out
    { name: "Gus", firebaseUid: "u7", fcmToken: "tok-g" },                          // default sport badminton
    { name: "Hal", firebaseUid: "u8", fcmToken: "tok-h", preferredSport: "pickleball" },
  ];
  for (const [i, p] of players.entries()) await db.collection("players").doc(`p${i}`).set(p);
  // big audience for batching
  const bulk = db.batch();
  for (let i = 0; i < 1200; i++) {
    bulk.set(db.collection("players").doc(`bulk${i}`), { name: `Bulk ${i}`, fcmToken: `bulk-${i}`, preferredSport: "badminton" });
  }
  await bulk.commit();

  // Dry run, pickleball only: Bob + Hal
  let s = new FakeSender();
  let r = await runBroadcast(db, s, { ...base, sport: "pickleball" }, quiet);
  check("dry run sends nothing", s.batches.length === 0 && r.sent === 0);
  check("pickleball audience = 2", r.audience === 2, `got ${r.audience}`);
  check("sample has names", r.sample.length === 2 && r.sample.some((x) => x.startsWith("Bob")));

  // Full dry run counts
  s = new FakeSender();
  r = await runBroadcast(db, s, base, quiet);
  check("scanned all", r.scanned === 1208, `got ${r.scanned}`);
  check("no-token skipped = 2", r.skippedNoToken === 2, `got ${r.skippedNoToken}`);
  check("opt-out skipped = 1", r.skippedOptOut === 1, `got ${r.skippedOptOut}`);
  check("dup skipped = 1", r.skippedDuplicate === 1, `got ${r.skippedDuplicate}`);
  check("audience = 1204", r.audience === 1204, `got ${r.audience}`);
  check("sample capped at 3", r.sample.length === 3);

  // --limit
  r = await runBroadcast(db, s, { ...base, limit: 5 }, quiet);
  check("limit 5", r.audience === 5);

  // --test-uid
  s = new FakeSender();
  r = await runBroadcast(db, s, { ...base, testUid: "u2", apply: true }, quiet);
  check("test-uid sends exactly 1", r.sent === 1 && s.batches.length === 1 && s.batches[0].length === 1);
  const m = s.batches[0][0] as Message & { token: string; data: Record<string, string> };
  check("test-uid token + payload", m.token === "tok-b" && m.data.type === "announcement" &&
    (m as { notification?: { title?: string } }).notification?.title === DEFAULT_TITLE);
  s = new FakeSender();
  r = await runBroadcast(db, s, { ...base, testUid: "u6", apply: true }, quiet);
  check("test-uid respects opt-out", r.sent === 0 && r.skippedOptOut === 1);

  // Apply: batching 500 and failure counting
  s = new FakeSender({ "bulk-1": "messaging/registration-token-not-registered", "bulk-2": "messaging/internal-error" });
  r = await runBroadcast(db, s, { ...base, apply: true }, quiet);
  check("batches of 500", s.batches.map((b) => b.length).join(",") === "500,500,204", s.batches.map((b) => b.length).join(","));
  check("sent/failed counts", r.sent === 1202 && r.failed === 2 && r.invalidTokens === 1, `${r.sent}/${r.failed}/${r.invalidTokens}`);
  const tokens = s.batches.flat().map((x) => (x as { token: string }).token);
  check("tokens deduped", new Set(tokens).size === tokens.length);
  check("opt-out/no-token never sent", !tokens.includes("tok-f"));
  const inbox = await db.collection("notifications").get();
  check("no inbox docs written", inbox.empty);
  const dan = (await db.collection("players").doc("p3").get()).data();
  check("player docs untouched", dan?.fcmToken === null);

  if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
  console.log("All broadcast checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
