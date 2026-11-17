/**
 * One-off backfill for sportsmanship reviews (issue 40). DRY RUN by default.
 *
 * For every old-shape `ratings` doc (has `raterId` on the public doc):
 *   - keeps the newest per (rater, player); older duplicates are deleted;
 *   - moves the author to server-side `ratingAuthors/{id}`, removes raterId
 *     from the public doc, marks it anonymous (nobody was told names would show),
 *     sets status "visible" and reportCount 0;
 *   - drops a comment that fails the text check (the stars stay);
 * then recomputes `players/{id}.sportsmanship` for every rated player.
 * Safe to re-run: normalised docs have no raterId and are skipped.
 *
 * Project: tournmate-dev by default; anything else must be named with --project.
 * Credentials: `gcloud auth application-default login` (personal laptop only).
 *
 * Usage (from tournmate-server/functions):
 *   npm run backfill:ratings                          # dry run, tournmate-dev
 *   npm run backfill:ratings -- --apply               # writes, tournmate-dev
 *   npm run backfill:ratings -- --project tournmate-prod [--apply]
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore, Timestamp } from "firebase-admin/firestore";
import { normalizeLegacyRating, RATINGS, refreshSportsmanship } from "../services/ratings";
import { ratingTextProblem } from "../services/ratingText";
import { parseRatingScriptArgs } from "./ratingScriptArgs";

export interface BackfillSummary {
  total: number;
  legacy: number;
  pairs: number;
  superseded: number;
  droppedComments: number;
  players: number;
  applied: boolean;
}

const millis = (v: unknown): number => (v instanceof Timestamp ? v.toMillis() : 0);

export async function backfillRatings(db: Firestore, apply: boolean, log: (s: string) => void = console.log): Promise<BackfillSummary> {
  const snap = await db.collection(RATINGS).get();
  const legacy = snap.docs.filter((d) => typeof d.data().raterId === "string" && d.data().raterId);
  const groups = new Map<string, typeof legacy>();
  for (const doc of legacy) {
    const d = doc.data();
    const key = `${String(d.raterId).toUpperCase()}|${String(d.playerId).toUpperCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), doc]);
  }
  let superseded = 0;
  let droppedComments = 0;
  for (const [key, docs] of groups) {
    docs.sort((a, b) => millis(a.data().createdAt) - millis(b.data().createdAt));
    const keep = docs[docs.length - 1];
    superseded += docs.length - 1;
    const c = keep.data().comment;
    const dropped = typeof c === "string" && c.trim() !== "" && ratingTextProblem(c.trim()) !== null;
    if (dropped) droppedComments++;
    if (docs.length > 1 || dropped) {
      log(`  ${key}: keep ${keep.id}${docs.length > 1 ? `, delete ${docs.slice(0, -1).map((d) => d.id).join(", ")}` : ""}${dropped ? " (comment fails the text check, dropped)" : ""}`);
    }
  }
  const players = new Set(snap.docs.map((d) => d.data().playerId).filter((p): p is string => typeof p === "string" && !!p)
    .map((p) => p.toUpperCase()));

  if (apply) {
    for (const docs of groups.values()) {
      for (const doc of docs) await normalizeLegacyRating(db, doc.id, { refresh: false });
    }
    for (const p of players) await refreshSportsmanship(db, p);
  }
  return {
    total: snap.size, legacy: legacy.length, pairs: groups.size, superseded, droppedComments,
    players: players.size, applied: apply,
  };
}

async function main(): Promise<void> {
  const { projectId, apply } = parseRatingScriptArgs(process.argv.slice(2));
  if (getApps().length === 0) initializeApp({ projectId });
  console.log(`Project ${projectId}${apply ? " (APPLY: writing)" : " (dry run: nothing is written; add --apply to write)"}`);
  const s = await backfillRatings(getFirestore(), apply);
  console.log(`ratings docs: ${s.total}, old shape: ${s.legacy}, rater/player pairs: ${s.pairs}`);
  console.log(`duplicates ${apply ? "deleted" : "to delete"}: ${s.superseded}, comments ${apply ? "dropped" : "to drop"}: ${s.droppedComments}`);
  console.log(`players ${apply ? "recounted" : "to recount"}: ${s.players}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
}
