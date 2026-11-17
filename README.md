# TournMate Server

Backend API and automation for the TournMate sports tournament platform. Built with Firebase Cloud Functions (v2) and TypeScript.

Supports **badminton** today, designed for expansion to **pickleball, tennis, table tennis, and more**.

## Architecture

```
tournmate-server/
├── functions/
│   └── src/
│       ├── index.ts              # Main entry — callables + triggers + scheduled jobs
│       ├── callables/             # Callable functions (server authority)
│       ├── validators/
│       │   └── index.ts           # Input validation (sport-specific score rules)
│       ├── services/
│       │   ├── elo.ts             # ELO rating calculation engine
│       │   └── notifications.ts   # FCM push notification helpers
│       ├── triggers/
│       │   ├── onTournamentCreated.ts
│       │   ├── onTournamentCancelled.ts
│       │   ├── onRegistrationCreated.ts
│       │   ├── onMatchFinished.ts
│       │   └── scheduledJobs.ts
│       └── types/
│           └── index.ts           # TypeScript interfaces matching Firestore schema
├── firebase.json
├── firestore.rules
├── firestore.rules.phase3        # player privacy phase 3 (NOT deployed yet)
├── firestore.indexes.json
├── .firebaserc
└── README.md
```

## Setup

```bash
# Install dependencies
cd functions
npm install

# Install Firebase CLI (if not already)
npm install -g firebase-tools

# Login to Firebase
firebase login

# Build
npm run build
```

## Local Development

```bash
cd functions

# Start Firebase Emulators (Functions + Firestore)
npm run serve

# Or watch mode for development
npm run build:watch
# In another terminal:
firebase emulators:start --only functions,firestore
```

Emulator API: `http://localhost:5001/baddies-live/us-central1/api`

## Deploy

```bash
# Switch environment
firebase use dev   # or: firebase use prod

# Deploy everything (functions + rules)
firebase deploy

# Deploy only functions
firebase deploy --only functions

# Deploy only security rules
firebase deploy --only firestore:rules
```

## Environments

| Alias | Firebase Project | Purpose |
|-------|-----------------|---------|
| `dev` | `baddies-live-dev` | Testing and development |
| `prod` | `baddies-live` | Production |

## API

The apps and the web call **callable functions** (`functions/src/callables/*`, exported from `index.ts`) and read Firestore directly under `firestore.rules`. The old Express REST `api` function was removed (player privacy, S8): nothing called it and its players route was an email-enumeration path.

### Player privacy

`players/{id}` is public (guest mode reads names and photos); contact and personal data (`email`, `phone`, `phoneDigits`, `dateOfBirth`, `weightKg`, `homePostalCode`, `fcmToken`) live in owner-only `playerPrivate/{id}` (same doc id). Server-written only: the `onPlayerWritten` mirror, the `updatePrivateProfile` callable and `npm run backfill:player-private`. Teammate lookup by email/phone goes through `findPlayerByContact` (returns only a player id; 20 lookups / 10 min). `firestore.rules.phase3` holds the stricter rules for after the min-version bump (not deployed). See tournmate-docs `designs/player-privacy/player-privacy-design.md`.

## Validation Rules

### Tournaments
- Title: 3-100 characters
- Date: at least 1 hour in the future
- Duration: 15-720 minutes
- Registration deadline: before tournament date
- Cancel cutoff: 3 hours before start

### Scores
Sport-specific validation dispatched by `sportType`:

**Badminton** (default):
- 1-3 sets, first to 21, win by 2, 30-point cap

Future sports will add their own scoring validators (e.g., tennis: 6 games/set, pickleball: 11 points).

### Registrations
- No duplicate registrations
- Deadline enforcement
- Mixed doubles: male + female pairing
- Partner uniqueness check

## Automated Triggers

| Trigger | Event | Action |
|---------|-------|--------|
| `onTournamentCreated` | New tournament | Push notification to regional FCM topic |
| `onTournamentCancelled` | Status → cancelled | Notify all registered players |
| `onRegistrationCreated` | New registration | Notify tournament organizer |
| `onMatchFinished` | Match confirmed | Notify both teams of result |

## Scheduled Jobs

| Job | Schedule | Action |
|-----|----------|--------|
| `hourlyCleanup` | Every hour | Clean stale FCM tokens, log metrics |
| `dailyReminders` | Daily 00:00 UTC | Remind players of tomorrow's tournaments |

## Multi-Sport Design

The API is sport-agnostic by design. Sport-specific logic is isolated to:

1. **`types/index.ts`** — `SportType` enum and sport-specific format types
2. **`validators/index.ts`** — Score validation dispatched by sport type

To add a new sport:
1. Add a value to the `SportType` enum
2. Add sport-specific scoring rules to the validator
3. Add any sport-specific tournament formats

Everything else (players, registrations, ratings, notifications, ELO) works across all sports.

### Sport catalog (`config/sports`)

The apps read `config/sports` to decide which sports are Live vs Soon and how the
picker is grouped. The server default lives in `functions/src/config/sportsCatalog.ts`;
`firestore.rules` only allows creating tournaments / play sessions whose `sportType`
is in `config/sports.live` (or the launch set pickleball/badminton/tennis if the doc
is missing). Unknown sport ids parse as `generic`: no region/country broadcasts and
no Elo for them.

Seed the doc (writes only if missing; `--force` overwrites, `--dry-run` prints):

```bash
cd functions
npm run seed:sports-config -- --project tournmate-dev
npm run seed:sports-config -- --project tournmate-prod
```

## Cross-Platform

This API serves all client platforms identically:

| Platform | Auth Token |
|----------|-----------|
| iOS | `Auth.auth().currentUser?.getIDToken()` |
| Android | `FirebaseAuth.getInstance().currentUser?.getIdToken()` |
| Web | `firebase.auth().currentUser.getIdToken()` |

Send as: `Authorization: Bearer <token>`
