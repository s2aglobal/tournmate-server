#!/usr/bin/env python3
"""Rules checks for racket live scoring (badminton): `matches.live` is
server-only, the `points` / `racketLive` subcollections are readable by
anyone and never client-written, and a match being scored live (any
`live.status` but `finished`) can't be changed by clients (older apps) until
the live scorer finishes.

Runs against the Firestore emulator (project demo-tm) started by run.sh.
Prints one PASS/FAIL line per case.
"""
from fsrest import Ts, get, merge, set_doc, delete

DATE = "2030-06-01T18:00:00Z"
failures = 0


def expect(got, want, name):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'} {name} ({got}{'' if ok else f', want {want}'})")


set_doc("tournaments/RL", "owner", {"title": "Smash Open", "location": "Hall", "date": Ts(DATE), "createdBy": "org",
                                    "sportType": "badminton", "formatRaw": "openDoubles",
                                    "matchFormatRaw": "singleElimination"})


def match(extra=None):
    d = {"tournamentId": "RL", "teamAId": "RA", "teamBId": "RB", "statusRaw": "scheduled", "createdAt": Ts(DATE)}
    d.update(extra or {})
    return d


LIVE = {"kind": "racket", "sport": "badminton", "status": "inProgress", "scorerUid": "pa", "scorerName": "Pat",
        "games": [{"a": 21, "b": 18}], "current": {"a": 9, "b": 7}, "server": {"side": "A", "court": "L"},
        "gamesWon": {"a": 1, "b": 0}, "switchEnds": False, "seq": 55}

print("# server-only racket live fields")
expect(set_doc("matches/RL_NEW", "org", match({"live": LIVE})), 403, "create with racket live rejected")
expect(set_doc("matches/RL_M", "org", match()), 200, "organizer creates match")
expect(merge("matches/RL_M", "pa", {"live": LIVE}), 403, "player write of live rejected")
expect(merge("matches/RL_M", "pa", {"statusRaw": "scoreSubmitted", "scoreA": 2, "scoreB": 0,
                                    "setScores": [{"teamAPoints": 21, "teamBPoints": 18}]}), 200,
       "older apps still enter a score when not scored live")

print("# match locked while scored live (in progress and ended)")
for status in ["inProgress", "ended"]:
    mid = f"matches/RL_LIVE_{status}"
    set_doc(mid, "owner", match({"live": {**LIVE, "status": status}}))
    expect(merge(mid, "pb", {"statusRaw": "scoreSubmitted", "scoreA": 0, "scoreB": 2}), 403,
           f"score entry while {status} rejected")
    expect(merge(mid, "org", {"statusRaw": "finished", "scoreA": 2, "scoreB": 0}), 403,
           f"organizer direct finish while {status} rejected")
    expect(merge(mid, "org", {"live": None}), 403, f"clearing live while {status} rejected")
    expect(get(mid, None), 200, f"anyone reads a match while {status}")
set_doc("matches/RL_DONE", "owner", match({"live": {**LIVE, "status": "finished"}, "statusRaw": "scoreSubmitted",
                                           "submittedBy": "pa"}))
expect(merge("matches/RL_DONE", "pb", {"statusRaw": "finished", "confirmedBy": "pb"}), 200,
       "older apps confirm after the live scorer finished")
expect(merge("matches/RL_DONE", "pb", {"live": {**LIVE, "status": "inProgress"}}), 403, "reopening live rejected")

print("# points / racketLive subcollections")
set_doc("matches/RL_M/points/p1", "owner", {"seq": 1, "game": 1, "winner": "A", "scoreA": 1, "scoreB": 0})
set_doc("matches/RL_M/racketLive/state", "owner", {"events": [], "config": {"sport": "badminton"}})
expect(get("matches/RL_M/points/p1", None), 200, "anyone reads a point")
expect(get("matches/RL_M/racketLive/state", None), 200, "anyone reads the event log")
expect(set_doc("matches/RL_M/points/p2", "pa", {"seq": 2, "winner": "B"}), 403, "client point create rejected")
expect(merge("matches/RL_M/points/p1", "pa", {"undone": True}), 403, "client point update rejected")
expect(delete("matches/RL_M/points/p1", "org"), 403, "client point delete rejected")
expect(set_doc("matches/RL_M/racketLive/state", "org", {"events": []}), 403, "client event log write rejected")
expect(delete("matches/RL_M/racketLive/state", "org"), 403, "client event log delete rejected")

raise SystemExit(1 if failures else 0)
