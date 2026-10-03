// TESTING.md L0.S: the fake serves other sites, a different route, zone names and loop length, 7 and
// 20 trucks, a 60 s notice, and BAY closing, with the live catalogue of faults running on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import type { GatewayMessage, Hello, Telemetry, ZoneEvent } from '../src/protocol.ts';
import { buildSite } from '../src/site.ts';
import { LIVE_DAY } from '../fake/faults.ts';
import { FakeGateway } from '../fake/gateway.ts';
import { siteVariant } from '../fake/sites.ts';

const T0 = 1_790_000_000_000;

function day(trucks: number, minutes: number, extra: { bayClosing?: boolean; seed?: number } = {}) {
  const site = siteVariant({ trucks, noticeMs: 60_000 });
  const clock = new ManualClock(T0);
  const gw = new FakeGateway(clock, { seed: extra.seed ?? 3, site, blasts: 'random', faults: { ...LIVE_DAY, bayClosing: extra.bayClosing ?? false } });
  gw.start();
  // A client that reconnects after link drops, so it sees the whole day.
  const msgs: GatewayMessage[] = [];
  const connect = () => {
    const c = gw.connect();
    c.onMessage((m) => msgs.push(m));
    c.send({ type: 'auth', email: 'variant@example.com' });
    const poll = () => { if (c.closed) clock.setTimeout(connect, 2_000); else clock.setTimeout(poll, 1_000); };
    poll();
  };
  connect();
  clock.advance(minutes * 60_000);
  gw.stop();
  return { site, gw, msgs };
}

for (const trucks of [7, 20]) {
  test(`L0.S a different site with ${trucks} trucks and a 60 s notice, under a live day`, () => {
    const { site, gw, msgs } = day(trucks, 15);
    const hellos = msgs.filter((m): m is Hello => m.type === 'hello');
    assert.ok(hellos.length >= 2, 'reconnected after the link drops');
    const hello = hellos[0]!;
    assert.equal(hello.vehicles.length, trucks);
    assert.equal(hello.loop_length_m, 1250);
    assert.deepEqual([...new Set(hello.route.map((r) => r.zone_id))], ['HAUL_ROAD', 'CRUSHER', 'RETURN_DRIFT', 'WORKSHOP', 'RAMP', 'STOPE_7', 'HAUL_ROAD_B']);
    const { site: built, issues } = buildSite(hello);
    assert.deepEqual(issues, []);

    // Every truck reports, on segments of this route only, and moves through the duty cycle.
    const tel = msgs.filter((m): m is Telemetry => m.type === 'telemetry');
    const segs = new Set(site.route.map((r) => r.segment_id));
    for (const v of site.vehicles) assert.ok(tel.some((t) => t.vehicle_id === v), v);
    assert.ok(tel.every((t) => segs.has(t.segment_id)));
    const states = new Set(tel.map((t) => String(t.state).toUpperCase()));
    for (const s of ['TRAMMING', 'LOADING', 'DUMPING']) assert.ok(states.has(s), s);

    // Blasts: the site's notice, closures, reopening.
    const zones = msgs.filter((m): m is ZoneEvent => m.type === 'zone_event');
    const closing = zones.filter((z) => z.status === 'CLOSING');
    assert.ok(closing.length >= 2);
    for (const z of closing) assert.equal(z.effective_at_ms! - z.server_time_ms, 60_000);
    assert.ok(zones.some((z) => z.status === 'CLOSED'));

    // The live catalogue ran here too: every class in the truth log.
    for (const f of ['frozen_moving', 'silent', 'seq_reset', 'fractional_soc', 'malformed', 'clock_skew', 'weak_pack', 'lost', 'duplicate', 'late', 'truncated', 'link_drop'] as const) {
      assert.ok(gw.truthLog.entries({ fault: f }).length > 0, `${f} on the ${trucks}-truck site`);
    }
    // The weak pack dies loaded in the climb from the face to the crusher, wherever that is.
    const weak = gw.truthLog.entries({ fault: 'weak_pack' })[0]!;
    const dead = gw.truthLog.entries({ fault: 'fault', vehicle: weak.vehicle! }).find((e) => e.detail.code === 'BATTERY_DEPLETED');
    assert.ok(dead, 'the weak pack died');
    assert.equal(built.zoneAt(dead!.detail.positionM as number)?.zoneId, 'HAUL_ROAD');
  });
}

test('L0.S BAY closing on another site: the bay zone (WORKSHOP) is blasted like any other', () => {
  const { msgs, gw } = day(7, 60, { bayClosing: true, seed: 5 });
  const bay = msgs.filter((m): m is ZoneEvent => m.type === 'zone_event' && m.zone_id === 'WORKSHOP');
  assert.ok(bay.some((z) => z.status === 'CLOSING'));
  assert.ok(gw.truthLog.entries({ fault: 'bay_closing' }).every((e) => e.detail.zoneId === 'WORKSHOP'));
});
