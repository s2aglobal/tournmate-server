#!/bin/bash
# Runs feedback.py against the Firestore emulator (project demo-tm, never
# tournmate-dev or prod): the `feedback` collection has no client access.
# The CLI won't load rules from outside its project directory, so the rules
# file is copied to a temp project.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp "$ROOT/firestore.rules" "$TMP/"
cat > "$TMP/firebase.json" <<JSON
{
  "firestore": { "rules": "firestore.rules" },
  "emulators": { "firestore": { "port": 8089 }, "ui": { "enabled": false } }
}
JSON
cd "$TMP"
firebase emulators:exec --only firestore --project demo-tm "python3 '$HERE/feedback.py'" 2>&1 | tee "$TMP/log.txt" | grep -E "^(PASS|FAIL)" | tee "$TMP/out.txt"
grep -q "^PASS" "$TMP/out.txt" || { tail -40 "$TMP/log.txt"; exit 1; }
! grep -q "^FAIL" "$TMP/out.txt"
