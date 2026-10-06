// Which things interrupt and which stay silent (TESTING.md L2.60-L2.62; CONTEXT.md assumption 11:
// interrupt only for action needed inside the next minute). This turns what the registry, the link
// and fleet state report into alarms in the shared shape (src/alarms.ts) for the store
// (src/attention.ts). Every alarm carries the rule that made it interrupt or kept it silent, in
// words, with the case it comes from.
//
// The blast engine raises its own can't-clear alarms in the same shape. Until it is wired in, a
// provisional alarm here interrupts for every closing or closed zone the provisional clearance rule
// (src/clearance.ts) does not call CLEAR, so a zone that might not be clear is never silent.
//
// Pure apart from its subscriptions: time is the fleet's server time.
import type { AlarmRaise } from './alarms.ts';
import type { AlarmStore } from './attention.ts';
import { DEPLETED_FAULT } from './battery.ts';
import { HOLD_THE_SHOT, zoneClearance } from './clearance.ts';
import type { FleetSnapshot, FleetState, TruckView, ZoneView } from './fleet.ts';
import type { GatewayLink } from './link.ts';
import { PARAMS } from './params.ts';
import type { CommandRecord, CommandRegistry } from './registry.ts';
import type { Site } from './site.ts';
import type { TruckNotes } from './trucknotes.ts';
import { dataState } from './words.ts';

export const RULES = {
  cantClearProvisional: 'Interrupts (L2.60): this zone might not be clear and the shot must be held now. Provisional rule until the blast engine takes over (src/clearance.ts)',
  commandFailedNear: 'Interrupts (L2.60): a command did not take effect after its last retry, and the truck is in or approaching a closing zone',
  commandFailedEstop: 'Interrupts (L2.60): an e-stop that was never confirmed is a stop that may not have happened',
  commandFailedFar: 'Silent (L2.61): the command failed, but the truck is not in or approaching a closing zone, so it can wait more than a minute. Acknowledging is not needed; it leaves the tray after 10 min',
  estopUndelivered: 'Interrupts (L2.60): an e-stop that has not reached the truck',
  batteryCannotReach: 'Interrupts (L2.60): a truck that cannot reach the bay on its charge has to be sent home now, while it still can (L2.28)',
  batteryWeak: 'Silent (L2.61): draining faster than the fleet, but it can still reach the bay. Sending it home is your call (assumption 13)',
  batteryDepleted: 'Silent: it needs a tow and nothing in the control room changes that in the next minute. If a zone closes on it, the clearance alarm interrupts',
  fault: 'Silent: a fault cannot be cleared from the control room (PROTOCOL.md 4.5). If a zone closes on it, the clearance alarm interrupts',
  restart: 'Silent (L2.61): a controller restart needs no action; its new data is being used. Leaves the tray after 10 min; truck detail keeps it',
  lostAck: 'Silent (L2.61): the command worked; only its acknowledgement from the site was lost. Leaves the tray after 10 min',
  old: 'Silent (L2.61): its data is a few seconds old; nothing to do unless it goes silent',
  doubtFar: 'Silent (L2.61): its data cannot be trusted, but it cannot be in any closing or closed zone',
  doubtNear: 'Silent here (L2.64, one cause one alarm): it might be in a closing or closed zone, and that zone\'s clearance alarm carries it',
  dataQuality: 'Silent (L2.61): bad lines are counted and dropped or repaired; nothing to do',
  linkDownClosing: 'Interrupts (L2.60): the site link is down while a zone is closing or closed, so nobody can see whether it is clear',
  linkDownQuiet: 'Silent: no zone is closing. The picture greys and the banner counts the outage; the service reconnects by itself',
  linkStopped: 'Interrupts (L2.44): the service has stopped trying to reach the site and needs a person',
} as const;

// Alarms that end when someone acknowledges them: they report something that happened, with no
// later condition that would clear them.
export const ENDS_ON_ACK: ReadonlySet<string> = new Set(['command_failed']);

export interface AlertingOptions {
  fleet: Pick<FleetState, 'subscribe' | 'serverNow' | 'site'>;
  link: Pick<GatewayLink, 'subscribe'>;
  registry: Pick<CommandRegistry, 'subscribe'>;
  store: AlarmStore;
  notes: TruckNotes;
  provisionalBlast: () => boolean; // true while the blast engine is not raising its own can't-clear alarms
}

export class Alerting {
  readonly #o: AlertingOptions;
  #derived = new Set<string>();                 // keys raised from the latest snapshot
  readonly #expires = new Map<string, number>(); // notice items: key -> server ms to clear at
  readonly #actions = new Map<string, string>(); // record id -> action, for alarms that name a record
  #linkStopped: string | null = null;
  #last: FleetSnapshot | null = null;
  readonly #unsub: Array<() => void> = [];

  constructor(o: AlertingOptions) {
    this.#o = o;
    this.#unsub.push(o.registry.subscribe((e) => {
      if (e.type === 'command') this.#command(e.record);
      else if (e.type === 'alarm') this.#registryAlarm(e.kind, e.vehicleId, e.recordId, e.message);
    }));
    this.#unsub.push(o.fleet.subscribe((e) => {
      if (e.type === 'controller_restart') {
        o.notes.restart(e.vehicleId, e.detail, e.atServerMs);
        this.#notice({ source: 'data', kind: 'controller_restart', key: `data:controller_restart:${e.vehicleId}`, vehicleId: e.vehicleId, zoneId: null,
          message: `${e.vehicleId}'s controller restarted: ${e.detail}.`, action: null, interrupt: false, rule: RULES.restart });
      }
    }));
    this.#unsub.push(o.link.subscribe((e) => {
      if (e.type === 'alarm') {
        this.#linkStopped = e.message;
        this.#raise({ source: 'link', kind: 'link_stopped', key: 'link:stopped', vehicleId: null, zoneId: null, message: e.message, action: 'Check the gateway settings and restart the service', interrupt: true, rule: RULES.linkStopped });
      } else if (e.type === 'up' && this.#linkStopped) {
        this.#linkStopped = null;
        this.#o.store.clear('link:stopped', 'the site link is up again', this.#now());
      }
    }));
  }

  stop(): void { for (const u of this.#unsub) u(); }

  // Everything that follows from the picture itself, re-derived from each snapshot: the link,
  // batteries, data doubt, faults, and the provisional can't-clear alarm.
  evaluate(snap: FleetSnapshot): void {
    this.#last = snap;
    const now = snap.atServerMs;
    this.#o.notes.observe(snap);
    const want = new Map<string, Omit<AlarmRaise, 'type' | 'atServerMs'>>();
    const add = (r: Omit<AlarmRaise, 'type' | 'atServerMs'>) => want.set(r.key, r);
    const notOpen = snap.zones.filter((z) => z.status !== 'OPEN');
    const closing = snap.zones.filter((z) => z.status === 'CLOSING' || z.status === 'CLOSED');
    // No heartbeat yet just after connecting is not an outage; the link's own watchdog says when it is.
    const linkDown = snap.link.up === false || (snap.heartbeat.stale && snap.heartbeat.ageMs !== null);

    if (linkDown && snap.link.up !== null) {
      const names = notOpen.map((z) => `${z.zoneId} (${z.status ?? 'status unknown'})`).join(', ');
      add(notOpen.length
        ? { source: 'link', kind: 'link_down', key: 'link:down', vehicleId: null, zoneId: notOpen[0]!.zoneId,
          message: `Site link down while ${names} ${notOpen.length > 1 ? 'are' : 'is'} not open. Nothing on screen can say whether ${notOpen.length > 1 ? 'they are' : 'it is'} clear.`,
          action: HOLD_THE_SHOT, interrupt: true, rule: RULES.linkDownClosing }
        : { source: 'link', kind: 'link_down', key: 'link:down', vehicleId: null, zoneId: null,
          message: 'Site link down: every truck is shown as it last reported, ageing.', action: null, interrupt: false, rule: RULES.linkDownQuiet });
    }

    // While the link is down every truck goes old, then silent: that is one cause, the link, so no
    // per-truck items until it is back.
    if (!linkDown) {
      for (const t of snap.trucks) this.#truck(t, closing, add);
      const dq = Object.entries(snap.dataQuality.connection).filter(([k]) => k !== 'blank');
      const total = dq.reduce((n, [, v]) => n + v, 0);
      if (total > 0) {
        const top = dq.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v} ${k}`).join(', ');
        add({ source: 'data', kind: 'data_quality', key: 'data:quality', vehicleId: null, zoneId: null, message: `${total} data-quality events on this connection (${top}).`, action: null, interrupt: false, rule: RULES.dataQuality });
      }
    }

    // Provisional can't-clear: new ones only while the link is up (while it is down, the link
    // alarm carries it); kept until the zone reopens or is called CLEAR.
    const provisional = new Set<string>();
    if (this.#o.provisionalBlast()) {
      for (const z of closing) {
        const key = `blast:provisional:${z.zoneId}`;
        const c = zoneClearance(z, snap.trucks);
        if (c.verdict === 'CLEAR') continue;
        if (linkDown && !this.#o.store.get(key)) continue;
        provisional.add(key);
        if (linkDown) continue; // keep the words from when the data could be seen
        const words = c.verdict === 'NOT_CLEAR' ? 'NOT CLEAR' : 'UNSURE';
        add({ source: 'blast', kind: 'cant_clear', key, vehicleId: c.reasons[0]?.vehicleIds[0] ?? null, zoneId: z.zoneId,
          message: `${z.zoneId} ${words} (${z.status}): ${c.reasons.map((r) => `${r.vehicleIds.join(', ')} ${r.why}`).join('; ')}.`,
          action: HOLD_THE_SHOT, interrupt: true, rule: RULES.cantClearProvisional });
      }
    }

    for (const r of want.values()) this.#raise(r, now);
    for (const key of this.#derived) {
      if (!want.has(key) && !provisional.has(key)) this.#o.store.clear(key, this.#whyGone(key, snap), now);
    }
    this.#derived = new Set([...want.keys(), ...provisional]);
    for (const [key, at] of this.#expires) if (now >= at) { this.#expires.delete(key); this.#o.store.clear(key, 'shown for 10 min', now); }
  }

  #truck(t: TruckView, closing: ZoneView[], add: (r: Omit<AlarmRaise, 'type' | 'atServerMs'>) => void): void {
    const v = t.vehicleId;
    const b = t.battery;
    if (b.warning === 'CANNOT_REACH_BAY' || b.warning === 'WONT_FINISH_LAP') {
      add({ source: 'battery', kind: 'battery_reach', key: `battery:reach:${v}`, vehicleId: v, zoneId: t.position?.value.zoneId ?? null,
        message: `${v}: ${b.message ?? 'may not reach the bay'}.`, action: `Send ${v} Return to bay`, interrupt: true, rule: RULES.batteryCannotReach });
    } else if (b.warning === 'DEPLETED') {
      add({ source: 'battery', kind: 'battery_depleted', key: `battery:depleted:${v}`, vehicleId: v, zoneId: t.position?.value.zoneId ?? null,
        message: `${v}: battery depleted where it stands${t.position ? ` in ${t.position.value.zoneId}` : ''}. Needs a tow; it cannot be driven.`, action: 'Arrange a tow', interrupt: false, rule: RULES.batteryDepleted });
    } else if (b.drainHigh) {
      const r = Math.max(b.ratioToFleet.empty ?? 0, b.ratioToFleet.loaded ?? 0);
      add({ source: 'battery', kind: 'battery_weak', key: `battery:weak:${v}`, vehicleId: v, zoneId: null,
        message: `${v} is draining ${r.toFixed(1)}× faster than the fleet; it can still reach the bay.`, action: null, interrupt: false, rule: RULES.batteryWeak });
    }
    const faults = t.faults?.value ?? [];
    if (faults.length && !faults.every((f) => f === DEPLETED_FAULT)) {
      const notes = this.#o.notes.get(v).faults.filter((f) => f.endedServerMs === null);
      const where = notes.find((n) => n.where)?.where;
      add({ source: 'data', kind: 'fault', key: `data:fault:${v}`, vehicleId: v, zoneId: where?.zoneId ?? null,
        message: `${v} faulted: ${faults.join(', ')}${where ? `, in ${where.zoneId} (${where.segmentId} at ${where.offsetM.toFixed(0)} m)` : ''}.`, action: null, interrupt: false, rule: RULES.fault });
    }
    if (t.confidence === 'old' || t.confidence === 'silent' || t.confidence === 'contradicted') {
      const touches = closing.filter((z) => t.range === null || t.mightBeIn.includes(z.zoneId)).map((z) => z.zoneId);
      const rule = t.confidence === 'old' ? RULES.old : touches.length ? RULES.doubtNear : RULES.doubtFar;
      add({ source: 'data', kind: `data_${t.confidence}`, key: `data:doubt:${v}`, vehicleId: v, zoneId: touches[0] ?? null,
        message: `${v}: ${dataState(t)}${t.confidence === 'contradicted' ? ' (reports moving but has not moved)' : ''}${t.position ? `; last seen in ${t.position.value.zoneId}` : ''}${touches.length ? `; might be in ${touches.join(', ')}` : ''}.`,
        action: null, interrupt: false, rule });
    }
  }

  #whyGone(key: string, snap: FleetSnapshot): string {
    if (key.startsWith('blast:provisional:')) {
      const z = snap.zones.find((x) => x.zoneId === key.slice('blast:provisional:'.length));
      return z?.status === 'OPEN' ? `${z.zoneId} reopened (${z.reason ?? 'open'})` : `${z?.zoneId ?? 'the zone'} is now called CLEAR`;
    }
    if (key === 'link:down') return 'the site link is up again';
    return 'no longer the case';
  }

  // ---- the registry ----

  #command(r: CommandRecord): void {
    this.#actions.set(r.id, r.action);
    if (this.#actions.size > 2_000) this.#actions.delete(this.#actions.keys().next().value!);
    const now = this.#now();
    if (r.action === 'ESTOP' && r.status !== 'pending') {
      const why = r.status === 'confirmed' ? 'the truck reports ESTOPPED' : r.status === 'cancelled' ? 'cancelled before it was sent' : r.status === 'sent' || r.status === 'acknowledged' ? 'sent to the truck' : `the e-stop ${r.status}`;
      this.#o.store.clear(`registry:estop_undelivered:${r.id}`, why, now);
    }
    if (r.status === 'confirmed') {
      this.#o.store.clear(`registry:command_failed:${r.vehicleId}`, `a later ${r.action} on ${r.vehicleId} was confirmed`, now);
      if (r.effect && !r.effect.ackReceived) {
        this.#notice({ source: 'registry', kind: 'lost_ack', key: `registry:lost_ack:${r.id}`, vehicleId: r.vehicleId, zoneId: null,
          message: `${r.action} ${r.vehicleId} worked (${r.effect.detail}), but the site's acknowledgement never arrived.`, action: null, interrupt: false, rule: RULES.lostAck });
      } else {
        this.#o.store.clear(`registry:lost_ack:${r.id}`, 'the acknowledgement arrived late', now);
      }
    }
  }

  #registryAlarm(kind: 'command_failed' | 'estop_undelivered', vehicleId: string, recordId: string, message: string): void {
    if (kind === 'estop_undelivered') {
      this.#raise({ source: 'registry', kind, key: `registry:estop_undelivered:${recordId}`, vehicleId, zoneId: null, message, action: 'Confirm the e-stop again or cancel it; use the radio if the truck must stop now', interrupt: true, rule: RULES.estopUndelivered });
      return;
    }
    const estop = this.#actions.get(recordId) === 'ESTOP';
    const near = estop ? null : this.#nearClosing(vehicleId);
    const interrupt = estop || near !== null;
    const key = `registry:command_failed:${vehicleId}`;
    this.#raise({ source: 'registry', kind, key, vehicleId, zoneId: near, message: `${message}${near ? ` ${vehicleId} is in or approaching ${near}.` : ''}`,
      action: `Open ${vehicleId} and decide: send again, hold it, or drive it`, interrupt, rule: estop ? RULES.commandFailedEstop : interrupt ? RULES.commandFailedNear : RULES.commandFailedFar });
    if (!interrupt) this.#expires.set(key, this.#now() + PARAMS.noticeItemFor.value);
  }

  // The closing or closed zone a truck is in, might be in, or will enter next along the route.
  #nearClosing(vehicleId: string): string | null {
    const snap = this.#last;
    const t = snap?.trucks.find((x) => x.vehicleId === vehicleId);
    if (!snap || !t) return null;
    const closing = new Set(snap.zones.filter((z) => z.status === 'CLOSING' || z.status === 'CLOSED').map((z) => z.zoneId));
    if (closing.size === 0) return null;
    if (t.range === null) return [...closing][0]!;
    const inside = t.mightBeIn.find((z) => closing.has(z));
    if (inside) return inside;
    const next = this.#o.fleet.site && t.position ? nextZone(this.#o.fleet.site, t.position.value.segmentId) : null;
    return next && closing.has(next) ? next : null;
  }

  // ---- bookkeeping ----

  #notice(r: Omit<AlarmRaise, 'type' | 'atServerMs'>): void {
    this.#raise(r);
    this.#expires.set(r.key, this.#now() + PARAMS.noticeItemFor.value);
  }

  #raise(r: Omit<AlarmRaise, 'type' | 'atServerMs'>, at = this.#now()): void {
    this.#o.store.raise({ type: 'raise', ...r, atServerMs: at });
  }

  #now(): number { return this.#o.fleet.serverNow(); }
}

// The next zone along the route (forward, with wrap) after the one a segment is in.
export function nextZone(site: Site, segmentId: string): string | null {
  const segs = [...site.segments].sort((a, b) => a.startM - b.startM);
  const i = segs.findIndex((s) => s.segmentId === segmentId);
  if (i < 0) return null;
  const here = segs[i]!.zoneId;
  for (let k = 1; k < segs.length; k++) {
    const s = segs[(i + k) % segs.length]!;
    if (s.zoneId !== here) return s.zoneId;
  }
  return null;
}
