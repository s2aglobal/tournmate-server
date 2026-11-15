#!/usr/bin/env python3
"""Rules checks for live video streaming: `matches.stream` and the
tournament's `liveStreams` / `liveStreamCount` are server-only (never set on
create, never changed on update), everyone can read them with the match /
tournament, and older apps' writes that leave them alone still pass (score
entry and confirm on a streamed match, organizer tournament edits with a
stream running).

Runs against the Firestore emulator (project demo-tm) started by run.sh.
Prints one PASS/FAIL line per case.
"""
from fsrest import Ts, get, merge, set_doc

DATE = "2030-06-01T18:00:00Z"
failures = 0


def expect(got, want, name):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'} {name} ({got}{'' if ok else f', want {want}'})")


STREAM = {"provider": "youtube", "videoId": "dQw4w9WgXcQ", "status": "live", "label": "SF1", "byUid": "org",
          "byName": "Olga", "startedAt": Ts(DATE), "lastHeartbeatAt": Ts(DATE), "viewers": 12, "peakViewers": 20,
          "reconnects": 1}
ENTRY = {"matchId": "LS_M", "videoId": "dQw4w9WgXcQ", "label": "SF1", "teamAName": "Priya & Arjun",
         "teamBName": "Maya & Leo", "viewers": 12, "startedAt": Ts(DATE)}
TOURNAMENT = {"title": "Smash Open", "location": "Hall", "date": Ts(DATE), "createdBy": "org",
              "sportType": "badminton", "formatRaw": "openDoubles", "matchFormatRaw": "singleElimination"}

print("# tournaments: liveStreams / liveStreamCount are server-only")
expect(set_doc("tournaments/LS_NEW", "org", {**TOURNAMENT, "liveStreams": [ENTRY]}), 403,
       "create with liveStreams rejected")
expect(set_doc("tournaments/LS_NEW2", "org", {**TOURNAMENT, "liveStreamCount": 1}), 403,
       "create with liveStreamCount rejected")
expect(set_doc("tournaments/LS", "org", TOURNAMENT), 200, "organizer creates tournament")
expect(merge("tournaments/LS", "org", {"liveStreams": [ENTRY]}), 403, "organizer write of liveStreams rejected")
expect(merge("tournaments/LS", "org", {"liveStreamCount": 3}), 403, "organizer write of liveStreamCount rejected")
set_doc("tournaments/LS", "owner", {**TOURNAMENT, "liveStreams": [ENTRY], "liveStreamCount": 1})
expect(merge("tournaments/LS", "org", {"title": "Smash Open 2"}), 200, "organizer edit with streams running passes")
expect(merge("tournaments/LS", "org", {**TOURNAMENT, "title": "Smash Open 3", "liveStreams": [ENTRY],
                                       "liveStreamCount": 1}), 200,
       "full-doc edit resending unchanged stream fields passes")
expect(merge("tournaments/LS", "org", {"liveStreams": []}), 403, "organizer clearing liveStreams rejected")
expect(merge("tournaments/LS", "org", {"liveStreams": None, "liveStreamCount": None}), 403,
       "organizer nulling stream fields rejected")
expect(get("tournaments/LS", None), 200, "anyone reads a streaming tournament")


def match(extra=None):
    d = {"tournamentId": "LS", "teamAId": "RA", "teamBId": "RB", "statusRaw": "scheduled", "createdAt": Ts(DATE)}
    d.update(extra or {})
    return d


print("# matches: stream is server-only")
expect(set_doc("matches/LS_NEW", "org", match({"stream": STREAM})), 403, "create with stream rejected")
expect(set_doc("matches/LS_M", "org", match()), 200, "organizer creates match")
expect(merge("matches/LS_M", "org", {"stream": STREAM}), 403, "organizer write of stream rejected")
expect(merge("matches/LS_M", "pa", {"stream": STREAM}), 403, "player write of stream rejected")
set_doc("matches/LS_M", "owner", match({"stream": STREAM}))
expect(merge("matches/LS_M", "org", {"stream": {**STREAM, "status": "ended"}}), 403, "client ending a stream rejected")
expect(merge("matches/LS_M", "org", {"stream": {**STREAM, "viewers": 999}}), 403, "client heartbeat write rejected")
expect(merge("matches/LS_M", "org", {"stream": None}), 403, "client clearing stream rejected")
expect(get("matches/LS_M", None), 200, "anyone reads a streamed match")

print("# older apps still score a streamed match")
expect(merge("matches/LS_M", "pa", {"statusRaw": "scoreSubmitted", "submittedBy": "pa", "scoreA": 2, "scoreB": 0,
                                    "setScores": [{"teamAPoints": 21, "teamBPoints": 18},
                                                  {"teamAPoints": 21, "teamBPoints": 15}]}), 200,
       "player score entry with a live stream passes")
expect(merge("matches/LS_M", "pb", {"statusRaw": "finished", "confirmedBy": "pb"}), 200,
       "other side confirms with a live stream (the trigger ends it)")
set_doc("matches/LS_DONE", "owner", match({"stream": {**STREAM, "status": "ended", "endedAt": Ts(DATE),
                                                      "endedReason": "organizer"}}))
expect(merge("matches/LS_DONE", "org", {"statusRaw": "finished", "scoreA": 2, "scoreB": 1}), 200,
       "organizer direct finish with an ended stream passes")
expect(merge("matches/LS_DONE", "org", {**match(), "statusRaw": "finished", "stream": {**STREAM, "status": "ended",
                                        "endedAt": Ts(DATE), "endedReason": "organizer"}}), 200,
       "full-doc match write resending the unchanged stream passes")

print("# tournaments: crew is server-only (Tournament crew callables)")
CREW = {"ca1": {"role": "camera", "status": "joined", "name": "Priya", "playerId": "P1", "invitedBy": "org",
                "invitedAt": Ts(DATE), "joinedAt": Ts(DATE), "via": "player"}}
expect(set_doc("tournaments/LS_CREWNEW", "org", {**TOURNAMENT, "crew": CREW}), 403, "create with crew rejected")
expect(set_doc("tournaments/LS_CREW", "org", TOURNAMENT), 200, "organizer creates tournament for crew")
expect(merge("tournaments/LS_CREW", "org", {"crew": CREW}), 403, "organizer write of crew rejected")
expect(merge("tournaments/LS_CREW", "ca1", {"crew": CREW}), 403, "player adding themselves to the crew rejected")
set_doc("tournaments/LS_CREW", "owner", {**TOURNAMENT, "crew": CREW})
expect(merge("tournaments/LS_CREW", "org", {"title": "Smash Open Crew"}), 200, "organizer edit with a crew passes")
expect(merge("tournaments/LS_CREW", "org", {**TOURNAMENT, "title": "Smash Open Crew 2", "crew": CREW}), 200,
       "full-doc edit resending the unchanged crew passes")
expect(merge("tournaments/LS_CREW", "org", {"crew": {}}), 403, "organizer clearing the crew rejected")
expect(merge("tournaments/LS_CREW", "org", {"crew": None}), 403, "organizer nulling the crew rejected")
expect(get("tournaments/LS_CREW", None), 200, "anyone reads a tournament with a crew")

print("# server-only collections (YouTube tokens, server broadcasts, crew invites)")
for coll in ["private_youtube", "serverBroadcasts", "serverBroadcastRate", "crewInvites"]:
    set_doc(f"{coll}/X1", "owner", {"a": 1})
    expect(get(f"{coll}/X1", "org"), 403, f"{coll}: signed-in read rejected")
    expect(get(f"{coll}/X1", None), 403, f"{coll}: signed-out read rejected")
    expect(set_doc(f"{coll}/org", "org", {"a": 2}), 403, f"{coll}: client write rejected")

raise SystemExit(1 if failures else 0)
