/*
 * Text check for sportsmanship review comments (ratePlayer). Comments are
 * public on the rated player's profile, so the server blocks:
 *   - profanity and slurs (English plus common Hindi / Telugu transliterations),
 *     with a leetspeak normaliser ("f@ck", "sh1t") and spaced-out letters ("f u c k");
 *   - links, including spelled-out dots ("site dot com", "site [dot] com");
 *   - contact details: emails (also "at gmail", "gmail dot com"), social
 *     handles ("@riley_23", "insta: riley23", "ig riley", "add me on snap")
 *     and "dm / text / call / whatsapp me";
 *   - phone numbers: 7+ digits where some group has 3+ digits (so match scores
 *     such as "21-17 18-21 21-15" still pass), and spelled-out or mixed
 *     numbers ("nine eight seven six five four three", "98 seven 6 five 432").
 *
 * The moderator is swappable like services/profilePhotos.ts `setPhotoModerator`,
 * so a later version can add an API check (e.g. Perspective) and emulator
 * tests can stub it. The word list itself never throws.
 */

export type TextVerdict = "pass" | "reject";

/**
 * Why a comment was rejected. Sent to the apps as `details.textReason` on
 * RATING_TEXT_REJECTED so they can say what to fix (the matched text is never
 * echoed). "contact" covers emails, social handles and "dm/text/call me".
 */
export type TextRejectReason = "profanity" | "link" | "contact" | "phone";

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

// ── Links ──
// TLDs safe to match after a real dot ("cheats.com"). A spaced or spelled-out
// dot ("site dot com", "site . com") only counts before an unambiguous TLD, so
// "the dot in the corner" and "great at net. in the end" still pass.
const TLD = "com|net|org|in|io|co|me|app|ly|gg|xyz|info|biz|us|uk|link|site|online|shop|tv";
const SAFE_TLD = "com|net|org|io|xyz|info|biz|app|gg|site|online|shop|link|tv";
const LINK = [
  /https?:\/\//i,
  /\bwww\s*(\.|\[\s*dot\s*\]|\(\s*dot\s*\)|\s+dot\s+)/i,
  new RegExp(`\\b[a-z0-9-]{2,}\\.(${TLD})\\b`, "i"),
  // site [dot] com, site (dot) com, site {.} com, site[.]in
  new RegExp(`\\b[a-z0-9-]{2,}\\s*[\\[({]\\s*(dot|\\.)\\s*[\\])}]\\s*(${TLD})\\b`, "i"),
  // site dot com, site . com, site .com
  new RegExp(`\\b[a-z0-9-]{2,}(\\s+dot\\s+|\\s+\\.\\s*|\\s*\\.\\s+)(${SAFE_TLD})\\b`, "i"),
  // a bracketed dot on its own is only ever used to dodge filters
  /[\[({]\s*dot\s*[\])}]/i,
];

// ── Contact details: emails, social handles, "dm me" ──
const MAIL_HOSTS = "gmail|googlemail|ymail|hotmail|yahoo|outlook|icloud|protonmail|proton|rediffmail|rediff|aol|live";
const EMAIL = [
  /[a-z0-9._%+-]+\s?@\s?[a-z0-9.-]+\.[a-z]{2,}/i,
  // riley [at] x, riley (at) gmail
  /[a-z0-9._%+-]+\s*[\[({]\s*at\s*[\])}]\s*[a-z0-9]/i,
  // "at gmail", "@ gmail", "gmail dot com", "gmail.com"
  new RegExp(`(\\bat|@)\\s*(${MAIL_HOSTS})\\b`, "i"),
  new RegExp(`\\b(${MAIL_HOSTS})\\s*([\\[({]\\s*)?(\\.|dot)(\\s*[\\])}])?\\s*(com|co|in|net)\\b`, "i"),
  // words that only appear when sharing an address
  /\b(gmail|googlemail|ymail|hotmail|rediffmail|protonmail)\b/i,
];
// Platforms whose name alone means "find me there".
const STRONG_PLATFORMS = /\b(instagram|insta|snapchat|telegram|whats\s?app|whatsap|watsapp|watsap|tiktok|wechat|facebook|twitter|discord)\b/i;
// Short or common names: only with a handle after them or "on/my/add" before.
const WEAK_PLATFORMS = "ig|snap|sc|tg|wa|fb|x|signal|kik|threads";
// Common words that can follow "@" or "ig" without being a handle ("good @the net", "ig he played well").
const COMMON = new Set((
  "a an the and or but so to of in on at by for from with as is am are was were be been it its this that these " +
  "those he she they we you i me my your his her their our him them us who what when where why how all any each " +
  "every some no not one two three first last least once times time home net court courts club gym work school " +
  "night noon morning evening back front baseline rear deuce match matches game games set sets practice training " +
  "tournament end start least best most very really just only also too well good great nice always never ever " +
  "think guess played plays play was had has have do did does dont can could would should will"
).split(/\s+/));
const HANDLE = /^(?=[a-z0-9_.]*[a-z])[a-z0-9_.]{2,30}$/;
const TIME = /^\d{1,2}(:\d{2})?(am|pm)?$/;
const CONTACT_PHRASE = /\b(whats\s?app|dm|pm|text|txt|call|ring|message|msg|email|e-mail|mail|ping|contact|reach|add|follow)\s+me\b|\bhmu\b|\bmy\s+(number|no\.?|digits|handle|id|insta|ig|snap)\b/i;

function hasHandle(text: string): boolean {
  const lower = text.toLowerCase();
  // "@riley_23", "(@riley)"; "good @ net" (space after @) passes.
  for (const m of lower.matchAll(/(?:^|[^a-z0-9_])@([a-z0-9_.]+)/g)) {
    const h = m[1].replace(/\.+$/, "");
    if (TIME.test(h) || COMMON.has(h)) continue;
    if (HANDLE.test(h)) return true;
  }
  if (STRONG_PLATFORMS.test(lower)) return true;
  const weak = new RegExp(`\\b(${WEAK_PLATFORMS})\\b(\\s*:\\s*|\\s+(is\\s+|id\\s+|handle\\s+)?)@?([a-z0-9_.]+)`, "g");
  for (const m of lower.matchAll(weak)) {
    const sep = m[2];
    const h = m[4].replace(/\.+$/, "");
    if (!HANDLE.test(h) || TIME.test(h) || /^\d+(st|nd|rd|th|s)$/.test(h)) continue;
    // "ig: riley", "snap riley_23", "ig riley" (a name, not a common word)
    if (sep.includes(":") || (/[\d_]/.test(h) && m[1] !== "x")) return true;
    if (m[1] !== "snap" && m[1] !== "x" && m[1] !== "signal" && m[1] !== "threads" && !COMMON.has(h) && h.length >= 3) return true;
  }
  // "add me on snap", "my ig", "find me on x". "x", "signal" and "threads"
  // are everyday words, so they need "me on" or "my" before them.
  const ctx = new RegExp(`\\b(me\\s+on|my|on|via)\\s+(${WEAK_PLATFORMS})\\b(?!\\s*(of|the|shot|smash|serve|and|-))`, "g");
  for (const m of lower.matchAll(ctx)) {
    if (["x", "signal", "threads"].includes(m[2]) && !/^(me\s+on|my)$/.test(m[1].replace(/\s+/g, " "))) continue;
    return true;
  }
  return false;
}

function hasContact(text: string): boolean {
  return EMAIL.some((re) => re.test(text)) || CONTACT_PHRASE.test(text) || hasHandle(text);
}

// ── Phone numbers ──
const NUMBER_WORDS: Record<string, number> = {
  zero: 1, oh: 1, one: 1, two: 1, three: 1, four: 1, five: 1, six: 1, seven: 1, eight: 1, nine: 1,
  double: 1, triple: 2,
};

function hasDigitPhone(text: string): boolean {
  // Digits with at most two separator characters between them.
  const runs = text.match(/\+?\(?\d(?:[\s().-]{0,2}\d)+/g) ?? [];
  for (const r of runs) {
    const groups = r.split(/[^\d]+/).filter(Boolean);
    const digits = groups.join("").length;
    if (digits >= 7 && groups.some((g) => g.length >= 3)) return true;
    // "9 8 7 6 5 4 3 2": 8+ single digits split by spaces (hyphens are set scores, "6-4 3-6 7-6 6-4").
    if (digits >= 8 && groups.every((g) => g.length === 1) && !/-/.test(r)) return true;
  }
  return false;
}

/** "nine eight seven six five four three", "98 seven 6 five 43 two": 7+ digits with at least one number word. */
function hasSpelledPhone(text: string): boolean {
  const tokens = text.toLowerCase().split(/[\s,.\-()/+]+/).filter(Boolean);
  let count = 0;
  let words = 0;
  for (const t of tokens) {
    if (/^\d+$/.test(t)) count += t.length;
    else if (t in NUMBER_WORDS) { count += NUMBER_WORDS[t]; words++; }
    else { count = 0; words = 0; continue; }
    if (count >= 7 && words >= 1) return true;
  }
  return false;
}

function hasPhone(text: string): boolean {
  return hasDigitPhone(text) || hasSpelledPhone(text);
}

/** The first rule a comment breaks, or null if it passes. */
export function ratingTextProblem(text: string): TextRejectReason | null {
  if (hasContact(text)) return "contact";
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
