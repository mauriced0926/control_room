// A recorder for the fake gateway that writes what research/capture.py writes for the live one:
// {kind, rx_ms, m | raw}, with 'connected', 'msg', 'unparseable' and 'closed_by_peer', and the same
// reconnect backoff (2, 4, 8, then 10 s). So research/report.py and test/helpers/radio-stats.ts can
// read a fake day exactly as they read a live capture (TESTING.md L0.C1, L0.C3).
import { writeFileSync } from 'node:fs';
import type { Clock } from '../../src/clock.ts';
import type { FakeGateway } from '../../fake/gateway.ts';
import type { FixtureRecord } from './fixtures.ts';

export interface Capture {
  rows: FixtureRecord[];
  send(msg: object): void; // a command or drive message, recorded as 'sent' (as probe.py does)
  write(path: string): void;
}

export function capture(gw: FakeGateway, clock: Clock, email = 'capture@fake.invalid'): Capture {
  const rows: FixtureRecord[] = [];
  let attempt = 0;
  let conn: ReturnType<FakeGateway['attach']> | null = null;
  const connect = () => {
    attempt++;
    let open = true;
    const c = gw.attach({
      write(line) {
        let m: unknown;
        try { m = JSON.parse(line); } catch { rows.push({ kind: 'unparseable', raw: line.slice(0, 500), rx_ms: clock.now() }); return; }
        rows.push({ kind: 'msg', m: m as Record<string, unknown>, rx_ms: clock.now() });
      },
      close() {
        if (!open) return;
        open = false;
        conn = null;
        rows.push({ kind: 'closed_by_peer', rx_ms: clock.now() });
        clock.setTimeout(connect, Math.min(2 ** Math.min(attempt, 4), 10) * 1000);
      },
    });
    conn = c;
    rows.push({ kind: 'connected', attempt, rx_ms: clock.now() });
    c.receive(JSON.stringify({ type: 'auth', email }));
  };
  connect();
  return {
    rows,
    send(msg) {
      const raw = JSON.stringify(msg);
      rows.push({ kind: 'sent', raw, rx_ms: clock.now() });
      conn?.receive(raw);
    },
    write(path) {
      writeFileSync(path, rows.map((r) => JSON.stringify({ ...r })).join('\n') + '\n');
    },
  };
}
