/**
 * Emulator checks for sportsmanship reviews (issue 40): ratePlayer,
 * deleteRating, reportRating, the text check, the aggregate, old-shape
 * normalisation (onRatingCreated / backfill) and the report digest email.
 * Runs the callable handlers directly (`.run`) against the Firestore
 * emulator; never a real project. Rules: tools/rules-test/run-ratings.sh.
 *
 * Usage (from tournmate-server/functions):
 *   npm run test:emulator-ratings
 *
 * Exits non-zero if any case fails.
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith("demo-")) {
  console.error("Refusing to run: needs the Firestore emulator and a demo-* project (use npm run test:emulator-ratings).");
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ projectId });

/* eslint-disable @typescript-eslint/no-var-requires */
const callables = require("../callables/ratings") as typeof import("../callables/ratings");
const svc = require("../services/ratings") as typeof import("../services/ratings");
const text = require("../services/ratingText") as typeof import("../services/ratingText");
const emails = require("../services/ratingReportEmails") as typeof import("../services/ratingReportEmails");
const mailer = require("../services/mailer") as typeof import("../services/mailer");
const backfill = require("./backfillRatings") as typeof import("./backfillRatings");

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) passes++; else failures++;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = { run: (req: any) => any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(fn: Fn, uid: string | null, data: unknown): Promise<any> {
  return await fn.run({ data, auth: uid ? { uid, token: {} } : undefined, rawRequest: {}, acceptsStreaming: false });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok(name: string, fn: Fn, uid: string | null, data: unknown): Promise<any> {
  try {
    const r = await call(fn, uid, data);
    check(name, true, JSON.stringify(r));
    return r;
  } catch (e) {
    const err = e as { message?: string; details?: { reason?: string } };
    check(name, false, `threw ${err.details?.reason ?? ""} ${err.message}`);
    return null;
  }
}
async function bad(name: string, fn: Fn, uid: string | null, data: unknown, reason: string): Promise<void> {
  try {
    const r = await call(fn, uid, data);
    check(name, false, `expected ${reason}, got ${JSON.stringify(r)}`);
  } catch (e) {
    const err = e as { message?: string; details?: { reason?: string } };
    check(name, err.details?.reason === reason, `${err.details?.reason}: ${err.message}`);
  }
}

async function badText(name: string, fn: Fn, uid: string | null, data: unknown, textReason: string | undefined): Promise<void> {
  try {
    const r = await call(fn, uid, data);
    check(name, false, `expected RATING_TEXT_REJECTED, got ${JSON.stringify(r)}`);
  } catch (e) {
    const err = e as { message?: string; details?: { reason?: string; textReason?: string } };
    const d = err.details ?? {};
    const comment = (data as { comment?: string }).comment ?? "";
    check(name, d.reason === "RATING_TEXT_REJECTED" && d.textReason === textReason
      && !JSON.stringify(d).includes(comment) && !(err.message ?? "").includes(comment),
    `${d.reason}/${d.textReason}: ${err.message}`);
  }
}

const P = (n: number) => `AAAAAAAA-0000-0000-0000-00000000000${n}`;
const A = { id: P(1), uid: "uA", name: "Alice Smith", avatarId: "avatar_3" };
const B = { id: P(2), uid: "uB", name: "Bob Jones" };
const C = { id: P(3), uid: "uC", name: "Cara" };
const Dd = { id: P(4), uid: "uD", name: "Dev Patel" };
const E = { id: P(5), uid: "uE", name: "Eve Long" };
const F = { id: P(6), uid: "uF", name: "Finn" };
// Web-created target with a lower-case doc id.
const W = { id: "bbbbbbbb-0000-0000-0000-000000000007", uid: "uW", name: "Web Person" };

async function main(): Promise<void> {
  const db = getFirestore();
  for (const p of [A, B, C, Dd, E, F, W]) {
    await db.collection("players").doc(p.id).set({
      name: p.name, firebaseUid: p.uid, email: `${p.uid}@x.com`, elo: 1200, streak: 0,
      avatarId: (p as { avatarId?: string }).avatarId ?? "avatar_1",
      ...(p === C ? { photoURL: "https://example.test/c.jpg" } : {}),
    });
  }
  const visibleFor = async (pid: string) => (await db.collection("ratings").where("playerId", "==", pid).get()).docs;
  const agg = async (pid: string) => (await db.collection("players").doc(pid).get()).data()?.sportsmanship;

  // ── Text check (pure) ──
  const benign = [
    "Great shuttlecock control and fair line calls.", "Won 21-17 18-21 21-15, close match!",
    "Class act, passed the shuttle back every time.", "Assessed every call calmly.", "Scunthorpe fan, good sport.",
    "Played at 7 pm, on time.", "bc of rain we started late", "Good game, see you next week :)",
    // false-positive guards for the contact / link / phone patterns
    "great at net", "good @ net", "Strong @ the net, weak at the back", "Met @7pm sharp, on time", "Played @home courts",
    "Fair player @ the club", "21-17 18-21 21-15", "6-4 3-6 7-6 6-4 6-2", "21-9 21-8 in 25 minutes",
    "Won 2 sets to 1, scores 21 19 and 21 15", "Lost one set, won two, then three more games",
    "the shuttle landed on the dot in the corner", "great at net. in the end he won", "Plays on the dot, never late",
    "Quick snap of the wrist on smashes", "Snappy footwork, great snap smash", "ig he played well tbh",
    "Called me out fairly when I was wrong", "Text book backhand, called every line fairly", "He made me laugh",
    "Good sport, would play again. Thanks!", "Smart doubles partner, great at reading the game",
    "Fast reflexes, great drop shots", "Hit me with a clean smash, all good", "She gave 100% in all 3 games",
    "Rally of 40+ shots, amazing", "Plays 4 times a week at 6am", "No.1 at the club", "Ranked #3 in the league",
    "Talked through every call, contacts the umpire calmly", "Sent a message to the group to reschedule",
    "Was on time at 7:30, 2 courts booked", "One of the best, five stars", "Seven out of ten serves landed in",
    "Good mail-in entry for the tourney", "x-factor at the net", "Score was 11 x 3 in the tiebreak",
  ];
  for (const t of benign) check(`text passes: "${t}"`, text.ratingTextProblem(t) === null, String(text.ratingTextProblem(t)));
  const blocked: [string, string][] = [
    ["you are a total fuck", "profanity"], ["F u c k this guy", "profanity"], ["sh1t player", "profanity"],
    ["what a b!tch", "profanity"], ["motherfucker", "profanity"], ["chutiya hai", "profanity"],
    ["bhenchod", "profanity"], ["lanja", "profanity"], ["fuuuuck", "profanity"],
    ["see www.spam.com", "link"], ["visit https://x.io now", "link"], ["dm me at insta.com", "contact"],
    ["check site dot com", "link"], ["check mysite [dot] com", "link"], ["visit cheats (dot) in", "link"],
    ["mysite{.}com", "link"], ["go to cheats . com", "link"], ["www dot cheats dot net", "link"],
    ["club(dot)org for details", "link"], ["see mysite .com", "link"],
    ["mail me a@b.com", "contact"], ["riley at gmail dot com", "contact"], ["riley23 at gmail", "contact"],
    ["gmail dot com", "contact"], ["riley [at] yahoo", "contact"], ["riley(at)hotmail(dot)com", "contact"],
    ["my gmail is riley23", "contact"], ["riley @ gmail . com", "contact"], ["write to riley at outlook", "contact"],
    ["follow @riley_23", "contact"], ["(@riley) on court", "contact"], ["@riley23 great game", "contact"],
    ["insta: riley23", "contact"], ["instagram riley", "contact"], ["ig riley", "contact"], ["ig: riley_23", "contact"],
    ["add me on snap", "contact"], ["snap: riley23", "contact"], ["my snap is riley_23", "contact"],
    ["snapchat riley", "contact"], ["telegram riley23", "contact"], ["on telegram", "contact"],
    ["whatsapp me", "contact"], ["whats app me for games", "contact"], ["dm me", "contact"], ["DM me for doubles", "contact"],
    ["text me anytime", "contact"], ["call me for a game", "contact"], ["message me later", "contact"],
    ["find me on x", "contact"], ["fb riley.k", "contact"], ["tiktok riley", "contact"], ["hmu for doubles", "contact"],
    ["my number is in my bio", "contact"],
    ["call 98765 43210", "phone"], ["ring me on 98765 43210", "contact"], ["98765 43210", "phone"],
    ["+1 (555) 123-4567", "phone"], ["9876543210", "phone"], ["9 8 7 6 5 4 3 2 1 0", "phone"],
    ["nine eight seven six five four three", "phone"], ["nine eight seven six five four three two one zero", "phone"],
    ["98 seven 6 five 43 two", "phone"], ["98765 four three two one", "phone"], ["nine 8 seven 6 five 4 three", "phone"],
    ["Nine-Eight-Seven-Six-Five-Four-Three", "phone"], ["double nine eight seven six five four", "phone"],
    ["number: nine eight seven, six five four, three two one", "phone"],
  ];
  for (const [t, why] of blocked) check(`text blocked (${why}): "${t}"`, text.ratingTextProblem(t) === why, String(text.ratingTextProblem(t)));
  check("display name: first + last initial", svc.reviewerDisplayName("Arjun  kumar reddy") === "Arjun R.");
  check("display name: single name", svc.reviewerDisplayName("Cara") === "Cara");
  check("display name: blank -> null", svc.reviewerDisplayName("  ") === null);

  // ── ratePlayer: create named ──
  const r1 = await ok("A rates B (named, with comment)", callables.ratePlayer, A.uid,
    { playerId: B.id, stars: 5, comment: "  Called every line fairly.  " });
  check("returns created + ratingId", r1?.status === "created" && typeof r1?.ratingId === "string");
  const id1 = r1?.ratingId as string;
  let doc = (await db.collection("ratings").doc(id1).get()).data() ?? {};
  check("public doc: fields", doc.playerId === B.id && doc.stars === 5 && doc.comment === "Called every line fairly."
    && doc.anonymous === false && doc.raterName === "Alice S." && doc.raterAvatarId === "avatar_3"
    && doc.status === "visible" && doc.reportCount === 0 && doc.createdAt instanceof Timestamp, JSON.stringify(doc));
  check("public doc has no raterId", !("raterId" in doc));
  check("rating id is a random UPPER case UUID (old apps need UUID ids)", /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(id1) && !id1.includes(A.id), id1);
  const author = (await db.collection("ratingAuthors").doc(id1).get()).data() ?? {};
  check("author doc", author.raterId === A.id && author.raterUid === A.uid && author.playerId === B.id, JSON.stringify(author));
  let s = await agg(B.id);
  check("aggregate after 1", s?.count === 1 && s?.avg === 5 && s?.withComments === 1 && s?.dist?.["5"] === 1, JSON.stringify(s));

  // ── edit -> anonymous, replaces ──
  const r2 = await ok("A edits (3 stars, anonymous)", callables.ratePlayer, A.uid,
    { playerId: B.id, stars: 3, comment: "Slow to agree on scores.", anonymous: true });
  check("edit returns updated, same id", r2?.status === "updated" && r2?.ratingId === id1);
  doc = (await db.collection("ratings").doc(id1).get()).data() ?? {};
  check("anonymous: no name, no avatar", doc.anonymous === true && doc.raterName === null && doc.raterAvatarId === null
    && doc.raterPhotoURL === null && !("raterId" in doc), JSON.stringify(doc));
  check("still one review by A", (await visibleFor(B.id)).length === 1);
  s = await agg(B.id);
  check("aggregate after edit", s?.count === 1 && s?.avg === 3 && s?.dist?.["5"] === 0 && s?.dist?.["3"] === 1, JSON.stringify(s));

  // ── C rates B, stars only; photo copied ──
  const r3 = await ok("C rates B (no comment)", callables.ratePlayer, C.uid, { playerId: B.id, stars: 5, comment: "   " });
  const c3 = (await db.collection("ratings").doc(r3?.ratingId).get()).data() ?? {};
  check("blank comment stored as null; photo copied", c3.comment === null && c3.raterPhotoURL === "https://example.test/c.jpg"
    && c3.raterName === "Cara", JSON.stringify(c3));
  s = await agg(B.id);
  check("aggregate: avg 4, 2 ratings, 1 with comment", s?.count === 2 && s?.avg === 4 && s?.withComments === 1, JSON.stringify(s));

  // ── web player (lower-case doc id) ──
  const rw = await ok("rate a web player by upper-case id", callables.ratePlayer, A.uid, { playerId: W.id.toUpperCase(), stars: 4 });
  const wdoc = (await db.collection("ratings").doc(rw?.ratingId).get()).data() ?? {};
  check("playerId stored as the UPPER case id the apps query", wdoc.playerId === W.id.toUpperCase(), String(wdoc.playerId));
  check("web player's aggregate on the lower-case doc", (await agg(W.id))?.count === 1);

  // ── validation ──
  await bad("signed out", callables.ratePlayer, null, { playerId: B.id, stars: 4 }, "UNAUTHENTICATED");
  await bad("no profile", callables.ratePlayer, "u-none", { playerId: B.id, stars: 4 }, "NO_PROFILE");
  await bad("self rating", callables.ratePlayer, A.uid, { playerId: A.id, stars: 4 }, "SELF_RATING");
  await bad("self rating (lower-case id)", callables.ratePlayer, A.uid, { playerId: A.id.toLowerCase(), stars: 4 }, "SELF_RATING");
  await bad("unknown player", callables.ratePlayer, A.uid, { playerId: "nope", stars: 4 }, "NOT_FOUND");
  for (const stars of [0, 6, 2.5, "4", null]) {
    await bad(`stars ${JSON.stringify(stars)}`, callables.ratePlayer, A.uid, { playerId: B.id, stars }, "INVALID_ARGUMENT");
  }
  await bad("comment over 200", callables.ratePlayer, A.uid, { playerId: B.id, stars: 4, comment: "x".repeat(201) }, "INVALID_ARGUMENT");
  await ok("comment of exactly 200", callables.ratePlayer, Dd.uid, { playerId: B.id, stars: 4, comment: "y".repeat(200) });
  await bad("anonymous not a bool", callables.ratePlayer, A.uid, { playerId: B.id, stars: 4, anonymous: "yes" }, "INVALID_ARGUMENT");
  await badText("profanity rejected (textReason profanity)", callables.ratePlayer, E.uid, { playerId: B.id, stars: 1, comment: "You are a total fuckwit" }, "profanity");
  await badText("link rejected (textReason link)", callables.ratePlayer, E.uid, { playerId: B.id, stars: 1, comment: "see www.cheats.com" }, "link");
  await badText("obfuscated link rejected (link)", callables.ratePlayer, E.uid, { playerId: B.id, stars: 1, comment: "see cheats [dot] com" }, "link");
  await badText("phone rejected (textReason phone)", callables.ratePlayer, E.uid, { playerId: B.id, stars: 1, comment: "98765 43210" }, "phone");
  await badText("spelled phone rejected (phone)", callables.ratePlayer, E.uid, { playerId: B.id, stars: 1, comment: "nine eight seven six five four three" }, "phone");
  await badText("email rejected (textReason contact)", callables.ratePlayer, E.uid, { playerId: B.id, stars: 1, comment: "riley at gmail dot com" }, "contact");
  await badText("handle rejected (contact)", callables.ratePlayer, E.uid, { playerId: B.id, stars: 1, comment: "insta: riley23" }, "contact");
  await badText("dm me rejected (contact)", callables.ratePlayer, E.uid, { playerId: B.id, stars: 1, comment: "dm me for doubles" }, "contact");
  text.setTextModerator(async () => { throw new Error("down"); });
  await bad("moderator error fails closed", callables.ratePlayer, E.uid, { playerId: B.id, stars: 2, comment: "ok" }, "RATING_CHECK_FAILED");
  text.setTextModerator(async () => "reject");
  await badText("stub moderator reject (no textReason)", callables.ratePlayer, E.uid, { playerId: B.id, stars: 2, comment: "fine" }, undefined);
  text.setTextModerator(null);
  check("rejected calls wrote nothing for E",
    (await db.collection("ratingAuthors").where("raterId", "==", E.id).get()).empty);

  // ── reports ──
  await bad("can't report own review", callables.reportRating, A.uid, { ratingId: id1, reason: "spam" }, "OWN_REVIEW");
  await bad("unknown reason", callables.reportRating, C.uid, { ratingId: id1, reason: "meh" }, "INVALID_ARGUMENT");
  await bad("unknown review", callables.reportRating, C.uid, { ratingId: "nope", reason: "spam" }, "NOT_FOUND");
  const rep1 = await ok("C reports A's review", callables.reportRating, C.uid, { ratingId: id1, reason: "offensive", note: "rude" });
  check("status reported", rep1?.status === "reported");
  const rep1b = await ok("C reports again", callables.reportRating, C.uid, { ratingId: id1, reason: "offensive" });
  check("second report by same person: already_reported", rep1b?.status === "already_reported");
  await ok("B (the rated player) reports", callables.reportRating, B.uid, { ratingId: id1, reason: "harassment" });
  doc = (await db.collection("ratings").doc(id1).get()).data() ?? {};
  check("2 reports: still visible, reportCount 2", doc.reportCount === 2 && doc.status === "visible");
  const rep3 = await ok("Dev reports (3rd)", callables.reportRating, Dd.uid, { ratingId: id1, reason: "spam" });
  check("3rd report hides it", rep3?.status === "hidden");
  check("moved out of ratings", !(await db.collection("ratings").doc(id1).get()).exists);
  const hid = (await db.collection("hiddenRatings").doc(id1).get()).data() ?? {};
  check("in hiddenRatings with status hidden", hid.status === "hidden" && hid.reportCount === 3, JSON.stringify(hid));
  s = await agg(B.id);
  check("hidden review dropped from aggregate", s?.count === 2 && s?.avg === 4.5, JSON.stringify(s));
  const rep4 = await ok("report after hidden", callables.reportRating, E.uid, { ratingId: id1, reason: "spam" });
  check("report on a hidden review: reported", rep4?.status === "reported");

  // ── report digest email ──
  const sent: { subject: string; text: string }[] = [];
  mailer.setMailTransportForTests({ sendMail: async (m) => { sent.push(m); return {}; } });
  const n = await emails.sendRatingReportDigest(db, new Date(Date.now() + 1000));
  check("digest counts 4 reports", n === 4, String(n));
  check("digest email sent with review text and author", sent.length === 1 && sent[0].subject.includes("Review reports")
    && sent[0].text.includes("Slow to agree on scores.") && sent[0].text.includes(A.id) && sent[0].text.includes("HIDDEN"),
  sent[0]?.subject);
  sent.length = 0;
  const none = await emails.sendRatingReportDigest(db, new Date(Date.now() + 3 * 24 * 3600 * 1000));
  check("no reports in window: no email", none === 0 && sent.length === 0);
  mailer.setMailTransportForTests(null);

  // ── rewriting a hidden review ──
  await bad("rewrite with the same comment rejected", callables.ratePlayer, A.uid,
    { playerId: B.id, stars: 3, comment: "Slow to agree on scores.", anonymous: true }, "RATING_TEXT_REJECTED");
  const r5 = await ok("rewrite with a new comment", callables.ratePlayer, A.uid, { playerId: B.id, stars: 4, comment: "Fair overall." });
  check("rewrite keeps id, visible again", r5?.ratingId === id1 && (await db.collection("ratings").doc(id1).get()).exists
    && !(await db.collection("hiddenRatings").doc(id1).get()).exists);
  doc = (await db.collection("ratings").doc(id1).get()).data() ?? {};
  check("rewrite resets reports", doc.reportCount === 0
    && (await db.collection("ratingReports").where("ratingId", "==", id1).get()).empty, JSON.stringify(doc));

  // ── admin moderation ──
  check("admin remove", await svc.setRatingStatus(db, id1, "removed"));
  check("removed review hidden with status removed",
    (await db.collection("hiddenRatings").doc(id1).get()).data()?.status === "removed");
  check("admin restore", await svc.setRatingStatus(db, id1, "visible"));
  check("restored review visible", (await db.collection("ratings").doc(id1).get()).data()?.status === "visible");

  // ── delete ──
  await ok("A deletes own review", callables.deleteRating, A.uid, { playerId: B.id });
  check("review and author doc gone", !(await db.collection("ratings").doc(id1).get()).exists
    && !(await db.collection("ratingAuthors").doc(id1).get()).exists);
  s = await agg(B.id);
  check("aggregate after delete", s?.count === 2, JSON.stringify(s));
  await bad("delete again", callables.deleteRating, A.uid, { playerId: B.id }, "NOT_FOUND");

  // ── rate limits ──
  for (let i = 0; i < svc.RATING_DAILY_LIMIT; i++) {
    await db.collection("ratingAuthors").doc(`limit-${i}`).set({ raterId: F.id, raterUid: F.uid, playerId: `X${i}`, updatedAt: Timestamp.now() });
  }
  await bad("21st rating in 24h rate limited", callables.ratePlayer, F.uid, { playerId: B.id, stars: 4 }, "RATE_LIMITED");
  for (let i = 0; i < svc.REPORT_DAILY_LIMIT; i++) {
    await db.collection("ratingReports").doc(`limit-${i}`).set({ ratingId: `Z${i}`, reporterId: F.id, reason: "spam",
      createdAt: Timestamp.fromMillis(Date.now() - 4 * 24 * 3600 * 1000 + i) });
  }
  const anyRating = (await visibleFor(B.id))[0].id;
  await ok("old reports don't count toward the limit", callables.reportRating, F.uid, { ratingId: anyRating, reason: "other" });
  for (let i = 0; i < svc.REPORT_DAILY_LIMIT; i++) {
    await db.collection("ratingReports").doc(`limit-${i}`).update({ createdAt: Timestamp.now() });
  }
  await bad("report rate limited", callables.reportRating, F.uid, { ratingId: anyRating, reason: "spam" }, "RATE_LIMITED");

  // ── old-shape docs: trigger normalisation ──
  const T = Timestamp.fromMillis(Date.now() - 60_000);
  await db.collection("ratings").doc("LEGACY-1").set({ playerId: E.id, raterId: Dd.id, stars: 2, comment: "Late again", createdAt: T });
  const n1 = await svc.normalizeLegacyRating(db, "LEGACY-1");
  check("legacy doc normalized in place", n1.outcome === "normalized");
  const l1 = (await db.collection("ratings").doc("LEGACY-1").get()).data() ?? {};
  check("legacy: raterId removed, anonymous, visible", !("raterId" in l1) && l1.anonymous === true && l1.raterName === null
    && l1.status === "visible" && l1.comment === "Late again", JSON.stringify(l1));
  check("legacy: author doc", (await db.collection("ratingAuthors").doc("LEGACY-1").get()).data()?.raterId === Dd.id);
  check("legacy: aggregate", (await agg(E.id))?.count === 1);
  const again = await svc.normalizeLegacyRating(db, "LEGACY-1");
  check("normalized doc is skipped next time", again.outcome === "skipped");
  // Old app writes a second rating for the same pair (newer): merged into the first id.
  await db.collection("ratings").doc("LEGACY-2").set({ playerId: E.id, raterId: Dd.id, stars: 5, createdAt: Timestamp.now() });
  const n2 = await svc.normalizeLegacyRating(db, "LEGACY-2");
  check("newer old-app rating merged into the existing review", n2.outcome === "merged"
    && !(await db.collection("ratings").doc("LEGACY-2").get()).exists
    && (await db.collection("ratings").doc("LEGACY-1").get()).data()?.stars === 5);
  check("one review per pair after merge", (await visibleFor(E.id)).length === 1 && (await agg(E.id))?.avg === 5);
  // Old app rating older than a callable rating: superseded (deleted).
  await ok("Dev edits through the callable", callables.ratePlayer, Dd.uid, { playerId: E.id, stars: 4, comment: "Nice" });
  await db.collection("ratings").doc("LEGACY-3").set({ playerId: E.id, raterId: Dd.id, stars: 1, createdAt: T });
  const n3 = await svc.normalizeLegacyRating(db, "LEGACY-3");
  check("older old-app rating superseded", n3.outcome === "superseded" && !(await db.collection("ratings").doc("LEGACY-3").get()).exists);
  check("aggregate unaffected by superseded", (await agg(E.id))?.avg === 4);
  // Callable-written docs (no raterId) are skipped.
  check("new-shape doc skipped", (await svc.normalizeLegacyRating(db, (await visibleFor(E.id))[0].id)).outcome === "skipped");

  // Old web doc with a lower-case player id still counts for that player.
  await db.collection("ratings").doc("LEGACY-W").set({ playerId: W.id, raterId: B.id, stars: 2, createdAt: T });
  await svc.normalizeLegacyRating(db, "LEGACY-W");
  check("lower-case legacy playerId normalised to UPPER and counted", (await db.collection("ratings").doc("LEGACY-W").get()).data()?.playerId === W.id.toUpperCase()
    && (await agg(W.id))?.count === 2, JSON.stringify(await agg(W.id)));

  // ── backfill ──
  const old = (ms: number) => Timestamp.fromMillis(Date.now() - ms);
  await db.collection("ratings").doc("BF-1").set({ playerId: F.id, raterId: A.id, stars: 1, createdAt: old(300_000) });
  await db.collection("ratings").doc("BF-2").set({ playerId: F.id, raterId: A.id, stars: 4, comment: "Good", createdAt: old(200_000) });
  await db.collection("ratings").doc("BF-3").set({ playerId: F.id, raterId: A.id, stars: 3, createdAt: old(250_000) });
  await db.collection("ratings").doc("BF-4").set({ playerId: F.id, raterId: B.uid, stars: 5, comment: "shit player", createdAt: old(100_000) });
  const dry = await backfill.backfillRatings(db, false, () => undefined);
  check("backfill dry run counts", dry.legacy === 4 && dry.pairs === 2 && dry.superseded === 2 && dry.droppedComments === 1
    && !dry.applied, JSON.stringify(dry));
  check("dry run wrote nothing", (await db.collection("ratings").doc("BF-1").get()).data()?.raterId === A.id
    && (await agg(F.id)) === undefined);
  const real = await backfill.backfillRatings(db, true, () => undefined);
  check("backfill applied", real.applied && real.superseded === 2);
  const fDocs = await visibleFor(F.id);
  check("backfill: newest kept per pair, 2 reviews", fDocs.length === 2, fDocs.map((d) => d.id).join(","));
  const keptA = fDocs.find((d) => d.data().stars === 4);
  check("backfill: kept the newest (4 stars, 'Good')", keptA?.data().comment === "Good");
  check("backfill: no raterId on any public doc", fDocs.every((d) => !("raterId" in d.data())));
  const keptB = fDocs.find((d) => d.data().stars === 5)?.data() ?? {};
  check("backfill: comment failing the text check dropped, stars kept", keptB.comment === null, JSON.stringify(keptB));
  const bAuthor = (await db.collection("ratingAuthors").doc("BF-4").get()).data() ?? {};
  check("backfill: uid raterId resolved to the player", bAuthor.raterId === B.id && bAuthor.raterUid === B.uid, JSON.stringify(bAuthor));
  s = await agg(F.id);
  check("backfill: aggregate", s?.count === 2 && s?.avg === 4.5 && s?.withComments === 1, JSON.stringify(s));
  const rerun = await backfill.backfillRatings(db, true, () => undefined);
  check("backfill re-run: nothing left to do", rerun.legacy === 0, JSON.stringify(rerun));

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "All checks passed" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
