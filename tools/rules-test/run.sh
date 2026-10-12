#!/bin/bash
# Runs team-entry.sh against the Firestore emulator (project demo-tm, never
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
firebase emulators:exec --only firestore --project demo-tm "$HERE/team-entry.sh" 2>&1 | grep -E "^(PASS|FAIL)" | tee "$TMP/out.txt"
! grep -q "^FAIL" "$TMP/out.txt"
