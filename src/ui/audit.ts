// The audit view (UI.md screen 4; TESTING.md L8.4): "who moved that truck at 3:12?" answered from
// store.history(), one query. Pure: history rows in, words out; times stay as server ms for the
// browser to show in local time.
import type { HistoryRow } from '../store.ts';

export interface AuditLine {
  recordId: string;
  atServerMs: number;
  action: string;
  who: string;            // "priya (operator)" or "the system, rule B3"
  system: boolean;
  why: string | null;
  inputs: string | null;  // what the rule saw, for system actions
  sent: string;           // attempts and command ids, as the site's statutory log will show them
  acks: string;
  outcome: string;        // status, with the effect or the failure in words
  closest: boolean;       // the command nearest the time asked about
}

export function auditLines(rows: readonly HistoryRow[], askedServerMs: number): AuditLine[] {
  let closest = -1;
  rows.forEach((r, i) => { if (closest < 0 || Math.abs(r.createdServerMs - askedServerMs) < Math.abs(rows[closest]!.createdServerMs - askedServerMs)) closest = i; });
  return rows.map((r, i) => {
    const system = r.actorKind === 'system';
    const effect = r.effect as { detail?: string; ackReceived?: boolean } | null;
    const failure = r.failure as { message?: string } | null;
    const acks = r.acks.filter((a) => !a.duplicate);
    return {
      recordId: r.recordId,
      atServerMs: r.createdServerMs,
      action: r.action,
      who: system ? `the system, rule ${r.rule ?? '?'}` : `${r.actor} (operator)`,
      system,
      why: r.why,
      inputs: system && r.inputs !== null ? JSON.stringify(r.inputs) : null,
      sent: r.sends.length
        ? r.sends.map((s) => `${s.replay ? 'replayed' : `attempt ${s.attempt}`} as ${s.commandId}`).join('; ')
        : 'never sent',
      acks: acks.length ? acks.map((a) => `${a.status}${a.reason ? ` ${a.reason}` : ''} for ${a.commandId}`).join('; ') : r.sends.length ? 'no acknowledgement received' : '—',
      outcome: r.status === 'confirmed' ? `done: ${effect?.detail ?? 'effect seen'}${effect && !effect.ackReceived ? ' (no ack)' : ''}`
        : failure?.message ? `${r.status}: ${failure.message}` : r.status,
      closest: i === closest,
    };
  });
}
