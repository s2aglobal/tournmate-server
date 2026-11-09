#!/usr/bin/env python3
"""Rules checks for cricket live scoring: `matches.live` / `matches.lineups`
and the `balls` / `cricketLive` subcollections are server-only (readable by
anyone), and a match being scored live can't be changed by clients (older
apps) until the live scorer finishes.

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


set_doc("tournaments/CL", "owner", {"title": "Live Cup", "location": "Ground", "date": Ts(DATE), "createdBy": "org",
                                    "sportType": "cricket", "formatRaw": "team", "matchFormatRaw": "roundRobin"})


def match(extra=None):
    d = {"tournamentId": "CL", "teamAId": "RA", "teamBId": "RB", "statusRaw": "scheduled", "createdAt": Ts(DATE)}
    d.update(extra or {})
    return d


LIVE = {"status": "inProgress", "scorerUid": "cap", "scorerName": "Cap", "battingFirstTeamId": "RA",
        "inningsIndex": 1, "innings": [{"battingTeamId": "RA", "runs": 12, "wickets": 1, "legalBalls": 9, "complete": False}]}

print("# server-only live fields")
expect(set_doc("matches/CL_NEW1", "org", match({"live": LIVE})), 403, "create with live rejected")
expect(set_doc("matches/CL_NEW2", "org", match({"lineups": {"RA": {"xi": ["P1"], "order": ["P1"]}}})), 403,
       "create with lineups rejected")
expect(set_doc("matches/CL_M", "org", match()), 200, "organizer creates match")
expect(merge("matches/CL_M", "org", {"live": LIVE}), 403, "organizer write of live rejected")
expect(merge("matches/CL_M", "cap", {"lineups": {"RA": {"xi": ["P1", "P2"], "order": ["P2", "P1"]}}}), 403,
       "client write of lineups rejected")
expect(merge("matches/CL_M", "cap", {"statusRaw": "scoreSubmitted", "scoreA": 100, "scoreB": 90}), 200,
       "older apps still enter a score when not scored live")

print("# match locked while scored live")
set_doc("matches/CL_LIVE", "owner", match({"live": LIVE, "lineups": {"RA": {"xi": ["P1", "P2"], "order": ["P1", "P2"]}}}))
expect(merge("matches/CL_LIVE", "cap", {"statusRaw": "scoreSubmitted", "scoreA": 100, "scoreB": 90}), 403,
       "score entry during live scoring rejected")
expect(merge("matches/CL_LIVE", "org", {"statusRaw": "finished"}), 403, "organizer direct finish during live scoring rejected")
expect(merge("matches/CL_LIVE", "org", {"live": None}), 403, "clearing live rejected")
expect(get("matches/CL_LIVE", None), 200, "anyone reads a live match")
set_doc("matches/CL_DONE", "owner", match({"live": {**LIVE, "status": "finished"}, "statusRaw": "scoreSubmitted",
                                           "submittedBy": "cap"}))
expect(merge("matches/CL_DONE", "opp", {"statusRaw": "finished", "confirmedBy": "opp"}), 200,
       "older apps confirm after the live scorer finished")
expect(merge("matches/CL_DONE", "opp", {"live": {**LIVE, "status": "inProgress"}}), 403, "reopening live rejected")
expect(delete("matches/CL_LIVE", "org"), 200, "organizer can still delete (reset draw)")

print("# balls / cricketLive subcollections")
set_doc("matches/CL_M/balls/b1", "owner", {"innings": 1, "seq": 1, "runs": 4})
set_doc("matches/CL_M/cricketLive/state", "owner", {"events": []})
expect(get("matches/CL_M/balls/b1", None), 200, "anyone reads a ball")
expect(get("matches/CL_M/cricketLive/state", None), 200, "anyone reads the event log")
expect(set_doc("matches/CL_M/balls/b2", "org", {"innings": 1, "seq": 2, "runs": 6}), 403, "client ball create rejected")
expect(merge("matches/CL_M/balls/b1", "cap", {"undone": True}), 403, "client ball update rejected")
expect(delete("matches/CL_M/balls/b1", "org"), 403, "client ball delete rejected")
expect(set_doc("matches/CL_M/cricketLive/state", "org", {"events": []}), 403, "client event log write rejected")

raise SystemExit(1 if failures else 0)
