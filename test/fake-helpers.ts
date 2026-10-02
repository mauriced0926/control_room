// Shared harness for the fake gateway tests: a fake on a ManualClock with one authenticated
// in-process client. Not a test file itself (no .test.ts suffix).
import { ManualClock } from '../src/clock.ts';
import type { CommandAck, GatewayMessage, Telemetry } from '../src/protocol.ts';
import { FakeGateway, type FakeConfig, type TestClient } from '../fake/gateway.ts';
import { DLH1 } from '../fake/dlh1.ts';

export const T0 = 1_790_000_000_000;

export interface Harness {
  clock: ManualClock;
  gw: FakeGateway;
  client: TestClient;
  advance(ms: number): void;
  command(vehicle: string, action: string, extra?: Record<string, unknown>, operator?: string): CommandAck;
  sendCommand(body: Record<string, unknown>): CommandAck | undefined;
  drive(vehicle: string, leaseId: string, seq: number, throttle: number, sentMs?: number): void;
  latest(vehicle: string): Telemetry;
  telemetry(vehicle: string): Telemetry[];
  messages<T extends GatewayMessage['type']>(type: T): Array<Extract<GatewayMessage, { type: T }>>;
  // Advance in ticks until pred holds on the vehicle's telemetry; returns the elapsed ms, or -1.
  until(vehicle: string, pred: (t: Telemetry) => boolean, maxMs: number): number;
}

export function harness(config: Partial<FakeConfig> = {}, email = 'tester@example.com'): Harness {
  const clock = new ManualClock(T0);
  const gw = new FakeGateway(clock, { seed: 7, site: DLH1, blasts: 'none', ...config });
  gw.start();
  const client = gw.connect();
  let n = 0;

  // Indexed as lines arrive: re-scanning every message on every poll is quadratic.
  const byType = new Map<string, GatewayMessage[]>();
  const byVehicle = new Map<string, Telemetry[]>();
  const acks = new Map<string, CommandAck>();
  client.onMessage((m) => {
    const list = byType.get(m.type) ?? [];
    list.push(m);
    byType.set(m.type, list);
    if (m.type === 'telemetry') {
      const v = byVehicle.get(m.vehicle_id) ?? [];
      v.push(m);
      byVehicle.set(m.vehicle_id, v);
    }
    if (m.type === 'command_ack') acks.set(m.command_id, m);
  });
  const messages = <T extends GatewayMessage['type']>(type: T) => (byType.get(type) ?? []) as Array<Extract<GatewayMessage, { type: T }>>;
  const lastAck = (id: string) => acks.get(id);
  const telemetry = (v: string) => byVehicle.get(v) ?? [];
  client.send({ type: 'auth', email });

  const h: Harness = {
    clock, gw, client,
    advance: (ms) => clock.advance(ms),
    command(vehicle, action, extra = {}, operator = 'op1') {
      const command_id = `t-${++n}`;
      client.send({ type: 'command', command_id, vehicle_id: vehicle, action, operator_id: operator, ...extra });
      const ack = lastAck(command_id);
      if (!ack) throw new Error(`no ack for ${command_id}`);
      return ack;
    },
    sendCommand(body) {
      client.send({ type: 'command', ...body });
      return typeof body.command_id === 'string' ? lastAck(body.command_id) : undefined;
    },
    drive(vehicle, leaseId, seq, throttle, sentMs) {
      client.send({ type: 'drive', vehicle_id: vehicle, lease_id: leaseId, seq, throttle, ...(sentMs === undefined ? {} : { sent_ms: sentMs }) });
    },
    latest(v) {
      const t = telemetry(v).at(-1);
      if (!t) throw new Error(`no telemetry for ${v}`);
      return t;
    },
    telemetry,
    messages,
    until(vehicle, pred, maxMs) {
      const start = clock.now();
      while (clock.now() - start <= maxMs) {
        const t = telemetry(vehicle).at(-1);
        if (t && pred(t)) return clock.now() - start;
        clock.advance(50);
      }
      return -1;
    },
  };
  return h;
}
