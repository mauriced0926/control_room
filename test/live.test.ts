// Task 6b scopes 3-5: the live hub between browsers and the registry, on a manual clock against the
// in-process fake gateway. Browser sockets are fakes that record what they were sent.
// Cases: L8.3, L8.2, L6.5, L6.3 (drive half: no drive path), L7.8 through the hub, frames and the
// service heartbeat (L9.3's server half), who's on, notices to the right people only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveHub, type LiveSocket } from '../src/live.ts';
import { PARAMS } from '../src/params.ts';
import { Sessions, type Session } from '../src/sessions.ts';
import type { User } from '../src/users.ts';
import { linkRig, type LinkRig } from './helpers/link-rig.ts';

const PRIYA: User = { id: 'priya', name: 'Priya', role: 'operator' };
const DAVE: User = { id: 'dave', name: 'Dave', role: 'operator' };
const MARTA: User = { id: 'marta', name: 'Marta', role: 'supervisor' };

class FakeSocket implements LiveSocket {
  readonly sent: Array<Record<string, any>> = [];
  closedWith: [number, string] | null = null;
  bufferedAmount = 0;
  send(text: string): void { this.sent.push(JSON.parse(text)); }
  close(code: number, reason: string): void { this.closedWith = [code, reason]; }
  frames(): Array<Record<string, any>> { return this.sent.filter((m) => m.type === 'frame'); }
  results(): Array<Record<string, any>> { return this.sent.filter((m) => m.type === 'result'); }
  last(): Record<string, any> { return this.results().at(-1)!; }
}

interface HubRig {
  r: LinkRig;
  hub: LiveHub;
  sessions: Sessions;
  logs: string[];
  open(user: User): { sock: FakeSocket; session: Session; say(m: unknown): Record<string, any>; raw(d: unknown, binary?: boolean): void };
  commandsAtGateway(): Array<Record<string, any>>;
  done(): void;
}

function hubRig(): HubRig {
  const r = linkRig();
  r.link.start();
  assert.ok(r.until(() => r.link.isUp(), 5_000) >= 0, 'link up');
  r.advance(1_000); // telemetry from every truck
  const sessions = new Sessions(r.clock);
  const logs: string[] = [];
  const hub = new LiveHub({ clock: r.clock, fleet: r.fleet, link: r.link, registry: r.registry, sessions, log: (l) => logs.push(l), store: r.store });
  return {
    r, hub, sessions, logs,
    open(user) {
      const sock = new FakeSocket();
      const session = sessions.create(user);
      const h = hub.connect(sock, session);
      return {
        sock, session,
        say(m) { h.receive(typeof m === 'string' ? m : JSON.stringify(m), false); return sock.last(); },
        raw(d, binary = false) { h.receive(d, binary); },
      };
    },
    commandsAtGateway: () => r.dialer.sentLines.map((l) => { try { return JSON.parse(l); } catch { return { unparseable: l }; } }).filter((m) => m.type === 'command'),
    done() { hub.shutdown(); r.cleanup(); },
  };
}

test('L8.3 the operator is the session\'s: operator_id in the browser\'s message is ignored, and noted', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    const res = p.say({ type: 'command', action: 'HOLD', vehicleId: 'HT-03', operator_id: 'mallory', operatorId: 'marta', actor: { kind: 'system', rule: 'x' }, role: 'supervisor' });
    assert.equal(res.ok, true);
    assert.equal(res.command.by, 'priya');
    const sent = h.commandsAtGateway();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.operator_id, 'priya', 'the gateway sees the session\'s operator');
    assert.ok(!h.r.dialer.sentLines.some((l) => l.includes('mallory')), 'the claimed name never leaves the service');
    const audit = h.r.store.auditLog('HT-03');
    assert.ok(audit.length > 0 && audit.every((a) => a.actor === 'priya' && a.actorKind === 'operator'), 'the audit log says priya');
    assert.ok(h.logs.some((l) => /ignored operator_id, operatorId, actor, role in a command from priya/.test(l)));
  } finally { h.done(); }
});

test('L8.2 only a supervisor can force a takeover; an operator\'s force never reaches the gateway', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    const refused = p.say({ type: 'command', action: 'TAKE_CONTROL', vehicleId: 'HT-05', force: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.command.status, 'refused');
    assert.match(refused.command.summary, /Only a supervisor can take HT-05/);
    assert.equal(h.commandsAtGateway().length, 0);

    const m = h.open(MARTA);
    const ok = m.say({ type: 'command', action: 'TAKE_CONTROL', vehicleId: 'HT-05', force: true });
    assert.equal(ok.ok, true);
    const sent = h.commandsAtGateway();
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0]!.action, sent[0]!.force, sent[0]!.operator_id], ['TAKE_CONTROL', true, 'marta']);
    h.r.advance(2_000);
    h.hub.tick();
    const live = h.hub.state();
    assert.deepEqual(live.leases.map((l) => [l.vehicleId, l.operatorId]), [['HT-05', 'marta']], 'who holds which lease');
  } finally { h.done(); }
});

test('L6.5 malformed and hostile messages are refused with a reason and logged; nothing reaches the gateway; the service carries on', () => {
  const h = hubRig();
  try {
    const p = h.open(DAVE);
    const before = h.r.registry.list().length;
    const deep = '['.repeat(1500) + ']'.repeat(1500);
    const hostile: Array<[unknown, RegExp, boolean?]> = [
      ['not json', /not JSON/],
      ['[1,2,3]', /not a JSON object/],
      ['null', /not a JSON object/],
      ['42', /not a JSON object/],
      [deep, /not a JSON object/],
      ['x'.repeat(5_000), /too large/],
      [Buffer.from([0xde, 0xad, 0xbe, 0xef]), /binary/, true],
      [{ type: 'command', action: 'SELF_DESTRUCT', vehicleId: 'HT-01' }, /unknown action/],
      [{ type: 'command', action: { toString: 'HOLD' }, vehicleId: 'HT-01' }, /unknown action/],
      [{ type: 'command', action: 'HOLD', vehicleId: ['HT-01'] }, /vehicleId must be/],
      [{ type: 'command', action: 'HOLD', vehicleId: 'HT-99' }, /not a truck on this site/],
      [{ type: 'command', action: 'HOLD', vehicleId: '__proto__' }, /not a truck on this site/],
      [{ type: 'command', action: 'HOLD' }, /vehicleId must be/],
      [{ type: 'command', action: 'TAKE_CONTROL', vehicleId: 'HT-01', force: 'yes' }, /force must be/],
      [{ type: 'command', action: 'HOLD', vehicleId: 'HT-01', force: true }, /force applies only/],
      [{ type: 'command', action: 'HOLD', vehicleId: 'HT-01', why: 'y'.repeat(300) }, /why must be/],
      [{ type: 'cancel', recordId: 7 }, /recordId/],
      [{ type: 'reconfirm', recordId: 'nope' }, /no such command/],
      [{ type: 'login', user: 'marta' }, /unknown message type/],
      [{ type: { nested: true } }, /unknown message type/],
      ['{"__proto__": {"type": "command"}, "constructor": {"prototype": {"x": 1}}}', /unknown message type/],
    ];
    for (const [m, re, binary] of hostile) {
      h.r.clock.advance(150); // under the rate limit: these are refused for what they are
      const n = p.sock.results().length;
      p.raw(typeof m === 'string' || Buffer.isBuffer(m) ? m : JSON.stringify(m), binary ?? false);
      assert.equal(p.sock.results().length, n + 1, `one reply to ${String(JSON.stringify(m)).slice(0, 60)}`);
      assert.equal(p.sock.last().ok, false);
      assert.match(p.sock.last().error, re, String(JSON.stringify(m)).slice(0, 60));
    }
    assert.equal(({} as Record<string, unknown>).x, undefined, 'no prototype was polluted');
    assert.equal(h.r.registry.list().length, before, 'the registry saw none of it');
    assert.equal(h.commandsAtGateway().length, 0, 'the gateway saw none of it');
    // Each refusal is logged, up to 20 per browser; after that every 100th, so a hostile page can't flood the log.
    assert.ok(hostile.length > 20);
    assert.equal(h.logs.filter((l) => /browser message refused \(dave, refusal \d+\)/.test(l)).length, 20);
    assert.equal(p.sock.closedWith, null);

    // Still serving: a frame on the next tick, and a good command still works.
    const frames = p.sock.frames().length;
    h.r.clock.advance(PARAMS.liveFrameMaxInterval.value);
    h.hub.tick();
    assert.equal(p.sock.frames().length, frames + 1);
    assert.equal(p.say({ type: 'command', action: 'HOLD', vehicleId: 'HT-01' }).ok, true);
  } finally { h.done(); }
});

test('L6.5 a flood is refused past the rate limit, and a browser that keeps flooding is disconnected', () => {
  const h = hubRig();
  try {
    const p = h.open(DAVE);
    for (let i = 0; i < 200; i++) p.raw(JSON.stringify({ type: 'nonsense', i }));
    const limited = p.sock.results().filter((m) => /too many messages/.test(m.error ?? '')).length;
    assert.equal(p.sock.results().length - limited, PARAMS.browserMessagesPerSecond.value * 2, 'the burst allowance, then refused');
    assert.deepEqual(p.sock.closedWith, [1008, 'too many messages']);
    assert.equal(h.hub.clientCount, 0);
    const other = h.open(PRIYA);
    assert.equal(other.say({ type: 'command', action: 'HOLD', vehicleId: 'HT-02' }).ok, true, 'other browsers are unaffected');
  } finally { h.done(); }
});

test('L6.3 (drive half) there is no drive path yet: a drive message is refused and nothing is sent to the gateway', () => {
  const h = hubRig();
  try {
    let drives = 0;
    const real = h.r.link.sendDrive.bind(h.r.link);
    h.r.link.sendDrive = (m) => { drives++; return real(m); };
    const m = h.open(MARTA);
    m.say({ type: 'command', action: 'TAKE_CONTROL', vehicleId: 'HT-07' });
    h.r.advance(1_000);
    for (let i = 1; i <= 5; i++) {
      h.r.clock.advance(150);
      const res = m.say({ type: 'drive', vehicleId: 'HT-07', lease_id: 'L-1', seq: i, throttle: 1.0 });
      assert.equal(res.ok, false);
      assert.match(res.error, /Driving from the browser is not available in this build yet\. Nothing was sent to the truck\./);
    }
    assert.equal(drives, 0, 'the link\'s drive path was never called');
    assert.ok(!h.r.dialer.sentLines.some((l) => /"type":"drive"/.test(l)), 'no drive line reached the gateway');
  } finally { h.done(); }
});

test('frames: one on connect, then on change at most every 250 ms, and at least every second with no change (the service heartbeat)', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    assert.equal(p.sock.frames().length, 1, 'a frame at once');
    const f = p.sock.frames()[0]!;
    assert.deepEqual(f.you, { id: 'priya', name: 'Priya', role: 'operator' });
    assert.ok(f.body.frame.snapshot.trucks.length === 12 && f.body.frame.site.segments.length > 0, 'the same snapshot and site the player sends');
    assert.equal(f.body.frame.live.blastSafety.active, false);
    assert.match(f.body.frame.live.blastSafety.note, /NOT active/);
    assert.equal(f.body.frame.live.link.state, 'up');

    // Nothing changes (the gateway is paused): no frame until a second has passed.
    h.r.gw.stop();
    h.hub.tick();
    const n = p.sock.frames().length;
    h.r.clock.advance(PARAMS.liveFrameMaxInterval.value - 1);
    h.hub.tick();
    assert.equal(p.sock.frames().length, n);
    h.r.clock.advance(1);
    h.hub.tick();
    assert.equal(p.sock.frames().length, n + 1);
    const a = p.sock.frames().at(-2)!, b = p.sock.frames().at(-1)!;
    assert.ok(b.body.seq > a.body.seq);
    assert.ok(b.body.frame.snapshot.trucks[0].ageMs > a.body.frame.snapshot.trucks[0].ageMs, 'ages keep counting in frames even with nothing new');

    // A change: a frame at the next tick, not before 250 ms after the last.
    h.hub.start();
    const m = p.sock.frames().length;
    h.open(DAVE); // presence changed
    h.r.clock.advance(PARAMS.livePushMinInterval.value);
    assert.equal(p.sock.frames().length, m + 1);
    assert.deepEqual(p.sock.frames().at(-1)!.body.frame.live.who.map((w: any) => [w.id, w.role, w.screens]), [['dave', 'operator', 1], ['priya', 'operator', 1]], 'who\'s on');
  } finally { h.done(); }
});

test('a browser that can\'t keep up skips frames; it is never sent a backlog', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    p.sock.bufferedAmount = PARAMS.liveMaxBufferedBytes.value + 1;
    const n = p.sock.frames().length;
    for (let i = 0; i < 10; i++) { h.r.clock.advance(PARAMS.liveFrameMaxInterval.value); h.hub.tick(); }
    assert.equal(p.sock.frames().length, n);
    p.sock.bufferedAmount = 0;
    h.r.clock.advance(PARAMS.liveFrameMaxInterval.value);
    h.hub.tick();
    assert.equal(p.sock.frames().length, n + 1, 'one current frame, not ten old ones');
  } finally { h.done(); }
});

test('an ended session closes its screens at once, and its messages are not acted on', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    const d = h.open(DAVE);
    h.sessions.end(p.session.id, 'logout');
    assert.deepEqual(p.sock.closedWith, [4401, 'session ended']);
    assert.equal(d.sock.closedWith, null);
    p.raw(JSON.stringify({ type: 'command', action: 'ESTOP', vehicleId: 'HT-01' }));
    assert.equal(h.commandsAtGateway().length, 0);
  } finally { h.done(); }
});

test('an open screen keeps its session alive past the idle timeout; a closed one does not', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    const idle = h.sessions.create(DAVE);
    h.r.gw.stop(); // the site's trucks don't matter here, and simulating 31 minutes of them is slow
    h.hub.start();
    h.r.advance(PARAMS.sessionIdleTimeout.value + 60_000, 1_000);
    assert.ok(h.sessions.get(p.session.id), 'watched screen stays logged in');
    assert.equal(h.sessions.get(idle.id), undefined, 'no screen, no requests: logged out');
    assert.equal(p.sock.closedWith, null);
  } finally { h.done(); }
});

test('notices go only to the people named: a LEASE_HELD refusal reaches the holder and the sender (L8.1 through the hub)', () => {
  const h = hubRig();
  try {
    const m = h.open(MARTA);
    const p = h.open(PRIYA);
    const d = h.open(DAVE);
    m.say({ type: 'command', action: 'TAKE_CONTROL', vehicleId: 'HT-04' });
    h.r.advance(2_000);
    h.r.clock.advance(150);
    p.say({ type: 'command', action: 'HOLD', vehicleId: 'HT-04' });
    h.r.advance(3_000);
    h.hub.tick();
    const notices = (s: FakeSocket): string[] => s.frames().at(-1)!.notices.map((n: any) => n.message as string);
    assert.ok(notices(m.sock).some((x) => /priya tried to HOLD HT-04, but marta holds its controls/.test(x)), 'the holder hears');
    assert.ok(notices(p.sock).some((x) => /priya tried to HOLD HT-04, but marta holds its controls/.test(x)), 'the sender hears');
    assert.deepEqual(notices(d.sock), [], 'nobody else');
  } finally { h.done(); }
});

test('L7.8 through the hub: an e-stop pressed while the site link is down is pending, cancellable only by its owner or a supervisor, and sent if the link returns within 10 s', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    const d = h.open(DAVE);
    h.r.dialer.mode = 'outage';
    h.r.dialer.dropAll();
    assert.ok(h.r.until(() => !h.r.link.isUp(), 1_000) >= 0);

    const res = p.say({ type: 'command', action: 'ESTOP', vehicleId: 'HT-09' });
    assert.equal(res.ok, true);
    assert.equal(res.command.waitingForLink, true);
    assert.match(res.command.summary, /NOT sent yet: waiting for the site link/);
    h.hub.tick();
    const shown = p.sock.frames().at(-1)!.body.frame.live.commands.find((c: any) => c.action === 'ESTOP');
    assert.equal(shown.waitingForLink, true, 'every screen shows it pending');
    assert.ok(h.hub.state().attention.some((a) => a.kind === 'estop_undelivered' && a.interrupt && /NOT delivered/.test(a.message)), 'an interrupt in the attention tray');

    h.r.clock.advance(150);
    const notMine = d.say({ type: 'cancel', recordId: res.command.id });
    assert.equal(notMine.ok, false);
    assert.match(notMine.error, /Only priya or a supervisor can cancel this ESTOP/);

    h.r.dialer.mode = 'normal';
    assert.ok(h.r.until(() => h.r.link.isUp(), 9_000) >= 0, 'link back within the 10 s');
    assert.ok(h.commandsAtGateway().some((c) => c.action === 'ESTOP' && c.vehicle_id === 'HT-09' && c.operator_id === 'priya'), 'sent on reconnect');
    assert.ok(h.r.until(() => h.r.registry.get(res.command.id)!.status === 'confirmed', 5_000) >= 0, 'done only when telemetry shows ESTOPPED');
    h.r.clock.advance(PARAMS.liveFrameMaxInterval.value);
    h.hub.tick();
    const last = p.sock.frames().at(-1)!.body.frame.live.commands.find((c: any) => c.id === res.command.id);
    assert.match(last.summary, /done: HT-09 is e-stopped/);
  } finally { h.done(); }
});

test('L7.8 through the hub: the owner can cancel a pending e-stop, and it is never sent', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    h.r.dialer.mode = 'outage';
    h.r.dialer.dropAll();
    h.r.until(() => !h.r.link.isUp(), 1_000);
    const res = p.say({ type: 'command', action: 'ESTOP', vehicleId: 'HT-09' });
    h.r.clock.advance(150);
    const c = p.say({ type: 'cancel', recordId: res.command.id });
    assert.equal(c.ok, true);
    assert.equal(c.command.status, 'cancelled');
    h.r.dialer.mode = 'normal';
    h.r.until(() => h.r.link.isUp(), 9_000);
    h.r.advance(2_000);
    assert.ok(!h.commandsAtGateway().some((x) => x.action === 'ESTOP'));
  } finally { h.done(); }
});

test('an acknowledgement is the session\'s operator\'s, whatever the message claims; it goes in the audit log; a second one is refused naming the first', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    const d = h.open(DAVE);
    h.r.dialer.mode = 'outage';
    h.r.dialer.dropAll();
    h.r.until(() => !h.r.link.isUp(), 1_000);
    p.say({ type: 'command', action: 'ESTOP', vehicleId: 'HT-09' });
    h.hub.tick();
    const item = h.hub.state().attention.find((a) => a.kind === 'estop_undelivered')!;
    assert.equal(item.interrupt, true);
    h.r.clock.advance(150);
    const res = d.say({ type: 'ack', key: item.key, operator_id: 'marta', by: 'marta' });
    assert.equal(res.ok, true);
    assert.equal(h.hub.attention.get(item.key)!.ack!.by, 'dave');
    h.r.clock.advance(150);
    const again = p.say({ type: 'ack', key: item.key });
    assert.deepEqual([again.ok, again.error], [false, 'Already acknowledged by Dave.']);
    const audit = h.r.store.auditLog('HT-09').filter((a) => a.event.startsWith('alarm_'));
    assert.deepEqual(audit.map((a) => [a.event, a.actorKind, a.actor]), [['alarm_raised', 'system', 'system'], ['alarm_acknowledged', 'operator', 'dave']]);
    h.r.clock.advance(150);
    assert.equal(p.say({ type: 'ack', key: 42 }).ok, false);
  } finally { h.done(); }
});

test('watching a truck: that screen\'s frames carry its command timeline and notes; other screens\' do not', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    const d = h.open(DAVE);
    p.say({ type: 'command', action: 'HOLD', vehicleId: 'HT-03' });
    h.r.clock.advance(150);
    assert.equal(p.say({ type: 'watch', vehicleId: 'HT-03' }).ok, true);
    h.r.clock.advance(PARAMS.liveFrameMaxInterval.value);
    h.hub.tick();
    const mine = p.sock.frames().at(-1)!;
    assert.equal(mine.detail.vehicleId, 'HT-03');
    assert.deepEqual(mine.detail.commands.map((c: any) => [c.action, c.actor.operatorId]), [['HOLD', 'priya']]);
    assert.equal(d.sock.frames().at(-1)!.detail, null);
    h.r.clock.advance(150);
    assert.equal(p.say({ type: 'watch', vehicleId: 'HT-99' }).ok, false);
    h.r.clock.advance(150);
    p.say({ type: 'watch', vehicleId: null });
    h.r.clock.advance(PARAMS.liveFrameMaxInterval.value);
    h.hub.tick();
    assert.equal(p.sock.frames().at(-1)!.detail, null);
  } finally { h.done(); }
});

test('L8.4 through the hub: "who moved HT-03 then?" is one request, answered from the command log', () => {
  const h = hubRig();
  try {
    const p = h.open(PRIYA);
    const at = h.r.fleet.serverNow();
    p.say({ type: 'command', action: 'HOLD', vehicleId: 'HT-03' });
    h.r.advance(10_000);
    const d = h.open(DAVE);
    const res = d.say({ type: 'history', vehicleId: 'HT-03', atServerMs: at + 2_000 });
    assert.equal(res.ok, true);
    assert.equal(res.history.lines.length, 1);
    const l = res.history.lines[0];
    assert.deepEqual([l.action, l.who, l.closest], ['HOLD', 'priya (operator)', true]);
    assert.match(l.outcome, /^done: HT-03 is holding/);
    h.r.clock.advance(150);
    assert.equal(d.say({ type: 'history', vehicleId: 'HT-03', atServerMs: 'yesterday' }).ok, false);
    h.r.clock.advance(150);
    assert.equal(d.say({ type: 'history', vehicleId: 'HT-03', atServerMs: at, windowMs: 1e12 }).ok, false);
  } finally { h.done(); }
});
