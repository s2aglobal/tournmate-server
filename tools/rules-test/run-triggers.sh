#!/bin/bash
# Runs triggers.py against the Firestore + Functions emulators (project
# demo-tm, never tournmate-dev or prod): Open Play triggers acting on writes
# from older apps. Builds functions first. Push sends fail harmlessly (no
# credentials in the emulator).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
(cd "$ROOT/functions" && npm run build >/dev/null)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp "$ROOT/firestore.rules" "$TMP/"
ln -s "$ROOT/functions" "$TMP/functions"
cat > "$TMP/firebase.json" <<JSON
{
  "firestore": { "rules": "firestore.rules" },
  "functions": [{ "source": "functions", "codebase": "default" }],
  "emulators": { "firestore": { "port": 8089 }, "functions": { "port": 5011 }, "ui": { "enabled": false } }
}
JSON
cd "$TMP"
firebase emulators:exec --only firestore,functions --project demo-tm "python3 '$HERE/triggers.py'" 2>&1 | tee "$TMP/log.txt" | grep -E "^(PASS|FAIL)" | tee "$TMP/out.txt"
grep -q "^PASS" "$TMP/out.txt" || { tail -40 "$TMP/log.txt"; exit 1; }
! grep -q "^FAIL" "$TMP/out.txt"
