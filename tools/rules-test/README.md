# Firestore rules checks (local emulator only)

Runs against the Firestore emulator with the throwaway project id `demo-tm`, so it never touches tournmate-dev or tournmate-prod.

```bash
cd tools/rules-test
firebase emulators:exec --only firestore --project demo-tm ./team-entry.sh
```

`team-entry.sh` covers:
- cricket tournaments accept only team entries (team id, team name, roster), never individuals or doubles pairs;
- cricket tournaments must use the team format;
- a gated sport (`liveMinAppVersion`) counts as live for creates;
- badminton singles and doubles are unaffected.
