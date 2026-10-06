// The attention tray's words (UI.md "Attention tray"; TESTING.md L2.60-L2.64), and which items a
// screen should sound for. Pure: the store's items in, plain data out.
import type { AlarmItem } from '../attention.ts';
import { elapsed } from '../words.ts';

export interface TrayEntry {
  key: string;
  interrupt: boolean;
  state: 'needs-ack' | 'resolved-needs-ack' | 'acknowledged' | 'silent';
  vehicleId: string | null;
  message: string;
  action: string | null;
  rule: string;           // why it interrupts, or why it was kept silent (L2.62)
  when: string;           // "raised 2:13 ago"
  status: string | null;  // acknowledgement, resolution, re-alert or escalation, in words
  escalated: boolean;
  forYou: boolean;        // the latest alert was addressed to this screen's operator
}

export interface Tray { interrupts: TrayEntry[]; silent: TrayEntry[]; needAck: number }

export function trayModel(items: readonly AlarmItem[], youId: string | null, nowServerMs: number): Tray {
  const entries = items.map((i): TrayEntry => {
    const state: TrayEntry['state'] = !i.interrupt ? 'silent' : i.ack ? 'acknowledged' : i.cleared ? 'resolved-needs-ack' : 'needs-ack';
    const ago = (ms: number) => `${elapsed(Math.max(0, nowServerMs - ms))} ago`;
    const notes: string[] = [];
    if (i.ack) notes.push(`Acknowledged by ${i.ack.name} ${ago(i.ack.atServerMs)}`);
    if (i.cleared) notes.push(`Resolved ${ago(i.cleared.atServerMs)}: ${i.cleared.reason}${i.ack ? '' : '. Acknowledge to remove it'}`);
    if (!i.ack && !i.cleared) {
      if (i.escalation) notes.push(i.escalation.words);
      else if (i.alerts.some((a) => a.why === 're-alert')) notes.push('Re-alerted at 15 min: nobody has acknowledged it');
    }
    const last = i.alerts.at(-1);
    return {
      key: i.key, interrupt: i.interrupt, state, vehicleId: i.vehicleId, message: i.message, action: i.action, rule: i.rule,
      when: `raised ${ago(i.interrupt ? (i.interruptSinceServerMs ?? i.raisedAtServerMs) : i.raisedAtServerMs)}`,
      status: notes.length ? notes.join('. ') : null,
      escalated: i.escalation !== null,
      forYou: !!last && youId !== null && (last.to === 'everyone' || last.to.includes(youId)),
    };
  });
  const interrupts = entries.filter((e) => e.interrupt);
  return { interrupts, silent: entries.filter((e) => !e.interrupt), needAck: interrupts.filter((e) => e.state !== 'acknowledged').length };
}

// Which items to sound for now on this screen: each alert sounds once, where it is addressed, and
// never for an acknowledged or resolved item. `heard` is the screen's memory of alertSeq per key.
export function toSound(items: readonly AlarmItem[], youId: string | null, heard: Map<string, number>): AlarmItem[] {
  const out: AlarmItem[] = [];
  for (const i of items) {
    const last = i.alerts.at(-1);
    if (!i.interrupt || i.ack || i.cleared || !last || youId === null) continue;
    if ((heard.get(i.key) ?? 0) >= i.alertSeq) continue;
    heard.set(i.key, i.alertSeq);
    if (last.to === 'everyone' || last.to.includes(youId)) out.push(i);
  }
  return out;
}

// One short tone pattern per kind of interrupt, so the ear tells them apart: blast safety is three
// falling notes, the link two, a truck one. Never continuous (UI.md principle 3).
export function tonePattern(item: Pick<AlarmItem, 'source' | 'kind'>): Array<{ hz: number; ms: number }> {
  if (item.source === 'blast') return [{ hz: 880, ms: 160 }, { hz: 740, ms: 160 }, { hz: 587, ms: 240 }];
  if (item.source === 'link') return [{ hz: 660, ms: 180 }, { hz: 660, ms: 180 }];
  if (item.kind === 'estop_undelivered' || item.kind === 'command_failed') return [{ hz: 523, ms: 140 }, { hz: 784, ms: 220 }];
  return [{ hz: 698, ms: 260 }];
}
