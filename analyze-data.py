import json, collections

types = collections.Counter()
fields_by_type = {}
samples = {}
fixtures = set()
bookmakers = set()
market_params = collections.Counter()
streams = collections.Counter()

with open('/opt/proofdesk/data/recordings/live-2026-07-14.jsonl') as f:
    for line in f:
        try:
            rec = json.loads(line)
            streams[rec.get('stream', '?')] += 1
            m = json.loads(rec['raw'])
        except Exception:
            continue
        t = m.get('SuperOddsType') or m.get('MessageType') or ('score:' + str(list(m.keys())[:3]))
        types[t] += 1
        fields_by_type.setdefault(t, set()).update(m.keys())
        if t not in samples:
            samples[t] = m
        if m.get('FixtureId'): fixtures.add(m['FixtureId'])
        if m.get('Bookmaker'): bookmakers.add(m['Bookmaker'])
        if m.get('MarketParameters'): market_params[m['MarketParameters']] += 1

print('=== STREAMS ===')
for s, c in streams.items(): print(f'  {s}: {c} messages')
print('\n=== MESSAGE TYPES ===')
for t, c in types.most_common(): print(f'  {t}: {c}')
print('\n=== FIXTURES SEEN ===', sorted(fixtures))
print('=== BOOKMAKERS ===', sorted(bookmakers))
print('\n=== MARKET PARAMETERS (top) ===')
for p, c in market_params.most_common(12): print(f'  {p}: {c}')
print('\n=== FIELDS PER TYPE ===')
for t, fl in fields_by_type.items(): print(f'  {t}: {sorted(fl)}')
print('\n=== FULL SAMPLES ===')
for t, s in samples.items():
    print(f'--- {t} ---')
    print(json.dumps(s, indent=1)[:700])
