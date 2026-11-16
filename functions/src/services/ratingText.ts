/*
 * Text check for sportsmanship review comments (ratePlayer). Comments are
 * public on the rated player's profile, so the server blocks:
 *   - profanity and slurs (English plus common Hindi / Telugu transliterations),
 *     with a leetspeak normaliser ("f@ck", "sh1t") and spaced-out letters ("f u c k");
 *   - links and email addresses;
 *   - phone numbers (7+ digits where some group has 3+ digits, so match
 *     scores such as "21-17 18-21 21-15" still pass).
 *
 * The moderator is swappable like services/profilePhotos.ts `setPhotoModerator`,
 * so a later version can add an API check (e.g. Perspective) and emulator
 * tests can stub it. The word list itself never throws.
 */

export type TextVerdict = "pass" | "reject";

/** Why a comment was rejected (logged, not shown verbatim). */
export type TextRejectReason = "profanity" | "link" | "email" | "phone";

/** Checks one comment. May throw when an external check fails (callers fail closed). */
export type TextModerator = (text: string) => Promise<TextVerdict>;

// Whole-word matches (after normalising). Kept to words that are offensive on
// their own; short words that appear inside normal words ("shuttlecock",
// "class") are only matched as whole words.
const WORDS = [
  // English
  "fuck", "fucks", "fucker", "fuckers", "fucking", "fucked", "fck", "fuk", "fking", "fkn", "wtf", "stfu",
  "shit", "shits", "shitty", "bullshit", "bitch", "bitches", "bastard", "bastards", "asshole", "assholes",
  "arsehole", "ass", "arse", "dick", "dickhead", "dicks", "cock", "cocks", "cocksucker", "pussy", "cunt", "cunts",
  "slut", "sluts", "whore", "whores", "wanker", "twat", "prick", "jerkoff", "douche", "douchebag", "motherfucker",
  "retard", "retarded", "fag", "fags", "faggot", "faggots", "nigger", "niggers", "nigga", "niggas", "spic", "chink",
  "kike", "tranny", "dyke", "rape", "rapist", "kys",
  // Hindi / Urdu (romanised)
  "chutiya", "chutiye", "chutia", "chootiya", "madarchod", "maderchod", "behenchod", "bhenchod", "benchod",
  "bhosdike", "bhosadike", "bhosdi", "bsdk", "gandu", "gaandu", "randi", "harami", "haramkhor", "lavde", "lawde", "lauda", "loda", "lund", "chod", "chodu", "jhatu", "kutte", "kutiya",
  // Telugu (romanised)
  "dengu", "dengey", "denga", "lanja", "lanjakodaka", "lanjakoduku", "puku", "modda", "gudda", "naakodaka",
  "nakodaka", "dengutha", "erripuka",
];

// Substring matches: roots that are never part of a normal word.
const ROOTS = [
  "fuck", "nigger", "nigga", "faggot", "motherf", "chutiy", "madarchod", "behenchod", "bhenchod", "bhosd",
  "lanjakod",
];

const WORD_SET = new Set(WORDS);

const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i",
};

/** Lower case, leetspeak letters mapped, accents dropped. */
function normalise(text: string): string {
  return text
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c);
}

/** "fuuuuck" -> "fuck" (3+ repeats to one). */
function squeeze(word: string): string {
  return word.replace(/(.)\1{2,}/g, "$1");
}

/** "fuuck" -> "fuck" (any repeat to one), only used against the word set. */
function squeezeAll(word: string): string {
  return word.replace(/(.)\1+/g, "$1");
}

function hasProfanity(text: string): boolean {
  const norm = normalise(text);
  const tokens = norm.split(/[^a-z]+/).filter(Boolean);
  // Join runs of single letters ("f u c k", "f.u.c.k").
  const joined: string[] = [];
  let run = "";
  for (const t of tokens) {
    if (t.length === 1) { run += t; continue; }
    if (run.length > 1) joined.push(run);
    run = "";
  }
  if (run.length > 1) joined.push(run);

  for (const t of [...tokens, ...joined]) {
    const forms = new Set([t, squeeze(t), squeezeAll(t)]);
    for (const f of forms) {
      if (WORD_SET.has(f)) return true;
      if (ROOTS.some((r) => f.includes(r))) return true;
    }
  }
  return false;
}

const LINK = [
  /https?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]{2,}\.(com|net|org|in|io|co|me|app|ly|gg|xyz|info|biz|us|uk|link|site|online|shop|tv)\b/i,
];
const EMAIL = /[a-z0-9._%+-]+\s?@\s?[a-z0-9.-]+\.[a-z]{2,}/i;

function hasPhone(text: string): boolean {
  // Digits with at most two separator characters between them.
  const runs = text.match(/\+?\(?\d(?:[\s().-]{0,2}\d)+/g) ?? [];
  for (const r of runs) {
    const groups = r.split(/[^\d]+/).filter(Boolean);
    const digits = groups.join("").length;
    if (digits >= 7 && groups.some((g) => g.length >= 3)) return true;
  }
  return false;
}

/** The first rule a comment breaks, or null if it passes. */
export function ratingTextProblem(text: string): TextRejectReason | null {
  if (EMAIL.test(text)) return "email";
  if (LINK.some((re) => re.test(text))) return "link";
  if (hasPhone(text)) return "phone";
  if (hasProfanity(text)) return "profanity";
  return null;
}

export const wordListModerator: TextModerator = async (text) => (ratingTextProblem(text) ? "reject" : "pass");

let moderator: TextModerator = wordListModerator;

export function textModerator(): TextModerator {
  return moderator;
}

/** Emulator tests only: replace the check (pass `null` to restore the word list). */
export function setTextModerator(fn: TextModerator | null): void {
  moderator = fn ?? wordListModerator;
}
