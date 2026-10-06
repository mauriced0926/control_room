// The safety check below every command path (TESTING.md L2.50-L2.53; CONTEXT.md "the safety gate sits
// below the command path"). The registry asks it before every send, operators' and the system's
// alike, first sends, retries and replays; a refusal is never sent and says why in words.
//
// Stopping is never refused (HOLD, ESTOP, and the lease commands, which stop the truck). What moves a
// truck is checked against the zones that are not open:
//   RESUME         not while the blast engine holds the truck for a zone that is not open (L2.51), and
//                  never into such a zone: refused if, resumed, it would be in one within the time a
//                  hold takes to act (the engine holds it before then otherwise);
//   RETURN_TO_BAY  not if the shorter way to the bay enters a zone that is not open (L2.50);
//   EXIT_ZONE      not in a bay, where the site refuses it (L2.54); not to a truck whose position can't
//                  be trusted while any zone is not open (B1); not if the nearest way out, which the
//                  truck picks itself, leads into a zone that is not open (L2.52, B4).
// A zone whose status is unknown counts as not open.
import { landingZone, notOpen, pathStart, type ZoneInfo } from './blast.ts';
import type { FleetState, TruckView } from './fleet.ts';
import { PARAMS } from './params.ts';
import { predictPath, visits } from './path.ts';
import type { GateRequest, GateVerdict, SafetyGate } from './registry.ts';

export interface GateEngineView {
  heldFor(vehicleId: string): string[];
  zone(zoneId: string): ZoneInfo | undefined;
}

const UNSURE: ReadonlySet<string> = new Set(['silent', 'contradicted', 'unknown']);

export class BlastGate implements SafetyGate {
  readonly #fleet: FleetState;
  readonly #engine: () => GateEngineView;

  constructor(fleet: FleetState, engine: () => GateEngineView) {
    this.#fleet = fleet;
    this.#engine = engine;
  }

  check(req: GateRequest): GateVerdict {
    const a = req.record.action;
    if (a !== 'RESUME' && a !== 'RETURN_TO_BAY' && a !== 'EXIT_ZONE') return { allow: true };
    const v = req.record.vehicleId;
    const site = this.#fleet.site;
    const engine = this.#engine();
    if (!site) return no('NO_SITE', `No description of the site yet, so ${a} can't be checked against the blast plan. Not sent.`);
    const zone = (id: string) => engine.zone(id);
    const closing = site.zones.filter((z) => notOpen(zone(z.zoneId))).map((z) => z.zoneId);
    const status = (id: string) => describe(zone(id), this.#fleet.serverNow());
    const t: TruckView | undefined = req.truck;
    const start = t ? pathStart(t) : null;

    if (a === 'RESUME') {
      const held = engine.heldFor(v).filter((z) => notOpen(zone(z)));
      if (held.length) {
        return no('BLAST_HOLD', `${v} is held for the blast in ${held.map((z) => `${z} (${status(z)})`).join(', ')}. It can't be resumed until ${held.length > 1 ? 'they reopen' : 'it reopens'}; the system resumes it then by itself.`);
      }
      if (closing.length === 0) return { allow: true };
      if (!start || UNSURE.has(t!.confidence)) return no('POSITION_UNSURE', `${v}'s position can't be trusted (${t?.confidenceReason ?? 'no data'}) while ${closing.join(', ')} ${closing.length > 1 ? 'are' : 'is'} not open, so it isn't resumed.`);
      const now = this.#fleet.serverNow();
      const lead = 2 * PARAMS.supervisoryDelayMax.value + PARAMS.telemetryLatencyAllowance.value + PARAMS.blastEvalInterval.value;
      const vs = visits(site, predictPath(site, { ...start, state: 'TRAMMING', task: null, direction: 'FWD', atMs: now }, 'early', now + lead), now + lead);
      for (let i = 0; i < vs.length; i++) {
        const x = vs[i]!;
        if (x.tIn > now + lead || !notOpen(zone(x.zoneId))) continue;
        const z = zone(x.zoneId);
        // Already inside a closing zone, and resuming takes it out the far side in time: allowed.
        const leavesInTime = i === 0 && z?.status === 'CLOSING' && z.effectiveAtMs !== null && x.tOut <= z.effectiveAtMs - PARAMS.blastExitMargin.value && !notOpen(zone(vs[1]?.zoneId ?? ''));
        if (leavesInTime) continue;
        return no('INTO_CLOSING_ZONE', `Resumed, ${v} would be in ${x.zoneId} (${status(x.zoneId)}) within ${Math.max(0, Math.round((x.tIn - now) / 1000))} s. Not sent: hold it until ${x.zoneId} reopens.`);
      }
      return { allow: true };
    }

    if (!start) {
      return closing.length ? no('POSITION_UNSURE', `${v}'s position is unknown while ${closing.join(', ')} ${closing.length > 1 ? 'are' : 'is'} not open, so ${a} isn't sent.`) : { allow: true };
    }
    const here = site.zoneAt(start.positionM);

    if (a === 'RETURN_TO_BAY') {
      if (closing.length === 0) return { allow: true };
      const bays = site.segments.filter((s) => s.kind === 'bay').map((s) => s.startM + s.lengthM - PARAMS.dutyStopBeforeEnd.value);
      if (bays.length === 0) return no('NO_BAY', 'This site has no bay to return to.');
      const L = site.loopLengthM;
      const fwd = Math.min(...bays.map((b) => ((b - start.positionM) % L + L) % L));
      const rev = Math.min(...bays.map((b) => ((start.positionM - b) % L + L) % L));
      const direction = rev < fwd ? 'REV' as const : 'FWD' as const;
      const vs = visits(site, predictPath(site, { ...start, state: 'TRAMMING', task: 'RETURN_TO_BAY', direction }, 'late', Infinity));
      const through = vs.slice(1).map((x) => x.zoneId).filter((z) => notOpen(zone(z)));
      if (through.length) {
        return no('RTB_THROUGH_CLOSING_ZONE', `${v}'s shorter way to the bay (${direction === 'FWD' ? 'ahead' : 'back'}) goes through ${[...new Set(through)].map((z) => `${z} (${status(z)})`).join(', ')}. Not sent: hold it, or wait until ${through.length > 1 ? 'they reopen' : 'it reopens'}.`);
      }
      return { allow: true };
    }

    // EXIT_ZONE
    if (here?.kinds.includes('bay')) {
      return no('EXIT_ZONE_IN_BAY', `${v} is in ${here.zoneId}, a bay: the site refuses EXIT_ZONE there. Drive it out, or hold the shot.`);
    }
    if (closing.length && UNSURE.has(t!.confidence)) {
      return no('EXIT_ZONE_UNSURE', `${v}'s position can't be trusted (${t!.confidenceReason}): EXIT_ZONE leaves the zone it is really in, which could take it into ${closing.join(', ')}. Not sent; hold it instead.`);
    }
    const landing = landingZone(site, start.positionM);
    if (landing !== null && notOpen(zone(landing)) && landing !== here?.zoneId) {
      return no('EXIT_ZONE_INTO_CLOSING_ZONE', `${v}'s nearest way out of ${here?.zoneId ?? 'its zone'} leads into ${landing} (${status(landing)}), and EXIT_ZONE picks that way itself. Not sent: hold it, or drive it out the other way.`);
    }
    return { allow: true };
  }
}

function no(code: string, reason: string): GateVerdict {
  return { allow: false, code, reason };
}

function describe(z: ZoneInfo | undefined, nowMs: number): string {
  if (!z || z.status === null) return 'status unknown';
  if (z.status === 'CLOSED') return 'closed';
  if (z.status === 'CLOSING') return z.effectiveAtMs === null ? 'closing' : `closing in ${Math.max(0, Math.round((z.effectiveAtMs - nowMs) / 1000))} s`;
  return 'open';
}
