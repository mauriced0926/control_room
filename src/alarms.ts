// The one shape every source of operator attention uses: the registry (commands that failed, e-stops
// not delivered), the link, the blast engine (can't-clear), battery and data quality. The attention
// tray (UI.md) shows them; the alerting rules (TESTING.md L2.60-L2.64) decide which interrupt.
// Types only: the blast engine and the attention tray are built in parallel against this.

export type AlarmSource = 'blast' | 'registry' | 'link' | 'battery' | 'data' | 'service';

export interface AlarmRaise {
  type: 'raise';
  source: AlarmSource;
  kind: string;            // e.g. 'cant_clear', 'command_failed', 'estop_undelivered', 'controller_restart'
  key: string;             // one cause, one alarm (L2.64): the same key is the same alarm, raised once
  vehicleId: string | null;
  zoneId: string | null;
  message: string;         // in the operator's words
  action: string | null;   // the next step, e.g. "Radio the shot firer to hold the shot"
  interrupt: boolean;      // true: sound and an acknowledgement; false: visible but silent (L2.60, L2.61)
  rule: string;            // what raised it, or kept it silent, e.g. "B9" (L2.62)
  atServerMs: number;
}

export interface AlarmClear {
  type: 'clear';
  key: string;
  reason: string;          // why it cleared, e.g. "truck confirmed outside DECLINE"
  atServerMs: number;
}

export type AlarmEvent = AlarmRaise | AlarmClear;
