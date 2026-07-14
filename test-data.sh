#!/bin/bash
# Test real TxLINE data with activated credentials
CRED=/opt/proofdesk/data/txline-credentials.json
API=$(python3 -c "import json;print(json.load(open('$CRED'))['api'])")
JWT=$(python3 -c "import json;print(json.load(open('$CRED'))['jwt'])")
TOK=$(python3 -c "import json;print(json.load(open('$CRED'))['apiToken'])")
H1="Authorization: Bearer $JWT"
H2="X-Api-Token: $TOK"

for path in /api/scores/schedule /api/schedule /api/fixtures /api/scores/snapshot /api/odds/snapshot; do
  echo "=== GET $path ==="
  curl -s --max-time 12 "$API$path" -H "$H1" -H "$H2" | head -c 400
  echo; echo
done

echo "=== SCORES STREAM (10s) ==="
timeout 10 curl -sN "$API/api/scores/stream" -H "$H1" -H "$H2" -H 'Accept: text/event-stream' | head -c 800
echo
echo "=== ODDS STREAM (10s) ==="
timeout 10 curl -sN "$API/api/odds/stream" -H "$H1" -H "$H2" -H 'Accept: text/event-stream' | head -c 800
echo "=== DONE ==="
