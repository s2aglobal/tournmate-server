/**
 * One-off broadcast push to players (e.g. a holiday message). DRY RUN by default.
 *
 * How it sends: the same per-device FCM token push the app uses everywhere
 * (`players/{id}.fcmToken`, see services/notifications.ts `sendToPlayer`), just
 * batched with `sendEach` (500 per call). Payload matches existing pushes
 * (notification + `data.type`, APNs badge/sound, Android high priority).
 *
 * - Audience: players with a non-empty fcmToken; tokens deduped. There is NO
 *   server-side notification opt-out/marketing field today (the OS permission is
 *   the only opt-out), so none is applied except a defensive skip of any
 *   explicit false/true flags listed in OPT_OUT_FIELDS.
 * - Invalid tokens: existing code only logs "stale FCM token" (the scheduled job
 *   nulls tokens of never-active players). Same here: counted and reported in
 *   the summary, nothing is written to Firestore. This script is read-only.
 * - Inbox: no `notifications` docs are written. The apps already save every
 *   received push into their local inbox; a Firestore doc would duplicate it.
 *
 * Usage (from tournmate-server/functions), credentials on your own machine only:
 *   npm run send:broadcast -- --project tournmate-dev                      # dry run
 *   npm run send:broadcast -- --project tournmate-dev --test-uid <uid> --apply
 *   npm run send:broadcast -- --project tournmate-prod --apply
 * Options: --title, --body, --sport <sport>, --limit N, --test-uid <uid>, --apply
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import { getMessaging, Message } from "firebase-admin/messaging";
import { isSportType, parseSportType } from "../types";

export const DEFAULT_TITLE = "Happy Veterans Day 🇺🇸";
export const DEFAULT_BODY =
  "Thank you to all who served. Grab your crew and get a game in today — host an open play or join a tournament on TournMate.";
export const BATCH_SIZE = 500;
export const ALLOWED_PROJECTS = ["tournmate-dev", "tournmate-prod"];

/** Fields that would mean "don't send": [field, value that opts out]. None exist in the apps today. */
export const OPT_OUT_FIELDS: ReadonlyArray<[string, unknown]> = [
  ["notificationsEnabled", false],
  ["pushEnabled", false],
  ["marketingOptOut", true],
  ["pushOptOut", true],
];

export interface BroadcastOptions {
  title: string;
  body: string;
  sport?: string;
  limit?: number;
  testUid?: string;
  apply: boolean;
}

/** Subset of firebase-admin Messaging used here (injectable for tests). */
export interface Sender {
  sendEach(messages: Message[]): Promise<{
    responses: Array<{ success: boolean; error?: { code?: string } }>;
  }>;
}

export interface Recipient { token: string; name: string; sport: string; uid?: string }
export interface BroadcastResult {
  scanned: number;
  skippedNoToken: number;
  skippedOptOut: number;
  skippedSport: number;
  skippedDuplicate: number;
  audience: number;
  bySport: Record<string, number>;
  sample: string[];
  sent: number;
  failed: number;
  invalidTokens: number;
}

export function buildMessage(token: string, title: string, body: string): Message {
  return {
    token,
    notification: { title, body },
    data: { type: "announcement" },
    apns: { payload: { aps: { sound: "default", badge: 1 } } },
    android: { priority: "high" as const },
  };
}

export async function collectAudience(
  db: Firestore,
  opts: BroadcastOptions,
): Promise<{ recipients: Recipient[]; result: BroadcastResult }> {
  const result: BroadcastResult = {
    scanned: 0, skippedNoToken: 0, skippedOptOut: 0, skippedSport: 0, skippedDuplicate: 0,
    audience: 0, bySport: {}, sample: [], sent: 0, failed: 0, invalidTokens: 0,
  };
  const snap = await db.collection("players").get();
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  for (const doc of snap.docs) {
    const p = doc.data();
    if (opts.testUid && p.firebaseUid !== opts.testUid) continue;
    result.scanned++;
    const token = typeof p.fcmToken === "string" ? p.fcmToken.trim() : "";
    if (!token) { result.skippedNoToken++; continue; }
    if (OPT_OUT_FIELDS.some(([f, v]) => p[f] === v)) { result.skippedOptOut++; continue; }
    const sport = parseSportType(p.preferredSport);
    if (opts.sport && sport !== opts.sport) { result.skippedSport++; continue; }
    if (seen.has(token)) { result.skippedDuplicate++; continue; }
    seen.add(token);
    recipients.push({ token, name: String(p.name ?? "(no name)"), sport, uid: p.firebaseUid });
  }
  const limited = opts.limit !== undefined ? recipients.slice(0, opts.limit) : recipients;
  for (const r of limited) result.bySport[r.sport] = (result.bySport[r.sport] ?? 0) + 1;
  result.audience = limited.length;
  result.sample = limited.slice(0, 3).map((r) => `${r.name} (${r.sport})`);
  return { recipients: limited, result };
}

export async function runBroadcast(
  db: Firestore,
  sender: Sender,
  opts: BroadcastOptions,
  log: (s: string) => void = console.log,
): Promise<BroadcastResult> {
  const { recipients, result } = await collectAudience(db, opts);
  log(`Scanned players:        ${result.scanned}`);
  log(`Skipped (no token):     ${result.skippedNoToken}`);
  log(`Skipped (opt-out):      ${result.skippedOptOut}`);
  log(`Skipped (other sport):  ${result.skippedSport}`);
  log(`Skipped (dup token):    ${result.skippedDuplicate}`);
  log(`Audience:               ${result.audience}`);
  log(`By platform:            not stored on player docs (single fcmToken, no platform field)`);
  log(`By sport:               ${JSON.stringify(result.bySport)}`);
  log(`Sample recipients:      ${result.sample.join("; ") || "(none)"}`);
  log(`Title: ${opts.title}\nBody:  ${opts.body}`);

  if (!opts.apply) {
    log("\nDRY RUN: nothing sent. Re-run with --apply to send.");
    return result;
  }

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const chunk = recipients.slice(i, i + BATCH_SIZE);
    const res = await sender.sendEach(chunk.map((r) => buildMessage(r.token, opts.title, opts.body)));
    for (const r of res.responses) {
      if (r.success) { result.sent++; continue; }
      result.failed++;
      const code = r.error?.code;
      if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
        result.invalidTokens++;
      }
    }
    log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${chunk.length} attempted`);
  }
  const skipped = result.skippedNoToken + result.skippedOptOut + result.skippedSport + result.skippedDuplicate;
  log(`\nSUMMARY: sent=${result.sent} failed=${result.failed} (invalid tokens: ${result.invalidTokens}, not removed) skipped=${skipped}`);
  return result;
}

function parseArgs(argv: string[]): { project: string; opts: BroadcastOptions } {
  const flags: Record<string, string | boolean> = {};
  const withValue = new Set(["project", "title", "body", "sport", "limit", "test-uid"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    let [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (k === "apply") { flags.apply = true; continue; }
    if (!withValue.has(k)) throw new Error(`Unknown argument: --${k}`);
    if (v === undefined) v = argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    flags[k] = v;
  }
  const project = String(flags.project ?? "");
  if (!ALLOWED_PROJECTS.includes(project)) {
    throw new Error(`--project is required: one of ${ALLOWED_PROJECTS.join(", ")}`);
  }
  const sport = flags.sport as string | undefined;
  if (sport !== undefined && !isSportType(sport)) throw new Error(`Unknown --sport "${sport}"`);
  let limit: number | undefined;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  }
  return {
    project,
    opts: {
      title: (flags.title as string) ?? DEFAULT_TITLE,
      body: (flags.body as string) ?? DEFAULT_BODY,
      sport, limit,
      testUid: flags["test-uid"] as string | undefined,
      apply: flags.apply === true,
    },
  };
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const { project, opts } = parsed;
  if (getApps().length === 0) initializeApp({ projectId: project });
  console.log(`Project ${project}${opts.apply ? " (APPLY: will send)" : " (dry run)"}`);
  if (opts.apply && !opts.testUid) {
    console.log("Sending to ALL matching players in 5 seconds. Ctrl-C to abort.");
    await new Promise((r) => setTimeout(r, 5000));
  }
  await runBroadcast(getFirestore(), getMessaging(), opts);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
