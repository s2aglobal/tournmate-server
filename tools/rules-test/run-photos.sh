#!/bin/bash
# Runs photos.py against the Firestore + Storage emulators (project demo-tm,
# never tournmate-dev or prod): storage.rules for profilePhotos/ and the
# server-only photo fields on players. The CLI won't load rules from outside
# its project directory, so both rules files are copied to a temp project.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp "$ROOT/firestore.rules" "$ROOT/storage.rules" "$TMP/"
cat > "$TMP/firebase.json" <<JSON
{
  "firestore": { "rules": "firestore.rules" },
  "storage": { "rules": "storage.rules" },
  "emulators": { "firestore": { "port": 8089 }, "storage": { "port": 9189 }, "ui": { "enabled": false } }
}
JSON
cd "$TMP"
firebase emulators:exec --only firestore,storage --project demo-tm "python3 '$HERE/photos.py'" 2>&1 | tee "$TMP/log.txt" | grep -E "^(PASS|FAIL)" | tee "$TMP/out.txt"
grep -q "^PASS" "$TMP/out.txt" || { tail -40 "$TMP/log.txt"; exit 1; }
! grep -q "^FAIL" "$TMP/out.txt"
