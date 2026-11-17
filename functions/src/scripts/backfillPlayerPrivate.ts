/**
 * Player privacy backfill (player-privacy-design.md 8). DRY RUN by default.
 *
 * Copies the private fields of every players/{id} doc into playerPrivate/{id}
 * (email from Firebase Auth when the player has a firebaseUid), and with
 * --scrub blanks / removes them from the public doc. Prints COUNTS ONLY,
 * never emails, phones or tokens, so the output is safe to paste into chat.
 *
 *   (default)          dry run: counts, nothing written
 *   --apply            upsert playerPrivate/{id} (merge, source "backfill"; a
 *                      private doc written after the player's last write keeps
 *                      its values, only missing keys are filled). Batches of 400.
 *   --apply --scrub    also, in the same batch: public email/phone -> "" and
 *                      dateOfBirth / homePostalCode / weightKg / fcmToken deleted
 *                      (only for values the private doc holds), then verify
 *   --tier1            with --scrub: email / phone only
 *   --verify           only the verify pass (exit 1 if a public doc still holds data)
 *   --restore          rollback: write private values back onto public docs where
 *                      the public value is blank / missing (needs --apply to write)
 *
 * Also reports how many tournaments are cricket or team format (the fast-path
 * signal: old apps offer the email/phone teammate lookup only there).
 *
 * Project: tournmate-dev by default; anything else must be named with --project.
 * Credentials: `gcloud auth application-default login` (PERSONAL LAPTOP ONLY).
 *
 * Usage (from tournmate-server/functions):
 *   npm run backfill:player-private -- --project tournmate-dev                  # dry run
 *   npm run backfill:player-private -- --project tournmate-dev --apply          # copy
 *   npm run backfill:player-private -- --project tournmate-prod --apply --scrub --tier1   # fast path
 *   npm run backfill:player-private -- --project tournmate-prod --apply --scrub  # phase 3
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { DocumentData, DocumentSnapshot, FieldPath, Firestore, Timestamp, WriteBatch, getFirestore } from "firebase-admin/firestore";
import {
  CONTACT_FIELDS, PLAYER_PRIVATE, ScrubMode, TIER2_FIELDS, hasValue, normalizeEmail, phoneDigits, planMirror,
} from "../services/playerPrivate";

export interface BackfillOptions {
  apply: boolean;
  scrub: ScrubMode;
  restore: boolean;
  verifyOnly: boolean;
}

export interface BackfillCounts {
  players: number;
  withEmail: number;
  withPhone: number;
  withDateOfBirth: number;
  withPostalCode: number;
  withWeight: number;
  withToken: number;
  noFirebaseUid: number;
  contactKeysMissing: number;
  privateExisting: number;
  privateToCreate: number;
  privateToUpdate: number;
  privateNewerKept: number;
  authEmailMismatch: number;
  authUserMissing: number;
  publicToScrub: number;
  scrubRefused: number;
  publicToRestore: number;
  writes: number;
  skippedChanged: number;
  teamOrCricketTournaments: number;
  playersInTeamOrCricket: number;
}

export interface VerifyCounts {
  players: number;
  publicWithContact: number;
  publicWithTier2: number;
  missingPrivate: number;
  ok: boolean;
}

/** uid -> lower-case Auth email ("" when the user has none), null when the user doesn't exist. */
export type AuthEmails = (uids: string[]) => Promise<Map<string, string | null>>;

export const firebaseAuthEmails: AuthEmails = async (uids) => {
  const out = new Map<string, string | null>();
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    const res = await getAuth().getUsers(chunk.map((uid) => ({ uid })));
    for (const u of res.users) out.set(u.uid, normalizeEmail(u.email ?? ""));
    for (const id of res.notFound) out.set((id as { uid: string }).uid, null);
  }
  return out;
};

const PAGE = 300;
const BATCH_LIMIT = 400;

async function forEachPlayerPage(db: Firestore, fn: (docs: DocumentSnapshot[]) => Promise<void>): Promise<void> {
  let last: DocumentSnapshot | undefined;
  for (;;) {
    let q = db.collection("players").orderBy(FieldPath.documentId()).limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) return;
    await fn(snap.docs);
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) return;
  }
}

class Batcher {
  private units: ((b: WriteBatch) => number)[] = [];
  private ops = 0;
  writes = 0;
  /** Docs that changed while the script ran (their own trigger run handles them). */
  skippedChanged = 0;
  constructor(private db: Firestore, private apply: boolean) {}
  /** Adds writes that must land together (private copy + public scrub). */
  async add(write: (b: WriteBatch) => number): Promise<void> {
    if (!this.apply) return;
    if (this.ops >= BATCH_LIMIT) await this.flush();
    this.ops += write(this.db.batch());
    this.units.push(write);
  }
  async flush(): Promise<void> {
    if (this.units.length === 0) return;
    const units = this.units;
    this.units = [];
    this.ops = 0;
    const batch = this.db.batch();
    const n = units.reduce((sum, u) => sum + u(batch), 0);
    try {
      await batch.commit();
      this.writes += n;
    } catch (err) {
      if (!isChanged(err)) throw err;
      // A player doc changed since it was read: commit one by one, skip those.
      for (const u of units) {
        const one = this.db.batch();
        const k = u(one);
        try {
          await one.commit();
          this.writes += k;
        } catch (e) {
          if (!isChanged(e)) throw e;
          this.skippedChanged++;
        }
      }
    }
  }
}

function isChanged(err: unknown): boolean {
  const code = (err as { code?: number | string }).code;
  return code === 9 || code === 5 || code === "failed-precondition" || code === "not-found";
}

/** Cricket / team-format tournaments and how many distinct players are registered in them. */
async function teamFormatSignal(db: Firestore): Promise<{ tournaments: number; players: number }> {
  const [team, cricket] = await Promise.all([
    db.collection("tournaments").where("formatRaw", "==", "team").get(),
    db.collection("tournaments").where("sportType", "==", "cricket").get(),
  ]);
  const ids = new Set([...team.docs, ...cricket.docs].map((d) => d.id));
  const players = new Set<string>();
  const list = [...ids];
  for (let i = 0; i < list.length; i += 10) {
    const variants = list.slice(i, i + 10).flatMap((id) => [id, id.toUpperCase(), id.toLowerCase()]);
    for (let j = 0; j < variants.length; j += 30) {
      const regs = await db.collection("registrations").where("tournamentId", "in", [...new Set(variants.slice(j, j + 30))]).get();
      for (const r of regs.docs) {
        const d = r.data();
        for (const id of [d.playerId, d.partnerId, ...(Array.isArray(d.rosterIds) ? d.rosterIds : [])]) {
          if (typeof id === "string" && id) players.add(id.toUpperCase());
        }
      }
    }
  }
  return { tournaments: ids.size, players: players.size };
}

export async function backfillPlayerPrivate(
  db: Firestore, opts: BackfillOptions, authEmails: AuthEmails = firebaseAuthEmails,
): Promise<BackfillCounts> {
  const c: BackfillCounts = {
    players: 0, withEmail: 0, withPhone: 0, withDateOfBirth: 0, withPostalCode: 0, withWeight: 0, withToken: 0,
    noFirebaseUid: 0, contactKeysMissing: 0, privateExisting: 0, privateToCreate: 0, privateToUpdate: 0,
    privateNewerKept: 0, authEmailMismatch: 0, authUserMissing: 0, publicToScrub: 0, scrubRefused: 0,
    publicToRestore: 0, writes: 0, skippedChanged: 0, teamOrCricketTournaments: 0, playersInTeamOrCricket: 0,
  };
  const out = new Batcher(db, opts.apply);

  await forEachPlayerPage(db, async (docs) => {
    const privSnaps = await db.getAll(...docs.map((d) => db.collection(PLAYER_PRIVATE).doc(d.id)));
    const uids = [...new Set(docs.map((d) => d.get("firebaseUid")).filter((u): u is string => typeof u === "string" && !!u))];
    const emails = opts.restore ? new Map<string, string | null>() : await authEmails(uids);

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const pub = doc.data() ?? {};
      const privSnap = privSnaps[i];
      const priv = privSnap.exists ? privSnap.data() ?? null : null;
      c.players++;
      if (hasValue(pub.email)) c.withEmail++;
      if (hasValue(pub.phone)) c.withPhone++;
      if (hasValue(pub.dateOfBirth)) c.withDateOfBirth++;
      if (hasValue(pub.homePostalCode)) c.withPostalCode++;
      if (hasValue(pub.weightKg)) c.withWeight++;
      if (hasValue(pub.fcmToken)) c.withToken++;
      if (!(typeof pub.firebaseUid === "string" && pub.firebaseUid)) c.noFirebaseUid++;
      if (!("email" in pub) || !("phone" in pub)) c.contactKeysMissing++;
      if (priv) c.privateExisting++;

      if (opts.restore) {
        if (!priv) continue;
        const back: Record<string, unknown> = {};
        for (const f of CONTACT_FIELDS) if (!hasValue(pub[f]) && hasValue(priv[f])) back[f] = priv[f];
        for (const f of TIER2_FIELDS) if (!hasValue(pub[f]) && hasValue(priv[f])) back[f] = priv[f];
        if (Object.keys(back).length === 0) continue;
        c.publicToRestore++;
        await out.add((b) => { b.update(doc.ref, back); return 1; });
        continue;
      }

      let authEmail: string | null = null;
      const uid = typeof pub.firebaseUid === "string" && pub.firebaseUid ? pub.firebaseUid : null;
      if (uid) {
        const e = emails.get(uid);
        if (e === null || e === undefined) c.authUserMissing++;
        else if (e) authEmail = e;
        if (authEmail && hasValue(pub.email) && normalizeEmail(pub.email) !== authEmail) c.authEmailMismatch++;
      }

      // A private doc written after the player's last write is newer: only fill its missing keys.
      const privNewer = !!priv && priv.updatedAt instanceof Timestamp && !!doc.updateTime
        && priv.updatedAt.toMillis() > doc.updateTime.toMillis();
      if (privNewer) c.privateNewerKept++;
      const plan = planMirror(privNewer ? pub : undefined, pub, priv, authEmail, opts.scrub, "backfill");

      if (plan.privateUpdate) {
        if (priv) c.privateToUpdate++;
        else c.privateToCreate++;
      }
      if (opts.scrub !== "off") {
        const fields = opts.scrub === "all" ? [...CONTACT_FIELDS, ...TIER2_FIELDS] : [...CONTACT_FIELDS];
        const wanted = fields.filter((f) => hasValue(pub[f]) || (opts.scrub === "all" && (TIER2_FIELDS as readonly string[]).includes(f) && f in pub));
        const scrubbed = plan.publicUpdate ? Object.keys(plan.publicUpdate) : [];
        if (wanted.some((f) => !scrubbed.includes(f))) c.scrubRefused++;
        if (plan.publicUpdate) c.publicToScrub++;
      }
      if (!plan.privateUpdate && !plan.publicUpdate) continue;
      const privRef = db.collection(PLAYER_PRIVATE).doc(doc.id);
      await out.add((b) => {
        let n = 0;
        if (plan.privateUpdate) {
          const data = { ...plan.privateUpdate };
          // phoneDigits for docs whose phone is kept as is.
          if (!("phoneDigits" in data) && !(priv && typeof priv.phoneDigits === "string")) {
            data.phoneDigits = phoneDigits(data.phone ?? priv?.phone);
          }
          b.set(privRef, data, { merge: true });
          n++;
        }
        if (plan.publicUpdate) {
          b.update(doc.ref, plan.publicUpdate, doc.updateTime ? { lastUpdateTime: doc.updateTime } : undefined);
          n++;
        }
        return n;
      });
    }
  });
  await out.flush();
  c.writes = out.writes;
  c.skippedChanged = out.skippedChanged;
  const signal = await teamFormatSignal(db);
  c.teamOrCricketTournaments = signal.tournaments;
  c.playersInTeamOrCricket = signal.players;
  return c;
}

/** Re-reads every player: no public contact data (and with "all", no Tier 2 field) may remain. */
export async function verifyPlayerPrivate(db: Firestore, mode: ScrubMode): Promise<VerifyCounts> {
  const v: VerifyCounts = { players: 0, publicWithContact: 0, publicWithTier2: 0, missingPrivate: 0, ok: true };
  await forEachPlayerPage(db, async (docs) => {
    const privSnaps = await db.getAll(...docs.map((d) => db.collection(PLAYER_PRIVATE).doc(d.id)));
    docs.forEach((doc, i) => {
      const pub = doc.data() ?? {};
      v.players++;
      if (CONTACT_FIELDS.some((f) => hasValue(pub[f]))) v.publicWithContact++;
      if (TIER2_FIELDS.some((f) => f in pub)) v.publicWithTier2++;
      if (!privSnaps[i].exists) v.missingPrivate++;
    });
  });
  v.ok = v.missingPrivate === 0
    && (mode === "off" || v.publicWithContact === 0)
    && (mode !== "all" || v.publicWithTier2 === 0);
  return v;
}

export function parseBackfillArgs(argv: string[]): BackfillOptions & { projectId: string } {
  let projectId: string | undefined;
  let apply = false;
  let scrub = false;
  let tier1 = false;
  let restore = false;
  let verifyOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else if (a === "--scrub") scrub = true;
    else if (a === "--tier1") tier1 = true;
    else if (a === "--restore") restore = true;
    else if (a === "--verify") verifyOnly = true;
    else if (a === "--project") projectId = argv[++i];
    else if (a.startsWith("--project=")) projectId = a.slice("--project=".length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (projectId === "") throw new Error("--project needs a value.");
  if (tier1 && !scrub) throw new Error("--tier1 only goes with --scrub.");
  if (scrub && restore) throw new Error("--scrub and --restore can't be combined.");
  if (!projectId) {
    const env = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    if (env && env !== "tournmate-dev") throw new Error(`Refusing to run against ${env} from the environment. Name it: --project ${env}`);
    projectId = "tournmate-dev";
  }
  return { projectId, apply, scrub: scrub ? (tier1 ? "tier1" : "all") : "off", restore, verifyOnly };
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseBackfillArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  if (getApps().length === 0) initializeApp({ projectId: args.projectId });
  const db = getFirestore();
  const mode = args.verifyOnly ? "verify" : args.restore ? "restore" : args.scrub !== "off" ? `scrub (${args.scrub})` : "copy";
  console.log(`Project: ${args.projectId}  mode: ${mode}  ${args.apply ? "APPLY (writes)" : "DRY RUN (no writes)"}`);

  if (!args.verifyOnly) {
    const c = await backfillPlayerPrivate(db, args);
    for (const [k, v] of Object.entries(c)) console.log(`  ${k.padEnd(26)} ${v}`);
  }
  if (args.verifyOnly || (args.apply && args.scrub !== "off")) {
    const v = await verifyPlayerPrivate(db, args.verifyOnly ? (args.scrub !== "off" ? args.scrub : "all") : args.scrub);
    console.log("Verify:");
    for (const [k, val] of Object.entries(v)) console.log(`  ${k.padEnd(26)} ${val}`);
    if (!v.ok) {
      console.error("VERIFY FAILED");
      process.exit(1);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
