/**
 * Seed script: writes the sport catalog document `config/sports` from
 * `DEFAULT_SPORTS_CONFIG` (src/config/sportsCatalog.ts).
 *
 * Idempotent: does nothing if `config/sports` already exists, unless `--force`
 * is passed (then it overwrites the whole doc with the default).
 *
 * Target project: `--project <id>`, else GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT.
 * There is no default, so it never writes to an unintended project.
 * Credentials: Application Default Credentials (`gcloud auth application-default login`)
 * or GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>.
 *
 * Usage (from tournmate-server/functions):
 *   npm run build
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev            # dev
 *   node lib/scripts/seedSportsConfig.js --project tournmate-prod           # prod
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --force    # overwrite
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --dry-run  # print only
 *
 * Turning sports on or off (e.g. cricket on dev for testing): `--live` sets the
 * whole live list and implies --force. Prod keeps the default unless you pass it.
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --live pickleball,badminton,tennis
 *
 * Sports that need a newer app (cricket): `--gated <sport>=<ios>/<android>`
 * puts them in `liveMinAppVersion`, so older apps keep showing them as "Soon".
 * Repeat for several sports. Implies --force.
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --gated cricket=1.8/1.1
 *
 * Point-by-point live scoring (`liveScoring`, badminton only for now):
 * `--live-scoring <sports>` switches it on for exactly those sports
 * (`none` = off for all). On its own it updates only `liveScoring` and keeps
 * the rest of the doc; with --force / --live / --gated it is part of the full
 * write. A full write without it keeps the existing `liveScoring`.
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --live-scoring badminton
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --live-scoring none
 *
 * Live video streaming (`liveStreaming`, badminton only for now): same rules
 * with `--live-streaming <sports>` / `none` (live-stream-contract.md). Alone
 * (or together with --live-scoring) it updates only those fields; a full
 * write without it keeps the existing `liveStreaming`.
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --live-streaming badminton
 *   node lib/scripts/seedSportsConfig.js --project tournmate-dev --live-streaming none
 *
 * Or via npm (args after `--`):
 *   npm run seed:sports-config -- --project tournmate-dev
 *
 * Against the Firestore emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node lib/scripts/seedSportsConfig.js --project demo-tournmate
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  CATALOG_SPORT_IDS,
  DEFAULT_SPORTS_CONFIG,
  SPORTS_CONFIG_COLLECTION,
  SPORTS_CONFIG_DOC_ID,
  SportsConfig,
  SportMinAppVersion,
} from "../config/sportsCatalog";
import type { SportType } from "../types";
import { RACKET_SPORTS } from "../services/racketLive";
import { LIVE_STREAM_SPORTS } from "../services/liveStream";

interface Args {
  projectId?: string;
  force: boolean;
  dryRun: boolean;
  live?: SportType[];
  gated: Partial<Record<SportType, SportMinAppVersion>>;
  liveScoring?: Partial<Record<SportType, boolean>>;
  liveStreaming?: Partial<Record<SportType, boolean>>;
}

const VERSION = /^\d+(\.\d+){0,2}$/;

function parseGated(value: string | undefined): [SportType, SportMinAppVersion] {
  const m = /^([a-z_]+)=([^/]*)\/([^/]*)$/.exec(value ?? "");
  const sport = m?.[1] as SportType | undefined;
  const ios = m?.[2] || undefined;
  const android = m?.[3] || undefined;
  if (!m || !sport || !CATALOG_SPORT_IDS.includes(sport) ||
      (ios && !VERSION.test(ios)) || (android && !VERSION.test(android)) || (!ios && !android)) {
    console.error(`--gated needs <sport>=<ios version>/<android version>, e.g. cricket=1.8/1.1 (got ${value})`);
    process.exit(1);
  }
  return [sport, { ...(ios ? { ios } : {}), ...(android ? { android } : {}) }];
}

function parseLive(value: string | undefined): SportType[] {
  const ids = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !CATALOG_SPORT_IDS.includes(id as SportType));
  if (ids.length === 0 || unknown.length > 0) {
    console.error(`--live needs catalog sport ids${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`);
    process.exit(1);
  }
  return ids as SportType[];
}

function parseSwitch(flag: string, what: string, supported: readonly string[], value: string | undefined):
  Partial<Record<SportType, boolean>> {
  if (value === "none") return {};
  const ids = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unsupported = ids.filter((id) => !supported.includes(id));
  if (ids.length === 0 || unsupported.length > 0) {
    console.error(`${flag} needs sports with ${what} (${supported.join(", ")}) or "none"` +
      `${unsupported.length ? `; not supported: ${unsupported.join(", ")}` : ""}`);
    process.exit(1);
  }
  return Object.fromEntries(ids.map((id) => [id, true]));
}

function parseLiveScoring(value: string | undefined): Partial<Record<SportType, boolean>> {
  return parseSwitch("--live-scoring", "live scoring", RACKET_SPORTS, value);
}

function parseLiveStreaming(value: string | undefined): Partial<Record<SportType, boolean>> {
  return parseSwitch("--live-streaming", "live streaming", LIVE_STREAM_SPORTS, value);
}

function parseArgs(argv: string[]): Args {
  let projectId: string | undefined;
  let force = false;
  let dryRun = false;
  let live: SportType[] | undefined;
  const gated: Partial<Record<SportType, SportMinAppVersion>> = {};
  let liveScoring: Partial<Record<SportType, boolean>> | undefined;
  let liveStreaming: Partial<Record<SportType, boolean>> | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") force = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--project") projectId = argv[++i];
    else if (arg.startsWith("--project=")) projectId = arg.slice("--project=".length);
    else if (arg === "--live") { live = parseLive(argv[++i]); force = true; }
    else if (arg.startsWith("--live=")) { live = parseLive(arg.slice("--live=".length)); force = true; }
    else if (arg === "--gated") { const [s, v] = parseGated(argv[++i]); gated[s] = v; force = true; }
    else if (arg.startsWith("--gated=")) { const [s, v] = parseGated(arg.slice("--gated=".length)); gated[s] = v; force = true; }
    else if (arg === "--live-scoring") liveScoring = parseLiveScoring(argv[++i]);
    else if (arg.startsWith("--live-scoring=")) liveScoring = parseLiveScoring(arg.slice("--live-scoring=".length));
    else if (arg === "--live-streaming") liveStreaming = parseLiveStreaming(argv[++i]);
    else if (arg.startsWith("--live-streaming=")) liveStreaming = parseLiveStreaming(arg.slice("--live-streaming=".length));
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  projectId = projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  return { projectId, force, dryRun, live, gated, liveScoring, liveStreaming };
}

async function main(): Promise<void> {
  const { projectId, force, dryRun, live, gated, liveScoring, liveStreaming } = parseArgs(process.argv.slice(2));
  const config: SportsConfig = { ...DEFAULT_SPORTS_CONFIG, ...(live ? { live } : {}) };
  if (Object.keys(gated).length > 0) {
    const both = Object.keys(gated).filter((s) => config.live.includes(s as SportType));
    if (both.length > 0) {
      console.error(`${both.join(", ")} can't be in both --live and --gated: every app version reads "live".`);
      process.exit(1);
    }
    config.liveMinAppVersion = gated;
  }
  if (!projectId) {
    console.error(
      "A project is required: pass --project <id> or set GOOGLE_CLOUD_PROJECT.\n" +
      "  e.g. node lib/scripts/seedSportsConfig.js --project tournmate-dev",
    );
    process.exit(1);
  }

  const target = `${SPORTS_CONFIG_COLLECTION}/${SPORTS_CONFIG_DOC_ID}`;
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  console.log(`Project: ${projectId}${emulator ? ` (emulator ${emulator})` : ""}`);
  console.log(`Target:  ${target}${force ? " (--force)" : ""}${dryRun ? " (--dry-run)" : ""}`);

  // --live-scoring / --live-streaming alone: update only those fields (the
  // doc is created from the default if missing).
  const switches: Partial<Pick<SportsConfig, "liveScoring" | "liveStreaming">> = {
    ...(liveScoring !== undefined ? { liveScoring } : {}),
    ...(liveStreaming !== undefined ? { liveStreaming } : {}),
  };
  const onlySwitches = Object.keys(switches).length > 0 && !force;
  Object.assign(config, switches);

  if (dryRun) {
    console.log(onlySwitches ? JSON.stringify(switches, null, 2) : JSON.stringify(config, null, 2));
    return;
  }

  if (getApps().length === 0) initializeApp({ projectId });
  const ref = getFirestore().collection(SPORTS_CONFIG_COLLECTION).doc(SPORTS_CONFIG_DOC_ID);

  const written = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (onlySwitches) {
      if (snap.exists) tx.update(ref, switches);
      else tx.set(ref, config);
      return true;
    }
    if (snap.exists && !force) return false;
    // A full write keeps the live-scoring / live-streaming switches unless given.
    const existing = snap.exists ? snap.get("liveScoring") : undefined;
    if (liveScoring === undefined && existing && typeof existing === "object") config.liveScoring = existing;
    const existingStreaming = snap.exists ? snap.get("liveStreaming") : undefined;
    if (liveStreaming === undefined && existingStreaming && typeof existingStreaming === "object") {
      config.liveStreaming = existingStreaming;
    }
    tx.set(ref, config);
    return true;
  });

  if (written && onlySwitches) {
    console.log(`Updated ${target}: ${Object.entries(switches).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("; ")}`);
  } else if (written) {
    const gatedText = config.liveMinAppVersion ? `; gated = ${JSON.stringify(config.liveMinAppVersion)}` : "";
    const scoringText = config.liveScoring ? `; liveScoring = ${JSON.stringify(config.liveScoring)}` : "";
    const streamingText = config.liveStreaming ? `; liveStreaming = ${JSON.stringify(config.liveStreaming)}` : "";
    console.log(`Wrote ${target}: live = ${config.live.join(", ")}${gatedText}${scoringText}${streamingText}`);
  } else {
    console.log(`${target} already exists; left unchanged. Pass --force to overwrite.`);
  }
}

main().catch((err) => {
  console.error("Seeding config/sports failed:", err);
  process.exit(1);
});
