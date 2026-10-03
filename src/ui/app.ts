/// <reference lib="dom" />
// The Overview in the browser: draws what src/ui/track.ts and src/ui/overview.ts compute from each
// frame, and nothing else. All decisions about words, order and shape live in those pure modules.
//
// Frames come from the fixture player now (player/server.ts) and from the service later, over the
// same shape: { player?, site, snapshot }. The browser keeps its own clock only to notice frames have
// stopped, so a stopped feed never looks current (UI.md principle 2).
import { SystemClock } from '../clock.ts';
import type { FleetSnapshot } from '../fleet.ts';
import { clearanceRows, fleetRows, serviceLink, siteLink, type LinkView } from './overview.ts';
import { trackModel, type SiteData, type TrackModel } from './track.ts';

interface PlayerState {
  fixture: string; shows: string; source: string; startMs: number; endMs: number; offsetMs: number;
  playing: boolean; speed: number; atEnd: boolean; heartbeatsRecorded: boolean; helloFrom: string;
  bookmarks: Array<{ offsetMs: number; text: string }>;
}
interface Frame { player?: PlayerState; site: SiteData | null; snapshot: FleetSnapshot }

const SERVICE_STALE_MS = 3_000; // the player sends a frame at least every second
const SPEEDS = [0.5, 1, 2, 5, 10, 30];
const clock = new SystemClock();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';

let frame: Frame | null = null;
let lastFrameAt: number | null = null;

// ---- small DOM helpers ----

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null) e.append(k);
  return e;
}

function svg(tag: string, attrs: Record<string, string | number> = {}, ...kids: Array<Node | string>): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
}

const clock2 = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---- links and banners ----

function setLink(id: string, v: LinkView): void {
  const e = $(id);
  e.dataset.state = v.state;
  e.textContent = v.text;
}

function renderLinks(): void {
  const since = lastFrameAt === null ? null : clock.now() - lastFrameAt;
  const service = serviceLink(since, SERVICE_STALE_MS);
  setLink('service-link', service);
  const site = frame ? siteLink(frame.snapshot, frame.player?.heartbeatsRecorded ?? true) : { state: 'down' as const, text: 'Site link: no data' };
  setLink('site-link', site);
  const aged = service.state === 'down' || site.state === 'down';
  document.body.classList.toggle('aged', aged);
  const banners: HTMLElement[] = [];
  if (service.state === 'down') banners.push(el('div', { class: 'banner down' }, `${service.text}. The picture below is not current.`));
  if (site.state === 'down') banners.push(el('div', { class: 'banner down' }, `${site.text}. Everything below is at least that old; ages keep counting.`));
  const p = frame?.player;
  if (p && !p.playing && service.state !== 'down') {
    banners.push(el('div', { class: 'banner note' }, p.atEnd ? 'End of the recording. Fixture time has stopped: ages are not counting.' : 'Paused. Fixture time has stopped: ages are not counting.'));
  }
  $('banners').replaceChildren(...banners);
}

// ---- zone clearance ----

function renderClearance(snap: FleetSnapshot): void {
  const rows = clearanceRows(snap);
  if (rows.length === 0) {
    $('clearance').replaceChildren(el('p', { class: 'none' }, 'No zone is closing or closed.'));
    return;
  }
  $('clearance').replaceChildren(...rows.map((r) => el('div', { class: 'zrow', 'data-zone': r.zoneId, 'data-verdict': r.verdict },
    el('div', { class: `verdict ${r.verdict}` }, r.verdictWords),
    el('div', {}, el('div', { class: 'zname' }, r.zoneId), el('div', { class: `zwhen ${r.status === 'CLOSED' ? 'closed' : ''}` }, r.when)),
    el('div', {},
      r.action ? el('div', { class: 'action' }, `${r.action}.`) : el('div', { class: 'action' }, 'No truck might be inside.'),
      r.reasons.length ? el('ul', { class: 'reasons' }, ...r.reasons.map((x) => el('li', {}, x))) : null),
  )));
}

// ---- track ----

const HEADER_H = 64;
const CHIP_LANE_H = 46;
const CHIP_H = 38;
const RANGE_LANE_H = 36;
const LINE_GAP = 22;
const chipX = new Map<string, number>();

function defs(): SVGElement {
  const hatch = (id: string, color: string, cross: boolean) => svg('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    svg('rect', { width: 8, height: 8, fill: '#0e1114' }),
    svg('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: color, 'stroke-width': 3 }),
    ...(cross ? [svg('line', { x1: 0, y1: 4, x2: 8, y2: 4, stroke: color, 'stroke-width': 2 })] : []));
  return svg('defs', {},
    hatch('silent-hatch', '#9aa1a8', false),
    hatch('frozen-hatch', '#b06cbd', true),
    hatch('closed-hatch', '#6a2a24', false),
    svg('pattern', { id: 'unknown-dots', width: 6, height: 6, patternUnits: 'userSpaceOnUse' },
      svg('rect', { width: 6, height: 6, fill: '#14181c' }), svg('circle', { cx: 3, cy: 3, r: 1, fill: '#4a535c' })));
}

function renderTrack(site: SiteData, snap: FleetSnapshot): void {
  const host = $('track');
  const width = Math.max(600, host.clientWidth);
  const m: TrackModel = trackModel(site, snap, width);
  const chipTop = HEADER_H;
  const lineY = chipTop + Math.max(1, m.chipLanes) * CHIP_LANE_H + LINE_GAP / 2;
  const rangeTop = lineY + LINE_GAP;
  const height = rangeTop + Math.max(1, m.rangeLanes) * RANGE_LANE_H + 8;

  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Track diagram' }, defs());
  m.bands.forEach((b, i) => {
    const g = svg('g', { class: `band ${b.kind}${i % 2 ? ' alt' : ''}`, 'data-zone': b.zoneId ?? '' },
      svg('rect', { class: 'bg', x: b.x0, y: 0, width: b.x1 - b.x0, height }),
      svg('rect', { class: 'edge', x: b.x0 + 1, y: 1, width: Math.max(0, b.x1 - b.x0 - 2), height: height - 2 }),
      svg('text', { x: b.x0 + 8, y: 18 }, b.zoneId ?? '(gap in route)'),
      svg('text', { class: 'status', x: b.x0 + 8, y: 37 }, b.word),
      svg('text', { class: 'status', x: b.x0 + 8, y: 55 }, b.detail));
    root.append(g);
  });
  root.append(svg('line', { class: 'trackline', x1: 3, y1: lineY, x2: width - 3, y2: lineY }));
  root.append(svg('text', { class: 'ends', x: 4, y: lineY + 17 }, '↻ joins the right end'));
  root.append(svg('text', { class: 'ends', x: width - 4, y: lineY + 17, 'text-anchor': 'end' }, 'joins the left end ↻'));

  for (const r of m.ranges) {
    const y = rangeTop + r.lane * RANGE_LANE_H;
    const g = svg('g', { class: `range ${r.kind}`, 'data-trucks': r.vehicleIds.join(' '), 'data-kind': r.kind });
    g.append(svg('text', { x: r.labelX, y: y + 12 }, r.label));
    for (const p of r.pieces) {
      g.append(svg('rect', { class: 'bar', x: p.x0, y: y + 17, width: Math.max(2, p.x1 - p.x0), height: 13 }));
      if (p.wrapsOut) g.append(svg('path', { class: 'wrap', d: `M${p.x1 - 2},${y + 15} l6,8 l-6,8` }));
      if (p.wrapsIn) g.append(svg('path', { class: 'wrap', d: `M${p.x0 + 2},${y + 15} l-6,8 l6,8` }));
    }
    if (r.anchorX !== null) g.append(svg('circle', { class: 'anchor', cx: r.anchorX, cy: y + 23.5, r: 5 }, svg('title', {}, 'last believable position')));
    root.append(g);
  }

  // Higher lanes first, so a chip near the line is drawn over the connectors of chips stacked above it.
  const seen = new Set<string>();
  for (const c of [...m.chips].sort((a, b) => b.lane - a.lane)) {
    seen.add(c.vehicleId);
    const y = lineY - LINE_GAP / 2 - (c.lane + 1) * CHIP_LANE_H + (CHIP_LANE_H - CHIP_H);
    const prev = chipX.get(c.vehicleId);
    const jump = prev !== undefined && Math.abs(prev - c.boxX) > width / 2; // wrapped round the loop
    chipX.set(c.vehicleId, c.boxX);
    const g = svg('g', { class: `chip ${c.kind}${c.fault ? ' fault' : ''}${jump ? ' jump' : ''}`, 'data-truck': c.vehicleId, 'data-kind': c.kind, style: `transform: translate(${c.boxX}px, 0px)` },
      svg('line', { x1: 0, y1: y + CHIP_H, x2: c.x - c.boxX, y2: lineY }),
      svg('rect', { x: -c.width / 2, y, width: c.width, height: CHIP_H }),
      svg('text', { x: 0, y: y + (c.lines.length > 1 ? 16 : 24) }, c.lines[0]!),
      ...(c.lines[1] ? [svg('text', { class: 'badge', x: 0, y: y + 31 }, c.lines[1])] : []));
    root.append(g);
  }
  for (const id of [...chipX.keys()]) if (!seen.has(id)) chipX.delete(id);

  // Chips keep their element between frames so they glide; everything else is redrawn.
  const old = host.querySelector('svg');
  if (old) {
    for (const g of root.querySelectorAll<SVGGElement>('g.chip')) {
      const before = old.querySelector<SVGGElement>(`g.chip[data-truck="${g.dataset.truck}"]`);
      if (before && !g.classList.contains('jump')) {
        before.setAttribute('class', g.getAttribute('class')!);
        before.replaceChildren(...g.childNodes);
        before.style.transform = g.style.transform;
        g.replaceWith(before);
      }
    }
  }
  host.replaceChildren(root);
}

// ---- fleet table ----

function renderRows(snap: FleetSnapshot): void {
  $('rows').replaceChildren(...fleetRows(snap).map((r) => el('tr', { class: r.dataKind, 'data-truck': r.vehicleId, 'data-kind': r.dataKind },
    el('td', { class: 'id' }, r.vehicleId),
    el('td', { class: 'data' }, r.data),
    el('td', { class: 'why' }, r.attention ?? ''),
    el('td', {}, r.state, r.fault ? el('span', { class: 'fault' }, r.fault) : null),
    el('td', {}, r.zone, r.zoneAlert ? el('br') : null, r.zoneAlert ? el('span', { class: 'zalert' }, r.zoneAlert) : null),
    el('td', {}, r.soc, ...r.socFlags.map((f) => el('span', { class: 'flag' }, f))),
    el('td', {}, r.control),
    el('td', { class: 'cmd', title: 'The command registry is not built yet' }, r.lastCommand),
  )));
}

// ---- player controls ----

async function control(body: Record<string, unknown>): Promise<void> {
  await fetch('/api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function renderPlayer(p: PlayerState | undefined): void {
  const box = $('player');
  box.hidden = !p;
  if (!p) return;
  $('mode').textContent = `REPLAY · ${p.fixture}`;
  const fx = $<HTMLSelectElement>('fixture');
  if (fx.value !== p.fixture) fx.value = p.fixture;
  $('play').textContent = p.playing ? '⏸ Pause' : '▶ Play';
  $<HTMLSelectElement>('speed').value = String(p.speed);
  const seek = $<HTMLInputElement>('seek');
  seek.max = String(p.endMs - p.startMs);
  if (document.activeElement !== seek) seek.value = String(p.offsetMs);
  $('pos').textContent = `+${clock2(p.offsetMs)} / ${clock2(p.endMs - p.startMs)}`;
  const marks = $<HTMLSelectElement>('marks');
  const key = `${p.fixture}:${p.bookmarks.length}`;
  if (marks.dataset.key !== key) {
    marks.dataset.key = key;
    marks.replaceChildren(el('option', { value: '' }, 'Jump to…'), ...p.bookmarks.map((b) => el('option', { value: String(b.offsetMs) }, `+${clock2(b.offsetMs)} ${b.text}`)));
  }
  $('shows').textContent = `${p.shows}${p.helloFrom === 'fixture' ? '' : ' (No hello in this recording: replayed on this site\'s route, every zone open at the start.)'}`;
}

async function setupPlayer(): Promise<void> {
  const list = await (await fetch('/api/fixtures')).json() as Array<{ name: string }>;
  $('fixture').replaceChildren(...list.map((f) => el('option', { value: f.name }, f.name)));
  $('speed').replaceChildren(...SPEEDS.map((s) => el('option', { value: String(s) }, `${s}×`)));
  $('fixture').addEventListener('change', (e) => void control({ op: 'load', fixture: (e.target as HTMLSelectElement).value }));
  $('restart').addEventListener('click', () => void control({ op: 'seek', offsetMs: 0 }));
  $('play').addEventListener('click', () => void control({ op: frame?.player?.playing ? 'pause' : 'play' }));
  $('step1').addEventListener('click', () => void control({ op: 'step', ms: 1_000 }));
  $('step5').addEventListener('click', () => void control({ op: 'step', ms: 5_000 }));
  $('next').addEventListener('click', () => void control({ op: 'next' }));
  $('speed').addEventListener('change', (e) => void control({ op: 'speed', speed: Number((e.target as HTMLSelectElement).value) }));
  $('seek').addEventListener('change', (e) => void control({ op: 'seek', offsetMs: Number((e.target as HTMLInputElement).value) }));
  $('marks').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v !== '') void control({ op: 'seek', offsetMs: Number(v) });
  });
  // ?fixture=name&t=ms opens a recording at a moment, paused: for links and screenshots.
  const q = new URLSearchParams(location.search);
  if (q.get('fixture')) await control({ op: 'load', fixture: q.get('fixture') });
  if (q.get('t')) await control({ op: 'seek', offsetMs: Number(q.get('t')) });
}

// ---- sound ----

function setupSound(): void {
  const b = $('sound');
  b.addEventListener('click', () => {
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    void new Ctx().resume().then(() => { b.dataset.armed = 'true'; b.textContent = 'Sound armed'; });
  });
}

// ---- main ----

function render(): void {
  renderLinks();
  if (!frame) return;
  renderPlayer(frame.player);
  $('site-id').textContent = frame.snapshot.siteId ?? 'no site yet';
  renderClearance(frame.snapshot);
  if (frame.site) renderTrack(frame.site, frame.snapshot);
  else $('track').replaceChildren(el('p', { class: 'none' }, 'No route yet: waiting for the site description (hello).'));
  renderRows(frame.snapshot);
}

function connect(): void {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    frame = JSON.parse(e.data as string) as Frame;
    lastFrameAt = clock.now();
    render();
  };
}

const watch = () => { renderLinks(); clock.setTimeout(watch, 500); };

setupSound();
void setupPlayer().then(connect);
watch();
let resizeTimer: ReturnType<typeof clock.setTimeout> | null = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clock.clearTimeout(resizeTimer);
  resizeTimer = clock.setTimeout(render, 100);
});
document.body.dataset.ready = 'true';
