# Firestore rules checks (local emulator only)

Runs against the Firestore emulator with the throwaway project id `demo-tm`, so it never touches tournmate-dev or tournmate-prod.

```bash
tools/rules-test/run.sh
```

`team-entry.sh` covers:
- cricket tournaments accept only team entries (team id, team name, roster), never individuals or doubles pairs;
- cricket tournaments must use the team format;
- a gated sport (`liveMinAppVersion`) counts as live for creates;
- badminton singles and doubles are unaffected;
- one team entry per person per tournament: a team registration needs its `teamEntries/{tournamentId}_{playerId}` lock (lower case) in the same batch, a second entry (in any id case) is rejected, the lock is freed with the entry, and older entries without a lock can still be withdrawn;
- roles (`captainId`, `viceCaptainId`, `keeperId`, `playerRoles`) can be changed after entry; the registrant can't.

`phase0.py` (stdlib Python, one PASS/FAIL line per case) covers the Phase 0 server-authority rules, using the write shapes of the older apps (iOS 1.7, Android 1.0) so their legitimate flows are proven to pass:
- `players.genderRaw` only goes from missing/`preferNotToSay` to `male`/`female`; full-profile writes with an unchanged gender (and the old apps writing back `preferNotToSay` for a missing value) still pass; web profile create/update unaffected;
- matches: only the organizer creates (incl. 40-match batches) and deletes; participants still submit/confirm scores; `eloApplied` is never client-written;
- `standings/{tournamentId}`: readable by anyone, never client-written;
- server-only fields: `tournaments.autoDraw` / `deadlineReminderFor`, `registrations.memberUids`, `matches.teamAUids` / `teamBUids` / `eloApplied` (unchanged values in full-doc edits still pass);
- playSessions: no cricket; server-only fields (`maxPlayers`, `endsAt`, `waitlistIds`, `attendeeUids`, `autoRemoved`, `autoCancelled`) never client-written; host-only edits with key fields locked once others joined (full-doc iOS merge / Android update with unchanged values passes); cancel/finish but never reopen; others may only add/remove their own player id by one, joins only while active, before the start, and within the cap (singles 2, else 4).

`run-triggers.sh` builds functions and runs `triggers.py` against the Firestore + Functions emulators (`demo-tm`). It covers the Open Play triggers that clean up after older apps: a joiner who clashes with another session (missing duration = 120 min) or overflows a mixed session's 2 men / 2 women is removed and notified (the host isn't told "player left"), and a newly created session is cancelled, with a note to the host, when the host already has 3 upcoming active sessions or it overlaps a session they host or joined.

Pure Open Play helpers (`functions/src/services/openPlay.ts`) are checked by `npm run check:openplay` in `functions/`.
