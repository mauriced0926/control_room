// Screenshots of the Overview at each fixture's telling moment, for docs/screenshots/ and the README
// walkthrough:
//   node player/shoot.ts [--out docs/screenshots] [--only name]
// Each moment is found from the data (a bookmark the player derived from the replay), never from a
// hard-coded time. Drives the locally installed Google Chrome through playwright-core: Playwright's
// own browser builds do not support this macOS 12 machine, so no browser is downloaded. What each
// screenshot shows is written in docs/screenshots/README.md, by a person who looked at it.
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { SystemClock } from '../src/clock.ts';
import type { Player } from './player.ts';
import { startPlayerServer } from './server.ts';

export interface Shot {
  file: string;
  fixture: string;
  // The moment: a bookmark's text (first match), plus an offset after it.
  mark: RegExp | null;
  after: number;
}

export const SHOTS: Shot[] = [
  { file: '01-frozen-truck.png', fixture: 'frozen-truck', mark: /HT-10 data frozen/, after: 20_000 },
  { file: '02-frozen-truck-loading-contrast.png', fixture: 'frozen-truck', mark: null, after: Number.POSITIVE_INFINITY },
  { file: '03-silent-truck-old.png', fixture: 'silent-truck', mark: /HT-03 silent/, after: -2_500 },
  { file: '04-silent-truck.png', fixture: 'silent-truck', mark: /HT-03 silent/, after: 25_000 },
  { file: '05-link-drop-in-notice.png', fixture: 'link-drop-in-notice', mark: /site link down/, after: 15_000 },
  { file: '06-two-zones-closing.png', fixture: 'two-zones-closing', mark: null, after: 5_000 },
  { file: '07-two-zones-one-closed.png', fixture: 'two-zones-closing', mark: /TIP CLOSED/, after: 3_000 },
  { file: '08-weak-pack-wont-finish-lap.png', fixture: 'weak-pack', mark: /HT-06 battery: Will not finish/, after: 5_000 },
  { file: '09-weak-pack-cannot-reach-bay.png', fixture: 'weak-pack', mark: /HT-06 battery: May not reach/, after: 2_000 },
  { file: '10-weak-pack-depleted.png', fixture: 'weak-pack', mark: /HT-06 battery: Battery depleted/, after: 5_000 },
  { file: '11-fractional-soc.png', fixture: 'fractional-soc', mark: null, after: 8_000 },
  { file: '12-reverse-exit-zone.png', fixture: 'reverse-exit-zone', mark: /probe sent EXIT_ZONE/, after: 20_000 },
  { file: '13-seq-reset.png', fixture: 'seq-reset', mark: /controller restarted/, after: 3_000 },
];

async function moment(player: Player, s: Shot): Promise<number> {
  player.load(s.fixture);
  const f = player.frame().player;
  let base = 0;
  if (s.mark) {
    const b = f.bookmarks.find((x) => s.mark!.test(x.text));
    if (!b) throw new Error(`${s.file}: no bookmark matching ${s.mark} in ${s.fixture}: ${f.bookmarks.map((x) => x.text).join(' | ')}`);
    base = b.offsetMs;
  }
  return Math.max(0, Math.min(base + s.after, f.endMs - f.startMs));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'docs/screenshots' }, only: { type: 'string' } } });
  mkdirSync(values.out, { recursive: true });
  const server = await startPlayerServer({ clock: new SystemClock(), fixture: 'frozen-truck' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, colorScheme: 'dark' });
    for (const s of SHOTS.filter((x) => !values.only || x.file.includes(values.only))) {
      const t = await moment(server.player, s);
      await page.goto(`${server.url}?fixture=${s.fixture}&t=${t}`);
      await page.waitForSelector('#rows tr');
      await page.waitForTimeout(600); // let chips settle after their 200 ms glide
      await page.screenshot({ path: `${values.out}/${s.file}`, fullPage: true });
      console.log(`${s.file}  ${s.fixture} +${(t / 1000).toFixed(1)} s`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
}
