import Foundation
let path = CommandLine.arguments[1]
FileManager.default.createFile(atPath: path, contents: nil)
let fh = FileHandle(forWritingAtPath: path)!
var buf = ""; buf.reserveCapacity(1 << 20)
func flush() { fh.write(buf.data(using: .utf8)!); buf.removeAll(keepingCapacity: true) }
let rulesList = [
  CricketRules(eventType: .custom, playersPerSide: 3, overs: 2, ballsPerOver: 6, lastManStands: false, superOver: true),
  CricketRules(eventType: .custom, playersPerSide: 3, overs: 2, ballsPerOver: 6, lastManStands: true, superOver: true),
  CricketRules(eventType: .custom, playersPerSide: 3, overs: 2, ballsPerOver: 4, lastManStands: false, superOver: false),
  CricketRules(eventType: .custom, playersPerSide: 2, overs: 3, ballsPerOver: 5, lastManStands: false, superOver: true),
]
let A = "regA", B = "regB"
var n = 0
func emit(_ r: CricketRules, _ res: CricketResult) {
  let issues = CricketScoring.validate(res, rules: r, teamA: A, teamB: B)
  var o = ""
  if issues.isEmpty { let x = CricketScoring.outcome(res, rules: r); o = "\(x.resultType.rawValue),\(x.winnerRegistrationId ?? "-"),\(x.margin)" }
  buf += "\(n)|\(issues.map { $0.field + ":" + $0.message }.joined(separator: ";"))|\(o)\n"
  n += 1
  if buf.utf8.count > 1 << 20 { flush() }
}
for r in rulesList {
  let wMax = r.maxWickets, limit = r.overs * r.ballsPerOver
  var inns: [(Int, Int, Int)] = []
  for runs in 0...8 { for w in 0...(wMax + 1) { for b in 0...(limit + 1) { inns.append((runs, w, b)) } } }
  let variants: [(CricketResult) -> CricketResult] = [
    { $0 },
    { var x = $0; x.superOverWinnerRegistrationId = A; return x },
    { var x = $0; x.superOverWinnerRegistrationId = B; return x },
    { var x = $0; x.revisedTarget = .init(runs: 5, overs: 1); return x },
    { var x = $0; x.revisedTarget = .init(runs: 9, overs: r.overs + 1); return x },
    { var x = $0; x.superOverWinnerRegistrationId = "regC"; return x },
  ]
  for i in 0..<inns.count {
    let f = inns[i]
    for firstSide in [A, B] {
      let secondSide = firstSide == A ? B : A
      let first = CricketInnings(battingRegistrationId: firstSide, runs: f.0, wickets: f.1, balls: f.2)
      emit(r, CricketResult(innings: [], noResult: true))
      emit(r, CricketResult(innings: [first], noResult: true))
      emit(r, CricketResult(innings: [first]))
      if i % 2 == 0 { emit(r, CricketResult(innings: [first, first])) }
      var j = 0
      while j < inns.count {
        let s = inns[j]
        let second = CricketInnings(battingRegistrationId: secondSide, runs: s.0, wickets: s.1, balls: s.2)
        for v in variants { emit(r, v(CricketResult(innings: [first, second]))) }
        if j % 11 == 0 { emit(r, CricketResult(innings: [first, second], noResult: true)) }
        j += (i % 7 == 0 ? 1 : 3)
      }
    }
  }
}
flush(); fh.closeFile()
print("cases", n)
