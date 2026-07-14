#!/bin/bash
CRED=/opt/proofdesk/data/txline-credentials.json
API=$(python3 -c "import json;print(json.load(open('$CRED'))['api'])")
TOK=$(python3 -c "import json;print(json.load(open('$CRED'))['apiToken'])")
JWT=$(curl -s -X POST $API/auth/guest/start -H 'Content-Type: application/json' -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
H1="Authorization: Bearer $JWT"; H2="X-Api-Token: $TOK"

echo '=== CAS 1: MATCH TERMINE (France-Spain 18237038) — historique complet ==='
curl -s "$API/api/scores/historical/18237038" -H "$H1" -H "$H2" | head -c 400
echo; echo
echo '=== CAS 1b: snapshot final ==='
curl -s "$API/api/scores/snapshot/18237038" -H "$H1" -H "$H2" | python3 -c "import sys,json; d=json.load(sys.stdin); d=d if isinstance(d,list) else [d]; m=d[-1]; print('GameState:',m.get('GameState'),'StatusId:',m.get('StatusId'),'Stats keys:',len(m.get('Stats',{})),'Score g1/g2:',m.get('Stats',{}).get('1',[]),m.get('Stats',{}).get('2',[]))" 2>/dev/null || echo "(parse)"
echo
echo '=== CAS 2: MATCH A VENIR demain (England-Argentina 18241006) — odds snapshot ==='
curl -s "$API/api/odds/snapshot/18241006" -H "$H1" -H "$H2" | head -c 300
echo; echo
echo '=== CAS 3: FRIENDLY lointain — odds ? ==='
# find a friendly fixture id from fixtures snapshot
FID=$(curl -s "$API/api/fixtures/snapshot" -H "$H1" -H "$H2" | python3 -c "
import sys,json
d=json.load(sys.stdin)
lst=d if isinstance(d,list) else d.get('fixtures') or d.get('data') or []
fr=[f for f in lst if 'riendl' in str(f.get('Competition',''))]
print(fr[0]['FixtureId'] if fr else '')
print('ALL FIXTURES:', [(f['FixtureId'],f.get('Competition'),f.get('Participant1'),f.get('Participant2')) for f in lst][:12], file=sys.stderr)
")
echo "friendly fixture: $FID"
if [ -n "$FID" ]; then curl -s "$API/api/odds/snapshot/$FID" -H "$H1" -H "$H2" | head -c 200; fi
echo
