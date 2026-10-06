// Task 7 in a real browser: the running service (`node src/main.ts`) against the fake gateway over TLS,
// driven with real keyboard events in Chrome through playwright-core. Never the real gateway. Every
// claim is checked against what the fake gateway received (timestamped here) and the fake's true truck
// state, not only against the page.
//
// Cases: L7.1 (deadman through the relay), L7.2 (the lag meter, and the lag measured against the
// fake), L7.6 (never into a closed zone, out the other way), L9.4 / L7.5 (stuck key: a real window
// blur with the key still held), L7.3 (forced takeover), L7.4 (e-stop wins), L7.7 (limp-home and
// tow), L7.9 / L9.5 (hand-back), L6.3 (the browser drops mid-drive). Screenshots go to SHOTS_DIR.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { DEFAULT_BEHAVIOUR } from '../fake/behaviour.ts';
import { DLH1 } from '../fake/dlh1.ts';
import { LIVE_DAY, planTrucks } from '../fake/faults.ts';
import { EMAIL, FakeSite, HAVE_OPENSSL, makeCert, PASSWORDS, startServiceProcess, tempDir, waitFor, writeUsers, type RunningService } from './helpers/e2e.ts';

const SEED = 11;
// The live day's radio (loss, duplicates, reordering, delay) and its truck faults, without its random
// link drops: a drop mid-test is L6/L9.2's business, and would make these flaky.
const FAULTS = { ...LIVE_DAY, linkDrops: false };
const plan = planTrucks(FAULTS, DLH1.vehicles, DEFAULT_BEHAVIOUR, SEED);
const busy = new Set(Object.values(plan).map((p) => p?.vehicle));
const CLEAN = DLH1.vehicles.filter((v) => !busy.has(v));
const [NEAR, SHARED, LIMP, HANDBACK] = CLEAN as [string, string, string, string];
const TOW = plan.weakPack!.vehicle; // its pack is weak anyway; the test empties it
const CLOSED_AT_M = 580; // L4_NORTH starts here (fake/dlh1.ts); it is CLOSED for the whole test
const SHOTS = process.env.SHOTS_DIR;

let tmp: ReturnType<typeof tempDir>;
let site: FakeSite;
let svc: RunningService;
let browser: Browser;
const ctxs: BrowserContext[] = [];
let priya: Page;
let marta: Page;
let dave: Page;
const received: Array<{ at: number; m: Record<string, any> }> = []; // every line the fake got, with when
const skip = HAVE_OPENSSL ? (CLEAN.length >= 4 && plan.weakPack ? false : 'needs four trucks without planned faults, and a weak pack') : 'needs openssl to make a test certificate';

const drives = (vehicle: string) => received.filter((r) => r.m.type === 'drive' && r.m.vehicle_id === vehicle);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const truth = (v: string) => site.gw.truth(v);

async function login(p: Page, user: keyof typeof PASSWORDS): Promise<void> {
  await p.goto(svc.url);
  await p.fill('input[name=username]', user);
  await p.fill('input[name=password]', PASSWORDS[user]);
  await p.click('button[type=submit]');
  await p.waitForFunction(() => document.querySelectorAll('#rows tr').length === 12, null, { timeout: 15_000 });
}

async function page(user: keyof typeof PASSWORDS): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  ctxs.push(ctx);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`PAGEERROR (${user}): ${e.message}`)); // a script error would leave a screen silently wrong
  await login(p, user);
  // Real focus: with emulation off, another page coming to the front blurs this one, as a desktop does.
  // Set after logging in: the override does not survive the navigations of the login.
  await (await ctx.newCDPSession(p)).send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return p;
}

async function shot(p: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await (await p.$('#detail'))!.screenshot({ path: join(SHOTS, name) });
}

async function openRow(p: Page, truck: string): Promise<void> {
  await p.$eval(`#rows tr[data-truck="${truck}"] td.id`, (td) => (td as HTMLElement).click());
  // 15 s: the full browser suite runs its files in parallel, and on a loaded machine 5 s has not been enough.
  await p.waitForFunction((t) => document.getElementById('detail-title')?.textContent === t && !document.getElementById('detail')!.hidden, truck, { timeout: 15_000 })
    .catch(async (e) => { throw new Error(`${e.message}; page: ${JSON.stringify(await p.evaluate(() => ({ title: document.getElementById('detail-title')?.textContent, hidden: document.getElementById('detail')!.hidden, hash: location.hash, service: document.getElementById('service-link')?.textContent, rows: document.querySelectorAll('#rows tr').length })))}`); });
}

async function takeControl(p: Page, truck: string, force = false): Promise<void> {
  await openRow(p, truck);
  await p.click(`#detail-buttons button[data-action="TAKE_CONTROL"]${force ? '[data-force="true"]' : ':not([data-force])'}`);
  await p.waitForSelector('#drive-panel:not([hidden])[data-streaming="true"]', { timeout: 15_000 });
}

const sent = (p: Page) => p.evaluate(() => Number(document.body.dataset.driveSent ?? '0'));
const panelText = (p: Page, id: string) => p.textContent(`#${id}`).then((t) => t ?? '');

before(async () => {
  if (skip) return;
  tmp = tempDir('cr-drive-');
  const tls = makeCert(tmp.dir);
  site = new FakeSite(tls, {
    seed: SEED, faults: FAULTS,
    blasts: [{ zoneId: 'L4_NORTH', atMs: 0, noticeMs: 1_000, closedForMs: 3_600_000 }],
    trucks: [
      { vehicle_id: NEAR, positionM: 520, state: 'HOLDING' },
      { vehicle_id: SHARED, positionM: 300, state: 'HOLDING' },
      { vehicle_id: LIMP, positionM: 200, state: 'HOLDING' },
      { vehicle_id: TOW, positionM: 400, state: 'HOLDING' },
      { vehicle_id: HANDBACK, positionM: 1_100, state: 'HOLDING' },
    ],
  });
  const receive = site.gw.receive.bind(site.gw);
  site.gw.receive = (conn, line) => { try { received.push({ at: Date.now(), m: JSON.parse(line) }); } catch { /* not ours to check */ } receive(conn, line); };
  await site.listen();
  svc = await startServiceProcess({
    GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(site.port), GATEWAY_EMAIL: EMAIL,
    NODE_EXTRA_CA_CERTS: tls.certPath, PORT: '0', DATA_DIR: join(tmp.dir, 'data'), USERS_FILE: await writeUsers(tmp.dir),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  priya = await page('priya');
  marta = await page('marta');
  dave = await page('dave');
});

after(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
  await browser?.close();
  await svc?.stop();
  await site?.stop();
  tmp?.cleanup();
});

test('L7.1 / L7.2 / L7.6: hold to drive with the lag meter live; stopped short of a CLOSED zone and told why; out the other way', { skip, timeout: 120_000 }, async () => {
  await priya.bringToFront();
  await takeControl(priya, NEAR);
  assert.match(await panelText(priya, 'drive-headline'), new RegExp(`^You are driving ${NEAR}$`));
  assert.match(await panelText(priya, 'drive-sending'), /sending stop \(0\) at 10 Hz/);
  await priya.waitForFunction(() => /^Forward: \d+ m to L4_NORTH, CLOSED$/.test(document.getElementById('drive-ahead')!.textContent!), null, { timeout: 5_000 });
  await shot(priya, 'drive-ready.png');

  const start = truth(NEAR).positionM;
  await priya.keyboard.press('4'); // full throttle
  await priya.keyboard.down('ArrowUp');
  const samples: Array<{ input: number; echo: number }> = [];
  let refused = false;
  for (let i = 0; i < 120 && !refused; i++) {
    await sleep(250);
    const s = await priya.evaluate(() => ({ input: Number(document.getElementById('meter-input')!.dataset.ms), echo: Number(document.getElementById('meter-echo')!.dataset.ms), refusal: !document.getElementById('drive-refusal')!.hidden }));
    if (truth(NEAR).speedMps > 0) samples.push({ input: s.input, echo: s.echo });
    if (i === 8) await shot(priya, 'drive-moving.png');
    refused = s.refusal;
  }
  assert.ok(refused, 'the refusal showed on screen');
  assert.ok(truth(NEAR).positionM > start + 20, `it drove: ${start} -> ${truth(NEAR).positionM}`);
  assert.match(await panelText(priya, 'drive-refusal'), /^Stopped: L4_NORTH is CLOSED, \d+ m ahead\. Driving forward into it is refused; you can drive the other way\.$/);
  assert.match(await panelText(priya, 'drive-sending'), /^asking forward 100 %: sent as a stop$/);
  await sleep(1_500); // key still held
  const stopAt = truth(NEAR).positionM;
  assert.ok(stopAt < CLOSED_AT_M, `never into the closed zone: at ${stopAt}`);
  assert.equal(truth(NEAR).speedMps, 0);
  await shot(priya, 'drive-refused-closed-zone.png');
  if (SHOTS) await priya.screenshot({ path: join(SHOTS, 'drive-full-page.png') });
  await priya.keyboard.up('ArrowUp');

  // L7.2: what the meter showed while it moved, and the relay's own round trips on this lease.
  const stats = (await priya.$eval('#drive-panel', (e) => (e as HTMLElement).dataset.echoStats!)).split(' ').map(Number);
  const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  const inputs = samples.map((s) => s.input), echoes = samples.map((s) => s.echo);
  console.log(`LAG against the fake (${samples.length} meter samples while moving): input age p50 ${q(inputs, 0.5)} ms, max ${Math.max(...inputs)} ms; echo age p50 ${q(echoes, 0.5)} ms, p95 ${q(echoes, 0.95)} ms, max ${Math.max(...echoes)} ms. Relay round trips: ${stats[0]} samples, p50 ${stats[1]} ms, p95 ${stats[2]} ms, max ${stats[3]} ms`);
  // Checked against raw data: when the fake gateway received each drive line, against the sent_ms the
  // service stamped on it (both on this machine's clock; the service's is learned from heartbeats).
  const up = drives(NEAR).filter((r) => typeof r.m.sent_ms === 'number').map((r) => r.at - r.m.sent_ms);
  console.log(`RAW uplink at the fake gateway, receipt minus sent_ms, ${up.length} drive lines: p50 ${q(up, 0.5)} ms, p95 ${q(up, 0.95)} ms, max ${Math.max(...up)} ms, min ${Math.min(...up)} ms`);
  assert.ok(q(inputs, 0.5) < 500, 'input arrives well inside the deadman');
  assert.ok(stats[0]! > 20 && stats[1]! > 0 && stats[1]! < 1_000, `round trips measured: ${stats.join(' ')}`);

  // Out, the other way: relayed as asked.
  await priya.keyboard.down('ArrowDown');
  await sleep(2_000);
  assert.ok(truth(NEAR).positionM < stopAt - 3, `reversed away: ${stopAt} -> ${truth(NEAR).positionM}`);
  assert.equal(await priya.$eval('#drive-refusal', (e) => (e as HTMLElement).hidden), true, `the refusal cleared: ${await panelText(priya, 'drive-refusal')}`);
  await priya.keyboard.up('ArrowDown');

  // Invariant 3: never more drive messages at the gateway than inputs the browser sent.
  await sleep(500);
  assert.ok(drives(NEAR).length <= await sent(priya), `${drives(NEAR).length} at the gateway, ${await sent(priya)} sent by the screen`);
});

test('L9.4 / L7.5 stuck key: the window loses focus with the key held; the browser sends 0 once and stops; nothing more reaches the gateway; deadman, then the lease lapses', { skip, timeout: 60_000 }, async () => {
  await priya.bringToFront();
  await priya.waitForSelector('#drive-panel[data-streaming="true"]', { timeout: 5_000 });
  await priya.keyboard.press('2');
  await priya.keyboard.down('ArrowDown'); // away from the closed zone; never released
  await sleep(1_500);
  assert.ok(truth(NEAR).speedMps > 0, 'moving');

  await priya.evaluate(() => { (window as any).focusLog = [document.hasFocus()]; for (const e of ['blur', 'focus']) addEventListener(e, () => (window as any).focusLog.push(e)); });
  const other = await ctxs[0]!.newPage();
  await (await ctxs[0]!.newCDPSession(other)).send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await other.bringToFront(); // a real blur on the driving page: no keyup is ever sent
  const blurAt = Date.now();
  await priya.waitForSelector('#drive-panel[data-streaming="false"]', { timeout: 2_000 }).catch(async (e) => { throw new Error(`${e.message}; focus events: ${JSON.stringify(await priya.evaluate(() => (window as any).focusLog))}, hasFocus ${await priya.evaluate(() => document.hasFocus())}`); });
  assert.equal(await priya.evaluate(() => document.body.dataset.driveLast), '0', 'the last input sent was a stop');
  const after1 = await sent(priya);
  await sleep(2_000);
  assert.equal(await sent(priya), after1, 'the browser stopped streaming');
  assert.match(await panelText(priya, 'drive-warning'), /Not sending: this window is not in front/);
  assert.match(await panelText(priya, 'drive-sending'), /NOT sending/);
  const late = drives(NEAR).filter((r) => r.at > blurAt + 300);
  assert.deepEqual(late.map((r) => r.m.throttle), [], 'nothing reached the gateway after the stop');
  assert.equal(truth(NEAR).speedMps, 0);
  assert.equal(truth(NEAR).deadman, true, 'stopped on its deadman');
  await shot(priya, 'drive-stuck-key-blur.png');
  await waitFor(() => truth(NEAR).state === 'HOLDING', 15_000, 'the lease to lapse to HOLDING');
  await other.close();
  await priya.keyboard.up('ArrowDown');
  await priya.bringToFront();
  // It holds, and the screen says whose input it was waiting for and what to do next.
  await priya.waitForFunction(() => /^Held by you: you drove it; control expired with no drive input\. It will not move until someone resumes it\./.test(document.getElementById('detail-callout')!.textContent!), null, { timeout: 5_000 });
  await priya.click('#detail-close');
});

test('L7.5 the page hidden with a key held (visibilitychange dispatched in the page: headless Chrome never hides a page): 0 once, then silence', { skip, timeout: 60_000 }, async () => {
  await priya.bringToFront();
  await takeControl(priya, NEAR);
  await priya.keyboard.down('ArrowDown');
  await sleep(1_000);
  await priya.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const at = Date.now();
  await priya.waitForSelector('#drive-panel[data-streaming="false"]', { timeout: 2_000 });
  assert.equal(await priya.evaluate(() => document.body.dataset.driveLast), '0');
  await sleep(1_500);
  assert.deepEqual(drives(NEAR).filter((r) => r.at > at + 300).map((r) => r.m.throttle), []);
  assert.equal(truth(NEAR).speedMps, 0);
  await priya.keyboard.up('ArrowDown');
  await priya.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await priya.click('#detail-buttons button[data-action="RELEASE_CONTROL"]');
  await waitFor(() => truth(NEAR).operatorId === null, 10_000, 'released');
  await priya.click('#detail-close');
});

test('L7.3 forced takeover mid-drive: the first driver sees who took it and when, and their input is refused; L7.4 e-stop wins while the new driver drives', { skip, timeout: 90_000 }, async () => {
  await priya.bringToFront();
  await takeControl(priya, SHARED);
  const priyaLease = truth(SHARED).leaseId!;
  await priya.keyboard.down('ArrowUp');
  await sleep(1_000);

  await marta.bringToFront(); // priya's window blurs too: that alone stops her stream, so bring her back
  await openRow(marta, SHARED);
  await marta.click(`#detail-buttons button[data-action="TAKE_CONTROL"][data-force="true"]`);
  await marta.waitForSelector('#drive-panel:not([hidden])', { timeout: 15_000 });
  const martaLease = truth(SHARED).leaseId!;
  assert.notEqual(martaLease, priyaLease);
  const takenAt = Date.now();
  await priya.bringToFront();
  await priya.keyboard.down('ArrowUp'); // she keeps trying
  await priya.waitForFunction(() => /^marta took control of .+ from you at \d\d:\d\d:\d\d\. Your input is no longer sent\.$/.test(document.getElementById('detail-callout')!.textContent!), null, { timeout: 5_000 });
  assert.equal(await priya.$eval('#drive-panel', (e) => (e as HTMLElement).hidden), true);
  await sleep(1_500);
  assert.deepEqual(drives(SHARED).filter((r) => r.at > takenAt && r.m.lease_id === priyaLease), [], 'nothing on her lease after the takeover');
  await shot(priya, 'drive-taken-over.png');
  await priya.keyboard.up('ArrowUp');

  await marta.bringToFront();
  await marta.waitForSelector('#drive-panel[data-streaming="true"]', { timeout: 5_000 });
  await marta.keyboard.down('ArrowUp');
  await sleep(1_000);
  assert.ok(truth(SHARED).speedMps > 0, 'marta drives it');
  await dave.click(`#estop-trucks button[data-truck="${SHARED}"]`); // dave's page is behind: a click needs no focus
  assert.equal(await marta.getAttribute('#drive-estop', 'aria-label'), `E-stop ${SHARED}`, 'the driver has the truck\'s own stop beside the keys too');
  const stopAt = Date.now();
  await waitFor(() => truth(SHARED).state === 'ESTOPPED', 5_000, 'e-stopped');
  await marta.waitForFunction(() => /was e-stopped by dave at \d\d:\d\d:\d\d; your control ended\./.test(document.getElementById('detail-callout')!.textContent!), null, { timeout: 5_000 });
  await sleep(1_000);
  assert.deepEqual(drives(SHARED).filter((r) => r.at > stopAt + 500).map((r) => r.m.lease_id), [], 'no drive input relayed once the lease was revoked');
  assert.equal(truth(SHARED).speedMps, 0);
  await marta.keyboard.up('ArrowUp');
  await marta.click('#detail-close');
});

test('L7.7 limp-home shows and keeps to its 1.0 m/s limit; a BATTERY_DEPLETED truck says it needs a tow and offers no Take control', { skip, timeout: 60_000 }, async () => {
  site.gw.injectFault(LIMP, 'HYD_PRESSURE_LOW');
  site.gw.model.deplete(TOW);
  await priya.bringToFront();
  await takeControl(priya, LIMP);
  await priya.waitForFunction(() => /^Limp-home \(HYD_PRESSURE_LOW\): limited to 1\.0 m\/s$/.test(document.getElementById('drive-limit')!.textContent!), null, { timeout: 5_000 });
  await priya.keyboard.press('4');
  await priya.keyboard.down('ArrowUp');
  await sleep(2_000);
  assert.equal(truth(LIMP).speedMps, 1.0);
  await shot(priya, 'drive-limp-home.png');
  await priya.keyboard.up('ArrowUp');
  await priya.click('#detail-buttons button[data-action="RELEASE_CONTROL"]');
  await waitFor(() => truth(LIMP).state === 'FAULT', 10_000, 'back to FAULT after release (§6.6)');

  await openRow(priya, TOW);
  await priya.waitForFunction(() => /Battery depleted: it needs a tow and cannot be driven/.test(document.getElementById('detail-buttons')!.textContent!), null, { timeout: 5_000 });
  assert.equal(await priya.$eval('#detail-buttons button[data-action="TAKE_CONTROL"]', (b) => (b as HTMLButtonElement).disabled), true);
  await shot(priya, 'drive-tow.png');
  await priya.click('#detail-close');
});

test('L7.9 / L9.5 hand-back after driving: Release, then "held by you" with Resume one click away; Resume sends it on', { skip, timeout: 60_000 }, async () => {
  await priya.bringToFront();
  await takeControl(priya, HANDBACK);
  await priya.keyboard.down('ArrowUp');
  await sleep(1_500);
  await priya.keyboard.up('ArrowUp');
  assert.match(await panelText(priya, 'drive-panel'), /Done\? Two steps: 1\. Release control \(it stops and holds\) · 2\. Resume/);
  await priya.click('#detail-buttons button[data-action="RELEASE_CONTROL"]');
  await priya.waitForFunction(() => /^Held by you: you handed it back after driving\./.test(document.getElementById('detail-callout')!.textContent!), null, { timeout: 15_000 });
  assert.equal(truth(HANDBACK).state, 'HOLDING');
  assert.equal(await priya.$eval('#drive-panel', (e) => (e as HTMLElement).hidden), true, 'the driving view has gone');
  assert.match(await priya.textContent(`#rows tr[data-truck="${HANDBACK}"]`) ?? '', /held by you: Resume in its detail/);
  await shot(priya, 'drive-hand-back.png');
  await priya.click('#detail-callout button.resume-now');
  await waitFor(() => truth(HANDBACK).state !== 'HOLDING' && truth(HANDBACK).mode === 'AUTO', 15_000, 'the truck to carry on');
  await priya.click('#detail-close');
});

test('L6.3 the browser drops mid-drive with the key held: the service sends nothing after its last input; the truck stops on its deadman', { skip, timeout: 60_000 }, async () => {
  await priya.bringToFront();
  await takeControl(priya, HANDBACK);
  await priya.keyboard.down('ArrowUp');
  await sleep(1_500);
  assert.ok(truth(HANDBACK).speedMps > 0);
  const n = await sent(priya);
  await priya.close(); // the screen is gone, key and all
  const closedAt = Date.now();
  await sleep(2_500);
  const all = drives(HANDBACK);
  assert.deepEqual(all.filter((r) => r.at > closedAt + 200).map((r) => r.m.throttle), [], 'nothing after the browser went');
  assert.ok(all.length <= n + 1, `${all.length} at the gateway against ${n} the screen had sent`);
  assert.equal(truth(HANDBACK).speedMps, 0);
  assert.equal(truth(HANDBACK).deadman, true);
});
