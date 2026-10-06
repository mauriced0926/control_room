// TESTING.md L9.1 and the Overview rows of UI.md's state table, in a real browser: the fixture player
// serves the page, and the locally installed Google Chrome renders it through playwright-core
// (Playwright's own browser builds don't run on this macOS 12 machine). Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import { SystemClock } from '../src/clock.ts';
import { Player } from '../player/player.ts';
import { startPlayerServer, type PlayerServer } from '../player/server.ts';

let server: PlayerServer;
let browser: Browser;
let page: Page;

before(async () => {
  server = await startPlayerServer({ clock: new SystemClock(), fixture: 'frozen-truck' });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(fixture: string, offsetMs: number): Promise<void> {
  await page.goto(`${server.url}?fixture=${fixture}&t=${Math.round(offsetMs)}`);
  await page.waitForFunction((t) => document.getElementById('pos')?.textContent?.startsWith(`+${Math.floor(t / 60000)}:`), offsetMs);
  await page.waitForSelector('#rows tr');
  await page.waitForTimeout(400);
}

// The first moment in a recording where one truck each is live, old, silent and contradicted. Found
// from the data, by stepping the player a second at a time.
function momentWithAllFour(fixture: string): { offsetMs: number; ids: Record<'live' | 'old' | 'silent' | 'contradicted', string> } {
  const p = new Player(fixture);
  for (let t = 0; t <= p.durationMs; t += 1_000) {
    p.seek(t);
    const trucks = p.frame().snapshot.trucks;
    const pick = (c: string) => trucks.find((x) => x.confidence === c)?.vehicleId;
    const ids = { live: pick('live'), old: pick('old'), silent: pick('silent'), contradicted: pick('contradicted') };
    if (Object.values(ids).every((x) => x !== undefined)) return { offsetMs: t, ids: ids as Record<keyof typeof ids, string> };
  }
  throw new Error(`no moment in ${fixture} with all four data states`);
}

test('L9.1 live, old, silent and contradicted trucks look different from each other', async () => {
  const { offsetMs, ids } = momentWithAllFour('weak-pack');
  await open('weak-pack', offsetMs);

  // On the track: live and old are chips, but drawn differently; silent and contradicted are not
  // chips at all but hatched bars, with different patterns.
  const chip = async (id: string) => page.$eval(`g.chip[data-truck="${id}"]`, (g) => {
    const r = g.querySelector('rect')!;
    const cs = getComputedStyle(r);
    return { kind: (g as SVGGElement).dataset.kind, fill: cs.fill, stroke: cs.stroke, dash: cs.strokeDasharray, text: g.textContent };
  });
  const range = async (id: string) => page.$$eval('g.range', (gs, id) => {
    const g = gs.find((x) => (x as SVGGElement).dataset.trucks!.split(' ').includes(id as string))!;
    const cs = getComputedStyle(g.querySelector('rect.bar')!);
    return { kind: (g as SVGGElement).dataset.kind, fill: cs.fill, stroke: cs.stroke, text: g.textContent };
  }, id);
  const live = await chip(ids.live);
  const old = await chip(ids.old);
  const silent = await range(ids.silent);
  const frozen = await range(ids.contradicted);
  assert.equal(await page.$(`g.chip[data-truck="${ids.silent}"]`), null, 'a silent truck is never a chip');
  assert.equal(await page.$(`g.chip[data-truck="${ids.contradicted}"]`), null, 'a contradicted truck is never a chip');

  assert.equal(live.kind, 'live');
  assert.equal(old.kind, 'old');
  assert.notEqual(live.fill, old.fill, 'old is greyed');
  assert.equal(live.dash, 'none');
  assert.notEqual(old.dash, 'none', 'old has a dashed edge: shape, not only colour');
  assert.match(old.text!, /old \d+ s/, 'old shows its age');

  assert.equal(silent.kind, 'silent');
  assert.equal(frozen.kind, 'contradicted');
  assert.match(silent.fill, /silent-hatch/);
  assert.match(frozen.fill, /frozen-hatch/);
  assert.match(silent.text!, /silent \d+ s/);
  assert.match(frozen.text!, /data frozen/);

  // In the table: each in words, and each with its own marker.
  const row = async (id: string) => page.$eval(`#rows tr[data-truck="${id}"] td.data`, (td) => ({
    text: td.textContent, color: getComputedStyle(td).color, marker: getComputedStyle(td, '::before').content,
  }));
  const rows = await Promise.all([ids.live, ids.old, ids.silent, ids.contradicted].map(row));
  assert.equal(rows[0]!.text, 'live');
  assert.match(rows[1]!.text!, /^old \d+ s$/);
  assert.match(rows[2]!.text!, /^silent \d+ s$/);
  assert.equal(rows[3]!.text, 'contradicted');
  assert.equal(new Set(rows.map((r) => r.marker)).size, 4, `four different markers: ${rows.map((r) => r.marker).join(' ')}`);
  assert.equal(new Set(rows.map((r) => r.color)).size, 4, 'and four different colours');
});

test('state table: site link down greys everything, with a banner that counts', async () => {
  const p = new Player('link-drop-in-notice');
  const down = p.frame().player.bookmarks.find((b) => b.text === 'site link down (no heartbeat)')!;
  await open('link-drop-in-notice', down.offsetMs + 10_000);
  assert.equal(await page.$eval('body', (b) => b.classList.contains('aged')), true);
  assert.notEqual(await page.$eval('main section.track', (m) => getComputedStyle(m).filter), 'none');
  const banner = await page.$eval('#banners .banner.down', (b) => b.textContent);
  assert.match(banner!, /Site link DOWN: no heartbeat for 1\d s/);
  assert.equal(await page.$eval('#site-link', (e) => (e as HTMLElement).dataset.state), 'down');
});

test('state table: zone CLOSING band with a countdown, CLOSED band hatched; UNSURE never CLEAR', async () => {
  const p = new Player('two-zones-closing');
  const tipClosed = p.frame().player.bookmarks.find((b) => b.text.startsWith('TIP CLOSED'))!;
  await open('two-zones-closing', tipClosed.offsetMs + 2_000);
  const band = (z: string) => page.$eval(`g.band[data-zone="${z}"]`, (g) => ({ cls: g.getAttribute('class'), text: g.textContent, fill: getComputedStyle(g.querySelector('rect.bg')!).fill }));
  const draw = await band('DRAW_12');
  const tip = await band('TIP');
  assert.match(draw.cls!, /closing/);
  assert.match(draw.text!, /CLOSING\d+:\d\d/);
  assert.match(tip.cls!, /closed/);
  assert.match(tip.text!, /CLOSED/);
  assert.match(tip.fill, /closed-hatch/);
  const verdicts = await page.$$eval('.zrow', (rs) => rs.map((r) => ({ zone: (r as HTMLElement).dataset.zone, v: r.querySelector('.verdict')!.textContent, action: r.querySelector('.action')!.textContent })));
  assert.deepEqual(verdicts.map((v) => v.zone), ['DRAW_12', 'TIP']);
  for (const v of verdicts) {
    assert.equal(v.v, 'UNSURE');
    assert.equal(v.action, 'Radio the shot firer to hold the shot.');
  }
});

test('UNSURE does not look like CLEAR: different word, glyph, colour, background and edge', async () => {
  const styles = await page.evaluate(() => ['CLEAR', 'UNSURE', 'NOT_CLEAR'].map((v) => {
    const d = document.createElement('div');
    d.className = `verdict ${v}`;
    d.textContent = v;
    document.body.append(d);
    const cs = getComputedStyle(d);
    const out = { v, glyph: getComputedStyle(d, '::before').content, color: cs.color, bg: cs.backgroundImage + cs.backgroundColor, edge: cs.borderTopStyle + cs.borderTopColor };
    d.remove();
    return out;
  }));
  const [clear, unsure, notClear] = styles;
  for (const k of ['glyph', 'color', 'bg', 'edge'] as const) {
    assert.notEqual(clear![k], unsure![k], `CLEAR and UNSURE differ in ${k}`);
    assert.notEqual(clear![k], notClear![k], `CLEAR and NOT CLEAR differ in ${k}`);
  }
});

test('state table: fault mark on the chip, the fault in words in the table', async () => {
  const p = new Player('weak-pack');
  const dead = p.frame().player.bookmarks.find((b) => /HT-06 battery: Battery depleted/.test(b.text))!;
  await open('weak-pack', dead.offsetMs + 3_000);
  assert.match(await page.$eval('g.chip[data-truck="HT-06"]', (g) => g.getAttribute('class')!), /fault/);
  assert.match(await page.$eval('g.chip[data-truck="HT-06"]', (g) => g.textContent!), /⚠ fault/);
  const first = await page.$eval('#rows tr', (tr) => ({ id: (tr as HTMLElement).dataset.truck, text: tr.textContent }));
  assert.equal(first.id, 'HT-06');
  assert.match(first.text!, /BATTERY_DEPLETED/);
  assert.match(first.text!, /depleted: needs a tow/);
});

test('state table: service down — frames stop, the page says disconnected and greys, never a frozen picture as current', async () => {
  await open('frozen-truck', 30_000);
  assert.equal(await page.$eval('#service-link', (e) => (e as HTMLElement).dataset.state), 'up');
  await server.close();
  await page.waitForFunction(() => document.getElementById('service-link')?.dataset.state === 'down', null, { timeout: 6_000 });
  assert.equal(await page.$eval('body', (b) => b.classList.contains('aged')), true);
  assert.match(await page.$eval('#banners', (b) => b.textContent!), /Service DISCONNECTED: nothing for \d+ s\. The picture below is not current\./);
});
