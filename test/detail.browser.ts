// Task 6c in a real browser: the running service (`node src/main.ts`) against the fake gateway's live
// day over TLS, and the locally installed Google Chrome through playwright-core. Never the real
// gateway. Claims are checked against what the gateway received (site.commands()) and the service's
// SQLite file, not only against the page.
//
// Cases: the attention tray (L2.60-L2.62 on screen: an interrupt with an attributed acknowledgement,
// silent items with their rule, "Sound off" until armed), truck detail and its command timeline,
// L8.1 (a blocked command shown to the lease holder too), L7.9 / L9.5 (hand-back: held by you, then
// Resume), the clearance panel during a link drop (UNSURE in full colour with the last call beneath),
// and L8.4 (the audit view). Screenshots go to SHOTS_DIR when it is set.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { DEFAULT_BEHAVIOUR } from '../fake/behaviour.ts';
import { DLH1 } from '../fake/dlh1.ts';
import { LIVE_DAY, planTrucks } from '../fake/faults.ts';
import { EMAIL, FakeSite, HAVE_OPENSSL, makeCert, PASSWORDS, startServiceProcess, tempDir, waitFor, writeUsers, type RunningService } from './helpers/e2e.ts';

const SEED = 11;
const plan = planTrucks(LIVE_DAY, DLH1.vehicles, DEFAULT_BEHAVIOUR, SEED);
const busy = new Set(Object.values(plan).map((p) => p?.vehicle));
const CLEAN = DLH1.vehicles.filter((v) => !busy.has(v));
const INSIDE = CLEAN[0]!;     // parked, holding, inside the zone that will close
const SHOTS = process.env.SHOTS_DIR;

let tmp: ReturnType<typeof tempDir>;
let site: FakeSite;
let svc: RunningService;
let browser: Browser;
let priyaCtx: BrowserContext;
let martaCtx: BrowserContext;
let page: Page;   // priya
let marta: Page;
let heldTruck = '';   // the truck priya held and resumed, for the audit test
let leased = '';      // the truck marta drove, for the hand-back test
const skip = HAVE_OPENSSL ? false : 'needs openssl to make a test certificate';

async function login(p: Page, user: keyof typeof PASSWORDS): Promise<void> {
  await p.goto(svc.url);
  await p.fill('input[name=username]', user);
  await p.fill('input[name=password]', PASSWORDS[user]);
  await p.click('button[type=submit]');
  await p.waitForFunction(() => document.querySelectorAll('#rows tr').length === 12, null, { timeout: 15_000 });
}

async function shot(p: Page, name: string, selector?: string): Promise<void> {
  if (!SHOTS) return;
  // Clipped from the whole page at the top, so the sticky header never covers the element.
  await p.evaluate(() => window.scrollTo(0, 0));
  const box = selector ? await (await p.$(selector))!.boundingBox() : null;
  const inDrawer = selector ? await p.$eval(selector, (e) => getComputedStyle(e).position === 'fixed') : false;
  if (box && !inDrawer) await p.screenshot({ path: join(SHOTS, name), fullPage: true, clip: box });
  else if (box) await (await p.$(selector!))!.screenshot({ path: join(SHOTS, name) });
  else await p.screenshot({ path: join(SHOTS, name) });
}

// Clicks the truck's own row element. The table is sorted by attention and re-sorts as trucks change,
// so a click at a row's screen position can land on another truck by the time it arrives.
async function openRow(p: Page, truck: string): Promise<void> {
  await p.$eval(`#rows tr[data-truck="${truck}"] td.id`, (td) => (td as HTMLElement).click());
  await p.waitForFunction((t) => document.getElementById('detail-title')?.textContent === t && !document.getElementById('detail')!.hidden, truck, { timeout: 5_000 })
    .catch(async (e) => { throw new Error(`${e.message}; page: ${JSON.stringify(await p.evaluate(() => ({ title: document.getElementById('detail-title')?.textContent, hidden: document.getElementById('detail')!.hidden, hash: location.hash, service: document.getElementById('service-link')?.textContent, summary: document.getElementById('detail-summary')?.textContent, timeline: document.getElementById('detail-timeline')?.textContent?.slice(0, 200), active: document.activeElement?.id })))}`); });
}

const audit = () => {
  const db = new DatabaseSync(join(tmp.dir, 'data', 'control-room.db'), { readOnly: true });
  try { return db.prepare('SELECT * FROM audit ORDER BY seq').all() as Array<Record<string, any>>; } finally { db.close(); }
};

// A truck that is driving its duty cycle right now, so a HOLD takes effect within seconds.
async function trammingTruck(exclude: string[]): Promise<string> {
  return waitFor(() => CLEAN.find((v) => !exclude.includes(v) && site.gw.truth(v).state === 'TRAMMING' && site.gw.truth(v).zoneId !== 'DECLINE'), 30_000, 'a tramming truck');
}

before(async () => {
  if (!HAVE_OPENSSL) return;
  tmp = tempDir('cr-detail-');
  const tls = makeCert(tmp.dir);
  site = new FakeSite(tls, {
    seed: SEED,
    blasts: [{ zoneId: 'DECLINE', atMs: 12_000, closedForMs: 900_000 }],
    trucks: [{ vehicle_id: INSIDE, positionM: 200, state: 'HOLDING' }],
  });
  await site.listen();
  svc = await startServiceProcess({
    GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(site.port), GATEWAY_EMAIL: EMAIL,
    NODE_EXTRA_CA_CERTS: tls.certPath, PORT: '0', DATA_DIR: join(tmp.dir, 'data'), USERS_FILE: await writeUsers(tmp.dir),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  priyaCtx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  martaCtx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  page = await priyaCtx.newPage();
  marta = await martaCtx.newPage();
  for (const [who, p] of [['priya', page], ['marta', marta]] as const) {
    p.on('pageerror', (e) => console.log(`PAGEERROR (${who}): ${e.message}\n${e.stack ?? ''}`));
    p.on('framenavigated', (f) => { if (f === p.mainFrame()) console.log(`NAV (${who}) ${Date.now()} ${f.url()}`); });
    p.on('websocket', (ws) => { console.log(`WSOPEN (${who}) ${Date.now()}`); ws.on('close', () => console.log(`WSCLOSE (${who}) ${Date.now()}`)); });
    p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`CONSOLE ${m.type()} (${who}): ${m.text()}`); });
  }
  await login(page, 'priya');
  await login(marta, 'marta');
});

after(async () => {
  await browser?.close();
  await svc?.stop();
  await site?.stop();
  tmp?.cleanup();
});

test('the tray: a closing zone that might not be clear interrupts, says what to do and why; sound is off until armed and says what was missed', { skip, timeout: 60_000 }, async () => {
  const key = 'blast:provisional:DECLINE';
  const item = `#tray-interrupts .item[data-key="${key}"]`;
  await page.waitForSelector(item, { timeout: 30_000 });
  const text = await page.textContent(item) ?? '';
  assert.match(text, /DECLINE NOT CLEAR \(CLOSING\)/);
  assert.match(text, new RegExp(`${INSIDE} inside`));
  assert.match(text, /Radio the shot firer to hold the shot\./);
  assert.match(text, /Rule: Interrupts \(L2\.60\)/);
  assert.equal(await page.$eval(item, (e) => (e as HTMLElement).dataset.state), 'needs-ack');
  // Nobody clicked the page: the alarm could not be heard, and the screen says so.
  await page.waitForFunction(() => /^Sound off: \d+ alarms? not heard\. Click to arm$/.test(document.getElementById('sound')!.textContent!), null, { timeout: 5_000 });
  assert.equal(await page.$eval('#sound', (b) => (b as HTMLElement).dataset.missed), 'true');
  await page.click('#sound');
  await page.waitForFunction(() => document.getElementById('sound')!.textContent === 'Sound armed', null, { timeout: 5_000 });

  // Silent items: shown, each with the rule that kept it silent.
  await page.click('#tray-silent-box summary');
  await page.waitForFunction(() => document.querySelectorAll('#tray-silent .item').length > 0, null, { timeout: 30_000 });
  const silent = await page.$$eval('#tray-silent .item', (es) => es.map((e) => e.textContent!));
  assert.ok(silent.every((s) => /Rule: Silent/.test(s)), silent.join('\n'));
  await shot(page, 'tray-interrupt-and-silent.png', '#tray');

  // An acknowledgement is attributed to the operator logged in, on every screen, and in the log.
  await page.click(`${item} button.ack`);
  await page.waitForFunction((s) => document.querySelector<HTMLElement>(s)?.dataset.state === 'acknowledged', item, { timeout: 5_000 });
  await marta.waitForFunction((s) => /Acknowledged by Priya \d:\d\d ago/.test(document.querySelector(s)?.textContent ?? ''), item, { timeout: 5_000 });
  assert.ok(audit().some((a) => a.event === 'alarm_acknowledged' && a.actor === 'priya' && a.actor_kind === 'operator'));
  assert.ok(audit().some((a) => a.event === 'alarm_raised' && a.actor_kind === 'system' && /DECLINE NOT CLEAR/.test(a.what)));
});

test('truck detail: Hold goes out as this operator; the timeline shows sent, acknowledged, effect seen, and "done" only then', { skip, timeout: 60_000 }, async () => {
  const truck = await trammingTruck([INSIDE]);
  await openRow(page, truck);
  await page.waitForSelector('#detail:not([hidden])');
  assert.equal(await page.textContent('#detail-title'), truck);
  const labels = await page.$$eval('#detail-buttons button', (bs) => bs.map((b) => b.textContent));
  assert.deepEqual(labels, ['Hold', 'Resume', 'Return to bay', 'Exit zone', 'Take control'].map((l) => `${l} · ${truck}`), 'every button names the truck');
  for (const f of ['Faults', 'Clock', 'Drain', 'Controller restarts']) assert.match(await page.textContent('#detail-facts') ?? '', new RegExp(f));

  await page.click('#detail-buttons button[data-action="HOLD"]');
  const sent = await waitFor(() => site.commands().find((c) => c.action === 'HOLD' && c.vehicle_id === truck), 5_000, 'the HOLD at the gateway');
  assert.equal(sent.operator_id, 'priya');
  const row = '#detail-timeline > li:first-child';
  await page.waitForFunction((s) => document.querySelector<HTMLElement>(s)?.dataset.outcome === 'done', row, { timeout: 20_000 });
  assert.equal(site.gw.truth(truck).state, 'HOLDING', 'the truck is really holding');
  const steps = await page.$$eval(`${row} .steps li`, (ls) => ls.map((l) => (l as HTMLElement).className));
  // The live day ignores some accepted commands (as the live site did): then a retry shows between.
  assert.deepEqual([steps.slice(0, 3), steps.at(-1)], [['request', 'send', 'ack'], 'effect'], steps.join(' '));
  if (steps.length > 4) assert.match(await page.textContent(row) ?? '', /Sent again: attempt 2 of 3/);
  assert.match(await page.textContent(`${row} .head`) ?? '', new RegExp(`^HOLD by priya: done$`));
  await shot(page, 'truck-detail.png', '#detail');
  // For L8.4 below.
  heldTruck = truck;
  await page.click('#detail-buttons button[data-action="RESUME"]');
  await waitFor(() => site.gw.truth(truck).state !== 'HOLDING', 15_000, 'the truck to move again');
  await page.click('#detail-close');
});

test('L8.1 a command blocked by a lease is shown to the lease holder as well as the sender, with the holder named', { skip, timeout: 60_000 }, async () => {
  const truck = await trammingTruck([INSIDE, heldTruck]);
  await openRow(marta, truck);
  await marta.waitForSelector('#detail:not([hidden])');
  await marta.click('#detail-buttons button[data-action="TAKE_CONTROL"]');
  await marta.waitForFunction(() => /^You are driving /.test(document.getElementById('drive-headline')!.textContent!) && !document.getElementById('drive-panel')!.hidden, null, { timeout: 10_000 });

  await openRow(page, truck);
  await page.waitForFunction(() => /marta is driving/.test(document.getElementById('detail-callout')!.textContent!), null, { timeout: 5_000 });
  assert.equal(await page.$eval('#detail-buttons button[data-action="TAKE_CONTROL"]', (b) => (b as HTMLButtonElement).disabled), true);
  assert.match(await page.textContent('#detail-buttons') ?? '', /marta is driving it\. Talk to them; a supervisor can take over/);
  await page.click('#detail-buttons button[data-action="HOLD"]');
  const row = '#detail-timeline > li:first-child';
  await page.waitForFunction((s) => document.querySelector<HTMLElement>(s)?.dataset.outcome === 'failed', row, { timeout: 10_000 });
  assert.match(await page.textContent(row) ?? '', new RegExp(`${truck} is being driven by marta\\. Talk to them first`));
  const ack = site.sent().find((m) => m.type === 'command' && m.action === 'HOLD' && m.vehicle_id === truck && m.operator_id === 'priya');
  assert.ok(ack, 'the HOLD reached the gateway as priya');
  await marta.waitForFunction((t) => [...document.querySelectorAll('#tray-notices .item')].some((n) => n.textContent!.includes(`priya tried to HOLD ${t}, but marta holds its controls`)), truck, { timeout: 5_000 });
  await page.click('#detail-close');
  leased = truck;
});

test('L7.9 / L9.5 hand-back: after release the truck shows "held by you" with Resume one click away, and Resume sends it on', { skip, timeout: 60_000 }, async () => {
  const truck = leased;
  // Marta still has the detail open, with control: Release is the primary button.
  await marta.waitForSelector('#detail-buttons button[data-action="RELEASE_CONTROL"].primary');
  await marta.click('#detail-buttons button[data-action="RELEASE_CONTROL"]');
  await marta.waitForFunction(() => /^Held by you: you handed it back after driving\./.test(document.getElementById('detail-callout')!.textContent!), null, { timeout: 15_000 });
  assert.equal(site.gw.truth(truck).state, 'HOLDING');
  assert.match(await marta.textContent(`#rows tr[data-truck="${truck}"]`) ?? '', /held by you: Resume in its detail/);
  assert.match(await page.textContent(`#rows tr[data-truck="${truck}"]`) ?? '', /held by marta/, 'everyone else sees who holds it');
  await shot(marta, 'hand-back.png', '#detail');
  await marta.click('#detail-callout button.resume-now');
  await waitFor(() => site.commands().find((c) => c.action === 'RESUME' && c.vehicle_id === truck && c.operator_id === 'marta'), 5_000, 'the RESUME at the gateway');
  await waitFor(() => site.gw.truth(truck).state !== 'HOLDING', 15_000, 'the truck to move again');
  await marta.waitForFunction(() => document.getElementById('detail-callout')!.textContent === '', null, { timeout: 10_000 });
  await marta.click('#detail-close');
});

test('L8.4 the audit view: pick a truck and a time; every command around it, who sent it, what the site said and what the truck did', { skip, timeout: 30_000 }, async () => {
  const truck = heldTruck;
  await marta.click('#audit-open');
  await marta.selectOption('#audit-truck', truck);
  await marta.click('#audit-form button[type=submit]');
  await marta.waitForSelector('#audit-result table');
  const rows = await marta.$$eval('#audit-result tbody tr', (rs) => rs.map((r) => [...r.querySelectorAll('td')].map((d) => d.textContent)));
  const hold = rows.find((r) => r[1] === 'HOLD');
  assert.ok(hold, JSON.stringify(rows));
  assert.equal(hold[2], 'priya (operator)');
  assert.match(hold[5]!, /^ACCEPTED for /);
  assert.match(hold[6]!, new RegExp(`^done: ${truck} is holding`));
  assert.ok(rows.some((r) => r[1] === 'RESUME' && r[2] === 'priya (operator)'));
  await shot(marta, 'audit.png', '#audit');
  await marta.click('#audit-close');
});

test('the fleet table keeps its order under the pointer: a re-sort waits, contents still update, and the click opens the truck that was under it', { skip, timeout: 60_000 }, async () => {
  if (await page.$('#detail:not([hidden])')) await page.click('#detail-close');
  const order = () => page.$$eval('#rows > tr', (trs) => trs.map((t) => (t as HTMLElement).dataset.truck!));
  const ids = await order();
  // An ordinary live, tramming truck low in the table, to e-stop: it will jump up the table. The row
  // just above it is the one under the pointer; every row between them would shift down.
  const ordinary = async (id: string) => CLEAN.includes(id) && ![INSIDE, heldTruck, leased].includes(id)
    && /^live$/.test(await page.textContent(`#rows tr[data-truck="${id}"] td.data`) ?? '')
    && (await page.textContent(`#rows tr[data-truck="${id}"] td.why`) ?? '') === '';
  let k = -1;
  for (let i = ids.length - 1; i >= 2 && k < 0; i--) if (await ordinary(ids[i]!)) k = i;
  assert.ok(k >= 2, `an ordinary truck low in the table: ${ids.join(' ')}`);
  const stopped = ids[k]!;
  const under = ids[k - 1]!;
  await page.hover(`#rows tr[data-truck="${under}"] td.id`);
  await page.waitForSelector('#order-paused:not([hidden])', { timeout: 2_000 });
  const frozen = await order();
  const box = (await (await page.$(`#rows tr[data-truck="${under}"] td.id`))!.boundingBox())!;
  assert.ok(box, `no box for ${under}: ${JSON.stringify(await page.evaluate((u) => ({ url: location.href, rows: document.querySelectorAll('#rows tr').length, row: !!document.querySelector(`#rows tr[data-truck="${u}"]`), connected: document.querySelector(`#rows tr[data-truck="${u}"]`)?.isConnected, drawer: !document.getElementById('detail')!.hidden, audit: !document.getElementById('audit')!.hidden, scrollY, body: document.body.className }), under))}`);

  await marta.click(`#estop-trucks button[data-truck="${stopped}"]`);
  await page.waitForFunction((t) => /ESTOPPED/.test(document.querySelector(`#rows tr[data-truck="${t}"]`)?.textContent ?? ''), stopped, { timeout: 15_000 });
  assert.deepEqual(await order(), frozen, 'the order held while the pointer was on the table');
  // Not only the order: the row's place on screen. Other rows' contents changed meanwhile, and they
  // may not push it down while frozen.
  const pointed = await page.evaluate(([x, y]) => (document.elementFromPoint(x as number, y as number)?.closest('[data-truck]') as HTMLElement | null)?.dataset.truck ?? null, [box.x + box.width / 2, box.y + box.height / 2]);
  assert.equal(pointed, under, 'the same truck is still under the pointer');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction((t) => document.getElementById('detail-title')?.textContent === t && !document.getElementById('detail')!.hidden, under, { timeout: 5_000 });

  // Opening the drawer took focus off the row, so a mouse click doesn't keep the table frozen. The
  // pointer leaves: the table sorts again, and the e-stopped truck moves up.
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-title');
  await page.mouse.move(5, 5);
  await page.waitForSelector('#order-paused[hidden]', { state: 'attached', timeout: 2_000 });
  await page.waitForFunction(([t, k]) => [...document.querySelectorAll('#rows > tr')].findIndex((r) => (r as HTMLElement).dataset.truck === t) < (k as number), [stopped, k] as const, { timeout: 5_000 });
  // Control: unfrozen, the same e-stop would have put another truck under the pointer.
  assert.notEqual((await order())[k - 1], under);
  await page.click('#detail-close');
});

test('the clearance panel during a link drop: UNSURE in full colour, the last call beneath it in grey with its age; the link-down interrupt', { skip, timeout: 60_000 }, async () => {
  const zrow = '#clearance .zrow[data-zone="DECLINE"]';
  assert.equal(await page.$eval(zrow, (e) => (e as HTMLElement).dataset.verdict), 'NOT_CLEAR');
  await site.down();
  await page.waitForFunction((s) => document.querySelector<HTMLElement>(s)?.dataset.verdict === 'UNSURE', zrow, { timeout: 10_000 });
  await page.waitForFunction((s) => /^was NOT CLEAR, [2-9] s ago$/.test(document.querySelector(`${s} .was`)?.textContent ?? ''), zrow, { timeout: 10_000 });
  assert.match(await page.textContent(zrow) ?? '', /Site link down: no data is arriving/);
  assert.equal(await page.$eval('main section.clearance', (m) => getComputedStyle(m).filter), 'none', 'not greyed');
  assert.notEqual(await page.$eval('main section.track', (m) => getComputedStyle(m).filter), 'none', 'the rest of the picture is');
  await page.waitForSelector('#tray-interrupts .item[data-key="link:down"]', { timeout: 5_000 });
  assert.match(await page.textContent('#tray-interrupts .item[data-key="link:down"]') ?? '', /Site link down while DECLINE \(CLOSING\) is not open/);
  await shot(page, 'clearance-link-drop.png');
  await shot(page, 'clearance-link-drop-panel.png', 'main section.clearance');
  await site.listen();
  await page.waitForFunction((s) => document.querySelector<HTMLElement>(s)?.dataset.verdict === 'NOT_CLEAR', zrow, { timeout: 20_000 });
  assert.equal(await page.$(`${zrow} .was`), null);
});

test('a real click on a fleet row opens the truck even when frames arrive between press and release (the cells are kept, not redrawn)', { skip, timeout: 30_000 }, async () => {
  if (await page.$('#detail:not([hidden])')) await page.click('#detail-close');
  const truck = CLEAN.find((v) => v !== INSIDE)!;
  const cell = `#rows tr[data-truck="${truck}"] td.id .cell`;
  const box = (await (await page.$(cell))!.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.$eval(cell, (e) => { (e as HTMLElement).dataset.mark = 'pressed'; });
  await page.mouse.down();
  await page.waitForTimeout(800); // three frames or more at 4 a second
  await page.mouse.up();
  assert.equal(await page.$eval(cell, (e) => (e as HTMLElement).dataset.mark), 'pressed', 'the same cell element throughout');
  await page.waitForFunction((t) => document.getElementById('detail-title')?.textContent === t && !document.getElementById('detail')!.hidden, truck, { timeout: 5_000 });
  await page.mouse.move(5, 5);
  await page.click('#detail-close');
});
