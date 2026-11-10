#!/usr/bin/env python3
"""feedback collection rules: no client read or write. Run via run-feedback.sh."""
from fsrest import Ts, req, set_doc, BASE, D, tok

failures = 0


def expect(got, want, name):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'} {name} ({got}{'' if ok else f', want {want}'})")


DOC = {"uid": "u1", "sport": "badminton", "mood": 5, "tags": ["design"], "text": "", "createdAt": Ts("2026-11-01T10:00:00Z")}
expect(set_doc("feedback/F1", "owner", DOC), 200, "seed: server writes feedback (admin bypass)")
expect(set_doc("feedback/F2", "u1", DOC), 403, "client create rejected")
expect(set_doc("feedback/F1", "u1", {**DOC, "mood": 1}), 403, "client update of own feedback rejected")
expect(req("GET", f"{BASE}/{D}/feedback/F1", "u1"), 403, "author can't read own feedback")
expect(req("GET", f"{BASE}/{D}/feedback/F1", "u2"), 403, "other user can't read")
expect(req("GET", f"{BASE}/{D}/feedback/F1", None), 403, "signed-out can't read")
expect(req("GET", f"{BASE}/{D}/feedback", "u1"), 403, "client list rejected")
expect(req("DELETE", f"{BASE}/{D}/feedback/F1", "u1"), 403, "client delete rejected")
print(f"# {failures} failed")
