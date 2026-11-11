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
- rosters, team names and roles (`captainId`, `viceCaptainId`, `keeperId`, `playerRoles`) are never written directly (only through `updateRoster` / `setRoles`); the registrant can't be changed.

`cricket_complete.py` covers the cricket-complete rules:
- server-only tournament fields `awards`, `awardPlayerIds`, `awardsNotified`, `drawMade`, `finished`, `finishedAt`: never set on create or changed on update (edits that leave them alone still pass); `groupCountChosen` is the organizer's to write;
- cricket rules (`eventTypeId`, `rulesData`, `formatConfigData`, `matchFormatRaw`, `formatRaw`, `sportType`) lock once `drawMade` is true; resending unchanged values passes; other sports unaffected;
- registrations: direct roster / name / role edits rejected; older apps' doubles `partnerId` update allowed until the draw is made; direct registration creates (all sports) rejected once `drawMade` is true.

`cricket_live.py` covers cricket live scoring: `matches.live` / `matches.lineups` are never client-written (create or update); `matches/{id}/balls/*` and `matches/{id}/cricketLive/*` are readable by anyone and never client-written; while `live.status` isn't `finished` no client may update the match (older apps can't enter a score mid-live), after it they confirm as usual. The callables are checked by `npm run test:emulator-cricket-live` and the reducer by `npm run check:cricket-live` in `functions/`.

`racket_live.py` covers racket live scoring (badminton): `matches.live` is never client-written; `matches/{id}/points/*` and `matches/{id}/racketLive/*` are readable by anyone and never client-written; while `live.status` is `inProgress` or `ended` no client may update the match, after `finished` older apps confirm as usual. The callables are checked by `npm run test:emulator-racket-live` and the reducer by `npm run check:racket-live` in `functions/`.

`phase0.py` (stdlib Python, one PASS/FAIL line per case) covers the Phase 0 server-authority rules, using the write shapes of the older apps (iOS 1.7, Android 1.0) so their legitimate flows are proven to pass:
- `players.genderRaw` only goes from missing/`preferNotToSay` to `male`/`female`; full-profile writes with an unchanged gender (and the old apps writing back `preferNotToSay` for a missing value) still pass; web profile create/update unaffected;
- matches: only the organizer creates (incl. 40-match batches) and deletes; participants still submit/confirm scores; `eloApplied` is never client-written;
- `standings/{tournamentId}`: readable by anyone, never client-written;
- server-only fields: `tournaments.autoDraw` / `deadlineReminderFor`, `registrations.memberUids`, `matches.teamAUids` / `teamBUids` / `eloApplied` (unchanged values in full-doc edits still pass);
- playSessions: no cricket; server-only fields (`maxPlayers`, `endsAt`, `waitlistIds`, `attendeeUids`, `autoRemoved`, `autoCancelled`) never client-written; host-only edits with key fields locked once others joined (full-doc iOS merge / Android update with unchanged values passes); cancel/finish but never reopen; others may only add/remove their own player id by one, joins only while active, before the start, and within the cap (the server-set `maxPlayers` = courts × per court + 2 bench; legacy docs without it: singles 2, else 4); `courts` is server-written only.

`run-triggers.sh` builds functions and runs `triggers.py` against the Firestore + Functions emulators (`demo-tm`). It covers the Open Play triggers that clean up after older apps: a joiner who clashes with another session (missing duration = 120 min) or overflows a mixed session's 2 men / 2 women is removed and notified (the host isn't told "player left"), and a newly created session is cancelled, with a note to the host, when the host already has 3 upcoming active sessions or it overlaps a session they host or joined. It also covers the match trigger's `finished` / `finishedAt` on the tournament: set when the last match finishes, removed when a new Manual Draw match or a deleted draw un-finishes it, and no tournament rewrite when nothing changed (no write loop).

Pure Open Play helpers (`functions/src/services/openPlay.ts`) are checked by `npm run check:openplay` in `functions/`.

`run-photos.sh` runs `photos.py` against the Firestore + Storage emulators (`demo-tm`). It covers profile photos: `storage.rules` (signed-in read; owner-only upload of `image/jpeg` under 2 MB to `profilePhotos/{uid}/{file}`; no client delete; everything else denied) and the server-only `players.photoURL` / `photoPath` / `photoUpdatedAt` (never set on create or changed on update; profile edits with a photo set still pass). The callables and the account-cleanup photo delete are checked by `npm run test:emulator-photos` in `functions/`.
