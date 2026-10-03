// Plain-words formatting shared by the clearance rule and the UI. Pure: no clock, no DOM.
import type { TruckView } from './fleet.ts';

// Whole seconds, counted down from the true age so "old 2 s" never claims more freshness than it has
// lost: 2.9 s is "2 s", and the next second shows when it is reached. Minutes past 90 s.
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// A countdown as m:ss. Rounded up: "0:01" until the moment itself, never "0:00" early.
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Time since something, as m:ss. Rounded down, like age: "closed 0:03 ago" at 3.9 s.
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// How old the truck's position is: since the last valid position, or since the last message if it
// never sent one.
export function positionAgeMs(t: TruckView): number | null {
  return t.position?.ageMs ?? t.ageMs;
}

// The data state in words, as the fleet table shows it (UI.md: "live, old 4 s, silent 32 s,
// contradicted").
export function dataState(t: TruckView): string {
  const a = positionAgeMs(t);
  switch (t.confidence) {
    case 'live': return 'live';
    case 'old': return `old ${age(a ?? 0)}`;
    case 'silent': return `silent ${age(a ?? 0)}`;
    case 'contradicted': return 'contradicted';
    case 'unknown': return t.ageMs === null ? 'never reported' : 'no position';
  }
}

export function faultWords(t: TruckView): string | null {
  const f = t.faults?.value ?? [];
  return f.length ? `faulted (${f.join(', ')})` : null;
}
