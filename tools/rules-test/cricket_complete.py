#!/usr/bin/env python3
"""Rules checks for cricket-complete: server-only tournament fields (awards,
awardPlayerIds, drawMade), the cricket rules lock once the draw is made, and
registration rosters / roles written only through the callables.

Runs against the Firestore emulator (project demo-tm) started by run.sh.
Prints one PASS/FAIL line per case.
"""
from fsrest import Ts, merge, set_doc

DATE = "2030-06-01T18:00:00Z"
failures = 0


def expect(got, want, name):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'} {name} ({got}{'' if ok else f', want {want}'})")


RULES = '{"ballsPerOver":6,"eventTypeId":"t20","lastManStands":false,"overs":20,"playersPerSide":11,"superOver":true}'
RULES_T10 = '{"ballsPerOver":6,"eventTypeId":"t10","lastManStands":false,"overs":10,"playersPerSide":11,"superOver":true}'
CONFIG = '{"pointsPerWin":2,"pointsPerDraw":1,"pointsPerLoss":0}'


def tournament(tid, sport="cricket", **extra):
    d = {"title": "Cup", "location": "Ground", "date": Ts(DATE), "createdBy": "org",
         "sportType": sport, "formatRaw": "team" if sport == "cricket" else "openDoubles",
         "matchFormatRaw": "roundRobin", "eventTypeId": "t20", "rulesData": RULES, "formatConfigData": CONFIG,
         "statusRaw": "scheduled"}
    d.update(extra)
    set_doc(f"tournaments/{tid}", "owner", d)


set_doc("config/sports", "owner", {"live": ["pickleball", "badminton", "tennis"],
                                   "liveMinAppVersion": {"cricket": {"ios": "1.9"}}})
tournament("CC_OPEN")
tournament("CC_DRAWN", drawMade=True)
tournament("BAD_DRAWN", sport="badminton", drawMade=True)
tournament("CC_AWARDS", drawMade=True, awards={"source": {"playerOfSeries": "auto"}}, awardPlayerIds=["P1"])

print("# server-only tournament fields")
base = {"title": "New Cup", "location": "Ground", "date": Ts(DATE), "createdBy": "org",
        "sportType": "cricket", "formatRaw": "team"}
expect(set_doc("tournaments/N1", "org", base), 200, "cricket create")
for f, v in [("awards", {"source": {}}), ("awardPlayerIds", ["P1"]), ("drawMade", False)]:
    expect(set_doc(f"tournaments/N_{f}", "org", {**base, f: v}), 403, f"create with {f} rejected")
    expect(merge("tournaments/CC_OPEN", "org", {f: v}), 403, f"organizer write of {f} rejected")
expect(merge("tournaments/CC_AWARDS", "org", {"title": "Renamed"}), 200, "edit keeps awards (merge)")
expect(merge("tournaments/CC_AWARDS", "org", {"awards": None}), 403, "clearing awards rejected")
expect(merge("tournaments/CC_AWARDS", "org", {"awardPlayerIds": ["P1", "P2"]}), 403, "adding to awardPlayerIds rejected")

print("# cricket rules lock once the draw is made")
expect(merge("tournaments/CC_OPEN", "org", {"rulesData": RULES_T10, "eventTypeId": "t10"}), 200, "rules edit before the draw")
expect(merge("tournaments/CC_OPEN", "org", {"formatConfigData": '{"pointsPerWin":3}'}), 200, "points edit before the draw")
expect(merge("tournaments/CC_DRAWN", "org", {"rulesData": RULES_T10}), 403, "rules edit after the draw rejected")
expect(merge("tournaments/CC_DRAWN", "org", {"eventTypeId": "t10"}), 403, "event type edit after the draw rejected")
expect(merge("tournaments/CC_DRAWN", "org", {"formatConfigData": '{"pointsPerWin":3}'}), 403, "points edit after the draw rejected")
expect(merge("tournaments/CC_DRAWN", "org", {"matchFormatRaw": "swiss"}), 403, "format edit after the draw rejected")
expect(merge("tournaments/CC_DRAWN", "org", {"title": "Same rules", "rulesData": RULES, "eventTypeId": "t20",
                                             "formatConfigData": CONFIG, "matchFormatRaw": "roundRobin"}), 200,
       "edit resending unchanged rules after the draw")
expect(merge("tournaments/BAD_DRAWN", "org", {"formatConfigData": '{"pointsPerWin":3}'}), 200,
       "other sports unaffected after the draw")
expect(merge("tournaments/CC_DRAWN", "stranger", {"title": "x"}), 403, "non-organizer edit rejected")

print("# registrations: rosters and roles only through callables")
set_doc("registrations/RT", "owner", {"tournamentId": "CC_OPEN", "playerId": "P1", "teamName": "Kings", "rosterIds": ["P1", "P2"]})
set_doc("registrations/RD", "owner", {"tournamentId": "BAD_DRAWN", "playerId": "P3"})
expect(merge("registrations/RT", "u1", {"rosterIds": ["P1"]}), 403, "direct roster edit rejected")
expect(merge("registrations/RT", "u1", {"teamName": "Queens"}), 403, "direct rename rejected")
expect(merge("registrations/RT", "u1", {"captainId": "P2"}), 403, "direct role edit rejected")
expect(merge("registrations/RD", "u3", {"partnerId": "P4"}), 200, "older apps: doubles partner still allowed")

raise SystemExit(1 if failures else 0)
