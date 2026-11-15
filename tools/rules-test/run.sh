#!/bin/bash
# Runs team-entry.sh, phase0.py, cricket_complete.py, cricket_live.py, racket_live.py and live_stream.py against the Firestore emulator (project demo-tm, never
# tournmate-dev or prod). The CLI won't load rules from outside its project
# directory, so the repo's firestore.rules is copied to a temp project.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp "$HERE/../../firestore.rules" "$TMP/"
cp "$HERE/firebase.json" "$TMP/"
sed -i '' 's#\.\./\.\./firestore\.rules#firestore.rules#' "$TMP/firebase.json"
cd "$TMP"
firebase emulators:exec --only firestore --project demo-tm "'$HERE/team-entry.sh'; python3 '$HERE/phase0.py'; python3 '$HERE/cricket_complete.py'; python3 '$HERE/cricket_live.py'; python3 '$HERE/racket_live.py'; python3 '$HERE/live_stream.py'" 2>&1 | grep -E "^(PASS|FAIL)" | tee "$TMP/out.txt"
! grep -q "^FAIL" "$TMP/out.txt"
