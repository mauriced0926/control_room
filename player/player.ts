// The fixture player (task 6a): replays a research/fixtures/ recording through FleetState on a
// ManualClock, with play, pause, step, seek and speed, and produces the frames the Overview draws.
// No gateway and no commands: nothing here sends anything anywhere. 'sent' records in a fixture are
// what the probe sent when it was recorded; they are shown as history, never re-sent.
//
// Fixture time is the clock inside the Replayer. Wall time comes in from outside (advanceWall), so
// this module never reads the wall clock and tests drive it directly.
import { readdirSync } from 'node:fs';
import type { FleetSnapshot } from '../src/fleet.ts';
import type { Hello } from '../src/protocol.ts';
import { siteData, type SiteData } from '../src/ui/track.ts';
import { readRecords, type FixtureRecord } from '../test/helpers/fixtures.ts';
import { Replayer } from '../test/helpers/rig.ts';

export const FIXTURES_DIR = new URL('../research/fixtures/', import.meta.url);

export interface FixtureInfo {
  name: string;
  shows: string;
  source: string;
}

export interface Bookmark {
  offsetMs: number;
  text: string;
}

export interface PlayerState {
  fixture: string;
  shows: string;
  source: string;
  startMs: number;
  endMs: number;
  offsetMs: number;
  playing: boolean;
  speed: number;
  atEnd: boolean;
  heartbeatsRecorded: boolean; // false: this recording kept no heartbeats, so the link state is unknown
  helloFrom: 'fixture' | 'this site, re-timed';
  bookmarks: Bookmark[];
}

export interface Frame {
  player: PlayerState;
  site: SiteData | null;
  snapshot: FleetSnapshot;
}

export const SPEEDS = [0.5, 1, 2, 5, 10, 30] as const;
const BOOKMARK_SAMPLE_MS = 500;
const MAX_BOOKMARKS = 80;

export function listFixtures(dir: URL = FIXTURES_DIR): FixtureInfo[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && !f.startsWith('._'))
    .sort()
    .map((f) => {
      const head = readRecords(new URL(f, dir))[0];
      return { name: f.replace(/\.jsonl$/, ''), shows: String(head?.shows ?? ''), source: String(head?.source ?? '') };
    });
}

// A fixture whose first message is a hello carries its own site; the rest were cut from the middle
// of a run and are replayed after this site's hello, as the tests do (test/helpers/fixtures.ts).
function ownHello(records: FixtureRecord[]): boolean {
  const first = records.filter((r) => r.kind === 'msg').sort((a, b) => a.rx_ms! - b.rx_ms!)[0];
  return (first?.m as { type?: string } | undefined)?.type === 'hello';
}

function replayerFor(records: FixtureRecord[]): Replayer {
  return new Replayer(records, ownHello(records) ? { hello: null as Hello | null } : {});
}

export class Player {
  readonly #dir: URL;
  #info!: FixtureInfo;
  #records: FixtureRecord[] = [];
  #r!: Replayer;
  #playing = false;
  #speed = 1;
  #bookmarks: Bookmark[] = [];
  #heartbeats = false;

  constructor(fixture: string, dir: URL = FIXTURES_DIR) {
    this.#dir = dir;
    this.load(fixture);
  }

  load(name: string): void {
    const info = listFixtures(this.#dir).find((f) => f.name === name);
    if (!info) throw new Error(`no fixture called ${name}`);
    this.#info = info;
    this.#records = readRecords(new URL(`${name}.jsonl`, this.#dir));
    this.#heartbeats = this.#records.some((r) => r.kind === 'msg' && (r.m as { type?: string } | undefined)?.type === 'heartbeat');
    this.#r = replayerFor(this.#records);
    this.#playing = false;
    this.#bookmarks = this.#findBookmarks();
  }

  get offsetMs(): number { return this.#r.clock.now() - this.#r.start; }
  get durationMs(): number { return this.#r.end - this.#r.start; }
  get playing(): boolean { return this.#playing; }

  play(): void { if (this.offsetMs >= this.durationMs) this.seek(0); this.#playing = true; }
  pause(): void { this.#playing = false; }

  setSpeed(x: number): void {
    if (!(SPEEDS as readonly number[]).includes(x)) throw new Error(`speed ${x} is not one of ${SPEEDS.join(', ')}`);
    this.#speed = x;
  }

  // Moves fixture time to `offsetMs` from the start. Going back replays from the start: the fleet
  // state only moves forward, as it does live.
  seek(offsetMs: number): void {
    const target = this.#r.start + Math.max(0, Math.min(offsetMs, this.durationMs));
    if (target < this.#r.clock.now()) this.#r = replayerFor(this.#records);
    this.#r.advanceTo(target);
  }

  step(ms: number): void { this.seek(this.offsetMs + ms); }

  // To the next bookmark, or the end.
  nextEvent(): void {
    const now = this.offsetMs;
    const mark = this.#bookmarks.find((b) => b.offsetMs > now)?.offsetMs ?? this.durationMs;
    this.seek(mark);
  }

  // Wall time has passed; fixture time follows at the chosen speed while playing, and stops at the end.
  advanceWall(wallMs: number): void {
    if (!this.#playing || wallMs <= 0) return;
    this.seek(this.offsetMs + wallMs * this.#speed);
    if (this.offsetMs >= this.durationMs) this.#playing = false;
  }

  frame(): Frame {
    const site = this.#r.fleet.site;
    return {
      player: {
        fixture: this.#info.name,
        shows: this.#info.shows,
        source: this.#info.source,
        startMs: this.#r.start,
        endMs: this.#r.end,
        offsetMs: this.offsetMs,
        playing: this.#playing,
        speed: this.#speed,
        atEnd: this.offsetMs >= this.durationMs,
        heartbeatsRecorded: this.#heartbeats,
        helloFrom: ownHello(this.#records) ? 'fixture' : 'this site, re-timed',
        bookmarks: this.#bookmarks,
      },
      site: site ? siteData(site) : null,
      snapshot: this.#r.fleet.snapshot(),
    };
  }

  // The moments worth jumping to, found by replaying the whole fixture once: confidence changes
  // other than old, zone changes, battery warnings, controller restarts, the site link going down and
  // coming back, reconnects, and what the probe sent. A truck's confidence marks count once each per
  // kind, and its battery marks once per warning, so a thinned recording (weak-pack keeps other trucks
  // at 0.2 Hz, so they flicker silent) doesn't bury the moments that matter.
  #findBookmarks(): Bookmark[] {
    const marks: Bookmark[] = [];
    const once = new Set<string>();
    const mark = (key: string, text: string) => { if (!once.has(key)) { once.add(key); marks.push({ offsetMs: at(), text }); } };
    const r = replayerFor(this.#records);
    const at = () => r.clock.now() - r.start;
    r.fleet.subscribe((e) => {
      switch (e.type) {
        case 'confidence':
          if (e.to === 'contradicted') mark(`${e.vehicleId}:frozen`, `${e.vehicleId} data frozen`);
          else if (e.to === 'silent') mark(`${e.vehicleId}:silent`, `${e.vehicleId} silent`);
          else if (e.to === 'live' && (e.from === 'silent' || e.from === 'contradicted')) mark(`${e.vehicleId}:again`, `${e.vehicleId} reporting again`);
          break;
        case 'zone':
          // A hello lists every open zone; only real changes are worth a mark.
          if (e.status === 'OPEN' && !e.reason) break;
          marks.push({ offsetMs: at(), text: `${e.zoneId} ${e.status ?? 'status unknown'}${e.reason ? ` (${e.reason})` : ''}` });
          break;
        case 'battery':
          if (e.warning) mark(`${e.vehicleId}:battery:${e.warning}`, `${e.vehicleId} battery: ${e.message ?? e.warning}`);
          else if (e.drainHigh) mark(`${e.vehicleId}:drain`, `${e.vehicleId} battery: draining faster than the fleet`);
          break;
        case 'controller_restart': marks.push({ offsetMs: at(), text: `${e.vehicleId} controller restarted` }); break;
        default: break;
      }
    });
    let linkDown: boolean | null = null;
    for (let t = r.start; ; t = Math.min(t + BOOKMARK_SAMPLE_MS, r.end)) {
      r.advanceTo(t);
      if (this.#heartbeats) {
        const hb = r.fleet.snapshot().heartbeat;
        const down = hb.stale && hb.ageMs !== null;
        if (linkDown !== null && down !== linkDown) marks.push({ offsetMs: at(), text: down ? 'site link down (no heartbeat)' : 'site link back' });
        if (hb.ageMs !== null) linkDown = down;
      }
      if (t >= r.end) break;
    }
    for (const rec of this.#records) {
      if (rec.kind === 'sent') {
        const c = safeJson(rec.raw);
        if (c) marks.push({ offsetMs: rec.rx_ms! - r.start, text: `recorded: probe sent ${String(c.action)} to ${String(c.vehicle_id)}` });
      } else if (rec.kind === 'connected') marks.push({ offsetMs: rec.rx_ms! - r.start, text: `recorded: reconnect attempt ${String(rec.attempt ?? '')}` });
      else if (rec.kind === 'msg' && (rec.m as { type?: string })?.type === 'hello') marks.push({ offsetMs: rec.rx_ms! - r.start, text: 'hello (site snapshot)' });
    }
    marks.sort((a, b) => a.offsetMs - b.offsetMs);
    return marks.slice(0, MAX_BOOKMARKS);
  }
}

function safeJson(s: unknown): Record<string, unknown> | null {
  try { return JSON.parse(String(s)) as Record<string, unknown>; } catch { return null; }
}
