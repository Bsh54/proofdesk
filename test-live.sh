#!/bin/bash
echo '{"fixtureId":18237038}' > /tmp/watch.json
curl -s -X POST http://localhost/api/live/watch -H 'Content-Type: application/json' -d @/tmp/watch.json
echo
sleep 25
echo '--- LAST JOURNAL ENTRIES ---'
tail -2 /opt/proofdesk/data/journal.jsonl | cut -c1-400
echo '--- JOURNAL VERIFY ---'
curl -s http://localhost/api/journal/verify
echo
echo '--- RECORDED MESSAGES ---'
wc -l /opt/proofdesk/data/recordings/*.jsonl
