#!/usr/bin/env python3
"""Open Play trigger checks (onSessionJoined / onPlaySessionCreated) for
writes from older apps. Runs against the Firestore + Functions emulators
(project demo-tm) started by run-triggers.sh. Seeds with the emulator owner
token, so rules are bypassed and only the triggers are under test.
Prints one PASS/FAIL line per case.
"""
import json
import time
import urllib.parse
import urllib.request

import urllib.error

from fsrest import BASE, D, Ts, merge, set_doc

failures = 0


def expect(ok, name, detail=""):
    global failures
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' ({detail})' if detail else ''}")


def read(path):
    r = urllib.request.Request(f"{BASE}/{D}/{path}")
    r.add_header("Authorization", "Bearer owner")
    try:
        with urllib.request.urlopen(r) as resp:
            return json.load(resp).get("fields", {})
    except urllib.error.HTTPError:
        return {}


def plain(v):
    if "arrayValue" in v:
        return [plain(x) for x in v["arrayValue"].get("values", [])]
    if "mapValue" in v:
        return {k: plain(x) for k, x in v["mapValue"].get("fields", {}).items()}
    for k in ("stringValue", "booleanValue", "timestampValue", "doubleValue"):
        if k in v:
            return v[k]
    if "integerValue" in v:
        return int(v["integerValue"])
    return None


def doc(path):
    return {k: plain(v) for k, v in read(path).items()}


def notifications(uid):
    body = {"structuredQuery": {"from": [{"collectionId": "notifications"}],
                                "where": {"fieldFilter": {"field": {"fieldPath": "recipientId"}, "op": "EQUAL",
                                                          "value": {"stringValue": uid}}}}}
    r = urllib.request.Request(f"{BASE}/{D}:runQuery", data=json.dumps(body).encode(), method="POST")
    r.add_header("Authorization", "Bearer owner")
    r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r) as resp:
        rows = json.load(resp)
    return [{k: plain(v) for k, v in row["document"]["fields"].items()} for row in rows if "document" in row]


def wait_for(fn, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return fn()


def player(pid, uid, gender):
    set_doc(f"players/{pid}", "owner", {"firebaseUid": uid, "name": pid.title(), "email": f"{uid}@x.com",
                                        "elo": 1200, "streak": 0, "genderRaw": gender})


def session(host, attendees, date, game="doubles", created="2026-10-01T10:00:00Z", **kw):
    d = {"title": kw.pop("title", "Open Play"), "venue": kw.pop("venue", "Hall"), "date": Ts(date),
         "gameType": game, "status": "active", "attendeeIds": attendees, "hostId": host,
         "createdAt": Ts(created), "timeZone": "UTC", "sportType": "badminton"}
    d.update(kw)
    return d


for pid, uid, g in [("HA", "ha", "male"), ("HB", "hb", "female"), ("HC", "hc", "male"), ("HD", "hd", "male"),
                    ("PA", "pa", "male"), ("PB", "pb", "male"), ("PC", "pc", "male"), ("PF", "pf", "female"),
                    ("PG", "pg", "female")]:
    player(pid, uid, g)

# ── onSessionJoined: clash removal ──
set_doc("playSessions/OTHER", "owner", session("hb", ["HB", "PA"], "2030-06-01T18:00:00Z", venue="Court Nine"))
set_doc("playSessions/JOIN", "owner", session("ha", ["HA"], "2030-06-01T19:00:00Z", durationMinutes=60))
time.sleep(2)
merge("playSessions/JOIN", "owner", {"attendeeIds": ["HA", "PA"]})
removed = wait_for(lambda: doc("playSessions/JOIN").get("attendeeIds") == ["HA"])
expect(removed, "clashing joiner removed from the newer session", doc("playSessions/JOIN").get("attendeeIds"))
expect("PA" in doc("playSessions/OTHER").get("attendeeIds", []), "kept in the session they were already in")
n = wait_for(lambda: [x for x in notifications("pa") if x.get("type") == "session_removed"])
expect(n and "Court Nine" in n[0]["body"] and "Jun 1 at 6:00 PM" in n[0]["body"],
       "removed player notified with venue and time", n[0]["body"] if n else "none")
time.sleep(2)
expect(not [x for x in notifications("ha") if x.get("type") in ("session_left", "session_joined")],
       "host not told about the auto-removal")

# missing duration = 120: OTHER2 18:00 (no duration) clashes with 19:30; 20:00 doesn't
set_doc("playSessions/OTHER2", "owner", session("hb", ["HB", "PG"], "2030-07-01T18:00:00Z"))
set_doc("playSessions/LATE", "owner", session("hc", ["HC"], "2030-07-01T20:00:00Z"))
time.sleep(2)
merge("playSessions/LATE", "owner", {"attendeeIds": ["HC", "PG"]})
ok = wait_for(lambda: [x for x in notifications("hc") if x.get("type") == "session_joined"])
expect(ok and doc("playSessions/LATE").get("attendeeIds") == ["HC", "PG"],
       "back-to-back with a 120-min legacy session is kept, host notified")

# ── onSessionJoined: mixed overflow ──
set_doc("playSessions/MIX", "owner", session("hd", ["HD", "PB"], "2030-08-01T18:00:00Z", game="mixed"))
time.sleep(2)
merge("playSessions/MIX", "owner", {"attendeeIds": ["HD", "PB", "PC"]})
ok = wait_for(lambda: doc("playSessions/MIX").get("attendeeIds") == ["HD", "PB"])
expect(ok, "3rd man removed from mixed session", doc("playSessions/MIX").get("attendeeIds"))
n = wait_for(lambda: [x for x in notifications("pc") if x.get("type") == "session_removed"])
expect(n and "2 men" in n[0]["body"], "overflow player notified", n[0]["body"] if n else "none")
merge("playSessions/MIX", "owner", {"attendeeIds": ["HD", "PB", "PF"]})
time.sleep(4)
expect(doc("playSessions/MIX").get("attendeeIds") == ["HD", "PB", "PF"], "woman joins mixed session")

# ── attendeeUids mirrored for direct joins/leaves on callable-created sessions ──
set_doc("playSessions/UIDS", "owner", session("hb", ["HB"], "2030-08-05T18:00:00Z", attendeeUids=["hb"],
                                              maxPlayers=4, waitlistIds=[]))
time.sleep(2)
merge("playSessions/UIDS", "owner", {"attendeeIds": ["HB", "PF"]})
ok = wait_for(lambda: doc("playSessions/UIDS").get("attendeeUids") == ["hb", "pf"])
expect(ok, "attendeeUids gains the joiner's uid", doc("playSessions/UIDS").get("attendeeUids"))
merge("playSessions/UIDS", "owner", {"attendeeIds": ["HB"]})
ok = wait_for(lambda: doc("playSessions/UIDS").get("attendeeUids") == ["hb"])
expect(ok, "attendeeUids loses the leaver's uid", doc("playSessions/UIDS").get("attendeeUids"))

# ── onPlaySessionCreated: host limit (>3 upcoming) ──
for i in range(3):
    set_doc(f"playSessions/LIM{i}", "owner",
            session("hlim", [], f"2030-09-0{i + 1}T18:00:00Z", created=f"2026-10-0{i + 1}T10:00:00Z"))
time.sleep(3)
set_doc("playSessions/LIM3", "owner", session("hlim", [], "2030-09-05T18:00:00Z", created="2026-10-05T10:00:00Z"))
ok = wait_for(lambda: doc("playSessions/LIM3").get("status") == "cancelled")
d = doc("playSessions/LIM3")
expect(ok and d.get("autoCancelled", {}).get("reason") == "HOST_LIMIT", "4th upcoming session cancelled", d.get("status"))
expect(all(doc(f"playSessions/LIM{i}").get("status") == "active" for i in range(3)), "first 3 stay active")
n = wait_for(lambda: [x for x in notifications("hlim") if x.get("type") == "session_cancelled"])
expect(n and "up to 3" in n[0]["body"], "host told about the limit", n[0]["body"] if n else "none")

# ── onPlaySessionCreated: overlap with own session ──
set_doc("playSessions/OWN1", "owner", session("hov", [], "2030-10-01T18:00:00Z", venue="Main Gym",
                                              durationMinutes=90, created="2026-10-01T10:00:00Z"))
time.sleep(2)
set_doc("playSessions/OWN2", "owner", session("hov", [], "2030-10-01T19:00:00Z", created="2026-10-02T10:00:00Z"))
ok = wait_for(lambda: doc("playSessions/OWN2").get("status") == "cancelled")
d = doc("playSessions/OWN2")
expect(ok and d.get("autoCancelled", {}).get("reason") == "SESSION_CLASH", "overlapping hosted session cancelled")
expect(doc("playSessions/OWN1").get("status") == "active", "earlier session kept")
n = wait_for(lambda: [x for x in notifications("hov") if x.get("type") == "session_cancelled"])
expect(n and "Main Gym" in n[0]["body"], "host told which session it overlaps", n[0]["body"] if n else "none")
set_doc("playSessions/OWN3", "owner", session("hov", [], "2030-10-01T19:30:00Z", created="2026-10-03T10:00:00Z"))
time.sleep(4)
expect(doc("playSessions/OWN3").get("status") == "active", "back-to-back hosted session kept")

# overlap with a session the host joined
player("HJ", "hj", "male")
set_doc("playSessions/JOINED", "owner", session("hb", ["HB", "HJ"], "2030-11-01T18:00:00Z", venue="Rec Center"))
time.sleep(2)
set_doc("playSessions/HJ1", "owner", session("hj", ["HJ"], "2030-11-01T18:30:00Z", created="2026-10-02T10:00:00Z"))
ok = wait_for(lambda: doc("playSessions/HJ1").get("status") == "cancelled")
expect(ok, "hosted session overlapping a joined session cancelled")

print(f"# {failures} failure(s)")
