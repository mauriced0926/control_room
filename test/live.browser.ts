// Task 6b in a real browser: the running service (`node src/main.ts`) against the fake gateway over
// TLS, and the locally installed Google Chrome through playwright-core. Cases: L9.2 (site link down:
// the picture ages, with a banner) and L9.3 (service down: the browser says disconnected) against the
// running service, plus logging in, the live Overview, who's on, and the e-stop pressed for real,
// including while the site link is down (L7.8). Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { EMAIL, FakeSite, HAVE_OPENSSL, makeCert, PASSWORDS, startServiceProcess, tempDir, waitFor, writeUsers, type RunningService } from './helpers/e2e.ts';

let tmp: ReturnType<typeof tempDir>;
let site: FakeSite;
let svc: RunningService;
let browser: Browser;
let page: Page;
const skip = HAVE_OPENSSL ? false : 'needs openssl to make a test certificate';

before(async () => {
  if (!HAVE_OPENSSL) return;
  tmp = tempDir('cr-browser-');
  const tls = makeCert(tmp.dir);
  site = new FakeSite(tls, { blasts: 'none' });
  await site.listen();
  svc = await startServiceProcess({
    GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(site.port), GATEWAY_EMAIL: EMAIL,
    NODE_EXTRA_CA_CERTS: tls.certPath, PORT: '0', DATA_DIR: join(tmp.dir, 'data'), USERS_FILE: await writeUsers(tmp.dir),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
});

after(async () => {
  await browser?.close();
  await svc?.stop();
  await site?.stop();
  tmp?.cleanup();
});

const state = (id: string) => page.$eval(`#${id}`, (e) => (e as HTMLElement).dataset.state);

test('log in, and the live Overview: every truck, both links up, who\'s on, the e-stop armed, blast safety said to be off', { skip, timeout: 60_000 }, async () => {
  await page.goto(svc.url);
  assert.match(page.url(), /\/login$/, 'no session: the login page');
  await page.fill('input[name=username]', 'priya');
  await page.fill('input[name=password]', 'wrong-password');
  await page.click('button[type=submit]');
  assert.match(await page.textContent('.login-error') ?? '', /Login refused/);
  await page.fill('input[name=username]', 'priya');
  await page.fill('input[name=password]', PASSWORDS.priya);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 12, null, { timeout: 15_000 });
  assert.equal(await page.textContent('#mode'), 'LIVE');
  assert.equal(await page.$eval('#player', (e) => (e as HTMLElement).hidden), true, 'no player controls in live mode');
  await page.waitForFunction(() => document.getElementById('site-link')?.dataset.state === 'up', null, { timeout: 10_000 });
  assert.equal(await state('service-link'), 'up');
  assert.match(await page.textContent('#who') ?? '', /Priya · operator/);
  assert.match(await page.textContent('#you') ?? '', /Priya \(operator\)/);
  assert.equal(await page.$$eval('#estop-trucks button', (bs) => bs.length), 12);
  assert.doesNotMatch(await page.textContent('#banners') ?? '', /Blast safety is NOT active/);
  assert.equal(await page.$eval('body', (b) => b.classList.contains('aged')), false);
  assert.ok(await page.$('g.chip'), 'trucks on the track');
});

test('the e-stop, pressed for real: one press, sent as this operator, shown done only when the truck reports ESTOPPED', { skip, timeout: 60_000 }, async () => {
  const truck = site.cleanTrucks()[2]!;
  const btn = `#estop-trucks button[data-truck="${truck}"]`;
  assert.equal(await page.$eval(btn, (b) => (b as HTMLElement).dataset.kind), 'ready');
  await page.click(btn);
  await waitFor(() => site.commands().find((c) => c.action === 'ESTOP' && c.vehicle_id === truck), 5_000, 'the e-stop at the gateway');
  assert.ok(site.commands().filter((c) => c.action === 'ESTOP').every((c) => c.operator_id === 'priya'));
  await page.waitForFunction((s) => document.querySelector<HTMLElement>(s)?.dataset.kind === 'stopped', btn, { timeout: 15_000 });
  assert.match(await page.textContent(`#rows tr[data-truck="${truck}"]`) ?? '', /ESTOPPED/);
  assert.match(await page.textContent(`#rows tr[data-truck="${truck}"] td.cmd`) ?? '', /ESTOP by priya: done/);
});

test('L9.2 site link down: the picture greys, a banner says so and counts, ages keep counting; an e-stop pressed now is shown pending and can be cancelled', { skip, timeout: 60_000 }, async () => {
  await site.down();
  await page.waitForFunction(() => document.getElementById('site-link')?.dataset.state === 'down', null, { timeout: 8_000 });
  assert.equal(await page.$eval('body', (b) => b.classList.contains('aged')), true);
  assert.notEqual(await page.$eval('main section.track', (m) => getComputedStyle(m).filter), 'none');
  assert.equal(await page.$eval('main section.clearance', (m) => getComputedStyle(m).filter), 'none', 'the clearance panel is never greyed');
  const banner = await page.$eval('#banners .banner.down', (b) => b.textContent!);
  assert.match(banner, /Site link DOWN: no heartbeat for \d+ s\. Everything below is at least that old; ages keep counting\./);
  assert.equal(await state('service-link'), 'up', 'the service itself is still there');

  // Ages count on: a truck's data cell, now and three seconds later.
  const truck = site.cleanTrucks()[0]!;
  const ageOf = async () => Number(/(\d+) s/.exec(await page.textContent(`#rows tr[data-truck="${truck}"] td.data`) ?? '')?.[1] ?? NaN);
  await page.waitForFunction((t) => /^(old|silent) \d+ s$/.test(document.querySelector(`#rows tr[data-truck="${t}"] td.data`)?.textContent ?? ''), truck, { timeout: 8_000 });
  const a = await ageOf();
  await page.waitForTimeout(3_000);
  const b = await ageOf();
  assert.ok(b >= a + 2, `the age grew from ${a} s to ${b} s`);
  assert.equal(await page.$(`#rows tr[data-truck="${truck}"].live`), null, 'nothing is shown as live');

  // An e-stop now: pending, never "done", with a cancel; cancelled, it is never sent.
  const other = site.cleanTrucks()[3]!;
  await page.click(`#estop-trucks button[data-truck="${other}"]`);
  await page.waitForSelector(`#estop-pending .estop-row[data-truck="${other}"][data-kind="pending"]`, { timeout: 5_000 });
  assert.match(await page.textContent(`#estop-pending .estop-row[data-truck="${other}"]`) ?? '', /E-stop .* \(pressed by priya\): NOT sent yet: waiting for the site link/);
  assert.equal(await page.$eval(`#estop-trucks button[data-truck="${other}"]`, (b) => (b as HTMLElement).dataset.kind), 'pending');
  await page.click(`#estop-pending .estop-row[data-truck="${other}"] button.cancel`);
  await page.waitForFunction((t) => !document.querySelector(`#estop-pending .estop-row[data-truck="${t}"]`), other, { timeout: 5_000 });
  await site.listen();
  await page.waitForFunction(() => document.getElementById('site-link')?.dataset.state === 'up', null, { timeout: 15_000 });
  await page.waitForTimeout(1_000);
  assert.ok(!site.commands().some((c) => c.action === 'ESTOP' && c.vehicle_id === other), 'the cancelled e-stop was never sent');
  assert.equal(await page.$eval('body', (bd) => bd.classList.contains('aged')), false, 'live again');
});

test('L9.3 service down: the browser says disconnected at once, greys the picture, and an e-stop says it was NOT sent', { skip, timeout: 60_000 }, async () => {
  assert.equal(await state('service-link'), 'up');
  await svc.stop();
  await page.waitForFunction(() => document.getElementById('service-link')?.dataset.state === 'down', null, { timeout: 5_000 });
  assert.equal(await page.$eval('body', (b) => b.classList.contains('aged')), true);
  assert.match(await page.$eval('#banners', (b) => b.textContent!), /Service DISCONNECTED: nothing for \d+ s\. The picture below is not current\./);
  const truck = site.cleanTrucks()[0]!;
  await page.click(`#estop-trucks button[data-truck="${truck}"]`);
  assert.match(await page.textContent('#estop-note') ?? '', /E-stop .* NOT sent: the service is disconnected\. Use the radio\./);
  await page.waitForTimeout(3_500);
  assert.match(await page.$eval('#banners', (b) => b.textContent!), /Service DISCONNECTED: nothing for [3-9] s/, 'still saying so, and counting');
});
