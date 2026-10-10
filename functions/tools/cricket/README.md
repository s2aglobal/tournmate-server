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

# iOS parity (needs Xcode + a booted simulator; IOS = path to tournmate-ios).
# CricketRules.swift uses other Domain types, so build the whole Domain layer for the simulator.
node tools/cricket/gen.js "$PWD/lib/services/cricket.js" /tmp/ts.txt
SDK=$(xcrun --sdk iphonesimulator --show-sdk-path); SIM=$(xcrun simctl list devices booted | grep -Eo '[0-9A-F-]{36}' | head -1)
SRC="$IOS/TournMate/Domain/*.swift $IOS/TournMate/Services/Region/PostalCodeRules.swift $IOS/Tools/DrawTests/Stubs.swift"
xcrun swiftc -O -sdk "$SDK" -target arm64-apple-ios17.0-simulator -o /tmp/sc $SRC tools/cricket/swift-scorecards/main.swift
xcrun simctl spawn "$SIM" /tmp/sc /tmp/swift.txt && cmp /tmp/ts.txt /tmp/swift.txt && echo IDENTICAL
xcrun swiftc -O -sdk "$SDK" -target arm64-apple-ios17.0-simulator -o /tmp/lg $SRC tools/cricket/swift-leagues/main.swift
xcrun simctl spawn "$SIM" /tmp/lg "$PWD/leagues.json"
```

Results on 2026-10-10, after the fixes: the oracle matched all 78.3M scorecards; the scorecard diff was byte-identical (5,193,720 cases); leagues: server NRR exact, and iOS identical (0 of 25,916 team totals differ).
