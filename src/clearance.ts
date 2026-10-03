// Is this zone clear? From belief only (CLAUDE.md invariant 6: never wrongly clear).
//
// PROVISIONAL: the blast engine (PLAN.md task 5) will own this verdict, adding "can't get out in
// time", hold-before-entry and command outcomes. Until then the UI uses this, which implements only
// invariant 6:
//   NOT_CLEAR  a live or old truck reports a position inside the zone;
//   UNSURE     otherwise, any truck whose reachable range touches the zone: silent, contradicted or
//              never heard from, or a live truck at the boundary that might already be in;
//   CLEAR      no truck might be inside.
// NOT_CLEAR and UNSURE carry the same action, because in doubt the shot is held (CONTEXT.md answer 1).
// CLEAR here says nothing about trucks that may still drive in before the zone closes.
import type { TruckView, ZoneView } from './fleet.ts';
import { age, faultWords, positionAgeMs } from './words.ts';

export type Verdict = 'CLEAR' | 'NOT_CLEAR' | 'UNSURE';

export const HOLD_THE_SHOT = 'Radio the shot firer to hold the shot';

export interface ClearanceReason {
  vehicleIds: string[];
  certainty: 'inside' | 'might';
  why: string;
}

export interface Clearance {
  zoneId: string;
  verdict: Verdict;
  action: string | null;
  reasons: ClearanceReason[]; // the certain ones first
}

export function mightBeIn(t: TruckView, zoneId: string): boolean {
  return t.range === null || t.mightBeIn.includes(zoneId);
}

export function zoneClearance(zone: ZoneView, trucks: readonly TruckView[]): Clearance {
  const inside: ClearanceReason[] = [];
  const might: ClearanceReason[] = [];
  const neverHeard: string[] = [];
  for (const t of trucks) {
    if (!mightBeIn(t, zone.zoneId)) continue;
    const extra = [faultWords(t), t.state?.value === 'ESTOPPED' ? 'e-stopped' : null].filter((x) => x !== null);
    const tail = extra.length ? `; ${extra.join('; ')}` : '';
    const reportedIn = t.position?.value.zoneId === zone.zoneId;
    switch (t.confidence) {
      case 'live':
      case 'old': {
        const fresh = t.confidence === 'old' ? ` (old ${age(positionAgeMs(t) ?? 0)})` : '';
        if (reportedIn) inside.push({ vehicleIds: [t.vehicleId], certainty: 'inside', why: `inside${fresh}${tail}` });
        else might.push({ vehicleIds: [t.vehicleId], certainty: 'might', why: `at the boundary, might already be in${fresh}${tail}` });
        break;
      }
      case 'silent':
        might.push({ vehicleIds: [t.vehicleId], certainty: 'might', why: `silent ${age(positionAgeMs(t) ?? 0)}: could have reached it${lastSeen(t)}${tail}` });
        break;
      case 'contradicted':
        might.push({ vehicleIds: [t.vehicleId], certainty: 'might', why: `data frozen: reports moving but has not moved${lastSeen(t)}${tail}` });
        break;
      case 'unknown':
        if (t.ageMs === null) neverHeard.push(t.vehicleId);
        else might.push({ vehicleIds: [t.vehicleId], certainty: 'might', why: `no valid position: could be anywhere${tail}` });
        break;
    }
  }
  if (neverHeard.length) might.push({ vehicleIds: neverHeard, certainty: 'might', why: 'never reported: could be anywhere' });
  const verdict: Verdict = inside.length ? 'NOT_CLEAR' : might.length ? 'UNSURE' : 'CLEAR';
  return { zoneId: zone.zoneId, verdict, action: verdict === 'CLEAR' ? null : HOLD_THE_SHOT, reasons: [...inside, ...might] };
}

function lastSeen(t: TruckView): string {
  const z = t.position?.value.zoneId;
  return z ? `; last seen in ${z}` : '';
}
