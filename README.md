# TournMate Server

Backend API and automation for the TournMate sports tournament platform. Built with Firebase Cloud Functions (v2), Express, and TypeScript.

Supports **badminton** today, designed for expansion to **pickleball, tennis, table tennis, and more**.

## Architecture

```
tournmate-server/
├── functions/
│   └── src/
│       ├── index.ts              # Main entry — HTTP API + triggers + scheduled jobs
│       ├── api/                   # REST API route handlers
│       │   ├── players.ts         # Player profile CRUD
│       │   ├── tournaments.ts     # Tournament CRUD + cancel
│       │   ├── registrations.ts   # Register/unregister with validation
│       │   ├── matches.ts         # Score submission, confirmation, disputes, ELO
│       │   └── ratings.ts         # Player ratings with duplicate prevention
│       ├── middleware/
│       │   └── auth.ts            # Firebase token verification
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

## API Reference

**Production**: `https://us-central1-baddies-live.cloudfunctions.net/api`

All endpoints (except `/health`) require: `Authorization: Bearer <Firebase ID Token>`

### Health Check
```
GET /health
```

### Players
```
POST   /api/players        Create profile
PUT    /api/players/:id    Update own profile
GET    /api/players/me     Get current player
```

### Tournaments
```
GET    /api/tournaments          List upcoming
GET    /api/tournaments/past     List past
GET    /api/tournaments/:id      Get single
POST   /api/tournaments          Create (requires auth)
PUT    /api/tournaments/:id      Update (organizer only)
POST   /api/tournaments/:id/cancel  Cancel (organizer only, 3hr cutoff)
```

### Registrations
```
POST   /api/registrations/:tournamentId/register       Register
DELETE /api/registrations/:tournamentId/register       Unregister
GET    /api/registrations/:tournamentId/registrations  List registrations
```

### Matches
```
GET    /api/matches/:tournamentId/matches         List matches
POST   /api/matches/:matchId/submit-score         Submit scores
POST   /api/matches/:matchId/confirm              Confirm scores
POST   /api/matches/:matchId/dispute              Dispute scores
```

### Ratings
```
POST   /api/ratings            Rate a player
GET    /api/ratings/:playerId  Get player ratings
```

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

## Cross-Platform

This API serves all client platforms identically:

| Platform | Auth Token |
|----------|-----------|
| iOS | `Auth.auth().currentUser?.getIDToken()` |
| Android | `FirebaseAuth.getInstance().currentUser?.getIdToken()` |
| Web | `firebase.auth().currentUser.getIdToken()` |

Send as: `Authorization: Bearer <token>`
