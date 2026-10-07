/// <reference lib="dom" />
// The Overview in the browser: draws what src/ui/track.ts and src/ui/overview.ts compute from each
// frame, and nothing else. All decisions about words, order and shape live in those pure modules.
//
// Frames come from the fixture player (player/server.ts, over server-sent events) or from the live
// service (src/live.ts, over a WebSocket), in the same shape: { player?, live?, site, snapshot }. The
// page is in live mode when the service marks it so (<body data-mode="live">). The browser keeps its
// own clock only to notice frames have stopped, so a stopped feed never looks current (UI.md
// principle 2).
//
// In live mode the browser sends commands (the e-stop for now) over the same WebSocket. It never
// names the operator: the service takes that from the session. It never queues a command it could not
// send: with the service disconnected it says so, and nothing is sent later.
import { HOLD_THE_SHOT } from '../clearance.ts';
import { SystemClock, type TimerHandle } from '../clock.ts';
import { age, elapsed } from '../words.ts';
import { PARAMS } from '../params.ts';
import type { FleetSnapshot } from '../fleet.ts';
import type { AlarmItem } from '../attention.ts';
import type { CommandView, LiveState, Notice, TruckDetail } from '../live.ts';
import type { AuditLine } from './audit.ts';
import { buttons, timelineEntry, truckFacts, type Button } from './detail.ts';
import { DRIVE_KEYS, drivePanel, holderWords, lostWords, THROTTLE_STEPS, throttleFor, type Meter } from './drive.ts';
import { CallMemory, clearanceRows, fleetRows, serviceLink, siteLink, type ClearanceRow, type LinkView } from './overview.ts';
import { tonePattern, toSound, trayModel, type TrayEntry } from './tray.ts';
import { trackModel, type SiteData, type TrackModel } from './track.ts';

interface PlayerState {
  fixture: string; shows: string; source: string; startMs: number; endMs: number; offsetMs: number;
  playing: boolean; speed: number; atEnd: boolean; heartbeatsRecorded: boolean; helloFrom: string;
  bookmarks: Array<{ offsetMs: number; text: string }>;
}
interface Frame { player?: PlayerState; live?: LiveState; site: SiteData | null; snapshot: FleetSnapshot }
interface You { id: string; name: string; role: string }

const SERVICE_STALE_MS = PARAMS.browserStaleAfter.value; // both the player and the service send a frame at least every second
const RECONNECT_MS = 2_000;
const LIVE = document.body.dataset.mode === 'live';
const SPEEDS = [0.5, 1, 2, 5, 10, 30];
const clock = new SystemClock();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';

let frame: Frame | null = null;
let lastFrameAt: number | null = null;
let socket: WebSocket | null = null; // live mode: open, or null
let you: You | null = null;
let notices: Notice[] = [];
let detail: TruckDetail | null = null; // the open truck's timeline and notes, from the service
let openTruck: string | null = null;    // the truck whose detail is open
let lastClearance: { rows: ClearanceRow[]; at: number } | null = null; // the last panel the service sent
const calls = new CallMemory();          // the fixture player's own last calls (live mode: the service's)

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
  const service = serviceLink(since, SERVICE_STALE_MS, !LIVE || socket !== null);
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
  const live = frame?.live;
  if (live && !live.blastSafety.active) banners.push(el('div', { class: 'banner warn' }, live.blastSafety.note));
  $('banners').replaceChildren(...banners);
  if (LIVE) renderEstops();
}

// ---- zone clearance ----

function serviceDown(): boolean {
  const since = lastFrameAt === null ? null : clock.now() - lastFrameAt;
  return serviceLink(since, SERVICE_STALE_MS, !LIVE || socket !== null).state === 'down';
}

// Live: the service's panel, which already says UNSURE while the site link is down. If the service
// itself has gone, this screen can't say anything is clear either: every row turns UNSURE here, with
// the service's last call beneath it and its age (UI.md; BLAST.md B13). The player keeps its own
// last calls.
function clearanceNow(snap: FleetSnapshot): ClearanceRow[] {
  const live = frame?.live;
  if (!live) return clearanceRows(snap, { linkDown: siteLink(snap, frame?.player?.heartbeatsRecorded ?? true).state === 'down', memory: calls });
  if (!serviceDown()) {
    lastClearance = { rows: live.clearance, at: clock.now() };
    return live.clearance;
  }
  const since = lastClearance ? clock.now() - lastClearance.at : 0;
  return (lastClearance?.rows ?? live.clearance).map((r) => ({
    ...r, verdict: 'UNSURE', verdictWords: 'UNSURE', action: HOLD_THE_SHOT, linkDown: true,
    reasons: ['Service disconnected: this screen is receiving nothing, so it cannot say whether a truck has gone in.', ...r.reasons.filter((x) => !x.startsWith('Site link down'))],
    was: r.was ? { verdictWords: r.was.verdictWords, agoMs: r.was.agoMs + since } : { verdictWords: r.verdictWords, agoMs: since },
  }));
}

function renderClearance(snap: FleetSnapshot): void {
  const rows = clearanceNow(snap);
  if (rows.length === 0) {
    $('clearance').replaceChildren(el('p', { class: 'none' }, 'No zone is closing or closed.'));
    return;
  }
  $('clearance').replaceChildren(...rows.map((r) => el('div', { class: 'zrow', 'data-zone': r.zoneId, 'data-verdict': r.verdict },
    el('div', {}, el('div', { class: `verdict ${r.verdict}` }, r.verdictWords),
      r.was ? el('div', { class: 'was' }, `was ${r.was.verdictWords}, ${age(r.was.agoMs)} ago`) : null),
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

function lastCommands(live: LiveState | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of live?.commands ?? []) { // newest first
    if (!out.has(c.vehicleId)) out.set(c.vehicleId, `${c.action} by ${c.by}: ${c.summary}`);
  }
  return out;
}

function renderRows(snap: FleetSnapshot): void {
  const live = frame?.live;
  const restarts = new Map(Object.entries(live?.restarts ?? {}));
  const heldWords = (id: string): string | null => {
    const h = live?.held[id];
    if (!h) return null;
    return h.by ? `held by ${h.by === you?.id ? 'you: Resume in its detail' : h.by}` : 'held (by whom not known)';
  };
  const rows = fleetRows(snap, lastCommands(live), restarts);
  // While the pointer is over the table or a row has keyboard focus, the order is frozen: a table
  // that re-sorts under the pointer sends a click to another truck. Contents still update.
  if (frozenOrder) {
    const at = (id: string) => { const i = frozenOrder!.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    rows.sort((a, b) => at(a.vehicleId) - at(b.vehicleId));
    for (const r of rows) if (!frozenOrder.includes(r.vehicleId)) frozenOrder.push(r.vehicleId);
  }
  $('order-paused').hidden = frozenOrder === null;
  const body = $('rows');
  const have = new Map([...body.querySelectorAll<HTMLTableRowElement>(':scope > tr')].map((tr) => [tr.dataset.truck!, tr]));
  const trs = rows.map((r) => {
    // Rows keep their element between frames, so focus and hover stay on the same truck.
    let tr = have.get(r.vehicleId);
    if (!tr) tr = el('tr', { 'data-truck': r.vehicleId, tabindex: '0', title: `Open ${r.vehicleId}` });
    tr.className = `${r.dataKind}${r.vehicleId === openTruck ? ' open' : ''}`;
    tr.dataset.kind = r.dataKind;
    patchCells(tr, rowCells(r, heldWords));
    return tr;
  });
  if (trs.length !== body.children.length || trs.some((tr, i) => body.children[i] !== tr)) {
    const focused = document.activeElement;
    body.replaceChildren(...trs);
    if (focused instanceof HTMLElement && body.contains(focused) && document.activeElement !== focused) focused.focus();
  }
  // Frozen rows keep their height too, so contents that grow can't push the row under the pointer
  // down. What no longer fits is cut short, marked, and in full in the truck's detail.
  if (frozenOrder) for (const tr of trs) tr.classList.toggle('clipped', [...tr.querySelectorAll<HTMLElement>('.cell')].some((c) => c.scrollHeight > c.clientHeight + 1));
}

let frozenOrder: string[] | null = null;
const FROZEN_CELL_PADDING = 15; // a cell's vertical padding and border (overview.css: td padding 7px)

function setupRowFreeze(): void {
  const table = $('rows').closest('table')!;
  const body = $('rows');
  const freeze = () => {
    if (frozenOrder) return;
    const trs = [...body.querySelectorAll<HTMLElement>(':scope > tr')];
    frozenOrder = trs.map((tr) => tr.dataset.truck!);
    for (const tr of trs) {
      const h = tr.getBoundingClientRect().height;
      tr.style.height = `${h}px`;
      tr.style.setProperty('--h', `${Math.max(0, h - FROZEN_CELL_PADDING)}px`);
    }
    body.classList.add('frozen');
    $('order-paused').hidden = false;
  };
  const thaw = () => {
    if (table.matches(':hover') || table.contains(document.activeElement)) return;
    frozenOrder = null;
    body.classList.remove('frozen');
    for (const tr of body.querySelectorAll<HTMLElement>(':scope > tr')) { tr.style.removeProperty('height'); tr.style.removeProperty('--h'); tr.classList.remove('clipped'); }
    if (frame) renderRows(frame.snapshot);
  };
  table.addEventListener('pointerenter', freeze);
  table.addEventListener('pointerleave', () => clock.setTimeout(thaw, 0));
  table.addEventListener('focusin', freeze);
  table.addEventListener('focusout', () => clock.setTimeout(thaw, 0));
}

// A row's cells stay the same elements from frame to frame; only a cell whose contents changed is
// redrawn. Replacing the cells on every frame (4 a second) lost clicks: when a cell is swapped between
// the press and the release, Chrome delivers no click at all, so an operator's click on a truck could
// silently do nothing.
function patchCells(tr: HTMLTableRowElement, cells: HTMLElement[]): void {
  if (tr.children.length !== cells.length) { tr.replaceChildren(...cells); return; }
  cells.forEach((fresh, i) => {
    const td = tr.children[i] as HTMLElement;
    if (td.className !== fresh.className) td.className = fresh.className;
    if (td.innerHTML === fresh.innerHTML) return;
    // The cell's own box (div.cell) stays too, which is what a click usually lands on; only what is
    // inside it is swapped.
    const box = td.firstElementChild as HTMLElement | null, freshBox = fresh.firstElementChild as HTMLElement | null;
    if (td.childElementCount === 1 && box && freshBox && box.tagName === freshBox.tagName) {
      if (box.className !== freshBox.className) box.className = freshBox.className;
      box.replaceChildren(...freshBox.childNodes);
    } else td.replaceChildren(...fresh.childNodes);
  });
}

function rowCells(r: ReturnType<typeof fleetRows>[number], heldWords: (id: string) => string | null): HTMLElement[] {
  const td = (attrs: Record<string, string>, ...kids: Array<Node | string | null>) => el('td', attrs, el('div', { class: 'cell' }, ...kids));
  return [
    td({ class: 'id' }, r.vehicleId),
    td({ class: 'data' }, r.data, r.restarted ? el('span', { class: 'restart', title: 'Controller restarted: its data is being used again; no action needed' }, `↻ ${r.restarted}`) : null),
    td({ class: 'why' }, r.attention ?? ''),
    td({}, r.state, r.fault ? el('span', { class: 'fault' }, r.fault) : null),
    td({}, r.zone, r.zoneAlert ? el('br') : null, r.zoneAlert ? el('span', { class: 'zalert' }, r.zoneAlert) : null),
    td({}, r.soc, ...r.socFlags.map((f) => el('span', { class: 'flag' }, f))),
    td({}, r.control, heldWords(r.vehicleId) ? el('span', { class: 'held' }, heldWords(r.vehicleId)!) : null),
    td({ class: 'cmd' }, r.lastCommand),
  ];
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

// Browsers block sound until the page is clicked, so "Sound off" shows until the operator arms it
// (UI.md). Interrupts only, a short tone pattern each, never continuous.
let audio: AudioContext | null = null;
const heard = new Map<string, number>(); // alertSeq heard per alarm key on this screen
let missed = 0;                          // interrupts that alerted while sound was off

function setupSound(): void {
  const b = $('sound');
  b.addEventListener('click', () => {
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) { b.textContent = 'Sound unavailable in this browser'; return; }
    const ctx = audio ?? new Ctx();
    void ctx.resume().then(() => {
      audio = ctx;
      missed = 0;
      b.dataset.armed = 'true';
      b.dataset.missed = 'false';
      b.textContent = 'Sound armed';
      play([{ hz: 660, ms: 80 }]); // a quiet click of confirmation
    });
  });
}

function play(pattern: Array<{ hz: number; ms: number }>): void {
  if (!audio || audio.state !== 'running') return;
  let t = audio.currentTime + 0.02;
  for (const n of pattern) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = n.hz;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + n.ms / 1000);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + n.ms / 1000 + 0.02);
    t += n.ms / 1000 + 0.06;
  }
}

// One pattern per frame at most, the most urgent first: several alarms at once are still one short
// sound, never a run of them.
function soundFor(items: AlarmItem[]): void {
  const due = toSound(items, you?.id ?? null, heard);
  if (due.length === 0) return;
  document.body.dataset.alerted = String(Number(document.body.dataset.alerted ?? '0') + due.length); // for tests
  const first = due.find((i) => i.source === 'blast') ?? due.find((i) => i.source === 'link') ?? due[0]!;
  if (audio && audio.state === 'running') { play(tonePattern(first)); return; }
  missed += due.length;
  const b = $('sound');
  b.dataset.missed = 'true';
  b.textContent = `Sound off: ${missed} alarm${missed > 1 ? 's' : ''} not heard. Click to arm`;
}

// ---- live mode ----

function connectLive(): void {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
  ws.onopen = () => { socket = ws; };
  ws.onmessage = (e) => {
    let m: { type?: string; [k: string]: unknown };
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.type === 'frame') {
      const body = m.body as { frame: Frame };
      frame = body.frame;
      you = m.you as You;
      notices = (m.notices as Notice[]) ?? [];
      detail = (m.detail as TruckDetail | null) ?? null;
      lastFrameAt = clock.now();
      if (openTruck && $('detail').hidden) openDetail(openTruck); // opened from the address (#truck=...)
      render();
    } else if (m.type === 'result') {
      onResult(m as unknown as Result);
    }
  };
  ws.onclose = (e) => {
    if (socket === ws) socket = null;
    renderLinks();
    if (e.code === 4401) { location.href = '/login'; return; } // the session ended
    clock.setTimeout(() => void reconnect(), RECONNECT_MS);
  };
}

// Before reconnecting, ask whether the session is still there; if not, back to the login page.
async function reconnect(): Promise<void> {
  try {
    const r = await fetch('/api/session', { cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; return; }
  } catch { /* the service is down: try the socket anyway, and again later */ }
  connectLive();
}

interface Result { type: 'result'; ref: string | null; ok: boolean; error?: string; command?: CommandView; drive?: { code: string | null; reason: string | null }; history?: { lines: AuditLine[]; truncated: boolean; atServerMs: number } }
const asked = new Map<string, string>(); // ref -> truck, for e-stops sent and not yet answered
let refN = 0;

const handlers = new Map<string, (m: Result) => void>(); // ref -> what to do with its result

function onResult(m: Result): void {
  const h = m.ref ? handlers.get(m.ref) : undefined;
  if (h) { handlers.delete(m.ref!); h(m); return; }
  if (m.drive) { lastDriveReply = { text: m.error ?? m.drive.reason ?? 'refused', at: clock.now() }; renderDrive(); return; }
  const truck = m.ref ? asked.get(m.ref) : undefined;
  if (m.ref) asked.delete(m.ref);
  if (!m.ok && truck) estopNote(`E-stop ${truck} NOT sent: ${m.error ?? m.command?.summary ?? 'refused'}`, true);
  else if (truck) estopNote(`E-stop ${truck}: ${m.command?.summary ?? 'sent'}`, false);
  else if (!m.ok) estopNote(m.error ?? m.command?.summary ?? 'refused', true);
  renderEstops();
}

function estopNote(text: string, bad: boolean): void {
  const n = $('estop-note');
  n.textContent = text;
  n.classList.toggle('bad', bad);
}

function send(msg: Record<string, unknown>): string | null {
  if (!socket || socket.readyState !== WebSocket.OPEN) return null;
  const ref = `b${++refN}`;
  socket.send(JSON.stringify({ ...msg, ref }));
  return ref;
}

function estop(truck: string): void {
  const ref = send({ type: 'command', action: 'ESTOP', vehicleId: truck });
  if (ref === null) {
    // Never queued: a stop sent later, unseen, is a different decision (L7.8).
    estopNote(`E-stop ${truck} NOT sent: the service is disconnected. Use the radio.`, true);
    return;
  }
  asked.set(ref, truck);
  estopNote(`E-stop ${truck}: sending…`, false);
}

// The e-stop state of one truck, in a word: our open command first, then the truck's own report.
// "stopped" only when the truck itself says ESTOPPED.
function estopWord(truck: string, live: LiveState, snap: FleetSnapshot): { word: string; kind: string } {
  const t = snap.trucks.find((x) => x.vehicleId === truck);
  const c = live.commands.find((x) => x.vehicleId === truck && x.action === 'ESTOP');
  if (c?.needsReconfirm) return { word: 'NOT sent', kind: 'reconfirm' };
  if (c?.waitingForLink) return { word: 'pending', kind: 'pending' };
  if (c && c.open) return { word: 'sent', kind: 'sent' };
  if (c && (c.status === 'failed' || c.status === 'expired')) return { word: 'NOT done', kind: 'failed' };
  if (t?.state?.value === 'ESTOPPED') return { word: 'stopped', kind: 'stopped' };
  return { word: 'STOP', kind: 'ready' };
}

function renderEstops(): void {
  const live = frame?.live;
  const snap = frame?.snapshot;
  const box = $('estop-trucks');
  if (!live || !snap) return;
  const ids = snap.trucks.filter((t) => t.onRoster !== false).map((t) => t.vehicleId);
  // Buttons keep their element between frames, so a press is never lost to a redraw.
  const have = new Map([...box.querySelectorAll<HTMLButtonElement>('button')].map((b) => [b.dataset.truck!, b]));
  const buttons = ids.map((id) => {
    let b = have.get(id);
    if (!b) {
      b = el('button', { type: 'button', class: 'estop-truck', 'data-truck': id }, el('b', {}, id), el('span', {}, 'STOP'));
      b.addEventListener('click', () => estop(id));
    }
    const s = estopWord(id, live, snap);
    b.dataset.kind = s.kind;
    b.lastElementChild!.textContent = s.word;
    b.setAttribute('aria-label', `E-stop ${id}: ${s.word}`);
    return b;
  });
  if (buttons.length !== box.children.length || buttons.some((b, i) => box.children[i] !== b)) box.replaceChildren(...buttons);

  // E-stops waiting for the link, needing confirmation again, or not done: each says so, with what to do.
  const list = $('estop-pending');
  const waiting = live.commands.filter((c) => c.action === 'ESTOP' && (c.waitingForLink || (!c.open && (c.status === 'failed' || c.status === 'expired'))));
  const rows = new Map([...list.querySelectorAll<HTMLElement>('.estop-row')].map((r) => [r.dataset.id!, r]));
  const out = waiting.map((c) => {
    let r = rows.get(c.id);
    if (!r) {
      r = el('div', { class: 'banner down estop-row', 'data-id': c.id, 'data-truck': c.vehicleId }, el('span', { class: 'text' }));
      if (c.waitingForLink) {
        const again = el('button', { type: 'button', class: 'again' }, 'Confirm e-stop again');
        again.addEventListener('click', () => { if (send({ type: 'reconfirm', recordId: c.id }) === null) estopNote('NOT sent: the service is disconnected.', true); });
        const cancel = el('button', { type: 'button', class: 'cancel' }, 'Cancel');
        cancel.addEventListener('click', () => { if (send({ type: 'cancel', recordId: c.id }) === null) estopNote('NOT cancelled: the service is disconnected.', true); });
        r.append(again, cancel);
      }
    }
    r.dataset.kind = c.needsReconfirm ? 'reconfirm' : c.waitingForLink ? 'pending' : 'failed';
    r.querySelector<HTMLElement>('.text')!.textContent = `E-stop ${c.vehicleId} (pressed by ${c.by}): ${c.summary}`;
    const again = r.querySelector<HTMLButtonElement>('button.again');
    if (again) again.hidden = !c.needsReconfirm;
    const cancel = r.querySelector<HTMLButtonElement>('button.cancel');
    if (cancel) cancel.hidden = !c.waitingForLink;
    return r;
  });
  if (out.length !== list.children.length || out.some((r, i) => list.children[i] !== r)) list.replaceChildren(...out);
  list.hidden = out.length === 0;
}

function renderLive(live: LiveState, snap: FleetSnapshot): void {
  $('you').textContent = you ? `${you.name} (${you.role})` : '';
  const who = live.who.map((w) => {
    const holds = live.leases.filter((l) => l.operatorId === w.id).map((l) => l.vehicleId);
    return el('span', { class: `person ${w.role}`, 'data-user': w.id },
      `${w.name} · ${w.role}${w.screens > 1 ? ` · ${w.screens} screens` : ''}${holds.length ? ` · has control of ${holds.join(', ')}` : ''}`);
  });
  // Leases held by someone with no screen open here: another client of the site, or a closed browser.
  const away = live.leases.filter((l) => !live.who.some((w) => w.id === l.operatorId))
    .map((l) => el('span', { class: 'person away', 'data-user': l.operatorId }, `${l.operatorId} · no screen open here · has control of ${l.vehicleId}`));
  $('who').replaceChildren(el('b', {}, 'On: '), ...who, ...away);

  renderTray(live, snap);
  renderDetail();
  renderEstops();
}

// ---- the attention tray ----

function renderTray(live: LiveState, snap: FleetSnapshot): void {
  const tray = trayModel(live.attention, you?.id ?? null, snap.atServerMs);
  soundFor(live.attention);
  $('tray-count').textContent = tray.needAck ? `${tray.needAck} to acknowledge` : 'nothing to acknowledge';
  $('tray').dataset.needAck = String(tray.needAck);
  $('tray-interrupts').replaceChildren(...(tray.interrupts.length ? tray.interrupts.map(trayItem) : [el('p', { class: 'none' }, 'Nothing needs you now.')]));
  const now = snap.atServerMs;
  $('tray-notices').replaceChildren(...notices.slice(0, 5).map((n) => el('div', { class: 'item notice' },
    el('span', { class: 'ago' }, `${elapsed(Math.max(0, now - n.atServerMs))} ago`), `For you: ${n.message}`)));
  $('tray-silent-count').textContent = `${tray.silent.length} shown, no sound`;
  $('tray-silent').replaceChildren(...tray.silent.map(trayItem));
}

function trayItem(e: TrayEntry): HTMLElement {
  const box = el('div', { class: `item ${e.interrupt ? 'interrupt' : 'silent'}`, 'data-key': e.key, 'data-state': e.state, ...(e.vehicleId ? { 'data-truck': e.vehicleId } : {}) },
    el('div', { class: 'msg' }, e.message),
    e.action ? el('div', { class: 'act' }, `${e.action}.`) : null,
    el('div', { class: 'meta' }, el('span', { class: 'ago' }, e.when), e.status ? ` · ${e.status}` : ''),
    el('div', { class: 'rule' }, `Rule: ${e.rule}`));
  const tools = el('div', { class: 'tools' });
  if (e.interrupt && e.state !== 'acknowledged') {
    const b = el('button', { type: 'button', class: 'ack' }, you ? `Acknowledge as ${you.name}` : 'Acknowledge');
    b.addEventListener('click', () => ask({ type: 'ack', key: e.key }, (m) => { if (!m.ok) b.textContent = m.error ?? 'Not acknowledged'; }));
    tools.append(b);
  }
  if (e.vehicleId) {
    const o = el('button', { type: 'button', class: 'open' }, `Open ${e.vehicleId}`);
    o.addEventListener('click', () => openDetail(e.vehicleId!));
    tools.append(o);
  }
  if (tools.childElementCount) box.append(tools);
  return box;
}

// Sends a request and runs `then` with its answer. False when the service is not connected.
function ask(msg: Record<string, unknown>, then: (m: Result) => void): boolean {
  const ref = send(msg);
  if (ref === null) { then({ type: 'result', ref: null, ok: false, error: 'NOT sent: the service is disconnected.' }); return false; }
  handlers.set(ref, then);
  return true;
}

// ---- truck detail (UI.md screen 2) ----

function openDetail(id: string): void {
  if (!LIVE) return;
  openTruck = id;
  detail = null;
  $('detail-result').textContent = '';
  $('detail').hidden = false;
  document.body.classList.add('drawer-open');
  if (location.hash !== `#truck=${id}`) history.replaceState(null, '', `#truck=${id}`);
  ask({ type: 'watch', vehicleId: id }, () => undefined);
  renderDetail();
  // Focus goes to the drawer, which names the truck: and off the row, so a mouse click does not
  // keep the table's order frozen after the pointer leaves.
  $('detail-title').focus({ preventScroll: true });
  if (frame) renderRows(frame.snapshot);
}

function closeDetail(): void {
  openTruck = null;
  updateDriving();
  renderDrive();
  detail = null;
  $('detail').hidden = true;
  document.body.classList.remove('drawer-open');
  if (location.hash.startsWith('#truck=')) history.replaceState(null, '', location.pathname);
  send({ type: 'watch', vehicleId: null });
  if (frame) renderRows(frame.snapshot);
}

const buttonEls = new Map<string, HTMLButtonElement>(); // kept between frames so a press is never lost to a redraw

function renderDetail(): void {
  updateDriving();
  renderDrive();
  const id = openTruck;
  const live = frame?.live;
  if (!id || !live || !frame) return;
  const snap = frame.snapshot;
  const t = snap.trucks.find((x) => x.vehicleId === id);
  $('detail-title').textContent = id;
  if (!t) { $('detail-summary').textContent = 'Not on this site.'; return; }
  const held = live.held[id] ?? null;
  const me = you?.id ?? null;
  const row = fleetRows({ ...snap, trucks: [t] }, new Map(), new Map(Object.entries(live.restarts)))[0]!;
  $('detail-summary').replaceChildren(
    el('span', { class: `chipword ${t.confidence}` }, row.data), ' ',
    el('b', {}, row.state), ` · ${row.zone} · ${row.soc}`,
    ...(row.attention ? [el('div', { class: 'why' }, row.attention)] : []));

  // L7.9: after a hand-back the next step is obvious: held by you, Resume.
  const callout = $('detail-callout');
  const c = t.control?.value;
  if (held && held.by && held.by === me) callout.replaceChildren(el('div', { class: 'callout held' }, `Held by you: you ${held.how}. It will not move until someone resumes it.`, resumeButton(id)));
  else if (driveTruck === id) callout.replaceChildren();
  else if (lostWords(live.leaseEnds[id], me, timeOf) && !(c?.mode === 'MANUAL' && c.operatorId === me)) callout.replaceChildren(el('div', { class: 'callout lost' }, lostWords(live.leaseEnds[id], me, timeOf)!));
  else if (c?.mode === 'MANUAL' && c.operatorId === me) callout.replaceChildren(el('div', { class: 'callout mine' }, 'You have control, but this service has no lease for you yet. Press Take control again to drive.'));
  else if (c?.mode === 'MANUAL' && c.operatorId) callout.replaceChildren(el('div', { class: 'callout other' }, holderWords(c.operatorId, id)));
  else if (held) callout.replaceChildren(el('div', { class: 'callout' }, `Holding: ${held.by ? `${held.by} ${held.how}` : held.how}.`));
  else callout.replaceChildren();

  const bs = buttons(t, you, held);
  const wanted = bs.map((b) => {
    const key = `${id}:${b.action}:${b.force ? 'f' : ''}`;
    let e = buttonEls.get(key);
    if (!e) {
      e = el('button', { type: 'button', 'data-action': b.action, ...(b.force ? { 'data-force': 'true' } : {}) });
      const btn = b;
      e.addEventListener('click', () => command(id, btn));
      buttonEls.set(key, e);
    }
    e.textContent = `${b.label} · ${id}`; // the truck in every button: a wrong drawer shows before anything is sent
    e.className = `cmd${b.primary ? ' primary' : ''}`;
    e.disabled = b.disabled !== undefined;
    e.title = b.disabled ?? b.note ?? '';
    return e;
  });
  const box = $('detail-buttons');
  const notes = bs.filter((b) => b.disabled).map((b) => el('p', { class: 'disabled-why' }, `${b.label}: ${b.disabled}`));
  if (wanted.length !== box.querySelectorAll('button').length || wanted.some((w, i) => box.querySelectorAll('button')[i] !== w)) box.replaceChildren(...wanted, ...notes);
  else { box.querySelectorAll('p').forEach((p) => p.remove()); box.append(...notes); }

  const d = detail && detail.vehicleId === id ? detail : null;
  $('detail-timeline').replaceChildren(...(d === null ? [el('li', { class: 'none' }, 'Loading…')]
    : d.commands.length === 0 ? [el('li', { class: 'none' }, 'No commands to this truck since the service started.')]
      : d.commands.map((r) => {
        const e = timelineEntry(r, t);
        return el('li', { class: `cmdrow ${e.outcome.replace(/[^a-z]+/g, '-')}`, 'data-id': e.id, 'data-outcome': e.outcome },
          el('div', { class: 'head' }, e.headline),
          e.detail && e.outcome !== 'done' ? el('div', { class: 'detail' }, e.detail) : null,
          el('ol', { class: 'steps' }, ...e.steps.filter((st) => st.kind !== 'end' || e.outcome === 'done').map((st) => el('li', { class: st.kind }, el('span', { class: 'at' }, st.atServerMs === null ? '—' : timeOf(st.atServerMs)), st.words))));
      })));
  $('detail-facts').replaceChildren(...truckFacts(t, snap, d?.note, held, me).flatMap((f) => [el('dt', {}, f.label), el('dd', f.flag ? { class: 'flag' } : {}, f.value)]));
}

function resumeButton(id: string): HTMLButtonElement {
  const b = el('button', { type: 'button', class: 'cmd primary resume-now' }, `Resume · ${id}`);
  b.addEventListener('click', () => command(id, { action: 'RESUME', label: 'Resume' }));
  return b;
}

// A command names an action and a truck; who sent it comes from the session (L8.3).
function command(id: string, b: Pick<Button, 'action' | 'label' | 'force'>): void {
  const out = $('detail-result');
  out.className = 'detail-result';
  out.textContent = `${b.label}: sending…`;
  ask({ type: 'command', action: b.action, vehicleId: id, ...(b.force ? { force: true } : {}) }, (m) => {
    out.className = `detail-result ${m.ok ? 'ok' : 'bad'}`;
    out.textContent = m.ok ? `${b.label} sent as ${you?.id ?? 'you'}. What happens to it is in the timeline below.`
      : `${b.label} NOT done: ${m.command?.summary ?? m.error ?? 'refused'}`;
  });
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); // yyyy-mm-dd
function timeOf(ms: number): string { return timeFmt.format(ms); }

// ---- driving (UI.md screen 3) ----
//
// While this screen holds the lease on the open truck, it streams input at 10 Hz: the held key's
// throttle, or 0 when no key is held, so the lease stays alive while the operator thinks. A key press
// or release goes at once and restarts the 10 Hz beat. If the window loses focus or is hidden, it
// sends 0 once and stops: the browser never sends keyup then, so a held key would otherwise keep the
// truck moving (L7.5). Nothing is queued: with the service disconnected, nothing is sent at all.
let driveTruck: string | null = null;
let held: 'FWD' | 'REV' | null = null;
let step: number = PARAMS.driveDefaultThrottle.value;
let lastDir: 'FWD' | 'REV' = 'FWD';
let driveN = 0;
let driveSent = 0;
let driveTimer: TimerHandle | null = null;
let paused = false; // stopped on blur or hide, until the window is back in front
let lastDriveReply: { text: string; at: number } | null = null;

function myLease(id: string | null): boolean {
  return !!id && !!you && (frame?.live?.leases ?? []).some((l) => l.vehicleId === id && l.operatorId === you!.id);
}

function updateDriving(): void {
  const want = openTruck && myLease(openTruck) ? openTruck : null;
  if (want !== driveTruck) {
    stopStream(true);
    driveTruck = want;
    held = null;
    lastDriveReply = null;
  }
  if (driveTruck && !driveTimer && !paused) beat();
}

function sendDrive(throttle: number): void {
  if (!driveTruck) return;
  if (send({ type: 'drive', vehicleId: driveTruck, throttle, n: ++driveN }) === null) return;
  driveSent++;
  document.body.dataset.driveSent = String(driveSent); // for tests: every input this screen sent
  document.body.dataset.driveLast = String(throttle);
}

function beat(): void {
  if (driveTimer) clock.clearTimeout(driveTimer);
  driveTimer = null;
  if (!driveTruck || paused) return;
  sendDrive(throttleFor(held, step));
  driveTimer = clock.setTimeout(beat, PARAMS.driveInterval.value);
}

function stopStream(sendZero: boolean): void {
  if (driveTimer) clock.clearTimeout(driveTimer);
  const was = driveTimer !== null;
  driveTimer = null;
  held = null;
  if (sendZero && was) sendDrive(0);
}

function pause(): void {
  if (!driveTruck || paused) return;
  paused = true;
  stopStream(true);
  renderDrive();
}

function unpause(): void {
  if (!paused) return;
  paused = false;
  held = null;
  updateDriving();
  renderDrive();
}

function keyOf(e: KeyboardEvent): 'FWD' | 'REV' | null {
  if ((DRIVE_KEYS.forward as readonly string[]).includes(e.key)) return 'FWD';
  if ((DRIVE_KEYS.reverse as readonly string[]).includes(e.key)) return 'REV';
  return null;
}

function setupDriving(): void {
  // The driven truck's own e-stop beside the keys: the drawer can cover the header's row of stops.
  $('drive-estop').addEventListener('click', () => { if (driveTruck) estop(driveTruck); });
  $('drive-steps').replaceChildren(...THROTTLE_STEPS.map((x, i) => {
    const b = el('button', { type: 'button', 'data-step': String(x), title: `Key ${i + 1}` }, `${x * 100} %`);
    b.addEventListener('click', () => { setStep(x); b.blur(); });
    return b;
  }));
  document.addEventListener('keydown', (e) => {
    if (!driveTruck) return;
    if ((e.target as Element).closest?.('input, select, textarea')) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= THROTTLE_STEPS.length) { setStep(THROTTLE_STEPS[n - 1]!); return; }
    const d = keyOf(e);
    if (!d) return;
    e.preventDefault();
    if (paused) unpause(); // a key reached this window: it is in front again
    if (e.repeat && held === d) return;
    if (held !== d) lastDriveReply = null; // a new direction: the last refusal was about the old one
    held = d;
    lastDir = d;
    beat();
    renderDrive();
  });
  document.addEventListener('keyup', (e) => {
    const d = keyOf(e);
    if (!driveTruck || !d || held !== d) return;
    e.preventDefault();
    held = null;
    beat();
    renderDrive();
  });
  window.addEventListener('blur', pause);
  window.addEventListener('pagehide', pause);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') pause(); else if (document.hasFocus()) unpause(); });
  window.addEventListener('focus', unpause);
}

function setStep(x: number): void {
  step = x;
  if (held) beat();
  renderDrive();
}

function setMeter(id: string, m: Meter, threshold: number): void {
  const box = $(id);
  box.dataset.level = m.level;
  box.dataset.ms = m.ms === null ? '' : String(Math.round(m.ms));
  box.querySelector<HTMLElement>('.fill')!.style.width = `${Math.round(m.fraction * 100)}%`;
  box.querySelector<HTMLElement>('.mark')!.style.left = `${threshold * 100}%`;
  box.querySelector<HTMLElement>('.val')!.textContent = m.text;
}

function renderDrive(): void {
  const box = $('drive-panel');
  const live = frame?.live;
  const v = driveTruck && live ? live.drives.find((d) => d.vehicleId === driveTruck) : undefined;
  if (!driveTruck || !v || !frame) { box.hidden = true; return; }
  box.hidden = false;
  const t = frame.snapshot.trucks.find((x) => x.vehicleId === driveTruck);
  const p = drivePanel({
    view: v, truck: t, sinceFrameMs: lastFrameAt === null ? 0 : clock.now() - lastFrameAt,
    siteLinkDown: siteLink(frame.snapshot).state === 'down', serviceDown: serviceDown(),
    direction: held ?? (t?.speedMps?.value ? t.direction?.value ?? lastDir : lastDir), streaming: driveTimer !== null,
  });
  const throttle = throttleFor(held, step);
  $('drive-headline').textContent = p.headline;
  $('drive-estop').setAttribute('aria-label', `E-stop ${driveTruck}`);
  const sending = $('drive-sending');
  const asked = held ? `${held === 'FWD' ? 'forward' : 'reverse'} ${Math.round(Math.abs(throttle) * 100)} %` : '';
  const reply = lastDriveReply && clock.now() - lastDriveReply.at < 2_000 ? lastDriveReply.text : null; // the relay's answer, ahead of the next frame
  const stopped = !!held && (v.refusal?.current === true || reply !== null);
  sending.textContent = driveTimer === null ? 'NOT sending' : !held ? 'sending stop (0) at 10 Hz' : stopped ? `asking ${asked}: sent as a stop` : `sending ${asked}`;
  sending.dataset.on = String(driveTimer !== null && !stopped);
  box.dataset.streaming = String(driveTimer !== null);
  box.dataset.held = held ?? '';
  const st = v.echo.stats; // the relay's round trips on this lease, for the record (and the tests)
  box.dataset.echoStats = `${st.samples} ${st.p50Ms ?? ''} ${st.p95Ms ?? ''} ${st.maxMs ?? ''}`;
  box.title = st.samples ? `Round trips this drive: ${st.samples}, median ${st.p50Ms} ms, 95th percentile ${st.p95Ms} ms, worst ${st.maxMs} ms` : '';
  for (const b of $('drive-steps').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.step) === step));
  const refusal = p.refusal ?? reply;
  $('drive-refusal').hidden = refusal === null;
  $('drive-refusal').textContent = refusal ?? '';
  $('drive-warning').hidden = p.warning === null;
  $('drive-warning').textContent = p.warning ?? '';
  const dm = $('drive-deadman');
  dm.dataset.level = p.deadman.level;
  dm.textContent = p.deadman.words;
  setMeter('meter-input', p.input, p.thresholdFraction);
  setMeter('meter-echo', p.echo, p.thresholdFraction);
  $('drive-speed').textContent = p.speed;
  const side = (id: string, x: typeof p.ahead) => { $(id).textContent = x?.words ?? 'no zone boundary'; $(id).dataset.level = x?.level ?? 'ok'; };
  side('drive-ahead', p.ahead);
  side('drive-behind', p.behind);
  $('drive-limit').hidden = p.limit === null;
  $('drive-limit').textContent = p.limit ?? '';
}

// ---- audit (UI.md screen 4) ----

function openAudit(): void {
  $('audit').hidden = false;
  const snap = frame?.snapshot;
  const sel = $<HTMLSelectElement>('audit-truck');
  if (snap && sel.options.length === 0) sel.replaceChildren(...snap.trucks.filter((t) => t.onRoster !== false).map((t) => el('option', { value: t.vehicleId }, t.vehicleId)));
  if (openTruck) sel.value = openTruck;
  const now = snap?.atServerMs ?? clock.now();
  const d = $<HTMLInputElement>('audit-date'), tm = $<HTMLInputElement>('audit-time');
  if (!d.value) d.value = dateFmt.format(now);
  if (!tm.value) tm.value = timeFmt.format(now);
}

function runAudit(): void {
  const v = $<HTMLSelectElement>('audit-truck').value;
  const at = Date.parse(`${$<HTMLInputElement>('audit-date').value}T${$<HTMLInputElement>('audit-time').value}`); // local time
  const w = Number($<HTMLSelectElement>('audit-window').value);
  const out = $('audit-result');
  if (!Number.isFinite(at)) { out.replaceChildren(el('p', { class: 'bad' }, 'Pick a date and a time.')); return; }
  out.replaceChildren(el('p', { class: 'none' }, 'Looking…'));
  ask({ type: 'history', vehicleId: v, atServerMs: at, windowMs: w }, (m) => {
    if (!m.ok || !m.history) { out.replaceChildren(el('p', { class: 'bad' }, m.error ?? 'No answer.')); return; }
    const lines = m.history.lines;
    out.replaceChildren(
      el('p', { class: 'answer' }, lines.length ? `${lines.length} command${lines.length > 1 ? 's' : ''} on ${v} open between ${timeOf(at - w)} and ${timeOf(at + w)}.` : `No command to ${v} was open between ${timeOf(at - w)} and ${timeOf(at + w)}.`),
      ...(lines.length ? [el('table', { class: 'audit-table' },
        el('thead', {}, el('tr', {}, ...['Time', 'Command', 'Who', 'Why', 'Sent', 'Site said', 'What happened'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...lines.map((l) => el('tr', { class: `${l.closest ? 'closest' : ''}${l.system ? ' system' : ''}`, 'data-id': l.recordId },
          el('td', { class: 'at' }, timeOf(l.atServerMs)), el('td', {}, el('b', {}, l.action)), el('td', {}, l.who),
          el('td', {}, l.why ?? '—', l.inputs ? el('div', { class: 'inputs' }, `saw: ${l.inputs}`) : null),
          el('td', { class: 'small' }, l.sent), el('td', { class: 'small' }, l.acks), el('td', {}, l.outcome))))),
      ] : []),
      ...(m.history.truncated ? [el('p', { class: 'hint' }, 'Only the last 200 shown: narrow the window.')] : []));
  });
}

function setupLiveScreens(): void {
  $('detail-close').addEventListener('click', closeDetail);
  $('audit-open').addEventListener('click', openAudit);
  $('audit-close').addEventListener('click', () => { $('audit').hidden = true; });
  $('audit-form').addEventListener('submit', (e) => { e.preventDefault(); runAudit(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('audit').hidden) $('audit').hidden = true;
    else if (openTruck) closeDetail();
  });
  // Click or Enter on a fleet row, or a click on a truck on the track, opens its detail.
  const fromEvent = (e: Event): string | null => {
    const target = e.target as Element;
    if (target.closest('button, a, input, select')) return null;
    const hit = target.closest('[data-truck]') as HTMLElement | SVGElement | null;
    return hit?.dataset.truck ?? null;
  };
  $('rows').addEventListener('click', (e) => { const id = fromEvent(e); if (id) openDetail(id); });
  $('rows').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { const id = fromEvent(e); if (id) openDetail(id); } });
  $('track').addEventListener('click', (e) => {
    const g = (e.target as Element).closest('g.chip, g.range') as SVGGElement | null;
    const id = g?.dataset.truck ?? g?.dataset.trucks?.split(' ')[0];
    if (id) openDetail(id);
  });
}

// ---- main ----

function render(): void {
  renderLinks();
  if (!frame) return;
  renderPlayer(frame.player);
  if (frame.live) renderLive(frame.live, frame.snapshot);
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

// Between frames too: a service that has stopped sending must turn the clearance panel UNSURE.
const watch = () => { renderLinks(); if (frame) { renderClearance(frame.snapshot); renderDrive(); } clock.setTimeout(watch, 500); };

setupSound();
if (LIVE) {
  $('player').hidden = true;
  $('mode').textContent = 'LIVE';
  $('live-bar').hidden = false;
  $('tray').hidden = false;
  setupLiveScreens();
  setupRowFreeze();
  setupDriving();
  const m = /^#truck=([\w.-]{1,64})$/.exec(location.hash);
  if (m) openTruck = m[1]!;
  $('estop-trucks').hidden = false;
  $('estop').title = 'E-stop: one press stops that truck. Shown as done only when the truck reports ESTOPPED.';
  $('estop').classList.add('armed');
  $('estop-note').textContent = 'one press per truck';
  connectLive();
} else {
  void setupPlayer().then(connect);
}
watch();
let resizeTimer: ReturnType<typeof clock.setTimeout> | null = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clock.clearTimeout(resizeTimer);
  resizeTimer = clock.setTimeout(render, 100);
});
document.body.dataset.ready = 'true';
