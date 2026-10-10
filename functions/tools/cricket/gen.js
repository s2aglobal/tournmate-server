// Enumerates cricket scorecards and prints validation + outcome per case.
const C = require(process.argv[2]);
const fs = require('fs');
const out = fs.createWriteStream(process.argv[3]);
const RULES = [
  { eventTypeId: 'custom', playersPerSide: 3, overs: 2, ballsPerOver: 6, lastManStands: false, superOver: true },
  { eventTypeId: 'custom', playersPerSide: 3, overs: 2, ballsPerOver: 6, lastManStands: true, superOver: true },
  { eventTypeId: 'custom', playersPerSide: 3, overs: 2, ballsPerOver: 4, lastManStands: false, superOver: false },
  { eventTypeId: 'custom', playersPerSide: 2, overs: 3, ballsPerOver: 5, lastManStands: false, superOver: true },
];
const A = 'regA', B = 'regB';
let n = 0;
function emit(r, res) {
  const issues = C.validateCricketResult(res, r, A, B);
  let o = '';
  if (issues.length === 0) { const x = C.cricketOutcome(res, r); o = `${x.resultType},${x.winnerRegistrationId ?? '-'},${x.margin}`; }
  out.write(`${n}|${issues.map(i => i.field + ':' + i.message).join(';')}|${o}\n`);
  n++;
}
for (const r of RULES) {
  const wMax = r.lastManStands ? r.playersPerSide : r.playersPerSide - 1;
  const limit = r.overs * r.ballsPerOver;
  const inns = [];
  for (let runs = 0; runs <= 8; runs++) for (let w = 0; w <= wMax + 1; w++) for (let b = 0; b <= limit + 1; b++) inns.push([runs, w, b]);
  const variants = [
    {}, { superOverWinnerRegistrationId: A }, { superOverWinnerRegistrationId: B },
    { revisedTarget: { runs: 5, overs: 1 } }, { revisedTarget: { runs: 9, overs: r.overs + 1 } },
    { superOverWinnerRegistrationId: 'regC' },
  ];
  for (let i = 0; i < inns.length; i++) {
    const f = inns[i];
    for (const firstSide of [A, B]) {
      const secondSide = firstSide === A ? B : A;
      const first = { battingRegistrationId: firstSide, runs: f[0], wickets: f[1], balls: f[2] };
      emit(r, { innings: [], noResult: true });
      emit(r, { innings: [first], noResult: true });
      emit(r, { innings: [first] });
      if (i % 2 === 0) emit(r, { innings: [first, { ...first }] });
      for (let j = 0; j < inns.length; j += (i % 7 === 0 ? 1 : 3)) {
        const s = inns[j];
        const second = { battingRegistrationId: secondSide, runs: s[0], wickets: s[1], balls: s[2] };
        for (const v of variants) emit(r, { innings: [first, second], ...v });
        if (j % 11 === 0) emit(r, { innings: [first, second], noResult: true });
      }
    }
  }
}
out.end(() => console.log('cases', n));
