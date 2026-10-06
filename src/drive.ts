// The drive relay: operator keyboard input from the browser to the truck (task 7; TESTING.md L6.3,
// L7.1-L7.7). CLAUDE.md invariant 3 is this file's reason to exist:
//
//   Drive input is relayed only while fresh, and never re-sent or synthesised by the service.
//   Silence means stop: a browser that goes quiet must let the deadman stop the truck.
//
// So every drive message that leaves the service is caused by exactly one input that just arrived
// from the browser, and goes out at once or not at all. There is no timer here that sends anything,
// no queue, no retry, no "last throttle" kept to repeat. If the link is down the input is dropped
// and the truck's deadman stops it (link.sendDrive refuses and queues nothing).
//
// What the relay adds to an input: the lease id from the registry, a seq it keeps strictly increasing
// per lease, and sent_ms on the gateway's clock so the truck's echo can be timed. What it refuses:
// input from anyone but the lease holder, out of order, too large to be a throttle, faster than
// 20 Hz per lease, from a second screen while the first is still driving, and throttle that would
// carry the truck into a zone that is CLOSED, or CLOSING and it can't get through in time (L7.6).
// That last one is not dropped: the input goes out with throttle 0, so the truck stops at once
// instead of half a second later on its deadman. It only ever lowers a throttle, and only when the
// browser has just sent one. Driving out of a zone that isn't open is never refused, either way.
//
// Time is the injected clock.
import type { Clock } from './clock.ts';
import type { FleetState, TruckView, ZoneView } from './fleet.ts';
import { normalise, zoneExit } from './geometry.ts';
import type { GatewayLink } from './link.ts';
import { PARAMS } from './params.ts';
import type { Direction, ZoneStatus } from './protocol.ts';
import type { CommandRegistry } from './registry.ts';
import type { Site } from './site.ts';
import type { AuditEntry } from './store.ts';

// ---- the boundary check (L7.6), pure ----

export interface Boundary {
  direction: Direction;
  distanceM: number;          // from the truck's last reported position to the boundary
  zoneId: string;             // the zone on the far side
  status: ZoneStatus | null;  // null: unknown, never read as open
  effectiveAtMs: number | null;
}

export type DriveCheck =
  | { allow: true }
  | { allow: false; code: 'POSITION_UNKNOWN' | 'DATA_FROZEN' | 'ZONE_CLOSED' | 'CANT_CLEAR'; reason: string; zoneId: string | null };

const STEP_M = 0.01; // just across a boundary, to find the zone on the other side

// The next boundaries from `positionM` in one direction, nearest first, out to `withinM`.
export function boundaries(site: Site, zones: readonly ZoneView[], positionM: number, direction: Direction, withinM = Number.POSITIVE_INFINITY): Boundary[] {
  const out: Boundary[] = [];
  const L = site.loopLengthM;
  let at = normalise(L, positionM);
  let travelled = 0;
  for (let i = 0; i < site.zones.length + 1; i++) {
    const exit = zoneExit(site, at);
    if (!exit) break;
    const d = direction === 'FWD' ? exit.fwdM : exit.revM;
    if (d >= L) break; // the whole loop is one zone
    travelled += d;
    if (travelled > withinM) break;
    const across = direction === 'FWD' ? normalise(L, exit.fwdBoundaryM + STEP_M) : normalise(L, exit.revBoundaryM - STEP_M);
    const zone = site.zoneAt(across);
    if (!zone) break;
    const z = zones.find((x) => x.zoneId === zone.zoneId);
    out.push({ direction, distanceM: travelled, zoneId: zone.zoneId, status: z?.status ?? null, effectiveAtMs: z?.effectiveAtMs ?? null });
    at = across;
    travelled += STEP_M;
  }
  return out;
}

// Top speed under manual control at full throttle: limp-home with a fault, else by load.
export function manualTopSpeed(t: Pick<TruckView, 'faults' | 'loaded'>): { mps: number; limp: boolean } {
  if ((t.faults?.value ?? []).length > 0) return { mps: PARAMS.limpHomeSpeed.value, limp: true };
  return { mps: t.loaded ? PARAMS.manualSpeedLoadedFull.value : PARAMS.manualSpeedEmptyFull.value, limp: false };
}

// How far ahead the check looks: everywhere the truck might be by the time this input has reached it
// and it has stopped. Its position is as old as its last report plus the latency a report can carry,
// then the trip to the gateway, then stopping (the deadman, if our stop is lost), plus a margin.
export function lookaheadM(t: Pick<TruckView, 'speedMps' | 'position'>, requestedMps: number): number {
  const v = Math.max(t.speedMps?.value ?? 0, requestedMps);
  const ms = (t.position?.ageMs ?? 0) + PARAMS.telemetryLatencyAllowance.value + PARAMS.commandUplinkAllowance.value + PARAMS.driveStoppingTime.value;
  return (v * ms) / 1000 + PARAMS.driveBoundaryMargin.value;
}

export function checkDrive(o: { site: Site; zones: readonly ZoneView[]; truck: TruckView; throttle: number; nowServerMs: number }): DriveCheck {
  const { site, zones, truck: t, throttle } = o;
  if (throttle === 0) return { allow: true };
  if (t.confidence === 'contradicted') {
    return { allow: false, code: 'DATA_FROZEN', zoneId: null, reason: `${t.vehicleId}'s data is frozen (it reports moving but its position does not change), so the system can't tell where its zone boundaries are. Driving refused until its data moves again.` };
  }
  if (!t.position || t.confidence === 'unknown') {
    return { allow: false, code: 'POSITION_UNKNOWN', zoneId: null, reason: `${t.vehicleId} has no valid position, so the system can't tell where its zone boundaries are. Driving refused.` };
  }
  const pos = t.position.value.loopM;
  const here = site.zoneAt(pos);
  const hereStatus = here ? zones.find((z) => z.zoneId === here.zoneId)?.status ?? null : null;
  // Inside a zone that isn't open: every way is a way out (CONTEXT.md assumption 10). Limp-home may be
  // the only way out, so this is never refused.
  if (hereStatus !== 'OPEN') return { allow: true };

  const direction: Direction = throttle > 0 ? 'FWD' : 'REV';
  const top = manualTopSpeed(t);
  const requested = Math.abs(throttle) * top.mps;
  const within = lookaheadM(t, requested);
  const way = direction === 'FWD' ? 'forward' : 'in reverse';
  for (const b of boundaries(site, zones, pos, direction, within)) {
    if (b.status === 'OPEN') continue;
    const dist = `${b.distanceM.toFixed(0)} m ${direction === 'FWD' ? 'ahead' : 'behind'}`;
    if (b.status === 'CLOSED' || b.status === null) {
      return { allow: false, code: 'ZONE_CLOSED', zoneId: b.zoneId, reason: `Stopped: ${b.zoneId} is ${b.status === null ? 'of unknown status' : 'CLOSED'}, ${dist}. Driving ${way} into it is refused; you can drive the other way.` };
    }
    // CLOSING: only if it can get right through before it closes, at the throttle asked for.
    const far = boundaries(site, zones, normalise(site.loopLengthM, pos + (direction === 'FWD' ? 1 : -1) * (b.distanceM + STEP_M)), direction)[0];
    const through = b.distanceM + (far?.distanceM ?? Number.POSITIVE_INFINITY);
    const needMs = requested > 0 ? (through / requested) * 1000 + PARAMS.driveStoppingTime.value : Number.POSITIVE_INFINITY;
    const left = b.effectiveAtMs === null ? 0 : b.effectiveAtMs - o.nowServerMs;
    if (needMs >= left) {
      return { allow: false, code: 'CANT_CLEAR', zoneId: b.zoneId, reason: `Stopped: ${b.zoneId} is CLOSING, ${dist}, and at this throttle ${t.vehicleId} can't get through it before it closes (needs ${Math.ceil(needMs / 1000)} s, ${Math.max(0, Math.floor(left / 1000))} s left). Driving ${way} into it is refused; you can drive the other way.` };
    }
  }
  return { allow: true };
}

// ---- the relay ----

export interface DriveSource { id: string; operatorId: string }

export type DriveCode = 'BAD_INPUT' | 'BAD_THROTTLE' | 'UNKNOWN_VEHICLE' | 'NO_LEASE' | 'NOT_YOURS' | 'LEASE_ID_UNKNOWN'
  | 'OTHER_SCREEN' | 'OUT_OF_ORDER' | 'RATE' | 'LINK_DOWN' | Extract<DriveCheck, { allow: false }>['code'];

export interface DriveResult {
  relayed: boolean;     // a drive message went to the gateway because of this input
  throttle: number | null; // the throttle it carried
  code: DriveCode | null;  // why it was not relayed, or why its throttle became 0
  reason: string | null;
}

export interface EchoStats { samples: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null }

export interface DriveView {
  vehicleId: string;
  operatorId: string;
  system: boolean;               // the system holds it (BLAST.md B6a), not an operator
  sinceServerMs: number;
  inputAgeMs: number | null;     // since the service last relayed input on this lease
  lastThrottle: number | null;   // what that input carried to the truck
  lastAsked: number | null;      // what the operator asked for
  echo: {
    seq: number | null;          // the last drive seq the truck reports applying
    ageMs: number | null;        // now minus the sent_ms of that message: round trip plus telemetry sampling plus how long ago that telemetry arrived
    roundTripMs: number | null;  // that telemetry's arrival minus that sent_ms
    stats: EchoStats;            // round trips this lease, for the record
  };
  deadman: boolean | null;       // the truck's own report
  refusal: { code: string; reason: string; zoneId: string | null; atServerMs: number; current: boolean } | null;
  siteRejected: { reason: string; atServerMs: number } | null; // the gateway's drive_rejected
  relayed: number;
  dropped: number;
  topSpeedMps: number | null;
  limp: boolean;
  ahead: { FWD: Boundary | null; REV: Boundary | null };
}

interface Lane {
  vehicleId: string;
  leaseId: string;
  operatorId: string;
  seq: number;
  sourceId: string | null;
  lastN: number;
  lastInputLocal: number;
  lastRelayLocal: number | null;
  lastThrottle: number | null;
  lastAsked: number | null;
  tokens: number;
  tokensAt: number;
  relayed: number;
  dropped: number;
  refusal: DriveView['refusal'];
  roundTrips: number[];
  lastEchoSeq: number | null;
}

export interface DriveRelayOptions {
  clock: Clock;
  fleet: FleetState;
  registry: Pick<CommandRegistry, 'lease' | 'leases'>;
  link: Pick<GatewayLink, 'sendDrive' | 'isUp' | 'subscribe'>;
  log: (line: string) => void;
  audit?: (e: AuditEntry) => void;
}

const MAX_ROUND_TRIPS = 600; // a minute at 10 Hz
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x);

export class DriveRelay {
  readonly #o: DriveRelayOptions;
  readonly #lanes = new Map<string, Lane>();
  readonly #ends = new Map<string, { operatorId: string | null; event: string; reason: string | null; by: string | null; atServerMs: number }>();
  readonly #rejected = new Map<string, { reason: string; atServerMs: number }>();
  readonly #unsub: () => void;

  constructor(o: DriveRelayOptions) {
    this.#o = o;
    this.#unsub = o.link.subscribe((e) => {
      if (e.type !== 'message') return;
      const m = e.msg;
      if (m.type === 'telemetry') this.#echo(m);
      else if (m.type === 'lease_event') this.#leaseEvent(m);
      else if (m.type === 'drive_rejected' && typeof m.vehicle_id === 'string' && typeof m.reason === 'string') {
        this.#rejected.set(m.vehicle_id, { reason: m.reason.slice(0, 40), atServerMs: typeof m.server_time_ms === 'number' ? m.server_time_ms : o.fleet.serverNow() });
      }
    });
  }

  stop(): void { this.#unsub(); }

  // One input from one screen. At most one drive message goes out because of it, now.
  input(src: DriveSource, m: { vehicleId?: unknown; throttle?: unknown; n?: unknown }): DriveResult {
    const no = (code: DriveCode, reason: string): DriveResult => ({ relayed: false, throttle: null, code, reason });
    const v = m.vehicleId;
    if (typeof v !== 'string' || v.length > 64) return no('BAD_INPUT', 'vehicleId must be a truck id');
    const throttle = m.throttle;
    if (typeof throttle !== 'number' || !Number.isFinite(throttle) || throttle < -1 || throttle > 1) {
      return no('BAD_THROTTLE', 'throttle must be a number from -1 to 1. Nothing was sent.');
    }
    if (!isInt(m.n) || m.n < 1) return no('BAD_INPUT', 'n must be a whole number from 1 (this screen\'s input counter)');
    const truck = this.#o.fleet.truck(v);
    if (!truck || truck.onRoster !== true) return no('UNKNOWN_VEHICLE', `${v} is not a truck on this site`);

    const lease = this.#o.registry.lease(v);
    if (!lease) return no('NO_LEASE', `${this.#lostWords(v, src.operatorId) ?? `You don't have control of ${v}.`} Nothing was sent to the truck.`);
    if (lease.operatorId !== src.operatorId) {
      const lost = this.#lostWords(v, src.operatorId);
      return no('NOT_YOURS', `${lost ?? `${lease.operatorId} has control of ${v}, not you.`} Your input was not sent.`);
    }
    if (!lease.leaseId) return no('LEASE_ID_UNKNOWN', `This service doesn't know the lease id for ${v} (control was taken before it connected). Press Take control again: the site returns the same lease.`);

    const now = this.#o.clock.now();
    let lane = this.#lanes.get(v);
    if (!lane || lane.leaseId !== lease.leaseId) {
      lane = {
        vehicleId: v, leaseId: lease.leaseId, operatorId: lease.operatorId, seq: 0, sourceId: null, lastN: 0, lastInputLocal: now,
        lastRelayLocal: null, lastThrottle: null, lastAsked: null, tokens: PARAMS.driveRelayBurst.value, tokensAt: now,
        relayed: 0, dropped: 0, refusal: null, roundTrips: [], lastEchoSeq: null,
      };
      this.#lanes.set(v, lane);
    }
    // One screen drives a lease. Another screen of the same operator takes over only once the first has
    // gone quiet for longer than the deadman.
    if (lane.sourceId !== null && lane.sourceId !== src.id) {
      if (now - lane.lastInputLocal <= PARAMS.deadman.value) { lane.dropped++; return no('OTHER_SCREEN', `${v} is being driven from another of your screens. Stop there first.`); }
      lane.lastN = 0;
    }
    lane.sourceId = src.id;
    if (m.n <= lane.lastN) { lane.dropped++; return no('OUT_OF_ORDER', 'older than input already received: dropped'); }
    lane.lastN = m.n;
    lane.lastInputLocal = now;
    lane.lastAsked = throttle;

    const rate = PARAMS.driveRelayMaxRate.value;
    lane.tokens = Math.min(PARAMS.driveRelayBurst.value, lane.tokens + ((now - lane.tokensAt) / 1000) * rate);
    lane.tokensAt = now;
    if (lane.tokens < 1) { lane.dropped++; return no('RATE', `more than ${rate} inputs a second: dropped`); }
    lane.tokens -= 1;

    if (!this.#o.link.isUp()) { lane.dropped++; return no('LINK_DOWN', `Site link down: not sent. ${v} stops on its deadman.`); }

    const site = this.#o.fleet.site;
    const snap = this.#o.fleet.snapshot();
    const check: DriveCheck = site ? checkDrive({ site, zones: snap.zones, truck, throttle, nowServerMs: snap.atServerMs }) : { allow: false, code: 'POSITION_UNKNOWN', zoneId: null, reason: 'No site description yet. Driving refused.' };
    const out = check.allow ? throttle : 0;

    // seq: strictly increasing within the lease, carried on from the truck's own echo so a restarted
    // service doesn't send seqs the truck would discard.
    const c = truck.control?.value;
    const echoed = c && c.operatorId === lease.operatorId && isInt(c.lastDriveSeq) ? c.lastDriveSeq : 0;
    const seq = Math.max(lane.seq, echoed) + 1;
    const sentMs = this.#o.fleet.serverNow();
    const ok = this.#o.link.sendDrive({ type: 'drive', vehicle_id: v, lease_id: lease.leaseId, seq, throttle: out, sent_ms: sentMs });
    if (!ok) { lane.dropped++; return no('LINK_DOWN', `Site link down: not sent. ${v} stops on its deadman.`); }
    lane.seq = seq;
    lane.relayed++;
    lane.lastRelayLocal = now;
    lane.lastThrottle = out;

    if (!check.allow) {
      const started = !lane.refusal?.current || lane.refusal.code !== check.code || lane.refusal.zoneId !== check.zoneId;
      lane.refusal = { code: check.code, reason: check.reason, zoneId: check.zoneId, atServerMs: sentMs, current: true };
      if (started) this.#refusalStarted(lane, check, throttle);
      return { relayed: true, throttle: 0, code: check.code, reason: check.reason };
    }
    if (lane.refusal && throttle !== 0) lane.refusal.current = false;
    return { relayed: true, throttle: out, code: null, reason: null };
  }

  // Every lease the registry knows, with what the relay knows about it.
  views(): DriveView[] {
    const now = this.#o.clock.now();
    const snap = this.#o.fleet.snapshot();
    const site = this.#o.fleet.site;
    return this.#o.registry.leases().map((l) => {
      const lane = this.#lanes.get(l.vehicleId);
      const live = lane && lane.leaseId === l.leaseId ? lane : undefined;
      const t = snap.trucks.find((x) => x.vehicleId === l.vehicleId);
      const c = t?.control?.value;
      const sent = c?.lastDriveSentMs ?? null;
      const mine = c?.operatorId === l.operatorId;
      const top = t ? manualTopSpeed(t) : null;
      const pos = t?.position?.value.loopM;
      const ahead = (d: Direction) => (site && pos !== undefined ? boundaries(site, snap.zones, pos, d)[0] ?? null : null);
      const rt = live?.roundTrips ?? [];
      const rej = this.#rejected.get(l.vehicleId);
      return {
        vehicleId: l.vehicleId, operatorId: l.operatorId, system: l.operatorId.startsWith('system:'), sinceServerMs: l.sinceServerMs,
        inputAgeMs: live?.lastRelayLocal != null ? now - live.lastRelayLocal : null,
        lastThrottle: live?.lastThrottle ?? null, lastAsked: live?.lastAsked ?? null,
        echo: {
          seq: mine && c ? c.lastDriveSeq : null,
          ageMs: mine && sent !== null ? snap.atServerMs - sent : null,
          roundTripMs: mine && sent !== null && t?.control ? t.control.atServerMs - sent : null,
          stats: stats(rt),
        },
        deadman: mine && c ? c.deadman : null,
        refusal: live?.refusal ?? null,
        siteRejected: rej && rej.atServerMs >= l.sinceServerMs ? rej : null,
        relayed: live?.relayed ?? 0, dropped: live?.dropped ?? 0,
        topSpeedMps: top?.mps ?? null, limp: top?.limp ?? false,
        ahead: { FWD: ahead('FWD'), REV: ahead('REV') },
      };
    });
  }

  // Each new echo: how long after we sent it the truck's report of applying it arrived.
  #echo(m: Record<string, unknown>): void {
    const v = typeof m.vehicle_id === 'string' ? m.vehicle_id : null;
    const lane = v ? this.#lanes.get(v) : undefined;
    const c = m.control as Record<string, unknown> | undefined;
    if (!lane || !c || typeof c !== 'object' || !isInt(c.last_drive_seq) || typeof c.last_drive_sent_ms !== 'number') return;
    if (c.operator_id !== lane.operatorId || c.last_drive_seq === lane.lastEchoSeq || c.last_drive_seq > lane.seq) return;
    lane.lastEchoSeq = c.last_drive_seq;
    lane.roundTrips.push(this.#o.fleet.serverNow() - c.last_drive_sent_ms);
    if (lane.roundTrips.length > MAX_ROUND_TRIPS) lane.roundTrips.shift();
  }

  #leaseEvent(m: Record<string, unknown>): void {
    const v = typeof m.vehicle_id === 'string' ? m.vehicle_id : null;
    if (!v || !['RELEASED', 'EXPIRED', 'REVOKED'].includes(String(m.event))) return;
    const str = (x: unknown) => (typeof x === 'string' ? x : null);
    this.#ends.set(v, { operatorId: str(m.operator_id), event: String(m.event), reason: str(m.reason), by: str(m.by_operator), atServerMs: typeof m.server_time_ms === 'number' ? m.server_time_ms : this.#o.fleet.serverNow() });
    const lane = this.#lanes.get(v);
    if (lane && (str(m.lease_id) === null || str(m.lease_id) === lane.leaseId)) this.#lanes.delete(v);
  }

  // Why this operator no longer has control, if the site told us.
  #lostWords(v: string, operatorId: string): string | null {
    const e = this.#ends.get(v);
    if (!e || e.operatorId !== operatorId) return null;
    if (e.event === 'REVOKED' && e.reason === 'FORCED_TAKEOVER') return `${e.by ?? 'A supervisor'} took control of ${v} from you.`;
    if (e.event === 'REVOKED' && e.reason === 'ESTOP') return `${v} was e-stopped${e.by ? ` by ${e.by}` : ''}; your control ended.`;
    if (e.event === 'REVOKED') return `Your control of ${v} was revoked (${e.reason ?? 'no reason given'}).`;
    if (e.event === 'EXPIRED') return `Your control of ${v} expired: no drive input for ${PARAMS.leaseIdleTimeout.value / 1000} s. Take control again to drive.`;
    return `You handed ${v} back.`;
  }

  #refusalStarted(lane: Lane, check: Extract<DriveCheck, { allow: false }>, asked: number): void {
    this.#o.log(`drive refused for ${lane.vehicleId} (${lane.operatorId}, throttle ${asked}): ${check.reason}`);
    try {
      this.#o.audit?.({
        atMs: this.#o.clock.now(), serverMs: this.#o.fleet.serverNow(), actorKind: 'operator', actor: lane.operatorId, rule: null,
        event: 'drive_refused', vehicleId: lane.vehicleId, recordId: null, commandId: null,
        what: `Drive input from ${lane.operatorId} sent as a stop (throttle ${asked} asked): ${check.code}`, why: check.reason, inputs: undefined,
      });
    } catch (e) { this.#o.log(`could not write a drive refusal to the audit log: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

function stats(xs: readonly number[]): EchoStats {
  if (xs.length === 0) return { samples: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { samples: s.length, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: s.at(-1)! };
}
