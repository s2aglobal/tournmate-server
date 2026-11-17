#!/bin/bash
# Runs player_privacy.py against the Firestore emulator (project demo-tm, never
# tournmate-dev or prod), twice: PHASE=1 with firestore.rules (active) and
# PHASE=3 with firestore.rules.phase3 (not deployed yet). The CLI won't load
# rules from outside its project directory, so each rules file is copied to a
# temp project.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
status=0
for phase in 1 3; do
  TMP=$(mktemp -d)
  if [ "$phase" = 1 ]; then cp "$ROOT/firestore.rules" "$TMP/firestore.rules"; else cp "$ROOT/firestore.rules.phase3" "$TMP/firestore.rules"; fi
  cat > "$TMP/firebase.json" <<JSON
{
  "firestore": { "rules": "firestore.rules" },
  "emulators": { "firestore": { "port": 8089 }, "ui": { "enabled": false } }
}
JSON
  (cd "$TMP" && PHASE=$phase firebase emulators:exec --only firestore --project demo-tm "python3 '$HERE/player_privacy.py'" 2>&1) \
    | tee "$TMP/log.txt" | grep -E "^(PASS|FAIL)" | tee "$TMP/out.txt"
  if ! grep -q "^PASS" "$TMP/out.txt"; then tail -40 "$TMP/log.txt"; status=1; fi
  if grep -q "^FAIL" "$TMP/out.txt"; then status=1; fi
  rm -rf "$TMP"
done
exit $status
