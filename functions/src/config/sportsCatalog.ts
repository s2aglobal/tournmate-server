import { SportType } from "../types";

/**
 * Sport catalog — the server's single source of truth for the `config/sports`
 * Firestore document (schemaVersion 1).
 *
 * The apps read `config/sports` to decide which sports are Live vs Soon, the
 * picker categories, and their order. Each app ships a bundled copy of this
 * default and uses it when the doc is missing or malformed, so keep this in
 * sync with the iOS and Android bundled defaults.
 *
 * firestore.rules also hardcodes the launch live list (pickleball, badminton,
 * tennis) as the fallback when `config/sports` is missing.
 *
 * Seed with `src/scripts/seedSportsConfig.ts`.
 */

export type SportCategoryId = "racket_paddle" | "court_field" | "target_more";

export interface SportCategory {
  id: SportCategoryId;
  title: string;
  sports: SportType[];
}

/** Minimum app versions ("1.8", "1.1.0") that support a sport. */
export interface SportMinAppVersion {
  ios?: string;
  android?: string;
}

export interface SportsConfig {
  schemaVersion: 1;
  /** Sports that can be selected / published. Every other catalog sport shows as "Soon". */
  live: SportType[];
  /**
   * Sports that are live only on app versions that support them (cricket
   * needs teams). Apps older than the minimum ignore this key and keep the
   * sport as "Soon"; a platform without an entry keeps it "Soon" too.
   * firestore.rules treats these sports as live for creates.
   * Never put such a sport in `live`, which every app version reads.
   */
  liveMinAppVersion?: Partial<Record<SportType, SportMinAppVersion>>;
  categories: SportCategory[];
}

export const SPORTS_CONFIG_COLLECTION = "config";
export const SPORTS_CONFIG_DOC_ID = "sports";

export const DEFAULT_SPORTS_CONFIG: SportsConfig = {
  schemaVersion: 1,
  live: ["pickleball", "badminton", "tennis"],
  categories: [
    {
      id: "racket_paddle",
      title: "Racket & Paddle",
      sports: ["pickleball", "badminton", "tennis", "padel", "table_tennis", "squash"],
    },
    {
      id: "court_field",
      title: "Court & Field",
      sports: ["volleyball", "beach_volleyball", "basketball", "soccer", "cricket", "roundnet"],
    },
    {
      id: "target_more",
      title: "Target & More",
      sports: ["golf", "disc_golf", "bowling", "darts"],
    },
  ],
};

/** Every sport id in the catalog, in display order. */
export const CATALOG_SPORT_IDS: readonly SportType[] =
  DEFAULT_SPORTS_CONFIG.categories.flatMap((c) => c.sports);
