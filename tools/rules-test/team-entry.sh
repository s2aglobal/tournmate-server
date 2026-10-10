#!/bin/bash
H="http://127.0.0.1:8089/v1/projects/demo-tm/databases/(default)/documents"
tok() { python3 -c "import base64,json;e=lambda d:base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip('=');print(e({'alg':'none','typ':'JWT'})+'.'+e({'sub':'$1','user_id':'$1','iss':'https://securetoken.google.com/demo-tm','aud':'demo-tm','auth_time':1,'iat':1,'exp':9999999999,'firebase':{'sign_in_provider':'password'}})+'.')"; }
U=$(tok user1)
put() { curl -s -o /dev/null -w "%{http_code}" -X PATCH "$H/$1" -H "Authorization: Bearer $2" -H 'Content-Type: application/json' -d "$3"; }
# seed tournaments (admin bypass)
put "tournaments/cric" owner '{"fields":{"formatRaw":{"stringValue":"team"},"sportType":{"stringValue":"cricket"},"createdBy":{"stringValue":"user1"},"title":{"stringValue":"T20 Cup"}}}' >/dev/null
put "tournaments/bad" owner '{"fields":{"formatRaw":{"stringValue":"openDoubles"},"sportType":{"stringValue":"badminton"},"createdBy":{"stringValue":"user1"},"title":{"stringValue":"Doubles"}}}' >/dev/null
put "config/sports" owner '{"fields":{"live":{"arrayValue":{"values":[{"stringValue":"pickleball"},{"stringValue":"badminton"},{"stringValue":"tennis"}]}},"liveMinAppVersion":{"mapValue":{"fields":{"cricket":{"mapValue":{"fields":{"ios":{"stringValue":"1.8"}}}}}}}}}' >/dev/null
exp() { r=$(put "$1" "$U" "$2"); [ "$r" = "$3" ] && echo "PASS $4 ($r)" || echo "FAIL $4 (got $r, want $3)"; }
exp registrations/r1 '{"fields":{"tournamentId":{"stringValue":"cric"},"playerId":{"stringValue":"p1"}}}' 403 "individual entry into cricket tournament rejected"
exp registrations/r2 '{"fields":{"tournamentId":{"stringValue":"cric"},"playerId":{"stringValue":"p1"},"partnerId":{"stringValue":"p2"}}}' 403 "doubles pair into cricket tournament rejected"
exp registrations/r3 '{"fields":{"tournamentId":{"stringValue":"cric"},"playerId":{"stringValue":"p1"},"teamId":{"stringValue":"t1"},"teamName":{"stringValue":"Strikers"},"rosterIds":{"arrayValue":{"values":[{"stringValue":"p1"}]}}}}' 200 "team entry accepted"
exp registrations/r4 '{"fields":{"tournamentId":{"stringValue":"cric"},"playerId":{"stringValue":"p1"},"teamId":{"stringValue":"t1"},"teamName":{"stringValue":"Strikers"}}}' 403 "team entry without roster rejected"
exp registrations/r5 '{"fields":{"tournamentId":{"stringValue":"bad"},"playerId":{"stringValue":"p1"}}}' 200 "badminton individual still allowed"
exp registrations/r6 '{"fields":{"tournamentId":{"stringValue":"bad"},"playerId":{"stringValue":"p1"},"partnerId":{"stringValue":"p2"}}}' 200 "badminton doubles still allowed"
exp registrations/r7 '{"fields":{"tournamentId":{"stringValue":"missing"},"playerId":{"stringValue":"p1"}}}' 403 "unknown tournament rejected"
NOW='{"timestampValue":"2026-12-01T10:00:00Z"}'
exp tournaments/t2 "{\"fields\":{\"formatRaw\":{\"stringValue\":\"openDoubles\"},\"sportType\":{\"stringValue\":\"cricket\"},\"createdBy\":{\"stringValue\":\"user1\"},\"title\":{\"stringValue\":\"Bad cricket\"},\"location\":{\"stringValue\":\"Ground\"},\"date\":$NOW}}" 403 "cricket tournament with doubles format rejected"
exp tournaments/t3 "{\"fields\":{\"formatRaw\":{\"stringValue\":\"team\"},\"sportType\":{\"stringValue\":\"cricket\"},\"createdBy\":{\"stringValue\":\"user1\"},\"title\":{\"stringValue\":\"Good cricket\"},\"location\":{\"stringValue\":\"Ground\"},\"date\":$NOW}}" 200 "cricket tournament with team format accepted (gated sport counts as live)"
exp tournaments/t4 "{\"fields\":{\"formatRaw\":{\"stringValue\":\"mensDoubles\"},\"sportType\":{\"stringValue\":\"badminton\"},\"createdBy\":{\"stringValue\":\"user1\"},\"title\":{\"stringValue\":\"Badminton\"},\"location\":{\"stringValue\":\"Hall\"},\"date\":$NOW}}" 200 "badminton tournament unaffected"
