#!/usr/bin/env python3
"""Sportsmanship review rules (issue 40). Run via run-ratings.sh (emulator, project demo-tm)."""
import json
import urllib.error
import urllib.request

from fsrest import Ts, req, set_doc, merge, delete, get, BASE, D, tok

failures = 0


def expect(got, want, name):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'} {name} ({got}{'' if ok else f', want {want}'})")


def query(uid, collection, field=None, value=None):
    sq = {"from": [{"collectionId": collection}]}
    if field:
        sq["where"] = {"fieldFilter": {"field": {"fieldPath": field}, "op": "EQUAL", "value": {"stringValue": value}}}
    r = urllib.request.Request(f"{BASE}/{D}:runQuery", data=json.dumps({"structuredQuery": sq}).encode(), method="POST")
    r.add_header("Content-Type", "application/json")
    if uid:
        r.add_header("Authorization", "Bearer " + tok(uid))
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


NOW = Ts("2026-11-10T10:00:00Z")
PLAYER = {"name": "Alice Smith", "email": "a@x.com", "elo": 1200, "streak": 0, "genderRaw": "female"}
set_doc("players/PA", "owner", {**PLAYER, "firebaseUid": "uA"})
set_doc("players/PB", "owner", {**PLAYER, "name": "Bob", "email": "b@x.com", "firebaseUid": "uB"})

VISIBLE = {"playerId": "PB", "stars": 4, "comment": "Fair calls", "anonymous": True, "raterName": None,
           "status": "visible", "reportCount": 0, "createdAt": NOW, "updatedAt": NOW}
expect(set_doc("ratings/R1", "owner", VISIBLE), 200, "seed visible review (admin)")
expect(set_doc("ratingAuthors/R1", "owner", {"raterId": "PA", "raterUid": "uA", "playerId": "PB"}), 200, "seed author")
expect(set_doc("hiddenRatings/H1", "owner", {**VISIBLE, "status": "hidden"}), 200, "seed hidden review")
expect(set_doc("ratingAuthors/H1", "owner", {"raterId": "PA", "raterUid": "uA", "playerId": "PB"}), 200, "seed hidden author")
expect(set_doc("ratingReports/R1_PB", "owner", {"ratingId": "R1", "reporterId": "PB", "reason": "spam"}), 200, "seed report")

# ratings: visible reviews readable by signed-in users
expect(get("ratings/R1", "uB"), 200, "signed-in user reads a review")
expect(get("ratings/R1", None), 403, "signed-out can't read reviews")
expect(query("uB", "ratings", "playerId", "PB"), 200, "signed-in list query by playerId (old and new apps)")
expect(set_doc("ratings/R1", "uA", {**VISIBLE, "stars": 5}), 403, "client can't update a review")
expect(delete("ratings/R1", "uA"), 403, "client can't delete a review")

# hiddenRatings: only the author, by id
expect(get("hiddenRatings/H1", "uA"), 200, "author reads own hidden review")
expect(get("hiddenRatings/H1", "uB"), 403, "rated player can't read the hidden review")
expect(get("hiddenRatings/R1", "uA"), 404, "author: own review not hidden -> not found (allowed)")
expect(get("hiddenRatings/NOPE", "uA"), 403, "no author doc -> denied")
expect(query("uA", "hiddenRatings"), 403, "hidden reviews can't be listed")
expect(set_doc("hiddenRatings/H2", "uA", VISIBLE), 403, "client can't write hidden reviews")

# ratingAuthors: own only
expect(get("ratingAuthors/R1", "uA"), 200, "author reads own author doc")
expect(get("ratingAuthors/R1", "uB"), 403, "rated player can't see who wrote it")
expect(query("uA", "ratingAuthors", "raterUid", "uA"), 200, "author lists own author docs")
expect(query("uB", "ratingAuthors", "playerId", "PB"), 403, "rated player can't list authors of their reviews")
expect(query("uB", "ratingAuthors"), 403, "can't list all authors")
expect(set_doc("ratingAuthors/R9", "uA", {"raterId": "PA", "raterUid": "uA", "playerId": "PB"}), 403, "client can't write authors")

# ratingReports: server only
expect(get("ratingReports/R1_PB", "uB"), 403, "reporter can't read reports")
expect(set_doc("ratingReports/R1_PA", "uA", {"ratingId": "R1", "reporterId": "PA"}), 403, "client can't write reports")
expect(query("uB", "ratingReports"), 403, "client can't list reports")

# Phase A: old-shape client create still allowed
OLD = {"playerId": "PB", "raterId": "PA", "stars": 5, "createdAt": NOW}
expect(set_doc("ratings/OLD1", "uA", OLD), 200, "old-shape create (no comment) still allowed")
expect(set_doc("ratings/OLD2", "uA", {**OLD, "comment": "Good game"}), 200, "old-shape create with comment allowed")
expect(set_doc("ratings/OLD3", "uA", {**OLD, "comment": None}), 200, "old-shape create with null comment allowed")
expect(set_doc("ratings/OLD4", "uA", {**OLD, "tournamentId": "T1"}), 200, "old-shape create with tournamentId allowed")
expect(set_doc("ratings/BAD1", "uA", {**OLD, "comment": "x" * 201}), 403, "comment over 200 rejected")
expect(set_doc("ratings/BAD2", "uA", {**OLD, "comment": 5}), 403, "non-text comment rejected")
expect(set_doc("ratings/BAD3", "uA", {**OLD, "status": "visible"}), 403, "client can't set status")
expect(set_doc("ratings/BAD4", "uA", {**OLD, "raterName": "Someone"}), 403, "client can't set raterName")
expect(set_doc("ratings/BAD5", "uA", {**OLD, "anonymous": False}), 403, "client can't set anonymous")
expect(set_doc("ratings/BAD6", "uA", {**OLD, "raterId": "PB", "playerId": "PA"}), 403, "can't rate as someone else")
expect(set_doc("ratings/BAD7", "uA", {**OLD, "playerId": "PA"}), 403, "can't rate yourself")
expect(set_doc("ratings/BAD8", "uA", {**OLD, "stars": 6}), 403, "stars over 5 rejected")

# players.sportsmanship is server-only
expect(set_doc("players/PC", "uC", {**PLAYER, "email": "c@x.com", "firebaseUid": "uC",
                                    "sportsmanship": {"avg": 5, "count": 99}}), 403, "player create with sportsmanship rejected")
expect(merge("players/PA", "uA", {"sportsmanship": {"avg": 5, "count": 99}}), 403, "player update of sportsmanship rejected")
expect(merge("players/PA", "uA", {"name": "Alice S"}), 200, "player name update still allowed")
print(f"# {failures} failed")
