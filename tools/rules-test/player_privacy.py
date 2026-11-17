#!/usr/bin/env python3
"""Player privacy rules (player-privacy-design.md 5, 10). Run via run-player-privacy.sh
(emulator, project demo-tm). PHASE=1 checks firestore.rules, PHASE=3 firestore.rules.phase3."""
import json
import os
import urllib.error
import urllib.request

from fsrest import Ts, req, set_doc, merge, delete, get, BASE, D, tok

PHASE = int(os.environ.get("PHASE", "1"))
failures = 0


def expect(got, want, name):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'} [phase {PHASE}] {name} ({got}{'' if ok else f', want {want}'})")


def by_phase(p1, p3):
    return p1 if PHASE == 1 else p3


def run_query(uid, collection, field=None, value=None):
    """Returns (status, list of returned docs' fields)."""
    sq = {"from": [{"collectionId": collection}]}
    if field:
        sq["where"] = {"fieldFilter": {"field": {"fieldPath": field}, "op": "EQUAL", "value": {"stringValue": value}}}
    r = urllib.request.Request(f"{BASE}/{D}:runQuery", data=json.dumps({"structuredQuery": sq}).encode(), method="POST")
    r.add_header("Content-Type", "application/json")
    if uid:
        r.add_header("Authorization", "Bearer " + tok(uid))
    try:
        with urllib.request.urlopen(r) as resp:
            rows = json.loads(resp.read())
            return resp.status, [row["document"].get("fields", {}) for row in rows if "document" in row]
    except urllib.error.HTTPError as e:
        return e.code, []


def get_fields(path, uid):
    r = urllib.request.Request(f"{BASE}/{D}/{path}", method="GET")
    if uid:
        r.add_header("Authorization", "Bearer " + tok(uid))
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read()).get("fields", {})
    except urllib.error.HTTPError as e:
        return e.code, {}


NOW = Ts("2026-11-17T10:00:00Z")
# Scrubbed public docs (what the backfill --scrub / trigger leave behind).
PUBLIC = {"name": "Alice Smith", "email": "", "phone": "", "elo": 1200, "streak": 0, "genderRaw": "female",
          "avatarId": "avatar_1", "createdAt": NOW}
set_doc("players/P1", "owner", {**PUBLIC, "firebaseUid": "u1"})
set_doc("players/P2", "owner", {**PUBLIC, "name": "Bob", "firebaseUid": "u2"})
# Web profile: lower-case doc id.
set_doc("players/aaaaaaaa-0000-0000-0000-000000000003", "owner", {**PUBLIC, "name": "Web", "firebaseUid": "u3"})
PRIVATE = {"firebaseUid": "u1", "email": "alice@example.com", "phone": "5125550101", "phoneDigits": "5125550101",
           "dateOfBirth": NOW, "weightKg": 60.0, "homePostalCode": "78641", "fcmToken": "tok-1",
           "updatedAt": NOW, "source": "backfill"}
set_doc("playerPrivate/P1", "owner", PRIVATE)
set_doc("playerPrivate/P2", "owner", {**PRIVATE, "firebaseUid": "u2", "email": "bob@example.com"})

# ── Public players: guests read names, never contact data ──
st, f = get_fields("players/P1", None)
expect(st, 200, "guest (signed out) GET public players/P1")
expect(f.get("email", {}).get("stringValue"), "", "guest sees email only as \"\" after scrub")
expect(f.get("phone", {}).get("stringValue"), "", "guest sees phone only as \"\" after scrub")
expect("fcmToken" in f or "dateOfBirth" in f, False, "no token / DOB on the public doc after scrub")
st, rows = run_query(None, "players")
expect(st, 200, "guest can still list players (guest mode)")
expect(any(r.get("email", {}).get("stringValue") for r in rows), False, "guest list holds no email")
st, rows = run_query(None, "players", "email", "alice@example.com")
expect(len(rows), 0, "guest query players by email finds nothing (oracle closed after scrub)")

# ── playerPrivate: owner only ──
st, f = get_fields("playerPrivate/P1", "u1")
expect(st, 200, "owner GET playerPrivate/P1")
expect(f.get("email", {}).get("stringValue"), "alice@example.com", "owner reads own email")
expect(get("playerPrivate/P9", "u1"), 404, "owner GET missing playerPrivate/P9 -> not found, not denied")
expect(get("playerPrivate/P1", "u2"), 403, "signed-in stranger GET playerPrivate/P1")
expect(get("playerPrivate/P1", None), 403, "guest GET playerPrivate/P1")
expect(run_query("u2", "playerPrivate", "email", "alice@example.com")[0], 403, "stranger query playerPrivate where email ==")
expect(run_query(None, "playerPrivate", "email", "alice@example.com")[0], 403, "guest query playerPrivate where email ==")
expect(run_query("u2", "playerPrivate")[0], 403, "signed-in list all playerPrivate")
st, rows = run_query("u1", "playerPrivate", "firebaseUid", "u1")
expect((st, len(rows)), (200, 1), "owner query playerPrivate where firebaseUid == me")
expect(set_doc("playerPrivate/P1", "u1", PRIVATE), 403, "owner can't write playerPrivate")
expect(merge("playerPrivate/P1", "u1", {"phone": "1"}), 403, "owner can't update playerPrivate")
expect(set_doc("playerPrivate/P7", "u1", {**PRIVATE}), 403, "client can't create playerPrivate")
expect(delete("playerPrivate/P1", "u1"), 403, "owner can't delete playerPrivate")

# ── calorieRecords: owner only ──
REC = {"sessionId": "S1", "playerId": "P1", "calories": 300.0, "source": "estimated", "weightUsedKg": 60.0,
       "durationMinutes": 60, "date": NOW, "activityType": "openPlay"}
expect(set_doc("calorieRecords/C1", "u1", REC), 200, "owner creates own calorie record (iOS setData)")
expect(set_doc("calorieRecords/C1", "u1", {**REC, "calories": 320.0}), 200, "owner overwrites own record (iOS re-save)")
expect(set_doc("calorieRecords/C1", "u1", {**REC, "playerId": "P2"}), 403, "owner can't move own record to another player")
expect(run_query("u1", "calorieRecords", "playerId", "P1")[0], 200, "owner lists own records (UPPER id)")
expect(run_query("u1", "calorieRecords", "playerId", "p1")[0], 200, "owner lists own records (Android lower-case query)")
expect(get("calorieRecords/C1", "u1"), 200, "owner GET own record")
expect(run_query("u2", "calorieRecords", "playerId", "P1")[0], 403, "stranger lists another player's records")
expect(run_query("u2", "calorieRecords")[0], 403, "signed-in list all records")
expect(run_query(None, "calorieRecords", "playerId", "P1")[0], 403, "guest lists records")
expect(get("calorieRecords/C1", "u2"), 403, "stranger GET another player's record")
expect(set_doc("calorieRecords/C2", "u2", REC), 403, "stranger creates a record for another player")
expect(set_doc("calorieRecords/C1", "u2", {**REC, "playerId": "P2"}), 403, "stranger overwrites another player's record")
expect(delete("calorieRecords/C1", "u2"), 403, "stranger deletes another player's record")
WEB_ID = "aaaaaaaa-0000-0000-0000-000000000003"
expect(set_doc("calorieRecords/C3", "u3", {**REC, "playerId": WEB_ID.upper()}), 200,
       "web-profile owner (lower-case doc) creates record with UPPER id (iOS)")
expect(run_query("u3", "calorieRecords", "playerId", WEB_ID)[0], 200, "web-profile owner lists by lower-case id (web)")
expect(set_doc("calorieRecords/C4", "u1", {**REC, "playerId": "NOPE"}), 403, "record for a missing player denied")
expect(delete("calorieRecords/C1", "u1"), 200, "owner deletes own record")

# ── Player create ──
NEW = {"name": "New", "email": "", "phone": "", "elo": 1200, "streak": 0, "genderRaw": "male", "avatarId": "avatar_2",
       "createdAt": NOW}
expect(set_doc("players/N1", "n1", {**NEW, "firebaseUid": "n1"}), 200, "new-app/web create with email \"\"")
expect(set_doc("players/N2", "n2", {**NEW, "firebaseUid": "n2", "email": "n2@example.com"}), by_phase(200, 403),
       "old-app create with real email")
expect(set_doc("players/N3", "n3", {**NEW, "firebaseUid": "n3", "dateOfBirth": NOW}), by_phase(200, 403),
       "create with dateOfBirth on the public doc")
expect(set_doc("players/N4", "n4", {**NEW, "firebaseUid": "n4", "phone": "5125550199"}), by_phase(200, 403),
       "create with a phone on the public doc")
expect(set_doc("players/N5", "n5", {**NEW, "firebaseUid": "other"}), 403, "create for another uid denied")

# ── Player update ──
expect(merge("players/P1", "u1", {"name": "Alice S"}), 200, "owner rename")
expect(set_doc("players/P1", "u1", {**PUBLIC, "firebaseUid": "u1", "name": "Alice S", "skillLevel": "advanced"}), 200,
       "owner full-profile write with unchanged phone \"\" / email \"\"")
expect(merge("players/P1", "u1", {"phone": "5125550101"}), by_phase(200, 403), "owner sets phone on the public doc")
expect(merge("players/P1", "u1", {"fcmToken": "tok-new"}), by_phase(200, 403), "owner sets fcmToken on the public doc")
expect(merge("players/P1", "u1", {"email": "x@example.com"}), 403, "owner changes email to another value")
expect(merge("players/P2", "u1", {"name": "Hacked"}), 403, "stranger edits another player")
# Old-shape doc (legacy, phase 1): web blanks its contact fields and deletes Tier 2 copies.
OLD = {"name": "Old", "email": "old@example.com", "phone": "5125550111", "elo": 1200, "streak": 0,
       "genderRaw": "male", "avatarId": "avatar_1", "homePostalCode": "78641", "weightKg": 80.0,
       "dateOfBirth": NOW, "fcmToken": "tok-old", "createdAt": NOW, "firebaseUid": "u5"}
set_doc("players/P5", "owner", OLD)
expect(merge("players/P5", "u5", {"email": "", "phone": ""}), 200, "owner blanks email / phone to \"\" (web)")
expect(req("PATCH", f"{BASE}/{D}/players/P5?updateMask.fieldPaths=homePostalCode&updateMask.fieldPaths=weightKg",
           "u5", {"fields": {}}), 200, "owner deletes public homePostalCode / weightKg (web)")
set_doc("players/P6", "owner", {**OLD, "firebaseUid": "u6"})
expect(merge("players/P6", "u6", {"weightKg": 81.0}), by_phase(200, 403), "old app updates weight on the public doc")
expect(set_doc("players/P6", "u6", {**OLD, "firebaseUid": "u6", "name": "Old 2"}), by_phase(200, 403),
       "old app full-profile save with its real email")

print(f"{'PASS' if failures == 0 else 'FAIL'} [phase {PHASE}] player privacy: {failures} failure(s)")
