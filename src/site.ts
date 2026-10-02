// The site as hello describes it (CLAUDE.md invariant 7): route, zones, loop length and vehicles.
// Nothing here knows this particular mine. A route that doesn't add up is reported in `issues`
// rather than silently trusted; a hello with no usable route is refused.
import type { Hello, RouteSegment } from './protocol.ts';

const EPS_M = 0.01;

export interface Range {
  startM: number;
  lengthM: number; // startM + lengthM may pass the loop end, meaning the range wraps
}

export interface Segment {
  segmentId: string;
  zoneId: string;
  kind: string;
  startM: number;
  lengthM: number;
}

export interface Zone {
  zoneId: string;
  ranges: Range[];
  lengthM: number;
  segmentIds: string[];
  kinds: string[];
}

export interface Site {
  readonly siteId: string;
  readonly loopLengthM: number;
  readonly segments: readonly Segment[];
  readonly zones: readonly Zone[]; // in the order they first appear along the route
  readonly vehicles: readonly string[];
  segment(segmentId: string): Segment | undefined;
  zone(zoneId: string): Zone | undefined;
  toLoop(segmentId: string, offsetM: number): number | undefined;
  zoneAt(positionM: number): Zone | undefined;
  bayZones(): Zone[];
}

export class SiteError extends Error {}

export function buildSite(hello: Hello): { site: Site; issues: string[] } {
  const loop = hello.loop_length_m;
  if (!Array.isArray(hello.route) || hello.route.length === 0) throw new SiteError('hello has no route');
  if (!(loop > 0)) throw new SiteError(`hello has no usable loop length (${loop})`);

  const issues: string[] = [];
  const segments = [...hello.route].sort((a, b) => a.start_m - b.start_m).map(toSegment);

  const seen = new Set<string>();
  for (const s of segments) {
    if (seen.has(s.segmentId)) issues.push(`duplicate segment id ${s.segmentId}`);
    seen.add(s.segmentId);
  }
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!, cur = segments[i]!;
    const prevEnd = prev.startM + prev.lengthM;
    if (cur.startM > prevEnd + EPS_M) issues.push(`gap of ${round(cur.startM - prevEnd)} m between ${prev.segmentId} and ${cur.segmentId}`);
    if (cur.startM < prevEnd - EPS_M) issues.push(`${prev.segmentId} and ${cur.segmentId} overlap by ${round(prevEnd - cur.startM)} m`);
  }
  const covered = segments.reduce((sum, s) => sum + s.lengthM, 0);
  if (Math.abs(covered - loop) > EPS_M) issues.push(`route covers ${round(covered)} m of a ${round(loop)} m loop`);

  const zones = buildZones(segments, loop);
  for (const z of zones) {
    if (z.ranges.length > 1) issues.push(`zone ${z.zoneId} is in ${z.ranges.length} separate stretches`);
  }

  const bySegment = new Map(segments.map((s) => [s.segmentId, s]));
  const byZone = new Map(zones.map((z) => [z.zoneId, z]));
  const norm = (p: number) => ((p % loop) + loop) % loop;

  const site: Site = {
    siteId: hello.site_id,
    loopLengthM: loop,
    segments,
    zones,
    vehicles: [...hello.vehicles],
    segment: (id) => bySegment.get(id),
    zone: (id) => byZone.get(id),
    toLoop(segmentId, offsetM) {
      const s = bySegment.get(segmentId);
      return s && Number.isFinite(offsetM) ? s.startM + offsetM : undefined;
    },
    zoneAt(positionM) {
      if (!Number.isFinite(positionM)) return undefined;
      const p = norm(positionM);
      const s = segments.find((x) => p >= x.startM - EPS_M / 2 && p < x.startM + x.lengthM);
      return s && byZone.get(s.zoneId);
    },
    bayZones: () => zones.filter((z) => z.kinds.includes('bay')),
  };
  return { site, issues };
}

function toSegment(r: RouteSegment): Segment {
  return { segmentId: r.segment_id, zoneId: r.zone_id, kind: r.kind, startM: r.start_m, lengthM: r.length_m };
}

// Consecutive segments of one zone make a range; a zone at both ends of the route is one range
// across the wrap.
function buildZones(segments: Segment[], loop: number): Zone[] {
  const runs: Array<{ zoneId: string; range: Range }> = [];
  for (const s of segments) {
    const last = runs.at(-1);
    if (last && last.zoneId === s.zoneId && Math.abs(last.range.startM + last.range.lengthM - s.startM) <= EPS_M) {
      last.range.lengthM += s.lengthM;
    } else {
      runs.push({ zoneId: s.zoneId, range: { startM: s.startM, lengthM: s.lengthM } });
    }
  }
  const first = runs[0], last = runs.at(-1);
  if (first && last && runs.length > 1 && first.zoneId === last.zoneId &&
      Math.abs(first.range.startM) <= EPS_M && Math.abs(last.range.startM + last.range.lengthM - loop) <= EPS_M) {
    last.range.lengthM += first.range.lengthM;
    runs.shift();
  }

  const order: string[] = [];
  for (const s of segments) if (!order.includes(s.zoneId)) order.push(s.zoneId);
  return order.map((zoneId) => {
    const mine = segments.filter((s) => s.zoneId === zoneId);
    const ranges = runs.filter((r) => r.zoneId === zoneId).map((r) => r.range).sort((a, b) => a.startM - b.startM);
    return {
      zoneId,
      ranges,
      lengthM: ranges.reduce((sum, r) => sum + r.lengthM, 0),
      segmentIds: mine.map((s) => s.segmentId),
      kinds: [...new Set(mine.map((s) => s.kind))],
    };
  });
}

const round = (x: number) => Math.round(x * 100) / 100;
