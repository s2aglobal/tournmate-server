// Independent oracle: expected validity + outcome from first principles, compared to cricket.ts.
const C = require(process.argv[2]);
const A = 'regA', B = 'regB';
const RULES = [
  { eventTypeId: 'custom', playersPerSide: 3, overs: 2, ballsPerOver: 6, lastManStands: false, superOver: true },
  { eventTypeId: 'custom', playersPerSide: 3, overs: 2, ballsPerOver: 6, lastManStands: true, superOver: true },
  { eventTypeId: 'custom', playersPerSide: 3, overs: 2, ballsPerOver: 4, lastManStands: false, superOver: false },
  { eventTypeId: 'custom', playersPerSide: 2, overs: 3, ballsPerOver: 5, lastManStands: false, superOver: true },
  { eventTypeId: 't20', playersPerSide: 11, overs: 20, ballsPerOver: 6, lastManStands: false, superOver: true },
];
const mism = {}; let total = 0, valid = 0;
function note(kind, ex) { mism[kind] = mism[kind] || { count: 0, ex }; mism[kind].count++; }
function expected(res, r) {
  const wMax = r.lastManStands ? r.playersPerSide : r.playersPerSide - 1;
  const full = r.overs * r.ballsPerOver;
  if (res.noResult) return { ok: res.innings.length <= 2 && res.innings.every(i => i.runs >= 0 && i.wickets >= 0 && i.wickets <= wMax && i.balls >= 0 && i.balls <= full) && sidesOk(res) , type: 'noResult' };
  if (res.innings.length !== 2 || !sidesOk(res)) return { ok: false };
  const [f, s] = res.innings;
  const rt = res.revisedTarget;
  if (rt && (rt.runs < 1 || rt.overs < 1 || rt.overs > r.overs)) return { ok: false };
  const sLim = rt ? rt.overs * r.ballsPerOver : full;
  for (const [inn, lim] of [[f, full], [s, sLim]]) if (inn.runs < 0 || inn.wickets < 0 || inn.wickets > wMax || inn.balls < 0 || inn.balls > lim) return { ok: false };
  const target = rt ? rt.runs : f.runs + 1;
  const firstDone = f.wickets === wMax || f.balls === full || !!rt;
  const chased = s.runs >= target;
  const secondDone = chased || s.wickets === wMax || s.balls === sLim;
  if (!firstDone || !secondDone) return { ok: false };
  if (chased && s.wickets === wMax) return { ok: false };
  if (chased && s.runs > target + 10) return { ok: false };
  const level = s.runs === target - 1;               // scores level (with or without revised target)
  if (res.superOverWinnerRegistrationId !== undefined) {
    if (!level || chased) return { ok: false, why: level ? '' : 'so-not-level' };
    if (!r.superOver) return { ok: false };
    if (![A, B].includes(res.superOverWinnerRegistrationId)) return { ok: false };
  }
  if (chased) return { ok: true, type: 'win', winner: s.battingRegistrationId, margin: `won by ${wMax - s.wickets} wicket` };
  if (level) return res.superOverWinnerRegistrationId ? { ok: true, type: 'win', winner: res.superOverWinnerRegistrationId, margin: 'won the super over' } : { ok: true, type: 'tie', winner: null, margin: 'Match tied' };
  return { ok: true, type: 'win', winner: f.battingRegistrationId, margin: `won by ${target - 1 - s.runs} run` };
}
function sidesOk(res) {
  const ss = res.innings.map(i => i.battingRegistrationId);
  return ss.every(x => x === A || x === B) && !(ss.length === 2 && ss[0] === ss[1]);
}
function test(r, res) {
  total++;
  const issues = C.validateCricketResult(res, r, A, B);
  const e = expected(res, r);
  const ok = issues.length === 0;
  if (ok !== e.ok) { note((ok ? 'ACCEPTED, oracle rejects' : 'REJECTED, oracle accepts') + (e.why ? ' ' + e.why : '') + ' :: ' + (issues[0]?.message ?? ''), JSON.stringify({ r: r.playersPerSide + 'p/' + r.overs + 'ov/' + r.ballsPerOver + 'bpo' + (r.lastManStands ? '/lms' : '') + (r.superOver ? '/so' : ''), res })); return; }
  if (!ok) return;
  valid++;
  const o = C.cricketOutcome(res, r);
  if (o.resultType !== e.type || (o.winnerRegistrationId ?? null) !== (e.winner ?? null) || !o.margin.startsWith(e.margin)) note('OUTCOME differs', JSON.stringify({ res, got: o, want: e }));
}
for (const r of RULES) {
  const wMax = r.lastManStands ? r.playersPerSide : r.playersPerSide - 1;
  const limit = r.overs * r.ballsPerOver;
  const step = r.overs > 5 ? 7 : 1;
  const runsList = r.overs > 5 ? [0, 1, 99, 100, 101, 105, 110, 111, 112, 150] : [...Array(13).keys()];
  const inns = [];
  for (const runs of runsList) for (let w = 0; w <= wMax + 1; w++) for (let b = 0; b <= limit + 1; b += (b >= limit - 1 ? 1 : step)) inns.push([runs, w, b]);
  const vs = [{}, { superOverWinnerRegistrationId: A }, { superOverWinnerRegistrationId: B }, { superOverWinnerRegistrationId: 'regC' },
    { revisedTarget: { runs: 5, overs: 1 } }, { revisedTarget: { runs: 7, overs: Math.max(1, r.overs - 1) } }, { revisedTarget: { runs: 0, overs: 1 } }, { revisedTarget: { runs: 5, overs: r.overs + 1 } },
    { revisedTarget: { runs: 5, overs: 1 }, superOverWinnerRegistrationId: A }, { revisedTarget: { runs: 7, overs: Math.max(1, r.overs - 1) }, superOverWinnerRegistrationId: B }];
  for (const f of inns) for (const s of inns) for (const v of vs) {
    test(r, { innings: [{ battingRegistrationId: A, runs: f[0], wickets: f[1], balls: f[2] }, { battingRegistrationId: B, runs: s[0], wickets: s[1], balls: s[2] }], ...v });
  }
}
console.log('cases', total, 'valid', valid);
for (const [k, v] of Object.entries(mism)) console.log(`${v.count}× ${k}\n   e.g. ${v.ex}`);
