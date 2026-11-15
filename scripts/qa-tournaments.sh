#!/usr/bin/env bash
# QA tournaments on tournmate-dev, in one command. Safe to run any time:
# by default it removes the previous QA tournaments, then creates a fresh set
# dated today (draw made, ready to score live / go live / test the crew).
#
#   ./scripts/qa-tournaments.sh                     # fresh set for the saved organizer
#   ./scripts/qa-tournaments.sh <organizerUid>      # fresh set for this organizer (remembered)
#   ./scripts/qa-tournaments.sh --all               # + standings/tennis/group set + cricket set
#   ./scripts/qa-tournaments.sh --keep              # add a set without deleting the old one
#   ./scripts/qa-tournaments.sh --clean             # only delete QA tournaments
#   ./scripts/qa-tournaments.sh --dry-run           # show what would happen, write nothing
#   FIREBASE_API_KEY=<key> ./scripts/qa-tournaments.sh --setup   # first time: test players + live config
#
# Sets:
#   live     (default) "QA Live Badminton …": knockout 8 teams (QF drawn, QF2 done),
#            league, short games 11 / 15, player view. You play in some matches.
#   general  "QA …": standings tie-breakers, tennis, group + knockout, open play.
#   cricket  "QA …" cricket tournaments.
#
# Needs: personal laptop, Node, `gcloud auth application-default login` with
# access to tournmate-dev. Every seed refuses any project except tournmate-dev.
# Never run this on the work machine.

set -euo pipefail

PROJECT="tournmate-dev"
HERE="$(cd "$(dirname "$0")" && pwd)"
FUNCTIONS="$HERE/../functions"
SAVED_UID_FILE="$HERE/.qa-organizer"

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

sets="live"; clean_first=1; only_clean=0; dry=""; setup=0; uid=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage 0 ;;
    --all) sets="live general cricket" ;;
    --only=*) sets="${arg#--only=}"; sets="${sets//,/ }" ;;
    --keep) clean_first=0 ;;
    --clean) only_clean=1 ;;
    --dry-run) dry="--dry-run" ;;
    --setup) setup=1 ;;
    -*) echo "Unknown option: $arg"; usage 1 ;;
    *) uid="$arg" ;;
  esac
done

# Organizer: argument, else QA_ORGANIZER_UID, else the one saved last time.
if [[ -z "$uid" && -n "${QA_ORGANIZER_UID:-}" ]]; then uid="$QA_ORGANIZER_UID"; fi
if [[ -z "$uid" && -f "$SAVED_UID_FILE" ]]; then uid="$(tr -d '[:space:]' < "$SAVED_UID_FILE")"; fi
if [[ -z "$uid" && $only_clean -eq 0 ]]; then
  echo "Which organizer? Pass your Firebase Auth UID once (Firebase console → tournmate-dev →"
  echo "Authentication → Users → copy the User UID of the account on your phone):"
  echo "  ./scripts/qa-tournaments.sh <uid>"
  exit 1
fi
if [[ -n "$uid" ]]; then
  [[ "$uid" =~ ^[A-Za-z0-9]{20,40}$ ]] || { echo "That doesn't look like a Firebase UID: $uid"; exit 1; }
  echo "$uid" > "$SAVED_UID_FILE"
fi

if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  echo "No Google credentials. Run: gcloud auth application-default login"
  exit 1
fi
export GOOGLE_CLOUD_PROJECT="$PROJECT" GCLOUD_PROJECT="$PROJECT"

cd "$FUNCTIONS"
echo "▸ Building functions…"
npm run build --silent

if [[ $setup -eq 1 ]]; then
  if [[ -n "$dry" ]]; then
    echo "▸ (dry run) would create test players and switch on badminton live streaming"
  else
    [[ -n "${FIREBASE_API_KEY:-}" ]] || { echo "--setup needs the dev web API key: FIREBASE_API_KEY=<key> ./scripts/qa-tournaments.sh --setup"; exit 1; }
    echo "▸ Test players (test1..test20@tournmate.dev)…"
    node lib/scripts/seedTestUsers.js
    echo "▸ Sports config: live streaming for badminton…"
    node lib/scripts/seedSportsConfig.js --project "$PROJECT" --live-streaming badminton
  fi
fi

if [[ $clean_first -eq 1 || $only_clean -eq 1 ]]; then
  echo "▸ Removing previous QA tournaments (and their notifications)…"
  node lib/scripts/cleanupQaTournaments.js --include-notifications $dry
fi
[[ $only_clean -eq 1 ]] && { echo "✓ Clean."; exit 0; }

for s in $sets; do
  case "$s" in
    live)    echo "▸ Seeding badminton live set…";  node lib/scripts/seedQaBadmintonLive.js --organizers="$uid" $dry ;;
    general) echo "▸ Seeding general set…";         node lib/scripts/seedQaTournaments.js --organizers="$uid" $dry ;;
    cricket) echo "▸ Seeding cricket set…";         node lib/scripts/seedQaCricket.js --organizers="$uid" $dry ;;
    *) echo "Unknown set: $s (use live, general, cricket)"; exit 1 ;;
  esac
done

echo "✓ Done${dry:+ (dry run, nothing written)}. Pull to refresh the Play tab on the phone signed in as $uid."
