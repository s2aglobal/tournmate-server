// Random valid leagues -> NRR via cricket.ts vs an independent formula; writes fixtures for Swift.
const C = require(process.argv[2]);
const fs = require('fs');
let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const presets = C.CRICKET_EVENT_TYPES.map(e => e.rules).concat([{ eventTypeId: 'custom', playersPerSide: 7, overs: 5, ballsPerOver: 8, lastManStands: true, superOver: true }]);
const leagues = []; let bad = 0, checks = 0;
for (let L = 0; L < 3000; L++) {
  const r = presets[L % presets.length];
  const wMax = r.lastManStands ? r.playersPerSide : r.playersPerSide - 1, lim = r.overs * r.ballsPerOver;
  const n = 2 + rnd(15); const teams = [...Array(n).keys()].map(i => 't' + i);
  const matches = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const [a, b] = rnd(2) ? [teams[i], teams[j]] : [teams[j], teams[i]];
    let res;
    if (rnd(25) === 0) res = { innings: [], noResult: true };
    else {
      const fw = rnd(wMax + 1), fb = fw === wMax ? 1 + rnd(lim) : lim, fr = rnd(lim * 2 + 1);
      const first = { battingRegistrationId: a, runs: fr, wickets: fw, balls: fb };
      const rev = rnd(10) === 0 && r.overs > 1 ? { runs: Math.max(1, Math.floor(fr * 0.7)), overs: Math.max(1, r.overs - 1 - rnd(Math.max(1, r.overs - 1))) } : undefined;
      const target = rev ? rev.runs : fr + 1, sLim = rev ? rev.overs * r.ballsPerOver : lim;
      let second; const k = rnd(3);
      if (k === 0) second = { battingRegistrationId: b, runs: target + rnd(4), wickets: rnd(wMax), balls: 1 + rnd(sLim) };
      else if (k === 1 && target - 1 > 0) second = { battingRegistrationId: b, runs: rnd(target), wickets: wMax, balls: 1 + rnd(sLim) };
      else second = { battingRegistrationId: b, runs: Math.max(0, target - 1 - rnd(target)), wickets: rnd(wMax), balls: sLim };
      res = { innings: [first, second] };
      if (rev) res.revisedTarget = rev;
    }
    const issues = C.validateCricketResult(res, r, a, b);
    if (issues.length) continue;   // generator produced an invalid card; skip it
    matches.push({ a, b, res });
  }
  // cricket.ts NRR and points
  const out = {};
  for (const t of teams) {
    let tot = { runsFor: 0, ballsFaced: 0, runsAgainst: 0, ballsBowled: 0 }, pts = 0;
    // independent formula
    let rf = 0, of = 0, ra = 0, ob = 0;
    for (const m of matches) {
      if (m.a !== t && m.b !== t) continue;
      tot = C.addToRunRate(tot, t, m.res, r);
      const o = C.cricketOutcome(m.res, r);
      pts += o.winnerRegistrationId ? (o.winnerRegistrationId === t ? 2 : 0) : 1;
      if (m.res.noResult) continue;
      m.res.innings.forEach((inn, idx) => {
        const quota = (idx === 1 && m.res.revisedTarget ? m.res.revisedTarget.overs : r.overs);
        const overs = inn.wickets === wMax ? quota : Math.floor(inn.balls / r.ballsPerOver) + (inn.balls % r.ballsPerOver) / r.ballsPerOver;
        if (inn.battingRegistrationId === t) { rf += inn.runs; of += overs; } else { ra += inn.runs; ob += overs; }
      });
    }
    const nrrLib = C.netRunRate(tot, r.ballsPerOver);
    const nrrIndep = of > 0 && ob > 0 ? rf / of - ra / ob : 0;
    checks++;
    if (Math.abs(nrrLib - nrrIndep) > 1e-9) { bad++; if (bad < 5) console.log('NRR mismatch', t, nrrLib, nrrIndep); }
    out[t] = { pts, nrr: C.formatNetRunRate(nrrLib) };
  }
  const total = Object.values(out).reduce((s, x) => s + x.pts, 0);
  checks++; if (total !== 2 * matches.length) { bad++; console.log('points total wrong', L); }
  leagues.push({ rules: r, teams, matches, expected: out });
}
fs.writeFileSync('leagues.json', JSON.stringify(leagues));
console.log('leagues', leagues.length, 'matches', leagues.reduce((s, l) => s + l.matches.length, 0), 'checks', checks, 'failures', bad);
