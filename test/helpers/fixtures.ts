// Test helpers: read research/fixtures/ and replay them through the fleet state with injected time.
// Fixture records are {kind, rx_ms, m | raw}; the first line describes the fixture.
import { readFileSync } from 'node:fs';
import type { Hello, RouteSegment } from '../../src/protocol.ts';
import { buildSite, type Site } from '../../src/site.ts';

const FIXTURES = new URL('../../research/fixtures/', import.meta.url);

export interface FixtureRecord {
  kind: string;
  rx_ms?: number;
  m?: Record<string, unknown>;
  raw?: string;
  [k: string]: unknown;
}

export function readRecords(path: string | URL): FixtureRecord[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as FixtureRecord);
}

export function fixture(name: string): FixtureRecord[] {
  return readRecords(new URL(`${name}.jsonl`, FIXTURES));
}

// DLH-1's real hello, from the one fixture that carries it.
export function siteHello(): Hello {
  const rec = fixture('two-zones-closing').find((r) => r.kind === 'msg' && r.m?.type === 'hello');
  if (!rec) throw new Error('no hello in two-zones-closing');
  return structuredClone(rec.m) as unknown as Hello;
}

// Most fixtures were cut from the middle of a run and carry no hello. They are replayed after this
// site's hello, re-timed to the fixture's first record, with every zone open: the site is the same,
// only the moment differs.
export function helloAt(serverTimeMs: number): Hello {
  const h = siteHello();
  h.server_time_ms = serverTimeMs;
  h.zones = h.zones.map((z) => ({ ...z, status: 'OPEN', effective_at_ms: null, reason: null }));
  h.leases = [];
  return h;
}

export function thisSite(): Site {
  return buildSite(siteHello()).site;
}

export const seg = (segment_id: string, zone_id: string, start_m: number, length_m: number, kind = 'transit'): RouteSegment =>
  ({ segment_id, zone_id, start_m, length_m, kind });

export function helloFor(route: RouteSegment[], loop: number, vehicles: string[], serverTimeMs = 0): Hello {
  return { type: 'hello', protocol: '3.0', site_id: 'X', server_time_ms: serverTimeMs, vehicles, route, loop_length_m: loop, zones: [], leases: [] };
}

// A deliberately different site: other names and lengths, a 900 m loop, and a zone across the wrap.
export function otherSite(): Site {
  return buildSite(helloFor(otherRoute(), 900, ['A', 'B', 'C'])).site;
}

export function otherRoute(): RouteSegment[] {
  return [
    seg('s1', 'North', 0, 100, 'bay'), seg('s2', 'Ramp', 100, 200), seg('s3', 'Face', 300, 200, 'load'),
    seg('s4', 'Shaft', 500, 350, 'dump'), seg('s5', 'North', 850, 50, 'bay'),
  ];
}
