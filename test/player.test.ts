// The fixture player (task 6a): play, pause, step, seek and speed over research/fixtures/, with no
// gateway and nothing sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { listFixtures, Player } from '../player/player.ts';
import { fixture } from './helpers/fixtures.ts';
import { replay } from './helpers/rig.ts';

test('lists every fixture with what it shows', () => {
  const names = readdirSync(new URL('../research/fixtures/', import.meta.url)).filter((f) => f.endsWith('.jsonl') && !f.startsWith('._'));
  const list = listFixtures();
  assert.equal(list.length, names.length);
  for (const f of list) assert.ok(f.shows.length > 20, f.name);
});

test('loads paused at the start; plays at the chosen speed from wall time; stops at the end', () => {
  const p = new Player('frozen-truck');
  assert.equal(p.offsetMs, 0);
  assert.equal(p.playing, false);
  p.advanceWall(5_000);
  assert.equal(p.offsetMs, 0, 'paused: wall time does not move it');
  p.setSpeed(10);
  p.play();
  p.advanceWall(1_000);
  assert.equal(p.offsetMs, 10_000);
  p.advanceWall(10_000_000);
  assert.equal(p.offsetMs, p.durationMs);
  assert.equal(p.playing, false);
  assert.equal(p.frame().player.atEnd, true);
  assert.throws(() => p.setSpeed(7));
});

test('seeking back replays from the start and gives the same picture as a straight replay', () => {
  const p = new Player('silent-truck');
  p.seek(60_000);
  p.seek(30_000);
  const recs = fixture('silent-truck');
  const straight = replay(recs.filter((r) => r.kind === 'fixture' || r.rx_ms! <= p.frame().player.startMs + 30_000));
  straight.clock.advance(p.frame().player.startMs + 30_000 - straight.clock.now());
  assert.deepEqual(p.frame().snapshot, straight.fleet.snapshot());
});

test('stepping ages the picture between records, as it would live', () => {
  const p = new Player('silent-truck');
  const silentMark = p.frame().player.bookmarks.find((b) => /HT-03 silent/.test(b.text))!;
  p.seek(silentMark.offsetMs);
  const a = p.frame().snapshot.trucks.find((t) => t.vehicleId === 'HT-03')!.ageMs!;
  p.step(1_000);
  const b = p.frame().snapshot.trucks.find((t) => t.vehicleId === 'HT-03')!.ageMs!;
  assert.equal(b - a, 1_000);
});

test('bookmarks are found from the data: freeze, silence, link drop, zones, battery, restart', () => {
  const marks = (name: string) => new Player(name).frame().player.bookmarks.map((b) => b.text);
  assert.ok(marks('frozen-truck').includes('HT-10 data frozen'));
  assert.ok(marks('silent-truck').includes('HT-03 silent'));
  assert.ok(marks('silent-truck').includes('HT-03 reporting again'));
  const link = marks('link-drop-in-notice');
  assert.ok(link.includes('DRAW_12 CLOSING (BLAST_WINDOW)'));
  assert.ok(link.includes('site link down (no heartbeat)'), link.join(' | '));
  assert.ok(marks('two-zones-closing').includes('TIP CLOSED (BLAST_WINDOW)'));
  assert.ok(marks('weak-pack').some((t) => /^HT-06 battery: /.test(t)));
  assert.ok(marks('seq-reset').includes('HT-01 controller restarted'));
  assert.ok(marks('accepted-then-ignored-resume').some((t) => t === 'recorded: probe sent RESUME to HT-02'));
});

test('a link-drop bookmark sits where the heartbeats stop, give or take one sample', () => {
  const p = new Player('link-drop-in-notice');
  const recs = fixture('link-drop-in-notice').filter((r) => r.kind !== 'fixture');
  const lastHb = recs.filter((r) => r.m?.type === 'heartbeat').at(-1)!.rx_ms! - p.frame().player.startMs;
  const down = p.frame().player.bookmarks.find((b) => b.text === 'site link down (no heartbeat)')!;
  assert.ok(down.offsetMs - lastHb >= 5_000 && down.offsetMs - lastHb <= 5_500, `${down.offsetMs} vs last heartbeat ${lastHb}`);
});

test('whether the recording kept heartbeats, and where the hello came from, are part of the frame', () => {
  assert.equal(new Player('frozen-truck').frame().player.heartbeatsRecorded, false);
  assert.equal(new Player('silent-truck').frame().player.heartbeatsRecorded, true);
  assert.equal(new Player('two-zones-closing').frame().player.helloFrom, 'fixture');
  assert.equal(new Player('weak-pack').frame().player.helloFrom, 'this site, re-timed');
});

test('the player cannot reach a gateway: no network client, no gateway settings', () => {
  const dir = new URL('../player/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.startsWith('._'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /node:(net|tls|dgram)|from 'net'|from 'tls'|GATEWAY_|\.env\b|fetch\(/, f);
  }
});
