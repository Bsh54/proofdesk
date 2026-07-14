#!/bin/bash
# Test TxLINE guest access to real data
BASE="https://txline.txodds.com"
JWT=$(curl -s --max-time 15 -X POST $BASE/auth/guest/start -H 'Content-Type: application/json' -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
echo "JWT obtained: ${JWT:0:40}..."

echo "=== SCHEDULE ==="
curl -s --max-time 15 "$BASE/api/scores/schedule" -H "Authorization: Bearer $JWT" | head -c 800
echo

echo "=== FIXTURES ==="
curl -s --max-time 15 "$BASE/api/fixtures" -H "Authorization: Bearer $JWT" | head -c 500
echo

echo "=== SCORES STREAM (10s) ==="
timeout 10 curl -sN "$BASE/api/scores/stream" -H "Authorization: Bearer $JWT" -H 'Accept: text/event-stream' | head -c 1000
echo

echo "=== ODDS STREAM (10s) ==="
timeout 10 curl -sN "$BASE/api/odds/stream" -H "Authorization: Bearer $JWT" -H 'Accept: text/event-stream' | head -c 1000
echo
echo "=== DONE ==="
