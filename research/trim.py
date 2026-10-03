"""Cut the failure-case fixtures in research/fixtures/ out of full captures.

Usage:
  python3 research/trim.py RUN2.jsonl RUN3.jsonl PROBE.jsonl OUTDIR [REPROBE.jsonl]

The full captures are 9–25 MB each and are not committed. Each fixture keeps the capture's
record format (kind, rx_ms, m | raw) and starts with one {"kind": "fixture"} line saying what
it shows. Windows are in seconds from the start of the source capture. Auth lines are dropped,
hello.site.name is redacted, and the probe's own printouts ("note" records) are left out.
"""
import json, os, sys

run2, run3, probe, outdir = [[json.loads(l) for l in open(f)] for f in sys.argv[1:4]] + [sys.argv[4]]
reprobe = [json.loads(l) for l in open(sys.argv[5])] if len(sys.argv) > 5 else None

def clean(r):
    r = json.loads(json.dumps(r))
    if r.get('kind') == 'msg' and r['m'].get('type') == 'hello' and 'site' in r['m']: r['m']['site'] = {'name': '<redacted>'}
    return r

def select(rows, a, b, keep):
    t0 = rows[0]['rx_ms']
    for r in rows:
        if a <= (r['rx_ms'] - t0) / 1000 <= b and r['kind'] != 'note' and not (r['kind'] == 'sent' and '"auth"' in r.get('raw', '')) and keep(r):
            yield clean(r)

def is_type(r, *types): return r['kind'] == 'msg' and r['m'].get('type') in types
def truck(r, *vs): return is_type(r, 'telemetry') and r['m'].get('vehicle_id') in vs
def about(r, v):  # commands we sent, and acks/lease events, for one truck
    if r['kind'] == 'sent': return '"%s"' % v in r['raw']
    return is_type(r, 'command_ack', 'lease_event', 'drive_rejected') and r['m'].get('vehicle_id') == v
def link(r): return r['kind'] in ('connected', 'closed_by_peer', 'error') or is_type(r, 'hello', 'zone_event', 'heartbeat')

def first_window(rows, v, state):
    t0 = rows[0]['rx_ms']
    xs = [(r['rx_ms'] - t0) / 1000 for r in rows if truck(r, v) and r['m'].get('state') == state]
    return (xs[0], xs[0] + 20) if xs else (0, 0)

ld = first_window(run3, 'HT-05', 'LOADING')
cases = [
    ('frozen-truck', 'run3', 'HT-10 freezes at about +160 s: every field stays identical while seq and t_device_ms keep '
     'advancing in step with real time; it reports TRAMMING at 2.0 m/s with an unchanged position. For contrast, '
     'HT-05 while LOADING: also identical bodies, but speed 0 in a stationary state.',
     [(run3, 140, 220, lambda r: truck(r, 'HT-10')), (run3, ld[0], ld[1], lambda r: truck(r, 'HT-05'))]),
    ('seq-reset', 'run3', 'HT-01 seq drops from 887 to 1 at about +178 s while t_device_ms carries on.',
     [(run3, 168, 188, lambda r: truck(r, 'HT-01'))]),
    ('silent-truck', 'run3', 'HT-03 sends nothing for 53 s from about +91 s while heartbeats show the link is up.',
     [(run3, 85, 150, lambda r: truck(r, 'HT-03') or is_type(r, 'heartbeat'))]),
    ('truncated-lines', 'run3', 'Every unparseable line in a 15-minute run (87 of 48,597): JSON cut off mid-object, newline-terminated.',
     [(run3, 0, 10 ** 6, lambda r: r['kind'] == 'unparseable')]),
    ('fractional-soc', 'run3', 'HT-12 reports soc_pct as a fraction (0.82 meaning 82%) for the whole run.',
     [(run3, 0, 10, lambda r: truck(r, 'HT-12'))]),
    ('accepted-then-ignored-resume', 'probe', 'HT-02: lease taken and left to expire, then RESUME is ACCEPTED (+233 s) '
     'but the truck stays HOLDING for 70 s; a second RESUME under a new command_id (+303 s) moves it within 1.3 s.',
     [(probe, 215, 306, lambda r: truck(r, 'HT-02') or about(r, 'HT-02'))]),
    ('reverse-exit-zone', 'probe', 'HT-05, empty and 145 m into DECLINE: EXIT_ZONE reverses it at 3.0 m/s up the decline '
     'and holds it 2 m inside BAY, 53 s later. Includes every truck reporting BAY or DECLINE in the window, i.e. what '
     'it was reversing toward.',
     [(probe, 160, 222, lambda r: about(r, 'HT-05') or (is_type(r, 'telemetry') and r['m'].get('zone_id') in ('BAY', 'DECLINE')))]),
    ('two-zones-closing', 'probe', 'hello with DRAW_12 and TIP both CLOSING at once, and the zone events that follow.',
     [(probe, 0, 210, lambda r: is_type(r, 'hello', 'zone_event'))]),
    ('weak-pack', 'run3', 'HT-06 drains about 5x faster than the fleet (43.8 % at the start) and stops with '
     'BATTERY_DEPLETED in the incline at about +508 s. Thinned to keep the file small: HT-06 at 1 Hz '
     '(seq divisible by 5) plus every HT-06 message in FAULT, and every other truck at 0.2 Hz '
     '(seq divisible by 25) as the fleet baseline.',
     [(run3, 0, 540, lambda r: truck(r, 'HT-06') and (r['m'].get('seq', 1) % 5 == 0 or r['m'].get('state') == 'FAULT')),
      (run3, 0, 540, lambda r: is_type(r, 'telemetry') and r['m'].get('vehicle_id') != 'HT-06' and r['m'].get('seq', 1) % 25 == 0)]),
    ('link-drop-in-notice', 'run2', 'DRAW_12 goes CLOSING; 1 s later the link drops for 45 s (logins accepted then closed); '
     'the hello on reconnect still shows DRAW_12 CLOSING with its effective time.',
     [(run2, 370, 420, link)]),
]

if reprobe:
    cases += [
        ('queued-hold-dropped', 'reprobe', 'Q1: HOLD sent to HT-06 0.2 s into loading is ACCEPTED, but when loading ends 20 s later '
         'the truck drives on into the next zone and never holds. One sample: a dropped queued command, or the '
         'accepted-then-ignored fault landing on a queued one.',
         [(reprobe, 14, 60, lambda r: truck(r, 'HT-06') or about(r, 'HT-06'))]),
        ('resume-during-pending-hold', 'reprobe', 'Q3: HOLD to HT-08 in the last second of loading; a RESUME 1 s later is '
         'REJECTED INVALID_STATE, and the HOLD still takes effect ~5.6 s after it was sent. Then a cleanup RESUME gets '
         'no ack and no effect; a second one, under a new command_id, works.',
         [(reprobe, 255, 320, lambda r: truck(r, 'HT-08') or about(r, 'HT-08'))]),
        ('loaded-reverse-into-silence', 'reprobe', 'R1: EXIT_ZONE on loaded HT-04, 47 m into L4_SOUTH. It reverses at 2.0 m/s '
         '(1.99 by its own clock, over 2.4 m), then goes silent for 41 s and reappears HOLDING 2 m outside the zone, '
         '53.8 m back.',
         [(reprobe, 310, 380, lambda r: truck(r, 'HT-04') or about(r, 'HT-04') or is_type(r, 'heartbeat'))]),
    ]

os.makedirs(outdir, exist_ok=True)
for name, source, what, parts in cases:
    # A fixture cut in several parts is written in arrival order, as a replay expects.
    lines = sorted((r for rows, a, b, keep in parts for r in select(rows, a, b, keep)), key=lambda r: r['rx_ms'])
    with open(os.path.join(outdir, name + '.jsonl'), 'w') as f:
        f.write(json.dumps({'kind': 'fixture', 'case': name, 'source': source, 'shows': what}) + '\n')
        for r in lines: f.write(json.dumps(r) + '\n')
    print('%-30s %5d records' % (name, len(lines)))
