// The radio between the trucks and the gateway (TESTING.md L0.F): telemetry lost, duplicated, late
// (so reordered) and truncated; acks slow and sometimes lost. Applied once for the whole site, so
// every client sees the same stream. Gateway messages (hello, heartbeats, zone and lease events,
// drive rejections) do not pass through it: live they arrived complete and on time.
//
// Every fault is drawn from its own seeded stream and written to the truth log with the truck and seq.
import type { Clock } from '../src/clock.ts';
import type { CommandAck } from '../src/protocol.ts';
import type { Behaviour } from './behaviour.ts';
import type { CommandMatch, Faults, TruthLog } from './faults.ts';
import { Rng } from './rng.ts';

export type Deliver = (line: string) => void;

export class SiteRadio {
  readonly #clock: Clock;
  readonly #b: Behaviour;
  readonly #f: Faults;
  readonly #log: TruthLog;
  readonly #deliver: Deliver;
  readonly #rngTel: Rng;
  readonly #rngAck: Rng;

  constructor(clock: Clock, b: Behaviour, faults: Faults, log: TruthLog, seed: number, deliver: Deliver) {
    this.#clock = clock;
    this.#b = b;
    this.#f = faults;
    this.#log = log;
    this.#deliver = deliver;
    const root = new Rng(seed);
    this.#rngTel = root.fork('radio-telemetry');
    this.#rngAck = root.fork('radio-acks');
  }

  // One telemetry line. The draws are made whether or not each fault is on, so switching one fault
  // on or off never changes another's pattern.
  telemetry(line: string, vehicle: string, seq: unknown): void {
    const r = this.#rngTel, b = this.#b, f = this.#f;
    const lost = r.chance(b.lossProbability);
    const truncate = r.chance(b.truncateProbability);
    const cutAt = r.int(b.truncateMinChars, b.truncateMaxChars);
    const late = r.chance(b.lateProbability);
    const lateBy = Math.round(r.uniform(b.lateMinDelayMs, b.lateMaxDelayMs));
    const dup = r.chance(b.duplicateProbability);
    const dupAfter = Math.round(r.uniform(0, b.duplicateMaxDelayMs));
    const now = this.#clock.now();

    if (f.loss && lost) { this.#log.event(now, vehicle, 'lost', { seq }); return; }
    let sent = line;
    if (f.truncation && truncate && line.length > cutAt) {
      sent = line.slice(0, cutAt);
      this.#log.event(now, vehicle, 'truncated', { seq, chars: cutAt });
    }
    const delay = f.reordering && late ? lateBy : 0;
    if (delay > 0) this.#log.event(now, vehicle, 'late', { seq, byMs: delay });
    this.#at(delay, sent);
    if (f.duplicates && dup) {
      this.#log.event(now, vehicle, 'duplicate', { seq, afterMs: delay + dupAfter });
      this.#at(delay + dupAfter, sent);
    }
  }

  // An ack. Its server_time_ms stays the time the gateway got the command, as live; it arrives
  // later. `n` is the order the command was received in, for CommandMatch.
  ack(line: string, ack: CommandAck, n: number, action: string): void {
    const r = this.#rngAck, b = this.#b, f = this.#f;
    const invalid = ack.reason === 'BAD_JSON' || ack.reason === 'BAD_COMMAND_ID';
    // Commands that act at once (e-stop, leases) were acked within 0.7 s live; the rest up to 2.6 s.
    const immediate = ['ESTOP', 'CLEAR_ESTOP', 'TAKE_CONTROL', 'RELEASE_CONTROL'].includes(action);
    const max = immediate ? b.ackDelayImmediateMaxMs : b.ackDelayMaxMs;
    const delay = invalid
      ? Math.round(r.uniform(b.ackDelayInvalidMinMs, b.ackDelayInvalidMaxMs))
      : Math.round(Math.exp(r.uniform(Math.log(b.ackDelayMinMs), Math.log(max)))); // log-uniform
    const lost = r.chance(b.lostAckProbability);
    if (matches(f.lostAcks, lost, { n, command_id: ack.command_id, vehicle_id: ack.vehicle_id ?? '', action })) {
      this.#log.event(this.#clock.now(), ack.vehicle_id, 'lost_ack', { command_id: ack.command_id, action, status: ack.status });
      return;
    }
    this.#at(f.ackLatency ? delay : 0, line);
  }

  #at(delayMs: number, line: string): void {
    if (delayMs <= 0) this.#deliver(line);
    else this.#clock.setTimeout(() => this.#deliver(line), delayMs);
  }
}

// A command fault switch: off, on at the measured rate (`drawn` is that draw), or a predicate.
export function matches(sw: boolean | CommandMatch | undefined, drawn: boolean, c: Parameters<CommandMatch>[0]): boolean {
  if (!sw) return false;
  if (sw === true) return drawn;
  return sw(c);
}
