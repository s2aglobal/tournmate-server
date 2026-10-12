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
