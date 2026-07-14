import json
idl = json.load(open('/opt/proofdesk/data/txline-idl.json'))
for name in ['request_devnet_faucet', 'subscribe', 'subscribe_v2']:
    ix = [i for i in idl['instructions'] if i['name'] == name]
    if not ix:
        print('===', name, ': NOT FOUND ===')
        continue
    i = ix[0]
    print('===', name, '===')
    print('args:', [(a['name'], str(a['type'])) for a in i['args']])
    for a in i['accounts']:
        flags = []
        if a.get('writable'): flags.append('writable')
        if a.get('signer'): flags.append('signer')
        pda = ''
        if a.get('pda'):
            pda = 'PDA seeds: ' + json.dumps(a['pda'].get('seeds', ''))[:200]
        print('  acct:', a['name'], ' '.join(flags), pda)
    print()
