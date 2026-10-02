// Injected time (CLAUDE.md invariant 1). This is the only module that touches the wall clock or
// timers; everything else takes a Clock. Times are Unix milliseconds.

export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export class SystemClock implements Clock {
  readonly #timers = new Map<number, ReturnType<typeof globalThis.setTimeout>>();
  #nextId = 1;

  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, globalThis.setTimeout(() => { this.#timers.delete(id); fn(); }, ms));
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    const t = this.#timers.get(handle.id);
    if (t !== undefined) globalThis.clearTimeout(t);
    this.#timers.delete(handle.id);
  }
}

interface Pending {
  id: number;
  due: number;
  fn: () => void;
}

// For tests: time moves only when advanced, and due timers run in order (by due time, then by the
// order they were set), each seeing now() equal to its own due time.
export class ManualClock implements Clock {
  #now: number;
  #nextId = 1;
  #pending: Pending[] = [];

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#pending.push({ id, due: this.#now + Math.max(0, ms), fn });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.#pending = this.#pending.filter((p) => p.id !== handle.id);
  }

  pending(): number {
    return this.#pending.length;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError('a clock cannot go backwards');
    const target = this.#now + ms;
    for (let fired = 0; ; fired++) {
      if (fired > 1_000_000) throw new Error('runaway timers: over a million fired in one advance');
      const next = this.#nextDue(target);
      if (!next) break;
      this.#pending = this.#pending.filter((p) => p !== next);
      this.#now = next.due;
      next.fn();
    }
    this.#now = target;
  }

  #nextDue(target: number): Pending | undefined {
    let best: Pending | undefined;
    for (const p of this.#pending) {
      if (p.due <= target && (!best || p.due < best.due || (p.due === best.due && p.id < best.id))) best = p;
    }
    return best;
  }
}
