"""Throwaway command probe against the DLH gateway. Not the client.

Usage:
  set -a; . ./.env; set +a
  python3 research/probe.py OUT.jsonl            # dry run: prints the plan, connects to nothing
  python3 research/probe.py OUT.jsonl --live     # sends real commands to the gateway

Reads GATEWAY_HOST, GATEWAY_PORT and GATEWAY_EMAIL from the environment (and
SSL_CERT_FILE if set). The auth line is never recorded.

Every command carries operator_id "probe" so it is identifiable in the site's
statutory log. Every step leaves its truck back in autonomous operation; a
finally-block releases leases, clears e-stops and RESUMEs anything we touched,
including on Ctrl-C. Steps only pick trucks in zones that are OPEN and not
CLOSING, and never in BAY. RESUME is never sent while the truck's zone or the
next zone ahead is not OPEN; such trucks are left held and listed at the end.
Everything received is recorded to OUT.jsonl, with step markers, and the email
is replaced by <email>.
"""
import json, os, socket, ssl, sys, threading, time, uuid

OPERATOR = 'probe'
RUN = uuid.uuid4().hex[:6]
LIVE = '--live' in sys.argv
STEPS = next((a.split('=', 1)[1].split(',') for a in sys.argv if a.startswith('--steps=')), None)

PLAN = [
    ('S1 hold/resume', 'TRAMMING truck in a transit zone: HOLD, time ack and stop; resend the same command_id '
     '(expect original result, no re-execution); reuse the id with a different action (expect COMMAND_ID_REUSED); RESUME.'),
    ('S2 queued hold', 'LOADING truck: HOLD (expect queued until loading ends), then RESUME (expect it to cancel the queued HOLD).'),
    ('S3 exit zone', 'TRAMMING truck mid-zone in a transit zone: EXIT_ZONE; record direction, speed and where it stops; RESUME.'),
    ('S4 lease expiry', 'TRAMMING truck: TAKE_CONTROL; send no drive input; expect deadman true at ~0.5 s; send HOLD while '
     'leased (expect LEASE_HELD); wait for lease EXPIRED at ~10 s; RESUME.'),
    ('S5 drive', 'TRAMMING truck: TAKE_CONTROL; drive throttle +0.3 for 3 s at 10 Hz with sent_ms, then 0 for 1 s; '
     'measure drive-echo latency; RELEASE_CONTROL with a wrong lease_id (expect NOT_LEASE_HOLDER), then the right one; RESUME.'),
    ('S6 estop', 'TRAMMING truck: ESTOP; HOLD (expect ESTOP_ACTIVE); CLEAR_ESTOP; RESUME.'),
    ('S7 rejections', 'UNKNOWN_VEHICLE, MISSING_OPERATOR, UNSUPPORTED_ACTION, missing command_id, and one unparseable line.'),
    ('S8 faulted truck', 'If a truck is in FAULT: HOLD (expect INTERLOCK_ACTIVE). Nothing else.'),
    ('S9 frozen truck', 'Wait up to 240 s for a truck reporting speed > 0.5 with an unchanged position for 8 s; '
     'if found outside BAY, EXIT_ZONE it and record what telemetry and acks say for 40 s; RESUME.'),
    # Re-probe of what S2 never measured, plus the loaded reverse speed. Run with --steps=Q1,Q2,Q3,R1.
    ('Q1 hold behind loading', 'LOADING truck: HOLD; record when loading ends and when it is HOLDING. Then RESUME, confirmed in telemetry.'),
    ('Q2 newer replaces older', 'LOADING truck: HOLD, then EXIT_ZONE; after loading, does it hold in place (HOLD kept) or '
     'leave the zone and hold ~2 m outside (EXIT_ZONE replaced it)? Then RESUME, confirmed.'),
    ('Q3 resume cancels queue', 'LOADING truck: HOLD, then RESUME; after loading, does it drive on (queue cancelled) or hold? '
     'RESUME again if it holds, confirmed.'),
    ('R1 loaded reverse', 'Loaded TRAMMING truck nearer its zone\'s start than its end: EXIT_ZONE; measure reverse speed and '
     'stop point. Then RESUME, confirmed.'),
]
DEFAULT_STEPS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']
SELECTED = [p for p in PLAN if p[0].split()[0] in (STEPS or DEFAULT_STEPS)]

if not LIVE:
    print('DRY RUN: nothing will be sent. Pass --live to run.\n')
    print('operator_id = %r, command_id = "probe-<run>-<n>"\n' % OPERATOR)
    for name, what in SELECTED: print('%-26s %s' % (name, what))
    print('\nExample messages:')
    for ex in ({'type': 'command', 'command_id': 'probe-%s-1' % RUN, 'vehicle_id': 'HT-xx', 'action': 'HOLD', 'operator_id': OPERATOR},
               {'type': 'command', 'command_id': 'probe-%s-9' % RUN, 'vehicle_id': 'HT-xx', 'action': 'TAKE_CONTROL', 'operator_id': OPERATOR},
               {'type': 'drive', 'vehicle_id': 'HT-xx', 'lease_id': '<from ack>', 'seq': 1, 'throttle': 0.3, 'sent_ms': 0}):
        print(' ', json.dumps(ex))
    print('\nCleanup on exit (always): RELEASE_CONTROL held leases, CLEAR_ESTOP, RESUME every truck touched,')
    print('except no RESUME while the truck\'s zone or the next zone ahead is not OPEN (left held and listed).')
    print('Every RESUME is confirmed in telemetry (truck seen moving or back in its duty cycle); one retry')
    print('under a new command_id if not, and anything still unconfirmed is listed at the end.')
    sys.exit(0)

HOST, PORT, EMAIL = os.environ['GATEWAY_HOST'], int(os.environ['GATEWAY_PORT']), os.environ['GATEWAY_EMAIL']
out = open(sys.argv[1], 'w'); out_lock = threading.Lock()

def record(kind, **kw):
    kw.update(kind=kind, rx_ms=int(time.time() * 1000))
    with out_lock: out.write(json.dumps(kw).replace(EMAIL, '<email>') + '\n'); out.flush()

def say(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True); record('note', text=' '.join(str(x) for x in a))

# ---- shared state, updated by the reader thread ----
lock = threading.Lock()
latest = {}        # vehicle -> (rx_ms, telemetry)
history = {}       # vehicle -> [(rx_ms, pos, speed)]
zones = {}         # zone_id -> status
acks = {}          # command_id -> [(arrival time, ack)]
sent_at = {}       # command_id -> time of the latest send
leases = {}        # vehicle -> lease_id we hold
events = []        # lease_event / drive_rejected
route_start = {}
route_kind = {}    # segment_id -> kind, from hello
route_seg_zone = {}
loading_since = {} # vehicle -> local time it was first seen LOADING in this stretch
zone_order = []    # zones in loop order, from hello.route
left_held = []
conn = {'sock': None, 'up': threading.Event()}
inflight = {}      # command_id -> payload, replayed after reconnect

def num(x): return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None
def pos(m):
    try: return route_start[m['segment_id']] + float(m['offset_m'])
    except Exception: return None

def reader():
    ctx = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE')); attempt = 0
    while True:
        attempt += 1
        try:
            s = ctx.wrap_socket(socket.create_connection((HOST, PORT), timeout=10), server_hostname=HOST); s.settimeout(5)
            s.sendall((json.dumps({'type': 'auth', 'email': EMAIL}) + '\n').encode()); record('connected', attempt=attempt)
            buf = b''
            while True:
                try: chunk = s.recv(65536)
                except socket.timeout: continue
                if not chunk: record('closed_by_peer'); break
                buf += chunk
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    try: m = json.loads(line)
                    except Exception: record('unparseable', raw=line.decode('utf-8', 'replace')[:300]); continue
                    record('msg', m=m); handle(m, s)
        except Exception as e:
            record('error', err=repr(e))
        conn['up'].clear(); conn['sock'] = None
        time.sleep(min(2 ** min(attempt, 4), 10))

def handle(m, s):
    t = m.get('type'); now = int(time.time() * 1000)
    with lock:
        if t == 'hello':
            route_start.update({x['segment_id']: x['start_m'] for x in m['route']})
            route_kind.update({x['segment_id']: x['kind'] for x in m['route']})
            route_seg_zone.update({x['segment_id']: x['zone_id'] for x in m['route']})
            zone_order[:] = [z for i, z in enumerate(x['zone_id'] for x in m['route']) if i == 0 or z != m['route'][i - 1]['zone_id']]
            zones.update({z['zone_id']: z['status'] for z in m['zones']})
            conn['sock'] = s; conn['up'].set()
            for cid, payload in list(inflight.items()):   # recover outcomes lost in an outage
                s.sendall((json.dumps(payload) + '\n').encode()); record('replayed', command_id=cid)
        elif t == 'zone_event': zones[m['zone_id']] = m['status']
        elif t == 'telemetry' and isinstance(m.get('vehicle_id'), str):
            # Keep the newest by seq, not by arrival: ~5 % of messages arrive out of order. A large seq
            # drop is a controller restart and is taken as new.
            v, cur = m['vehicle_id'], latest.get(m['vehicle_id'])
            sq, cq = m.get('seq'), cur[1].get('seq') if cur else None
            if cur is None or not isinstance(sq, int) or not isinstance(cq, int) or sq > cq or sq < cq - 200:
                latest[v] = (now, m)
                if st(m) == 'LOADING': loading_since.setdefault(v, now)
                else: loading_since.pop(v, None)
            history.setdefault(m['vehicle_id'], []).append((now, pos(m), num(m.get('speed_mps'))))
            history[m['vehicle_id']] = history[m['vehicle_id']][-80:]
        elif t == 'command_ack':
            acks.setdefault(m['command_id'], []).append((time.time(), m)); inflight.pop(m['command_id'], None)
            if m.get('lease_id') and m.get('status') == 'ACCEPTED': leases[m['vehicle_id']] = m['lease_id']
        elif t in ('lease_event', 'drive_rejected'):
            events.append(m)
            if t == 'lease_event' and m['event'] in ('RELEASED', 'EXPIRED', 'REVOKED'): leases.pop(m['vehicle_id'], None)

def send_raw(text):
    conn['up'].wait(60); conn['sock'].sendall((text + '\n').encode()); record('sent', raw=text[:300])

counter = [0]; touched = set()
def blocked_ahead(v):
    m = latest.get(v, (0, {}))[1]; z = m.get('zone_id')
    if z not in zone_order: return 'unknown zone %r' % z
    nxt = zone_order[(zone_order.index(z) + 1) % len(zone_order)]
    bad = [x for x in (z, nxt) if zones.get(x) != 'OPEN']
    return ', '.join('%s %s' % (x, zones.get(x)) for x in bad) if bad else None

def command(v, action, cid=None, **extra):
    if action == 'RESUME' and v in latest:
        why = blocked_ahead(v)
        if why:
            left_held.append(v); say('NOT resuming', v, 'because', why); return None, time.time()
    counter[0] += 1; cid = cid or 'probe-%s-%d' % (RUN, counter[0])
    payload = dict(type='command', command_id=cid, vehicle_id=v, action=action, operator_id=OPERATOR, **extra)
    if v: touched.add(v)
    with lock: inflight[cid] = payload; sent_at[cid] = time.time()
    send_raw(json.dumps(payload)); say('->', v, action, cid, extra or '')
    return cid, time.time()

def wait_ack(cid, timeout=10):
    """First ack for cid that arrived after its latest send. Acks can be lost, so a resend's
    reply must not be confused with an earlier send's: counting acks per id gets this wrong."""
    end = time.time() + timeout
    while time.time() < end:
        with lock: a = [m for t, m in acks.get(cid, []) if t >= sent_at.get(cid, 0)]
        if a: return a[0]
        time.sleep(0.05)
    return None

def wait_for(v, pred, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        with lock: lm = latest.get(v)
        if lm and pred(lm[1]): return time.time() - t0, lm[1]
        time.sleep(0.05)
    return None, latest.get(v, (0, None))[1]

def summary(m):
    if not m: return None
    return dict(state=m.get('state'), task=m.get('task'), speed=m.get('speed_mps'), dir=m.get('direction'),
                zone=m.get('zone_id'), pos=pos(m), ctrl=m.get('control'), faults=m.get('faults'))

def st(m):
    return str(m.get('state')).upper()

def sane(m):
    return all(num(m.get(f)) is not None for f in ('offset_m', 'speed_mps', 'soc_pct')) and m.get('segment_id') in route_start

def pick(states=('TRAMMING',), kinds_ok=('transit',), mid=False, exclude=()):
    with lock: cands = [(v, m) for v, (rx, m) in latest.items() if time.time() * 1000 - rx < 1500]
    for v, m in sorted(cands):
        if v in exclude or v in touched or m.get('state') not in states or not sane(m) or m.get('faults'): continue
        if m.get('zone_id') == 'BAY' or zones.get(m.get('zone_id')) != 'OPEN': continue
        if mid and not 60 < float(m['offset_m']) < 190: continue
        return v
    return None

def step(name, fn):
    record('step', name=name); say('==', name)
    try: fn()
    except Exception as e: say('step failed:', repr(e))
    time.sleep(2)

def s1():
    v = pick()
    if not v: return say('no candidate')
    cid, t0 = command(v, 'HOLD')
    dt, m = wait_for(v, lambda m: m.get('state') == 'HOLDING', 15); say('HOLDING after (from send)', dt, summary(m))
    a = wait_ack(cid, timeout=max(0.5, 10 - (time.time() - t0))); say('ack', a or 'none received')
    command(v, 'HOLD', cid=cid); say('resend same id ->', wait_ack(cid))
    command(v, 'RESUME', cid=cid); say('same id, other action ->', wait_ack(cid))
    cid2, _ = command(v, 'RESUME'); say('ack', wait_ack(cid2))
    dt, m = wait_for(v, lambda m: m.get('state') == 'TRAMMING' and (num(m.get('speed_mps')) or 0) > 0.5, 15); say('moving after', dt)

def s2():
    v = None; end = time.time() + 120
    while not v and time.time() < end:
        v = pick(states=('LOADING',), kinds_ok=('load',)); time.sleep(0.5)
    if not v: return say('no LOADING truck in 120 s')
    cid, t0 = command(v, 'HOLD'); say('ack', wait_ack(cid))
    time.sleep(3); say('3 s later', summary(latest[v][1]))
    cid2, _ = command(v, 'RESUME'); say('RESUME while queued ->', wait_ack(cid2))
    dt, m = wait_for(v, lambda m: m.get('state') == 'TRAMMING' and (num(m.get('speed_mps')) or 0) > 0.5, 40)
    say('left draw point after', dt, summary(m), '(HOLDING would mean the queue was not cancelled)')
    if m and m.get('state') == 'HOLDING': command(v, 'RESUME')

def s3():
    v = pick(mid=True)
    if not v: return say('no mid-zone candidate')
    z = latest[v][1]['zone_id']; say('start', summary(latest[v][1]))
    cid, _ = command(v, 'EXIT_ZONE'); say('ack', wait_ack(cid))
    t0 = time.time(); last = None
    while time.time() - t0 < 120:
        m = latest[v][1]; k = (m.get('state'), m.get('task'), m.get('direction'), m.get('zone_id'))
        if k != last: say('%+.1fs' % (time.time() - t0), summary(m)); last = k
        if m.get('state') == 'HOLDING' and m.get('zone_id') != z: break
        time.sleep(0.2)
    say('final', summary(latest[v][1])); command(v, 'RESUME')

def s4():
    v = pick()
    if not v: return say('no candidate')
    cid, _ = command(v, 'TAKE_CONTROL'); a = wait_ack(cid); say('ack', a)
    if not a or a.get('status') != 'ACCEPTED': return
    dt, m = wait_for(v, lambda m: (m.get('control') or {}).get('deadman') is True, 5); say('deadman after', dt)
    cid2, _ = command(v, 'HOLD'); say('HOLD while leased ->', wait_ack(cid2))
    t0 = time.time()
    while time.time() - t0 < 15 and v in leases: time.sleep(0.1)
    say('lease gone after %.1fs' % (time.time() - t0), [e for e in events if e.get('vehicle_id') == v][-2:], summary(latest[v][1]))
    command(v, 'RESUME')

def s5():
    v = pick()
    if not v: return say('no candidate')
    cid, _ = command(v, 'TAKE_CONTROL'); a = wait_ack(cid); say('ack', a)
    if not a or a.get('status') != 'ACCEPTED': return
    lease = a['lease_id']; seq = 0; lat = []
    for i in range(40):
        seq += 1; thr = 0.3 if i < 30 else 0.0; sent = int(time.time() * 1000)
        send_raw(json.dumps({'type': 'drive', 'vehicle_id': v, 'lease_id': lease, 'seq': seq, 'throttle': thr, 'sent_ms': sent}))
        c = (latest[v][1].get('control') or {})
        if c.get('last_drive_sent_ms'): lat.append(int(time.time() * 1000) - c['last_drive_sent_ms'])
        time.sleep(0.1)
    lat.sort(); say('echo age ms min/med/max', lat[0] if lat else None, lat[len(lat) // 2] if lat else None, lat[-1] if lat else None, summary(latest[v][1]))
    cid2, _ = command(v, 'RELEASE_CONTROL', lease_id='L-wrong'); say('wrong lease ->', wait_ack(cid2))
    cid3, _ = command(v, 'RELEASE_CONTROL', lease_id=lease); say('release ->', wait_ack(cid3))
    time.sleep(1); command(v, 'RESUME')

def s6():
    v = pick()
    if not v: return say('no candidate')
    cid, t0 = command(v, 'ESTOP'); say('ack', wait_ack(cid))
    dt, m = wait_for(v, lambda m: m.get('state') == 'ESTOPPED', 5); say('ESTOPPED after', dt, summary(m))
    cid2, _ = command(v, 'HOLD'); say('HOLD while estopped ->', wait_ack(cid2))
    cid3, _ = command(v, 'CLEAR_ESTOP'); say('clear ->', wait_ack(cid3))
    dt, m = wait_for(v, lambda m: m.get('state') == 'HOLDING', 10); say('state after clear', summary(m))
    command(v, 'RESUME')

def s7():
    touched.add('HT-01')  # the malformed commands below target HT-01; cleanup resumes it if one is wrongly accepted
    cid, _ = command('HT-99', 'HOLD'); say('unknown vehicle ->', wait_ack(cid))
    cid = 'probe-%s-nooperator' % RUN
    send_raw(json.dumps({'type': 'command', 'command_id': cid, 'vehicle_id': 'HT-01', 'action': 'HOLD'})); say('missing operator ->', wait_ack(cid))
    cid, _ = command('HT-01', 'DANCE'); say('unsupported action ->', wait_ack(cid))
    before = len(acks.get('<missing>', []))
    send_raw(json.dumps({'type': 'command', 'vehicle_id': 'HT-01', 'action': 'HOLD', 'operator_id': OPERATOR}))
    time.sleep(3); say('missing command_id ->', [m for _, m in acks.get('<missing>', [])[before:]])
    before = len(acks.get('<unparseable>', []))
    send_raw('{"type":"command", this is not json'); time.sleep(3); say('unparseable ->', [m for _, m in acks.get('<unparseable>', [])[before:]])

def s8():
    with lock: f = [v for v, (rx, m) in latest.items() if m.get('state') == 'FAULT']
    if not f: return say('no faulted truck right now')
    cid, _ = command(f[0], 'HOLD'); say(f[0], latest[f[0]][1].get('faults'), '->', wait_ack(cid))

def frozen():
    with lock:
        for v, h in history.items():
            recent = [x for x in h if x[0] > time.time() * 1000 - 8000]
            m = latest[v][1]
            if len(recent) > 25 and all(x[1] is not None and abs(x[1] - recent[0][1]) < 0.01 for x in recent) \
               and all((x[2] or 0) > 0.5 for x in recent) and m.get('zone_id') != 'BAY' and not m.get('faults'):
                return v
    return None

def s9():
    end = time.time() + 240; v = None
    while time.time() < end and not v: v = frozen(); time.sleep(1)
    if not v: return say('no frozen truck seen in 240 s')
    say('frozen candidate', v, summary(latest[v][1]))
    cid, _ = command(v, 'EXIT_ZONE'); say('ack', wait_ack(cid))
    t0 = time.time(); last = None
    while time.time() - t0 < 40:
        m = latest[v][1]; k = (m.get('state'), m.get('task'), pos(m))
        if k != last: say('%+.1fs' % (time.time() - t0), summary(m)); last = k
        time.sleep(0.5)
    command(v, 'RESUME')

# ---- re-probe: queuing and loaded reverse ----

def load_zones():
    return {route_seg_zone[s] for s, k in route_kind.items() if k == 'load'}

def zone_after(z):
    return zone_order[(zone_order.index(z) + 1) % len(zone_order)] if z in zone_order else None

def zone_before(z):
    return zone_order[(zone_order.index(z) - 1) % len(zone_order)] if z in zone_order else None

def load_area_open():
    zs = load_zones()
    return bool(zs) and all(zones.get(z) == 'OPEN' and zones.get(zone_after(z)) == 'OPEN' for z in zs)

def pick_loading(timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        if load_area_open():
            with lock:
                c = [(v, m) for v, (rx, m) in latest.items() if time.time() * 1000 - rx < 1500 and st(m) == 'LOADING'
                     and sane(m) and not m.get('faults') and v not in touched and m.get('zone_id') in load_zones()]
            # Prefer one that only just started, so the queued command waits for most of a load.
            c.sort(key=lambda vm: -loading_since.get(vm[0], 0))
            if c: return c[0][0]
        time.sleep(0.25)
    return None

def watch(v, seconds, label):
    """Record every change of state, task, direction or zone for `seconds`; stop early if the load area closes."""
    t0 = time.time(); last = None; trace = []
    while time.time() - t0 < seconds:
        if not load_area_open() and label.startswith('Q'):
            say(label, 'load area no longer OPEN: stopping the watch'); break
        with lock: m = latest[v][1]
        k = (st(m), m.get('task'), m.get('direction'), m.get('zone_id'))
        if k != last:
            trace.append((round(time.time() - t0, 2), k, pos(m))); say('%s %+.2fs' % (label, time.time() - t0), summary(m)); last = k
        time.sleep(0.1)
    return trace

def resume_confirmed(v, label):
    """RESUME, then require telemetry to show the truck moving or back in its duty cycle. One retry under a
    new command_id (an ACCEPTED RESUME has been ignored live); anything still unconfirmed is listed."""
    for attempt in (1, 2):
        cid, t0 = command(v, 'RESUME')
        if cid is None: return False
        a = wait_ack(cid); say(label, 'resume ack', a or 'none received')
        if a and a.get('status') == 'REJECTED' and a.get('reason') == 'INVALID_STATE' and st(latest[v][1]) not in ('HOLDING', 'IDLE'):
            say(label, v, 'not holding, so nothing to resume:', summary(latest[v][1])); return True
        dt, m = wait_for(v, lambda m: (st(m) == 'TRAMMING' and (num(m.get('speed_mps')) or 0) > 0.5) or st(m) in ('LOADING', 'DUMPING', 'CHARGING'), 15)
        if dt is not None:
            say(label, v, 'confirmed moving %.1fs after RESUME (attempt %d)' % (time.time() - t0, attempt)); return True
        say(label, v, 'RESUME not confirmed (attempt %d):' % attempt, summary(m))
    unconfirmed.append(v); return False

def queue_step(label, second=None):
    v = pick_loading()
    if not v: return say(label, 'no LOADING truck with the load area OPEN within 180 s')
    loading_for = time.time() - loading_since.get(v, time.time() * 1000) / 1000
    z = latest[v][1].get('zone_id'); say(label, 'truck', v, 'loading for ~%.1fs' % loading_for, summary(latest[v][1]))
    cid, t0 = command(v, 'HOLD'); say(label, 'HOLD ack', wait_ack(cid))
    if second:
        cid2, _ = command(v, second); say(label, second, 'ack', wait_ack(cid2))
    dt, m = wait_for(v, lambda m: st(m) != 'LOADING', 45)
    say(label, 'loading ended %s after HOLD was sent' % ('%.1fs' % (time.time() - t0) if dt is not None else 'NOT within 45 s'), summary(m))
    trace = watch(v, 25, label)
    final = latest[v][1]
    say(label, 'RESULT', {'truck': v, 'load_zone': z, 'final_state': st(final), 'final_zone': final.get('zone_id'),
                          'final_pos': pos(final), 'trace': trace})
    resume_confirmed(v, label)

def q1(): queue_step('Q1')
def q2(): queue_step('Q2', 'EXIT_ZONE')
def q3(): queue_step('Q3', 'RESUME')

def r1():
    end = time.time() + 240; v = None
    while time.time() < end and not v:
        with lock:
            for cand, (rx, m) in sorted(latest.items()):
                z = m.get('zone_id')
                if cand in touched or st(m) != 'TRAMMING' or not sane(m) or m.get('faults') or (num(m.get('payload_kg')) or 0) <= 0: continue
                if route_kind.get(m.get('segment_id')) != 'transit' or zones.get(z) != 'OPEN' or zones.get(zone_before(z)) != 'OPEN': continue
                segs = [s for s, zz in route_seg_zone.items() if zz == z]
                start = min(route_start[s] for s in segs); p = pos(m)
                if p is None: continue
                if 40 < p - start < 120: v = cand; break
        if not v: time.sleep(0.5)
    if not v: return say('R1 no loaded truck 40-120 m into an OPEN transit zone within 240 s')
    say('R1 truck', v, summary(latest[v][1]))
    cid, t0 = command(v, 'EXIT_ZONE'); say('R1 ack', wait_ack(cid))
    samples = []
    while time.time() - t0 < 90:
        with lock: rx, m = latest[v]
        if m.get('direction') == 'REV' and st(m) == 'TRAMMING' and (num(m.get('speed_mps')) or 0) > 0: samples.append((rx, pos(m), m.get('seq'), num(m.get('speed_mps'))))
        if st(m) == 'HOLDING' and samples: break
        time.sleep(0.1)
    if len(samples) > 10:
        (ra, pa, _, _), (rb, pb, _, _) = samples[0], samples[-1]
        say('R1 RESULT', {'truck': v, 'reversed_m': round(pa - pb, 2), 'seconds': round((rb - ra) / 1000, 2),
                          'reverse_mps': round((pa - pb) / ((rb - ra) / 1000), 3), 'reported_speeds': sorted({x[3] for x in samples}),
                          'stopped_at': summary(latest[v][1])})
    else:
        say('R1 RESULT: not enough reversing telemetry', len(samples), summary(latest[v][1]))
    resume_confirmed(v, 'R1')

unconfirmed = []

def cleanup():
    say('== cleanup', sorted(touched))
    for v in sorted(touched):
        if v not in latest: continue
        if v in leases: command(v, 'RELEASE_CONTROL', lease_id=leases[v]); time.sleep(0.5)
        if st(latest[v][1]) == 'ESTOPPED': command(v, 'CLEAR_ESTOP'); time.sleep(1)
        if st(latest[v][1]) in ('HOLDING', 'IDLE') or latest[v][1].get('task'): resume_confirmed(v, 'cleanup')
    time.sleep(5)
    if left_held: say('LEFT HELD (zone not OPEN; resume by hand after it reopens):', sorted(set(left_held)))
    if unconfirmed: say('RESUME NOT CONFIRMED IN TELEMETRY:', sorted(set(unconfirmed)))
    say('final states', {v: summary(latest[v][1])['state'] for v in sorted(touched) if v in latest})

threading.Thread(target=reader, daemon=True).start()
if not conn['up'].wait(60): sys.exit('no hello within 60 s')
time.sleep(5)  # let telemetry populate
try:
    fns = dict(S1=s1, S2=s2, S3=s3, S4=s4, S5=s5, S6=s6, S7=s7, S8=s8, S9=s9, Q1=q1, Q2=q2, Q3=q3, R1=r1)
    for name, _ in SELECTED: step(name, fns[name.split()[0]])
except KeyboardInterrupt:
    say('interrupted')
finally:
    cleanup(); record('done')
