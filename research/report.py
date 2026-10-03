# Per-run report over a capture.jsonl, so runs can be compared like for like.
import json, sys, collections, statistics as st

rows = [r for r in (json.loads(l) for l in open(sys.argv[1])) if r.get('kind') != 'fixture']
T0 = rows[0]['rx_ms']
def t(rx): return '%+6.0fs' % ((rx - T0) / 1000)
def num(x):
    if isinstance(x, bool): return None
    if isinstance(x, (int, float)): return float(x)
    return None

route = None; start = {}; length = {}
for r in rows:
    if r['kind'] == 'msg' and r['m']['type'] == 'hello':
        route = r['m']['route']; start = {s['segment_id']: s['start_m'] for s in route}; length = {s['segment_id']: s['length_m'] for s in route}
        break
def pos(m):
    try: return start[m['segment_id']] + float(m['offset_m'])
    except Exception: return None

# ---- link ----
print('== LINK ==')
dur = (rows[-1]['rx_ms'] - T0) / 1000
kinds = collections.Counter(r['kind'] if r['kind'] != 'msg' else r['m']['type'] for r in rows)
print('duration %.0fs  counts %s' % (dur, dict(kinds)))
for r in rows:
    if r['kind'] in ('connected', 'closed_by_peer', 'error', 'rx_timeout'): print(' ', t(r['rx_ms']), r['kind'], r.get('err', ''), r.get('attempt', ''))
    if r['kind'] == 'msg' and r['m']['type'] == 'hello':
        h = r['m']; print(' ', t(r['rx_ms']), 'hello: non-open zones', [(z['zone_id'], z['status']) for z in h['zones'] if z['status'] != 'OPEN'], 'leases', h['leases'], 'vehicles', len(h['vehicles']))
hb = [r['rx_ms'] for r in rows if r['kind'] == 'msg' and r['m']['type'] == 'heartbeat']
anyrx = [r['rx_ms'] for r in rows if r['kind'] in ('msg', 'unparseable')]
for a, b in zip(anyrx, anyrx[1:]):
    if b - a > 1500: print('  silence on whole link %s for %.1fs' % (t(a), (b - a) / 1000))
d = [b - a for a, b in zip(hb, hb[1:])]
if d: print('  heartbeat gaps >3s:', [(t(a), round((b - a) / 1000, 1)) for a, b in zip(hb, hb[1:]) if b - a > 3000])
other = [r for r in rows if r['kind'] == 'msg' and r['m']['type'] not in ('telemetry', 'heartbeat', 'hello', 'zone_event')]
for r in other[:20]: print('  OTHER', t(r['rx_ms']), json.dumps(r['m'])[:250])
print('  truncated/unparseable lines: %d of %d (%.2f%%)' % (kinds['unparseable'], len(anyrx), 100 * kinds['unparseable'] / max(1, len(anyrx))))

# ---- telemetry by truck, in arrival order ----
tel = collections.defaultdict(list)
for r in rows:
    if r['kind'] == 'msg' and r['m']['type'] == 'telemetry': tel[r['m'].get('vehicle_id')].append((r['rx_ms'], r['m']))

# ---- zones ----
print('== ZONES ==')
events = [(r['rx_ms'], r['m']) for r in rows if r['kind'] == 'msg' and r['m']['type'] == 'zone_event']
closed_windows = []; open_since = {}
for rx, m in events:
    note = ''
    if m['status'] == 'CLOSING': note = 'notice %.0fs' % ((m['effective_at_ms'] - m['server_time_ms']) / 1000)
    if m['status'] == 'CLOSED': open_since[m['zone_id']] = rx
    if m['status'] == 'OPEN' and m['zone_id'] in open_since:
        a = open_since.pop(m['zone_id']); closed_windows.append((m['zone_id'], a, rx)); note = 'closed for %.0fs' % ((rx - a) / 1000)
    print(' ', t(rx), m['zone_id'], m['status'], m.get('reason'), note)
for z, a in open_since.items(): closed_windows.append((z, a, rows[-1]['rx_ms']))
for z, a, b in closed_windows:
    inside = []
    for v, l in sorted(tel.items()):
        n = [(rx, m) for rx, m in l if a <= rx <= b and m.get('zone_id') == z]
        if n: inside.append('%s(%d msgs, %s, pos %.0f..%.0f)' % (v, len(n), '/'.join(sorted(set(str(m['state']) for _, m in n))), min(pos(m) or 0 for _, m in n), max(pos(m) or 0 for _, m in n)))
    print('  while %s CLOSED %s..%s, reported inside: %s' % (z, t(a), t(b), inside or 'none'))

# ---- per truck ----
print('== TRUCKS ==')
fleet_drain = {}
for v, l in sorted(tel.items(), key=lambda kv: str(kv[0])):
    issues = []
    seqs = [m.get('seq') for _, m in l]
    # resets: big drop while device clock advances
    mx = None; mx_dev = None; resets = []
    seen = {}; ident = 0; reorder = 0; last = None
    for rx, m in l:
        s = m.get('seq'); dv = num(m.get('t_device_ms'))
        if isinstance(s, int) and mx is not None and s < mx - 20:
            resets.append('%s %d->%d' % (t(rx), mx, s)); mx = s; seen = {}
        if isinstance(s, int):
            key = json.dumps(m, sort_keys=True)
            if s in seen: ident += seen[s] == key
            seen[s] = key
            if last is not None and s < last: reorder += 1
            last = s; mx = s if mx is None else max(mx, s)
    if resets: issues.append('SEQ RESET ' + ', '.join(resets))
    gaps = [(a, b) for (a, _), (b, _) in zip(l, l[1:]) if b - a > 2000]
    if gaps: issues.append('SILENT ' + ', '.join('%s %.0fs' % (t(a), (b - a) / 1000) for a, b in gaps))
    sk = [num(m.get('t_device_ms')) - rx for rx, m in l if num(m.get('t_device_ms')) is not None]
    skew = st.median(sk) if sk else 0
    if abs(skew) > 1500: issues.append('CLOCK SKEW %+.1fs' % (skew / 1000))
    socs = [(rx, num(m.get('soc_pct'))) for rx, m in l if num(m.get('soc_pct')) is not None]
    if socs and max(s for _, s in socs) <= 1.0: issues.append('SOC LOOKS LIKE A FRACTION (%.3f)' % socs[-1][1])
    # drain while tramming, %/min
    tram = [(rx, num(m.get('soc_pct'))) for rx, m in l if m.get('state') == 'TRAMMING' and num(m.get('soc_pct')) is not None]
    drain = None
    if len(tram) > 50 and tram[-1][0] > tram[0][0]:
        scale = 100 if socs and max(s for _, s in socs) <= 1.0 else 1
        drops = sum(max(0, a[1] - b[1]) for a, b in zip(tram, tram[1:]) if 0 < b[0] - a[0] < 2000)
        mins = sum(b[0] - a[0] for a, b in zip(tram, tram[1:]) if 0 < b[0] - a[0] < 2000) / 60000
        drain = drops * scale / mins if mins else None
        if drain is not None: fleet_drain[v] = drain
    # malformed fields
    bad = collections.Counter()
    for _, m in l:
        for f in ('offset_m', 'soc_pct', 'speed_mps', 'payload_kg', 't_device_ms'):
            if f not in m: bad['missing ' + f] += 1
            elif num(m[f]) is None: bad['%s=%s' % (f, type(m[f]).__name__)] += 1
        if m.get('state') not in ('TRAMMING', 'LOADING', 'DUMPING', 'CHARGING', 'HOLDING', 'IDLE', 'MANUAL', 'ESTOPPED', 'FAULT'): bad['state=%r' % m.get('state')] += 1
        if m.get('segment_id') not in start: bad['segment=%r' % m.get('segment_id')] += 1
        elif m.get('zone_id') != [s['zone_id'] for s in route if s['segment_id'] == m['segment_id']][0]: bad['zone/segment mismatch'] += 1
        o = num(m.get('offset_m'))
        if o is not None and m.get('segment_id') in length and not 0 <= o <= length[m['segment_id']] + 0.01: bad['offset outside segment'] += 1
        sp = num(m.get('speed_mps'))
        if sp is not None and (sp < 0 or sp > 4.5): bad['speed %.1f' % sp] += 1
        so = num(m.get('soc_pct'))
        if so is not None and not 0 <= so <= 100: bad['soc %.1f' % so] += 1
    if bad: issues.append('MALFORMED ' + str(dict(bad.most_common(6))))
    # frozen position: speed > 0.5 reported, moving state, position unchanged across >5s of in-order msgs
    ordered = sorted(((m['seq'], rx, m) for rx, m in l if isinstance(m.get('seq'), int)), key=lambda x: x[0])
    frozen = []; run_start = None
    for (s1, r1, m1), (s2, r2, m2) in zip(ordered, ordered[1:]):
        p1, p2 = pos(m1), pos(m2); sp = num(m2.get('speed_mps')) or 0
        if p1 is not None and p2 is not None and abs(p2 - p1) < 0.01 and sp > 0.5 and m2.get('state') in ('TRAMMING', 'MANUAL'):
            run_start = run_start or (r1, p1)
        else:
            if run_start and r1 - run_start[0] > 5000: frozen.append('%s for %.0fs at %.0fm' % (t(run_start[0]), (r1 - run_start[0]) / 1000, run_start[1]))
            run_start = None
    if run_start and ordered[-1][1] - run_start[0] > 5000: frozen.append('%s for %.0fs+ at %.0fm (to end)' % (t(run_start[0]), (ordered[-1][1] - run_start[0]) / 1000, run_start[1]))
    if frozen: issues.append('FROZEN POSITION ' + ', '.join(frozen))
    # state / fault / task / control changes (in seq order, per reset epoch roughly)
    changes = []; prev = None
    for s, rx, m in ordered:
        k = (m.get('state'), tuple(m.get('faults') or []), m.get('task'), (m.get('control') or {}).get('mode'))
        if prev and k != prev and (k[0] not in ('TRAMMING', 'LOADING', 'DUMPING', 'tramming', 'loading') or k[1] or k[2] or k[3] != 'AUTO' or prev[1]):
            changes.append('%s %s%s%s' % (t(rx), k[0], ' ' + ','.join(k[1]) if k[1] else '', ' task=' + k[2] if k[2] else ''))
        prev = k
    if changes: issues.append('EVENTS ' + '; '.join(changes[:8]))
    s0 = socs[0][1] if socs else None; s1 = socs[-1][1] if socs else None
    lastm = l[-1][1]
    print('%s n=%d dupIdent=%d reorder=%d skew=%+.1fs soc %s->%s drain=%s/min | last %s %s %.0fm' % (
        v, len(l), ident, reorder, skew / 1000, s0, s1, '%.2f' % drain if drain else '?', lastm.get('state'), lastm.get('zone_id'), pos(lastm) or -1))
    for i in issues: print('    -', i)
if fleet_drain and st.median(fleet_drain.values()) > 0:
    med = st.median(fleet_drain.values())
    print('fleet median drain %.2f%%/min; outliers:' % med, {v: round(d / med, 1) for v, d in fleet_drain.items() if d > 1.6 * med or d < 0.5 * med})
