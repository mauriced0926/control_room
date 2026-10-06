// The alarm store behind the attention tray (UI.md; TESTING.md L2.60-L2.64). Every source of operator
// attention speaks the shared shape in src/alarms.ts; this decides what each alarm does over time.
//
// - One cause, one alarm (L2.64): an alarm is its `key`. Raising a key that is already open updates
//   its words and never alerts again. A silent alarm raised again as an interrupt is upgraded, and
//   that does alert: the need for action is new.
// - An interrupt alerts (sound, and a banner that needs acknowledging) when raised, again at
//   PARAMS.realertAfter if nobody has acknowledged it, and is escalated at PARAMS.escalateAfter
//   (L2.63). Escalation goes to the supervisors on screen. When there is nobody else to hand it to
//   (nights: the only person on is the supervisor; or no supervisor is on at all), escalation is
//   more persistent alerting to whoever is there, every PARAMS.persistentAlertEvery.
// - An acknowledgement names a logged-in operator, always from the server's session. A source that
//   clears an interrupt nobody acknowledged leaves it in the tray, marked resolved, until someone
//   does: the operator learns it happened, without sound.
// - A silent alarm never alerts. It shows the rule that kept it silent (L2.62) and leaves the tray
//   when its source clears it.
//
// Pure: time is given as the gateway's server time; nothing here reads a clock.
import type { AlarmEvent, AlarmRaise } from './alarms.ts';
import { PARAMS } from './params.ts';
import type { Role } from './registry.ts';

export interface Person { id: string; name: string; role: Role }

export type AlertWhy = 'raised' | 'upgraded' | 're-alert' | 'escalated' | 'persistent';

export interface Alert {
  atServerMs: number;
  why: AlertWhy;
  to: string[] | 'everyone'; // operator ids, or every screen
}

export interface Escalation {
  atServerMs: number;
  mode: 'supervisor' | 'same-person' | 'no-supervisor';
  to: string[];   // who it went to; empty for no-supervisor, which alerts everyone on screen
  words: string;  // for the tray
}

export interface AlarmItem {
  key: string;
  source: AlarmRaise['source'];
  kind: string;
  vehicleId: string | null;
  zoneId: string | null;
  message: string;
  action: string | null;
  interrupt: boolean;
  rule: string;
  raisedAtServerMs: number;      // first raised
  interruptSinceServerMs: number | null; // when it became an interrupt: the 15- and 30-minute clocks start here
  updatedAtServerMs: number;
  alerts: Alert[];
  alertSeq: number;              // rises with every alert; a screen sounds once per rise addressed to it
  ack: { by: string; name: string; role: Role; atServerMs: number } | null;
  escalation: Escalation | null;
  cleared: { reason: string; atServerMs: number } | null;
}

export type StoreEvent =
  | { type: 'raised'; item: AlarmItem }
  | { type: 'alert'; item: AlarmItem; alert: Alert }
  | { type: 'escalated'; item: AlarmItem }
  | { type: 'acknowledged'; item: AlarmItem }
  | { type: 'cleared'; item: AlarmItem; removed: boolean };

export type AckResult = { ok: true; item: AlarmItem } | { ok: false; error: string };

const MAX_ALERTS_KEPT = 20;

export class AlarmStore {
  readonly #items = new Map<string, AlarmItem>();
  readonly #listeners = new Set<(e: StoreEvent) => void>();
  #seq = 0;

  subscribe(fn: (e: StoreEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  apply(e: AlarmEvent): void {
    if (e.type === 'raise') this.raise(e);
    else this.clear(e.key, e.reason, e.atServerMs);
  }

  raise(r: AlarmRaise): AlarmItem {
    const now = r.atServerMs;
    const open = this.#items.get(r.key);
    if (open && !open.cleared) {
      const upgrade = r.interrupt && !open.interrupt;
      Object.assign(open, { message: r.message, action: r.action, rule: r.rule, zoneId: r.zoneId, vehicleId: r.vehicleId, updatedAtServerMs: now });
      if (upgrade) {
        open.interrupt = true;
        open.interruptSinceServerMs = now;
        open.ack = null;
        this.#alert(open, 'upgraded', 'everyone', now);
      }
      return open;
    }
    const item: AlarmItem = {
      key: r.key, source: r.source, kind: r.kind, vehicleId: r.vehicleId, zoneId: r.zoneId, message: r.message, action: r.action,
      interrupt: r.interrupt, rule: r.rule, raisedAtServerMs: now, interruptSinceServerMs: r.interrupt ? now : null, updatedAtServerMs: now,
      alerts: [], alertSeq: 0, ack: null, escalation: null, cleared: null,
    };
    this.#items.set(r.key, item); // replaces a resolved-but-unacknowledged one: the cause is back
    this.#emit({ type: 'raised', item });
    if (item.interrupt) this.#alert(item, 'raised', 'everyone', now);
    return item;
  }

  // A source says its cause has gone. A silent alarm, or an acknowledged interrupt, leaves the
  // tray; an interrupt nobody acknowledged stays, marked resolved, and never alerts again.
  clear(key: string, reason: string, atServerMs: number): void {
    const item = this.#items.get(key);
    if (!item || item.cleared) return;
    item.cleared = { reason, atServerMs };
    item.updatedAtServerMs = atServerMs;
    const removed = !item.interrupt || item.ack !== null;
    if (removed) this.#items.delete(key);
    this.#emit({ type: 'cleared', item, removed });
  }

  // `by` comes from the server's session, never from the browser's message.
  acknowledge(key: string, by: Person, atServerMs: number): AckResult {
    const item = this.#items.get(key);
    if (!item) return { ok: false, error: 'That alarm is no longer open.' };
    if (!item.interrupt) return { ok: false, error: 'Silent items need no acknowledgement.' };
    if (item.ack) return { ok: false, error: `Already acknowledged by ${item.ack.name}.` };
    item.ack = { by: by.id, name: by.name, role: by.role, atServerMs };
    item.updatedAtServerMs = atServerMs;
    this.#emit({ type: 'acknowledged', item });
    if (item.cleared) {
      this.#items.delete(key);
      this.#emit({ type: 'cleared', item, removed: true });
    }
    return { ok: true, item };
  }

  // Re-alerts and escalation (L2.63). `present`: the people with a screen open now.
  tick(nowServerMs: number, present: readonly Person[]): void {
    const realert = PARAMS.realertAfter.value;
    const escalate = PARAMS.escalateAfter.value;
    for (const item of this.#items.values()) {
      if (!item.interrupt || item.ack || item.cleared || item.interruptSinceServerMs === null) continue;
      const age = nowServerMs - item.interruptSinceServerMs;
      const last = item.alerts.at(-1)?.atServerMs ?? item.interruptSinceServerMs;
      if (!item.escalation) {
        if (age >= escalate) { this.#escalate(item, nowServerMs, present); continue; }
        if (age >= realert && !item.alerts.some((a) => a.why === 're-alert')) this.#alert(item, 're-alert', 'everyone', nowServerMs);
        continue;
      }
      if (item.escalation.mode === 'supervisor') {
        // Escalated to a supervisor: they are reminded every realert period after that.
        if (nowServerMs - last >= realert) this.#alert(item, 'persistent', item.escalation.to, nowServerMs);
      } else if (nowServerMs - last >= PARAMS.persistentAlertEvery.value) {
        this.#alert(item, 'persistent', item.escalation.mode === 'same-person' ? item.escalation.to : 'everyone', nowServerMs);
      }
    }
  }

  get(key: string): AlarmItem | undefined {
    return this.#items.get(key);
  }

  // Interrupts first (needing acknowledgement, then resolved but unacknowledged, then acknowledged
  // and still open), oldest first so the longest-waiting is on top; then silent items, newest first.
  list(): AlarmItem[] {
    const rank = (i: AlarmItem) => (!i.interrupt ? 3 : i.ack ? 2 : i.cleared ? 1 : 0);
    return [...this.#items.values()].sort((a, b) => rank(a) - rank(b)
      || (a.interrupt ? (a.interruptSinceServerMs ?? 0) - (b.interruptSinceServerMs ?? 0) : b.updatedAtServerMs - a.updatedAtServerMs));
  }

  #escalate(item: AlarmItem, now: number, present: readonly Person[]): void {
    const sups = present.filter((p) => p.role === 'supervisor');
    const others = present.filter((p) => p.role !== 'supervisor');
    let e: Escalation;
    if (sups.length && others.length === 0) {
      const names = sups.map((p) => p.name).join(', ');
      e = { atServerMs: now, mode: 'same-person', to: sups.map((p) => p.id), words: `Unacknowledged for 30 min. ${names} is the supervisor and the only one on, so there is nobody to hand it to: alerting ${names} every ${Math.round(PARAMS.persistentAlertEvery.value / 1000)} s until acknowledged.` };
    } else if (sups.length) {
      e = { atServerMs: now, mode: 'supervisor', to: sups.map((p) => p.id), words: `Unacknowledged for 30 min: escalated to ${sups.map((p) => p.name).join(', ')} (supervisor).` };
    } else {
      e = { atServerMs: now, mode: 'no-supervisor', to: [], words: `Unacknowledged for 30 min and no supervisor is logged in: alerting every screen every ${Math.round(PARAMS.persistentAlertEvery.value / 1000)} s until acknowledged. Phone the supervisor.` };
    }
    item.escalation = e;
    this.#emit({ type: 'escalated', item });
    this.#alert(item, 'escalated', e.mode === 'no-supervisor' ? 'everyone' : e.to, now);
  }

  #alert(item: AlarmItem, why: AlertWhy, to: Alert['to'], atServerMs: number): void {
    const alert: Alert = { atServerMs, why, to };
    item.alerts.push(alert);
    if (item.alerts.length > MAX_ALERTS_KEPT) item.alerts.splice(1, item.alerts.length - MAX_ALERTS_KEPT); // keep the first
    item.alertSeq = ++this.#seq;
    this.#emit({ type: 'alert', item, alert });
  }

  #emit(e: StoreEvent): void {
    for (const fn of this.#listeners) fn(e);
  }
}

// Whether a screen should sound for this item now: the latest alert is addressed to it.
export function alertsFor(item: AlarmItem, userId: string): boolean {
  const a = item.alerts.at(-1);
  if (!a || item.ack || item.cleared) return false;
  return a.to === 'everyone' || a.to.includes(userId);
}
