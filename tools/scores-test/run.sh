#!/bin/bash
# Score callables + standings trigger against the local emulators (auth,
# Firestore, functions) with the throwaway project id demo-tm, so it never
# touches tournmate-dev or tournmate-prod. Builds the functions first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
(cd "$HERE/../../functions" && npm run build >/dev/null)
cd "$HERE"
firebase emulators:exec --only auth,firestore,functions --project demo-tm "node $HERE/scores.test.js" 2>&1 \
  | tee "${TMPDIR:-/tmp}/scores-test.log" | grep -E "^(PASS|FAIL|DONE)"
! grep -q "^FAIL" "${TMPDIR:-/tmp}/scores-test.log" && grep -q "^DONE" "${TMPDIR:-/tmp}/scores-test.log"
