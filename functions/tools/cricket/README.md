# Exhaustive cricket rule tests

Heavier companions to `npm run check:cricket` (the shared hand-written cases).

| Script | What it does |
|---|---|
| `oracle.js` | Runs ~78M scorecards (every runs/wickets/overs combination in small rule sets, plus T20 boundary values, super overs and revised targets) through `services/cricket.ts` and compares validity, winner and margin with an independent implementation written from first principles. Expect `cases … valid …` and no mismatch lines. |
| `gen.js` | Prints validation + outcome for 5.19M scorecards, one line each, for diffing against the apps. |
| `leagues.js` | 3,000 random valid leagues (all presets + a custom 8-ball rule set): NRR from `cricket.ts` vs an independent formula, points total = 2 × matches. Writes `leagues.json` for the app check. |
| `swift-scorecards/` | iOS port, same enumeration as `gen.js`. Output must be byte-identical. |
| `swift-leagues/` | iOS port over `leagues.json`: same points and formatted NRR as the server. |

```bash
cd functions && npm run build
node tools/cricket/oracle.js "$PWD/lib/services/cricket.js"
node tools/cricket/leagues.js "$PWD/lib/services/cricket.js"     # writes leagues.json here

# iOS parity (needs Xcode; IOS = path to tournmate-ios)
node tools/cricket/gen.js "$PWD/lib/services/cricket.js" /tmp/ts.txt
xcrun swiftc -O -o /tmp/sc "$IOS/TournMate/Domain/CricketRules.swift" tools/cricket/swift-scorecards/main.swift && /tmp/sc /tmp/swift.txt
cmp /tmp/ts.txt /tmp/swift.txt && echo IDENTICAL
xcrun swiftc -O -o /tmp/lg "$IOS/TournMate/Domain/CricketRules.swift" tools/cricket/swift-leagues/main.swift && /tmp/lg leagues.json
```

Results on 2026-10-10: the oracle matched everything after the rain-revised super-over fix. The scorecard diff was byte-identical. Leagues: server NRR exact, and iOS matched except rounding of exact halves (fixed to JavaScript's `Math.round`).
