import Foundation
struct M: Decodable { let a: String; let b: String; let res: CricketResult }
struct E: Decodable { let pts: Int; let nrr: String }
struct L: Decodable { let rules: CricketRules; let teams: [String]; let matches: [M]; let expected: [String: E] }
let data = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let leagues = try! JSONDecoder().decode([L].self, from: data)
var checks = 0, bad = 0
for l in leagues {
  for t in l.teams {
    var rr = CricketRunRate(); var pts = 0
    for m in l.matches where m.a == t || m.b == t {
      let issues = CricketScoring.validate(m.res, rules: l.rules, teamA: m.a, teamB: m.b)
      if !issues.isEmpty { bad += 1; print("iOS rejects a card the server accepts:", issues[0].message); continue }
      rr.add(m.res, for: t, rules: l.rules)
      let o = CricketScoring.outcome(m.res, rules: l.rules)
      pts += o.winnerRegistrationId.map { $0 == t ? 2 : 0 } ?? 1
    }
    checks += 1
    let nrr = CricketRunRate.format(rr.netRunRate(ballsPerOver: l.rules.ballsPerOver))
    let e = l.expected[t]!
    if nrr != e.nrr || pts != e.pts { bad += 1; if bad < 5 { print("mismatch", t, nrr, e.nrr, pts, e.pts) } }
  }
}
print("iOS leagues \(leagues.count) team checks \(checks) failures \(bad)")
