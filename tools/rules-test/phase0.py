#!/usr/bin/env python3
"""Phase 0 rules checks (players gender, matches, standings, playSessions).

Runs against the Firestore emulator (project demo-tm) started by run.sh.
Write shapes mirror the older apps (iOS 1.7 FirestorePlaySessionRepository /
FirestoreMatchRepository / FirestorePlayerRepository, Android 1.0 equivalents)
so their legitimate flows are proven to still pass.
Prints one PASS/FAIL line per case.
"""
from fsrest import D, Ts, array_op, commit, delete, fields, get, merge, set_doc

FUTURE = "2030-06-01T18:00:00Z"
PAST = "2024-01-01T18:00:00Z"
CREATED = "2026-10-01T10:00:00Z"


failures = 0


def expect(got, want, name):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'} {name} ({got}{'' if ok else f', want {want}'})")


# ─── Seed (admin bypass) ─────────────────────────────────
def player(pid, uid, name, gender=None, extra=None):
    d = {"firebaseUid": uid, "name": name, "email": f"{uid}@x.com", "elo": 1200, "streak": 0}
    if gender is not None:
        d["genderRaw"] = gender
    d.update(extra or {})
    set_doc(f"players/{pid}", "owner", d)


player("HOSTP", "host", "Host", "male")
player("J1", "j1", "J One", "male")
player("J2", "j2", "J Two", "female")
player("J3", "j3", "J Three", "male")
player("J4", "j4", "J Four", "female")
player("abcd-web", "jw", "Web Player", "female")  # web profile: lower-case doc id
player("G0", "g0", "No Gender")
player("G1", "g1", "Prefer Not", "preferNotToSay")
player("G2", "g2", "Female", "female")
player("G3", "g3", "Prefer Not 2", "preferNotToSay")
player("G4", "g4", "Old Profile")

# ─── Players: genderRaw is set once ──────────────────────
print("# players.genderRaw")
expect(merge("players/G0", "g0", {"genderRaw": "male"}), 200, "missing -> male")
expect(merge("players/G0", "g0", {"genderRaw": "female"}), 403, "male -> female rejected")
expect(merge("players/G0", "g0", {"genderRaw": "preferNotToSay"}), 403, "male -> preferNotToSay rejected")
expect(merge("players/G0", "g0", {"name": "Renamed", "genderRaw": "male", "avatarId": "fox"}), 200,
       "full profile merge with unchanged gender (iOS/Android updatePlayer)")
expect(merge("players/G1", "g1", {"genderRaw": "female"}), 200, "preferNotToSay -> female")
expect(merge("players/G2", "g2", {"genderRaw": "preferNotToSay"}), 403, "female -> preferNotToSay rejected")
expect(merge("players/G3", "g3", {"genderRaw": "preferNotToSay", "name": "Same"}), 200,
       "preferNotToSay unchanged passes")
expect(merge("players/G4", "g4", {"name": "Old", "genderRaw": "preferNotToSay"}), 200,
       "missing -> preferNotToSay (old app writes back its decoded default)")
expect(merge("players/G1", "g0", {"genderRaw": "male"}), 403, "someone else's profile rejected")
expect(merge("players/G4", "g4", {"homeCountryCode": "US", "homePostalCode": "78701", "avatarId": "owl"}), 200,
       "web updatePlayer (avatar, home country/postal) passes")
expect(set_doc("players/new-web", "nw", {"firebaseUid": "nw", "name": "New", "email": "nw@x.com", "elo": 1200,
                                         "streak": 0, "genderRaw": "female"}), 200,
       "web player create with genderRaw")

# ─── Matches ─────────────────────────────────────────────
print("# matches")
set_doc("tournaments/T1", "owner", {"createdBy": "org", "title": "Cup", "formatRaw": "openDoubles"})
set_doc("tournaments/t-lower", "owner", {"createdBy": "org", "title": "Web cup"})


def match(tid, a="R1", b="R2", extra=None):
    d = {"tournamentId": tid, "teamAId": a, "teamBId": b, "statusRaw": "scheduled",
         "createdAt": Ts(CREATED), "round": 1, "sportType": "badminton"}
    d.update(extra or {})
    return d


expect(set_doc("matches/M1", "org", match("T1")), 200, "organizer creates match")
expect(set_doc("matches/M2", "j1", match("T1")), 403, "non-organizer create rejected")
expect(set_doc("matches/M3", "org", match("T1", extra={"eloApplied": False})), 403, "create with eloApplied rejected")
expect(set_doc("matches/M4", "org", match("MISSING")), 403, "match for unknown tournament rejected")
expect(set_doc("matches/M5", "org", match("T-LOWER")), 200, "organizer of lower-case tournament doc id")
batch = [{"update": {"name": f"{D}/matches/B{i}", "fields": fields(match("T1", f"R{i}", f"R{i + 1}"))}}
         for i in range(40)]
expect(commit("org", batch), 200, "organizer batch-creates 40 matches (iOS/Android createMatches)")
expect(commit("j1", [{"update": {"name": f"{D}/matches/X1", "fields": fields(match("T1"))}}]), 403,
       "non-organizer batch create rejected")
expect(merge("matches/M1", "j1", {"setScores": [{"teamAPoints": 21, "teamBPoints": 15}], "scoreA": 1, "scoreB": 0,
                                  "submittedBy": "J1", "statusRaw": "scoreSubmitted"}), 200,
       "participant submits score (merge)")
expect(merge("matches/M1", "j2", {"confirmedBy": "J2", "statusRaw": "finished", "winnerRegistrationId": "R1"}), 200,
       "opponent confirms score (merge)")
expect(merge("matches/M1", "org", {"eloApplied": True}), 403, "client write of eloApplied rejected")
expect(merge("matches/M1", "j1", {"teamAUids": ["j1"]}), 403, "client write of teamAUids rejected")
expect(set_doc("matches/M7", "org", match("T1", extra={"teamBUids": ["x"]})), 403, "create with teamBUids rejected")
expect(merge("matches/M1", "j2", {"disputeReason": "wrong score"}), 403, "client write of disputeReason rejected")
expect(set_doc("matches/M8", "org", match("T1", extra={"disputeReason": "x"})), 403, "create with disputeReason rejected")
set_doc("matches/M6", "owner", match("T1", extra={"eloApplied": True, "disputeReason": "server"}))
expect(merge("matches/M6", "org", {"scoreA": 2, "scoreB": 0, "statusRaw": "finished"}), 200,
       "score edit on a match with server eloApplied passes")
expect(delete("matches/M1", "j1"), 403, "non-organizer delete rejected")
expect(commit("org", [{"delete": f"{D}/matches/B{i}"} for i in range(40)]), 200,
       "organizer batch-deletes matches (reset bracket)")

# ─── Server-only tournament / registration fields ───────
print("# server-only fields")
expect(merge("tournaments/T1", "org", {"title": "Cup 2", "autoDraw": {"done": True}}), 403,
       "organizer write of autoDraw rejected")
expect(merge("tournaments/T1", "org", {"deadlineReminderFor": Ts(CREATED)}), 403,
       "organizer write of deadlineReminderFor rejected")
set_doc("tournaments/T2", "owner", {"createdBy": "org", "title": "Cup", "location": "Hall", "date": Ts(FUTURE),
                                    "autoDraw": {"done": True}, "deadlineReminderFor": Ts(CREATED)})
expect(merge("tournaments/T2", "org", {"title": "Renamed cup", "location": "Hall", "statusRaw": "scheduled"}), 200,
       "organizer edit leaves server fields alone (passes)")
expect(set_doc("tournaments/T3", "org", {"createdBy": "org", "title": "Cup", "location": "Hall", "date": Ts(FUTURE),
                                         "autoDraw": {}}), 403, "create with autoDraw rejected")
expect(set_doc("registrations/RG1", "j1", {"tournamentId": "T1", "playerId": "J1", "memberUids": ["j1"]}), 403,
       "registration create with memberUids rejected")
expect(set_doc("registrations/RG2", "j1", {"tournamentId": "T1", "playerId": "J1"}), 200, "registration create")
expect(merge("registrations/RG2", "j1", {"memberUids": ["j1", "j2"]}), 403, "registration memberUids write rejected")
expect(merge("registrations/RG2", "j1", {"partnerId": "J2"}), 200, "registration partner update")

# ─── Standings ───────────────────────────────────────────
print("# standings")
set_doc("standings/T1", "owner", {"format": "roundRobin"})
expect(get("standings/T1", None), 200, "standings readable without sign-in")
expect(set_doc("standings/T1", "org", {"format": "x"}), 403, "organizer can't write standings")
expect(set_doc("standings/T9", "j1", {"format": "x"}), 403, "player can't create standings")

# ─── Play sessions ───────────────────────────────────────
print("# playSessions")


def ios_session(attendees, date=FUTURE, game="doubles", **kw):
    """FirestorePlaySessionRepository.encode (iOS 1.7)."""
    d = {"title": "Evening Open Play", "venue": "Austin Badminton", "venueAddress": "1 Main St",
         "date": Ts(date), "skillLevel": "allLevels", "gameType": game, "currency": "USD",
         "preferredAgeGroup": "open", "status": "active", "attendeeIds": attendees,
         "createdAt": Ts(CREATED), "durationMinutes": 120, "costPerPerson": 5.0, "hostId": "host",
         "timeZone": "America/Chicago", "sportType": "badminton", "countryCode": "US", "postalCode": "78701"}
    d.update(kw)
    return d


def android_session(attendees, **kw):
    """PlaySession.toFirestoreMap (Android 1.0) adds hostName / hostAvatarId."""
    d = ios_session(attendees, **kw)
    d.update({"hostName": "Host", "hostAvatarId": "fox"})
    return d


# create
expect(set_doc("playSessions/S1", "host", ios_session(["HOSTP"])), 200, "iOS create (host in attendees)")
expect(set_doc("playSessions/S2", "host", android_session(["HOSTP"])), 200, "Android create (hostName/hostAvatarId)")
expect(set_doc("playSessions/S3", "host", ios_session([])), 200, "create without attendees")
expect(set_doc("playSessions/SX1", "host", ios_session(["J1"])), 403, "create listing someone else as attendee rejected")
expect(set_doc("playSessions/SX2", "host", ios_session(["HOSTP", "J1"])), 403, "create with extra attendees rejected")
expect(set_doc("playSessions/SX3", "host", ios_session(["HOSTP"], sportType="cricket")), 403, "cricket session rejected")
expect(set_doc("playSessions/SX4", "host", ios_session(["HOSTP"], maxPlayers=8)), 403, "create with maxPlayers rejected")
expect(set_doc("playSessions/SX5", "host", ios_session(["HOSTP"], waitlistIds=[])), 403, "create with waitlistIds rejected")
expect(set_doc("playSessions/SX6", "host", ios_session(["HOSTP"], status="completed")), 403, "create non-active rejected")
expect(set_doc("playSessions/SX7", "j1", ios_session(["J1"])), 403, "create with someone else's hostId rejected")

# join / leave (arrayUnion / arrayRemove)
S1 = "playSessions/S1"
expect(array_op(S1, "j1", "attendeeIds", "union", ["J1"]), 200, "player joins (arrayUnion)")
expect(array_op(S1, "j1", "attendeeIds", "union", ["J2"]), 403, "adding someone else rejected")
expect(merge(S1, "j2", {"attendeeIds": ["HOSTP", "J1", "J2"], "title": "Mine"}), 403,
       "non-host changing other fields with a join rejected")
expect(merge(S1, "j2", {"attendeeIds": ["HOSTP", "J2"]}), 403, "swap someone out for self rejected")
expect(array_op(S1, "jw", "attendeeIds", "union", ["ABCD-WEB"]), 200,
       "web-created profile (lower-case doc id) joins with UPPERCASE id")
expect(array_op(S1, "j3", "attendeeIds", "union", ["J3"]), 200, "4th player joins doubles")
expect(array_op(S1, "j4", "attendeeIds", "union", ["J4"]), 403, "5th player rejected (doubles cap 4)")
expect(array_op(S1, "j9", "attendeeIds", "union", ["NOPE"]), 403, "join with an unknown player id rejected")
expect(array_op(S1, "j1", "attendeeIds", "remove", ["J3"]), 403, "removing someone else rejected")
expect(array_op(S1, "j3", "attendeeIds", "remove", ["J3"]), 200, "player leaves (arrayRemove)")
expect(merge(S1, "j1", {"maxPlayers": 10}), 403, "non-host write of maxPlayers rejected")
expect(merge(S1, "j1", {"status": "cancelled"}), 403, "non-host cancel rejected")

set_doc("playSessions/SS", "owner", ios_session(["HOSTP"], game="singles"))
expect(array_op("playSessions/SS", "j1", "attendeeIds", "union", ["J1"]), 200, "singles: 2nd player joins")
expect(array_op("playSessions/SS", "j2", "attendeeIds", "union", ["J2"]), 403, "singles: 3rd player rejected")

set_doc("playSessions/SP", "owner", ios_session(["HOSTP"], date=PAST))
expect(array_op("playSessions/SP", "j1", "attendeeIds", "union", ["J1"]), 403, "join after start rejected")
set_doc("playSessions/SP2", "owner", ios_session(["HOSTP", "J1"], date=PAST))
expect(array_op("playSessions/SP2", "j1", "attendeeIds", "remove", ["J1"]), 200, "leave after start still allowed")
set_doc("playSessions/SC", "owner", ios_session(["HOSTP"], status="cancelled"))
expect(array_op("playSessions/SC", "j1", "attendeeIds", "union", ["J1"]), 403, "join cancelled session rejected")
set_doc("playSessions/SL", "owner", ios_session(["HOSTP", "A", "B", "C", "D"]))
expect(array_op("playSessions/SL", "j1", "attendeeIds", "union", ["J1"]), 403, "join legacy over-full session rejected")
expect(array_op("playSessions/SL", "j1", "attendeeIds", "remove", ["J1"]), 200, "arrayRemove of an absent id is a no-op")

# host edits (S1 now has HOSTP, J1, ABCD-WEB)
now = ["HOSTP", "J1", "ABCD-WEB"]
expect(merge(S1, "host", ios_session(now, title="New title", notes="Bring shuttles", skillLevel="beginner",
                                     preferredAgeGroup="adult")), 200,
       "iOS host edit after joins: full-doc merge, unchanged key fields pass")
expect(merge(S1, "host", android_session(now, title="Android title", notes="n")), 200,
       "Android host edit after joins: full update incl. hostName/hostAvatarId")
expect(merge(S1, "host", ios_session(now, costPerPerson=5)), 200, "cost re-sent as int 5 for stored 5.0 passes")
expect(merge(S1, "host", ios_session(now, date=Ts("2030-06-02T18:00:00Z"))), 403, "date locked once others joined")
expect(merge(S1, "host", ios_session(now, gameType="singles")), 403, "gameType locked once others joined")
expect(merge(S1, "host", ios_session(now, durationMinutes=90)), 403, "duration locked once others joined")
expect(merge(S1, "host", ios_session(now, costPerPerson=8.0)), 403, "cost locked once others joined")
expect(merge(S1, "host", ios_session(now, venue="Elsewhere")), 403, "venue locked once others joined")
expect(merge(S1, "host", ios_session(now, sportType="pickleball")), 403, "sport locked once others joined")
expect(merge(S1, "host", ios_session(["HOSTP", "J1"])), 403, "host removing an attendee rejected")
expect(merge(S1, "host", {"waitlistIds": ["J4"]}), 403, "host write of waitlistIds rejected")
expect(merge(S1, "host", {"endsAt": Ts(FUTURE)}), 403, "host write of endsAt rejected")
expect(merge(S1, "host", {"attendeeUids": ["host"]}), 403, "host write of attendeeUids rejected")
expect(merge(S1, "host", {"hostId": "j1"}), 403, "hostId can't change")

S3 = "playSessions/S3"
expect(merge(S3, "host", ios_session([], date=Ts("2030-07-01T18:00:00Z"), gameType="singles", durationMinutes=60)),
       200, "host alone may change key fields")
expect(merge(S3, "host", {"sportType": "cricket"}), 403, "change to cricket rejected")
expect(array_op(S3, "host", "attendeeIds", "union", ["HOSTP"]), 200, "host joins own session")

S2 = "playSessions/S2"
expect(merge(S2, "host", {"status": "cancelled"}), 200, "host cancels (updateData status)")
expect(merge(S2, "host", android_session(["HOSTP"], status="active")), 403, "host can't reopen a cancelled session")
expect(merge(S1, "host", ios_session(now, status="completed")), 200, "host finishes session (iOS full merge)")
set_doc("playSessions/SF", "owner", ios_session(["HOSTP", "J1"], date=PAST))
expect(merge("playSessions/SF", "host", android_session(["HOSTP", "J1"], date=PAST, status="completed")), 200,
       "host finishes a started session (Android update)")
set_doc("playSessions/SFL", "owner", ios_session(["HOSTP"], status="flagged"))
expect(merge("playSessions/SFL", "host", {"status": "active"}), 403, "host can't unflag")

expect(delete(S3, "j1"), 403, "non-host delete rejected")
expect(delete(S3, "host"), 200, "host deletes session")

print(f"# {failures} failure(s)")
