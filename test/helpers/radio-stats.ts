// The radio and blast statistics of research/README.md ("Radio and blast statistics"), computed from
// a capture in the recorders' format ({kind, rx_ms, m | raw}). TESTING.md L0.C3 runs the same code
// over the live captures (to check it reproduces the table) and over a fake day (to compare), so a
// difference in counting method cannot pass for a difference in the radio.
//
// Shares no code with the product or the fake: it reads raw records only.
import type { FixtureRecord } from './fixtures.ts';

export interface RadioStats {
  durationS: number;
  telemetryHz: number;        // per truck: its telemetry received over its own span (first to last), averaged over trucks
  duplicatePct: number;       // same seq already seen in that controller run, over telemetry received
  reorderedPct: number;       // seq below the highest already seen in that run (not a duplicate), over telemetry received
  lostPct: number;            // seqs never received within each controller run, over the seqs in it; outage seqs in neither
  truncatedPct: number;       // unparseable lines over all lines
  noticesS: number[];         // CLOSING -> effective_at, per closure
  closedForS: number[];       // CLOSED -> OPEN, per closure seen whole
  betweenClosingsS: number[]; // CLOSING -> next CLOSING (any zone), as the table counts them
  cancelled: number;
  linkDropsS: number[];       // heartbeat gaps over 3 s
  maxNormalGapS: number;      // longest gap in one truck's messages, outside outages and silences
}

const LINK_GAP_MS = 3_000;    // research/README.md: link drops are heartbeat gaps over 3 s
const SILENT_GAP_MS = 10_000; // gaps this long are silences, not "normal" gaps (the table excludes silent trucks)
const RESET_DROP = 50;        // a seq drop this large starts a new controller run

export function radioStats(records: FixtureRecord[]): RadioStats {
  const recs = records.filter((r) => typeof r.rx_ms === 'number');
  const t0 = recs[0]!.rx_ms!, tEnd = recs.at(-1)!.rx_ms!;
  const msgs = recs.filter((r) => r.kind === 'msg' && r.m);
  const lines = recs.filter((r) => r.kind === 'msg' || r.kind === 'unparseable');

  // Outages: heartbeat gaps over 3 s, and the time after the last heartbeat if the capture ends down.
  const beats = msgs.filter((r) => r.m!.type === 'heartbeat');
  const outages: Array<[number, number]> = [];
  for (let i = 1; i < beats.length; i++) {
    const a = beats[i - 1]!, b = beats[i]!;
    if (b.rx_ms! - a.rx_ms! > LINK_GAP_MS) outages.push([num(a.m!.server_time_ms) ?? a.rx_ms!, num(b.m!.server_time_ms) ?? b.rx_ms!]);
  }
  const linkDropsS = outages.map(([a, b]) => round1((b - a) / 1000));

  // Telemetry by truck, in arrival order.
  const byTruck = new Map<string, Array<{ rx: number; seq: number; dev: number }>>();
  let telemetry = 0;
  for (const r of msgs) {
    const m = r.m!;
    if (m.type !== 'telemetry' || typeof m.vehicle_id !== 'string') continue;
    telemetry++;
    if (typeof m.seq !== 'number') continue;
    const l = byTruck.get(m.vehicle_id) ?? [];
    l.push({ rx: r.rx_ms!, seq: m.seq, dev: num(m.t_device_ms) ?? NaN });
    byTruck.set(m.vehicle_id, l);
  }

  let dup = 0, reord = 0, lost = 0, expected = 0, maxGap = 0, hzSum = 0;
  for (const l of byTruck.values()) {
    hzSum += l.length / Math.max(1e-9, (l.at(-1)!.rx - l[0]!.rx) / 1000);
    // Controller runs: a large seq drop starts a new one. A message that arrives late from the run
    // before (its seq near that run's highest) still belongs to that run, not to a third one.
    const runs: Array<{ seqs: Map<number, number>; max: number }> = [];
    for (const x of l) {
      let run = runs.findLast((r) => x.seq >= r.max - RESET_DROP && x.seq <= r.max + RESET_DROP);
      if (!run) { run = { seqs: new Map(), max: -Infinity }; runs.push(run); }
      if (run.seqs.has(x.seq)) dup++;
      else if (x.seq < run.max) reord++;
      run.max = Math.max(run.max, x.seq);
      if (!run.seqs.has(x.seq)) run.seqs.set(x.seq, x.rx);
    }
    for (const run of runs) {
      const seqs = [...run.seqs.keys()].sort((a, b) => a - b);
      for (let i = 1; i < seqs.length; i++) {
        const a = seqs[i - 1]!, b = seqs[i]!;
        if (b - a <= 1) continue;
        // The seqs between a and b were sent between their arrivals; a gap that spans an outage is not loss.
        const ra = run.seqs.get(a)!, rb = run.seqs.get(b)!;
        const lo = Math.min(ra, rb), hi = Math.max(ra, rb);
        if (outages.some(([s, e]) => lo < e + 2_000 && hi > s - 2_000)) continue;
        lost += b - a - 1;
      }
      expected += seqs.length > 0 ? seqs.at(-1)! - seqs[0]! + 1 : 0;
    }
    // Normal gaps: between consecutive arrivals, outside outages, shorter than a silence.
    for (let i = 1; i < l.length; i++) {
      const a = l[i - 1]!.rx, b = l[i]!.rx, g = b - a;
      if (g >= SILENT_GAP_MS || outages.some(([s, e]) => a < e + 2_000 && b > s - 2_000)) continue;
      maxGap = Math.max(maxGap, g);
    }
  }

  // Blasts.
  const zoneEvents = msgs.filter((r) => r.m!.type === 'zone_event').map((r) => r.m!);
  const noticesS: number[] = [], closedForS: number[] = [], closings: number[] = [];
  const closedAt = new Map<string, number>();
  let cancelled = 0;
  const seenEvent = new Set<string>();
  for (const z of zoneEvents) {
    const key = `${z.zone_id}|${z.status}|${z.server_time_ms}`;
    if (seenEvent.has(key)) continue; // a hello's replay after reconnect is not a new event
    seenEvent.add(key);
    const at = num(z.server_time_ms)!;
    if (z.status === 'CLOSING') { noticesS.push(round1((num(z.effective_at_ms)! - at) / 1000)); closings.push(at); }
    if (z.status === 'CLOSED') closedAt.set(String(z.zone_id), at);
    if (z.status === 'OPEN') {
      if (z.reason === 'CANCELLED') cancelled++;
      const c = closedAt.get(String(z.zone_id));
      if (c !== undefined) { closedForS.push(Math.round((at - c) / 1000)); closedAt.delete(String(z.zone_id)); }
    }
  }
  const betweenClosingsS = closings.slice(1).map((c, i) => Math.round((c - closings[i]!) / 1000));

  const durationS = (tEnd - t0) / 1000;
  const unparseable = recs.filter((r) => r.kind === 'unparseable').length;
  return {
    durationS: round1(durationS),
    telemetryHz: round2(hzSum / Math.max(1, byTruck.size)),
    duplicatePct: round2((100 * dup) / telemetry),
    reorderedPct: round2((100 * reord) / telemetry),
    lostPct: round2((100 * lost) / Math.max(1, expected)),
    truncatedPct: round2((100 * unparseable) / Math.max(1, lines.length)),
    noticesS, closedForS, betweenClosingsS, cancelled, linkDropsS,
    maxNormalGapS: round2(maxGap / 1000),
  };
}

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
