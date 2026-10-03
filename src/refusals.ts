// What a refusal means, in the operator's words (TESTING.md L2.39). Every reason in PROTOCOL.md §4.5
// gets its own message: the distinct kinds stay distinct rather than collapsing into "rejected". A
// reason that is the control room's own fault says so, so nobody goes looking at the truck.
import type { Action, RejectReason } from './protocol.ts';

export interface RefusalContext {
  vehicleId: string;
  action: Action | string;
  holder?: string | null;         // LEASE_HELD: who is driving
  state?: string | null;          // what telemetry last said the truck was doing
  faults?: string[] | null;       // INTERLOCK_ACTIVE: which fault
  inFlight?: { action: string; sentAgoMs: number } | null; // a command of ours still on its way
}

export interface Refusal {
  reason: string;     // the protocol's reason, or our own code
  ourFault: boolean;  // a bug in the control room, not something about the truck
  retry: false;       // a refusal is never retried: the same command would be refused again
  message: string;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function refusal(reason: RejectReason | string, c: RefusalContext): Refusal {
  const v = c.vehicleId, a = c.action;
  const r = (message: string, ourFault = false): Refusal => ({ reason, ourFault, retry: false, message });
  switch (reason) {
    case 'BAD_COMMAND_ID':
      return r(`The site could not read the ID on the ${a} for ${v}. This is a fault in the control-room software, not the truck; it has been logged. Not sent again.`, true);
    case 'BAD_JSON':
      return r(`The site could not read the ${a} for ${v} at all. This is a fault in the control-room software; it has been logged. Not sent again.`, true);
    case 'MISSING_OPERATOR':
      return r(`The ${a} for ${v} went out without an operator name, so the site refused it. This is a fault in the control-room software; it has been logged.`, true);
    case 'UNKNOWN_VEHICLE':
      return r(`The site does not know a truck called ${v}.`);
    case 'UNSUPPORTED_ACTION':
      return r(`The site does not support "${a}".`, true);
    case 'INTERLOCK_ACTIVE': {
      const which = c.faults && c.faults.length > 0 ? c.faults.join(', ') : 'a fault';
      return r(`${v} is interlocked by ${which}: only an e-stop works until maintenance clears it. Faults cannot be cleared from the control room. If the fault allows limp-home, take control and drive it.`);
    }
    case 'ESTOP_ACTIVE':
      return r(`${v} is e-stopped. Clear the e-stop first; it will then hold.`);
    case 'LEASE_HELD':
      return r(`${v} is being driven by ${c.holder ?? 'another operator'}. Talk to them first; a supervisor can take control from them.`);
    case 'NOT_LEASE_HOLDER':
      return r(`You do not hold ${v}'s controls, so you cannot hand them back.`);
    case 'INVALID_STATE':
      if (c.inFlight) {
        return r(`${a} refused: the ${c.inFlight.action} sent ${secs(c.inFlight.sentAgoMs)} ago is still on its way to ${v} and cannot be called back. It will take effect within a few seconds; send ${a} after that.`);
      }
      if (a === 'RESUME' && (c.state === 'HOLDING' || c.state === 'IDLE')) {
        return r(`${v} refused RESUME although its telemetry says ${c.state}. Its reported state may be wrong (frozen data); treat its position as uncertain.`);
      }
      if (a === 'EXIT_ZONE') {
        return r(`${v} refused EXIT_ZONE: the site does not allow it in a bay, or while it is ${c.state ?? 'in its current state'}. To move it out of a bay, take control and drive it.`);
      }
      return r(`${v} cannot ${a} while it is ${c.state ?? 'in its current state'}.`);
    case 'COMMAND_ID_REUSED':
      return r(`The control room reused a command ID for ${v}'s ${a}. That is our software's fault, not the truck's; it has been logged and will not be retried.`, true);
    default:
      return r(`The site refused the ${a} for ${v} (${reason}).`);
  }
}
