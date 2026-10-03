// The track diagram's layout (UI.md "Track diagram, not a map"). Pure: it turns hello's route and a
// fleet snapshot into positions in pixels, and the browser only draws what this returns. Runs in Node
// for tests and in the browser as served; no DOM, no clock.
//
// The loop is one straight line, route start on the left, loop end on the right, with both ends
// marked as joined. Like a metro map it is not to scale: a zone too short to read is widened to a
// minimum, and the rest share what is left in proportion to their length. Within a zone, position is
// to scale.
import type { FleetSnapshot, TruckView, ZoneView } from '../fleet.ts';
import type { Range, Site } from '../site.ts';
import { age, countdown, dataState, positionAgeMs } from '../words.ts';

// The site as the browser receives it: plain data, no methods.
export interface SiteData {
  siteId: string;
  loopLengthM: number;
  segments: Array<{ segmentId: string; zoneId: string; kind: string; startM: number; lengthM: number }>;
}

export function siteData(site: Site): SiteData {
  return {
    siteId: site.siteId,
    loopLengthM: site.loopLengthM,
    segments: site.segments.map((s) => ({ segmentId: s.segmentId, zoneId: s.zoneId, kind: s.kind, startM: s.startM, lengthM: s.lengthM })),
  };
}

// ---- scale ----

export interface Stretch {
  zoneId: string | null; // null: a gap in the route, which hello did not describe
  startM: number;
  endM: number;
  x0: number;
  x1: number;
}

export interface Scale {
  width: number;
  stretches: Stretch[];
  x(loopM: number): number;
}

// Consecutive segments of one zone are one stretch. A zone at both ends of the route stays two
// stretches here, because the line is drawn from the route start, not from a zone boundary.
function stretchesOf(site: SiteData): Array<{ zoneId: string | null; startM: number; endM: number }> {
  const segs = [...site.segments].sort((a, b) => a.startM - b.startM);
  const out: Array<{ zoneId: string | null; startM: number; endM: number }> = [];
  let at = 0;
  for (const s of segs) {
    const start = Math.max(at, s.startM);
    const end = Math.min(site.loopLengthM, s.startM + s.lengthM);
    if (end <= start) continue;
    if (start > at + 0.01) out.push({ zoneId: null, startM: at, endM: start });
    const last = out.at(-1);
    if (last && last.zoneId === s.zoneId && Math.abs(last.endM - start) <= 0.01) last.endM = end;
    else out.push({ zoneId: s.zoneId, startM: start, endM: end });
    at = end;
  }
  if (at < site.loopLengthM - 0.01) out.push({ zoneId: null, startM: at, endM: site.loopLengthM });
  return out;
}

export function trackScale(site: SiteData, width: number, minStretchPx: number): Scale {
  const raw = stretchesOf(site);
  const widths = new Array<number>(raw.length).fill(0);
  if (raw.length * minStretchPx >= width) {
    widths.fill(width / raw.length);
  } else {
    // Fix the stretches that would be too narrow at the minimum, share the rest in proportion, and
    // repeat until no proportional stretch falls below the minimum.
    const fixed = new Set<number>();
    for (;;) {
      const freeLen = raw.reduce((a, s, i) => (fixed.has(i) ? a : a + (s.endM - s.startM)), 0);
      const freePx = width - fixed.size * minStretchPx;
      let changed = false;
      raw.forEach((s, i) => {
        if (fixed.has(i)) { widths[i] = minStretchPx; return; }
        widths[i] = freeLen > 0 ? ((s.endM - s.startM) / freeLen) * freePx : 0;
        if (widths[i]! < minStretchPx) { fixed.add(i); changed = true; }
      });
      if (!changed) break;
    }
  }
  let x = 0;
  const stretches = raw.map((s, i) => {
    const out = { ...s, x0: x, x1: x + widths[i]! };
    x = out.x1;
    return out;
  });
  const last = stretches.at(-1);
  if (last) last.x1 = width;
  return {
    width,
    stretches,
    x(loopM: number): number {
      const L = site.loopLengthM;
      if (loopM >= L) return width;
      const m = Math.max(0, loopM);
      const s = stretches.find((t) => m >= t.startM && m < t.endM) ?? stretches.at(-1)!;
      const f = s.endM > s.startM ? (m - s.startM) / (s.endM - s.startM) : 0;
      return s.x0 + f * (s.x1 - s.x0);
    },
  };
}

// ---- ranges and lanes ----

export interface Piece { startM: number; endM: number; wrapsIn: boolean; wrapsOut: boolean }

// A range on the loop as pieces that don't cross the loop end. wrapsOut: it carries on past the right
// end; wrapsIn: it comes in from past the left end.
export function splitRange(loopM: number, r: Range): Piece[] {
  if (r.lengthM >= loopM) return [{ startM: 0, endM: loopM, wrapsIn: true, wrapsOut: true }];
  const start = ((r.startM % loopM) + loopM) % loopM;
  const end = start + r.lengthM;
  if (end <= loopM) return [{ startM: start, endM: end, wrapsIn: false, wrapsOut: false }];
  return [
    { startM: start, endM: loopM, wrapsIn: false, wrapsOut: true },
    { startM: 0, endM: end - loopM, wrapsIn: true, wrapsOut: false },
  ];
}

// Greedy lanes: each item takes the lowest lane where none of its spans comes within `gap` of a span
// already there. Items are placed in the order given.
export function assignLanes(items: Array<{ id: string; spans: Array<[number, number]> }>, gap: number): Map<string, number> {
  const lanes: Array<Array<[number, number]>> = [];
  const out = new Map<string, number>();
  for (const it of items) {
    let lane = lanes.findIndex((taken) => it.spans.every(([a, b]) => taken.every(([c, d]) => b + gap <= c || d + gap <= a)));
    if (lane < 0) { lane = lanes.length; lanes.push([]); }
    lanes[lane]!.push(...it.spans);
    out.set(it.id, lane);
  }
  return out;
}

// ---- the model the browser draws ----

export type BandKind = 'open' | 'closing' | 'closed' | 'unknown';

export interface Band {
  zoneId: string | null;
  x0: number;
  x1: number;
  kind: BandKind;
  status: string; // in words: "open", "CLOSING 1:23", "CLOSED", "status unknown"
  word: string; // the status on its own line: "open", "CLOSING", "CLOSED", "unknown"
  detail: string; // and what goes under it: "1:23", "due 0:12 ago", ""
}

export interface Chip {
  vehicleId: string;
  kind: 'live' | 'old';
  x: number; // where the truck is
  boxX: number; // where its chip is centred: x, pulled in from the ends so the chip stays on the diagram
  lane: number;
  width: number;
  lines: string[]; // the id, then badges in words
  fault: boolean;
}

export interface RangeMark {
  key: string;
  vehicleIds: string[];
  kind: 'silent' | 'contradicted' | 'unknown';
  pieces: Array<{ x0: number; x1: number; wrapsIn: boolean; wrapsOut: boolean }>;
  anchorX: number | null; // where it was last believably seen
  label: string;
  labelX: number;
  lane: number;
  fault: boolean;
}

export interface TrackModel {
  width: number;
  bands: Band[];
  chips: Chip[];
  ranges: RangeMark[];
  chipLanes: number;
  rangeLanes: number;
}

// Text is measured by character count: a fixed advance per character at the diagram's font size,
// generous so labels never collide.
export const CHAR_PX = 8;
const CHIP_PAD_PX = 16;
const LANE_GAP_PX = 6;
export const MIN_STRETCH_PX = 96;

export function zoneStatusWords(z: ZoneView | undefined): { kind: BandKind; status: string; word: string; detail: string } {
  const w = (kind: BandKind, word: string, detail = '') => ({ kind, word, detail, status: detail ? `${word}${detail.startsWith('due') ? ', ' : ' '}${detail}` : word });
  switch (z?.status ?? null) {
    case 'OPEN': return w('open', 'open');
    case 'CLOSED': return w('closed', 'CLOSED');
    case 'CLOSING': {
      const left = z!.msUntilEffective;
      if (left === null) return w('closing', 'CLOSING');
      if (left < 0) return w('closing', 'CLOSING', `due ${countdown(-left)} ago`);
      return w('closing', 'CLOSING', countdown(left));
    }
    default: return w('unknown', 'status unknown');
  }
}

export function chipBadges(t: TruckView): string[] {
  const out: string[] = [];
  if (t.confidence === 'old') out.push(`old ${age(positionAgeMs(t) ?? 0)}`);
  if ((t.faults?.value.length ?? 0) > 0) out.push('⚠ fault');
  const s = t.state?.value;
  if (s && s !== 'TRAMMING' && s !== 'FAULT') out.push(s === 'ESTOPPED' ? 'e-stopped' : s.toLowerCase());
  if (t.direction?.value === 'REV' && (t.speedMps?.value ?? 0) > 0) out.push('◀ reversing');
  const holder = t.control?.value.operatorId;
  if (holder) out.push(`◆ ${holder}`);
  return out;
}

export function trackModel(site: SiteData, snap: FleetSnapshot, width: number): TrackModel {
  const scale = trackScale(site, width, MIN_STRETCH_PX);
  const L = site.loopLengthM;
  const zones = new Map(snap.zones.map((z) => [z.zoneId, z]));
  const bands: Band[] = scale.stretches.map((s) => {
    const w = s.zoneId === null ? { kind: 'unknown' as const, status: 'not in route', word: 'not in route', detail: '' } : zoneStatusWords(zones.get(s.zoneId));
    return { zoneId: s.zoneId, x0: s.x0, x1: s.x1, ...w };
  });

  const chips: Array<Omit<Chip, 'lane'>> = [];
  const ranges: Array<Omit<RangeMark, 'lane'>> = [];
  const never: TruckView[] = [];
  for (const t of snap.trucks) {
    const faulty = (t.faults?.value.length ?? 0) > 0;
    if ((t.confidence === 'live' || t.confidence === 'old') && t.position) {
      const lines = [t.vehicleId];
      const badges = chipBadges(t);
      if (badges.length) lines.push(badges.join(' · '));
      const w = Math.max(...lines.map((l) => l.length)) * CHAR_PX + CHIP_PAD_PX;
      const x = scale.x(t.position.value.loopM);
      const boxX = Math.max(w / 2, Math.min(width - w / 2, x));
      chips.push({ vehicleId: t.vehicleId, kind: t.confidence, x, boxX, width: w, lines, fault: faulty });
      continue;
    }
    if (t.confidence === 'unknown' && t.ageMs === null) { never.push(t); continue; }
    const kind = t.confidence === 'contradicted' ? 'contradicted' : t.confidence === 'silent' ? 'silent' : 'unknown';
    const range = t.range ?? { startM: 0, lengthM: L };
    let words: string;
    if (kind === 'contradicted') {
      const since = t.anchor ? snap.atServerMs - t.anchor.atServerMs : null;
      words = since === null ? 'data frozen' : `data frozen, last moved ${age(since)} ago`;
    } else words = dataState(t);
    const extra = chipBadges(t).filter((b) => !b.startsWith('old'));
    ranges.push(rangeMark(t.vehicleId, [t.vehicleId], kind, range, t.anchor?.loopM ?? null, [t.vehicleId, words, ...extra].join(' · '), faulty));
  }
  if (never.length) {
    const ids = never.map((t) => t.vehicleId);
    ranges.push(rangeMark('never', ids, 'unknown', { startM: 0, lengthM: L }, null, `Never reported (${ids.length}), could be anywhere: ${ids.join(', ')}`, false));
  }

  function rangeMark(key: string, ids: string[], kind: RangeMark['kind'], r: Range, anchorM: number | null, label: string, fault: boolean): Omit<RangeMark, 'lane'> {
    const pieces = splitRange(L, r).map((p) => ({ x0: scale.x(p.startM), x1: scale.x(p.endM), wrapsIn: p.wrapsIn, wrapsOut: p.wrapsOut }));
    const labelW = label.length * CHAR_PX;
    const labelX = Math.max(0, Math.min(pieces[0]!.x0, width - labelW));
    return { key, vehicleIds: ids, kind, pieces, anchorX: anchorM === null ? null : scale.x(anchorM), label, labelX, fault };
  }

  // Chips are placed left to right; ranges with the narrowest first, so the whole-loop bars sit
  // below the precise ones.
  chips.sort((a, b) => a.boxX - b.boxX);
  const chipLanes = assignLanes(chips.map((c) => ({ id: c.vehicleId, spans: [[c.boxX - c.width / 2, c.boxX + c.width / 2]] })), LANE_GAP_PX);
  const span = (r: Omit<RangeMark, 'lane'>) => r.pieces.reduce((a, p) => a + p.x1 - p.x0, 0);
  ranges.sort((a, b) => span(a) - span(b));
  const rangeLanes = assignLanes(ranges.map((r) => ({
    id: r.key,
    spans: [...r.pieces.map((p): [number, number] => [p.x0, p.x1]), [r.labelX, r.labelX + r.label.length * CHAR_PX]],
  })), LANE_GAP_PX);
  const placedChips = chips.map((c) => ({ ...c, lane: chipLanes.get(c.vehicleId)! }));
  const placedRanges = ranges.map((r) => ({ ...r, lane: rangeLanes.get(r.key)! }));
  return {
    width, bands, chips: placedChips, ranges: placedRanges,
    chipLanes: Math.max(0, ...placedChips.map((c) => c.lane + 1)),
    rangeLanes: Math.max(0, ...placedRanges.map((r) => r.lane + 1)),
  };
}
