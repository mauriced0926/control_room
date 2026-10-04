// Operator sessions, held in memory (task 6b scope 2). A session is a random 256-bit id in an
// HttpOnly, SameSite=Strict cookie. It ends at logout, after PARAMS.sessionIdleTimeout with no request
// and no screen open, or at PARAMS.sessionMaxAge whatever happens. A restart ends every session:
// operators log in again, which is acceptable for a service that restarts rarely and safer than
// keeping session ids on disk.
//
// Login throttling is per address and per (address, user name) pair, never per user name alone: a
// person at another desk mistyping Dave's password must not lock Dave out of the control room.
import { randomBytes } from 'node:crypto';
import type { Clock } from './clock.ts';
import { PARAMS } from './params.ts';
import type { User } from './users.ts';

export interface Session {
  readonly id: string;
  readonly user: User;
  readonly createdMs: number;
  lastSeenMs: number;
}

export type EndReason = 'logout' | 'idle' | 'max_age';

export const END_WORDS: Record<EndReason, string> = {
  logout: 'logged out',
  idle: `idle for ${PARAMS.sessionIdleTimeout.value / 60_000} min with no screen open`,
  max_age: `session reached its ${PARAMS.sessionMaxAge.value / 3_600_000} h limit`,
};

export interface SessionOptions {
  idleMs?: number;
  maxAgeMs?: number;
  newId?: () => string;
}

export class Sessions {
  readonly #clock: Clock;
  readonly #idleMs: number;
  readonly #maxAgeMs: number;
  readonly #newId: () => string;
  readonly #byId = new Map<string, Session>();
  readonly #listeners = new Set<(s: Session, why: EndReason) => void>();

  constructor(clock: Clock, o: SessionOptions = {}) {
    this.#clock = clock;
    this.#idleMs = o.idleMs ?? PARAMS.sessionIdleTimeout.value;
    this.#maxAgeMs = o.maxAgeMs ?? PARAMS.sessionMaxAge.value;
    this.#newId = o.newId ?? (() => randomBytes(32).toString('base64url'));
  }

  get maxAgeMs(): number { return this.#maxAgeMs; }

  onEnd(fn: (s: Session, why: EndReason) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  create(user: User): Session {
    const now = this.#clock.now();
    const s: Session = { id: this.#newId(), user: { id: user.id, name: user.name, role: user.role }, createdMs: now, lastSeenMs: now };
    this.#byId.set(s.id, s);
    return s;
  }

  // The live session for this id, or undefined. A session past its time is ended here, so nothing can
  // use it between sweeps.
  get(id: string | undefined): Session | undefined {
    if (typeof id !== 'string' || id.length === 0) return undefined;
    const s = this.#byId.get(id);
    if (!s) return undefined;
    const why = this.#expired(s, this.#clock.now());
    if (why) { this.end(s.id, why); return undefined; }
    return s;
  }

  // A request, or a screen still open: the session is in use.
  touch(id: string): void {
    const s = this.get(id);
    if (s) s.lastSeenMs = this.#clock.now();
  }

  end(id: string, why: EndReason): Session | undefined {
    const s = this.#byId.get(id);
    if (!s) return undefined;
    this.#byId.delete(id);
    for (const fn of this.#listeners) fn(s, why);
    return s;
  }

  sweep(): void {
    const now = this.#clock.now();
    for (const s of [...this.#byId.values()]) {
      const why = this.#expired(s, now);
      if (why) this.end(s.id, why);
    }
  }

  active(): Session[] {
    return [...this.#byId.values()];
  }

  #expired(s: Session, now: number): EndReason | null {
    if (now - s.createdMs >= this.#maxAgeMs) return 'max_age';
    if (now - s.lastSeenMs >= this.#idleMs) return 'idle';
    return null;
  }
}

// ---- cookies ----

export const SESSION_COOKIE = 'cr_session';

export function sessionIdFrom(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : undefined;
    }
  }
  return undefined;
}

export function sessionCookie(id: string, o: { secure: boolean; maxAgeMs: number }): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(o.maxAgeMs / 1000)}${o.secure ? '; Secure' : ''}`;
}

export function clearedCookie(o: { secure: boolean }): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${o.secure ? '; Secure' : ''}`;
}

// ---- login throttling ----

export class LoginThrottle {
  readonly #clock: Clock;
  readonly #max: number;
  readonly #windowMs: number;
  readonly #failures = new Map<string, number[]>();

  constructor(clock: Clock, o: { max?: number; windowMs?: number } = {}) {
    this.#clock = clock;
    this.#max = o.max ?? PARAMS.loginMaxFailures.value;
    this.#windowMs = o.windowMs ?? PARAMS.loginFailureWindow.value;
  }

  static keys(address: string, userName: string): string[] {
    return [`addr:${address}`, `pair:${address}|${userName.slice(0, 64)}`];
  }

  // Refused while the address has had too many failures, or this address with this name has.
  blocked(keys: string[]): boolean {
    const now = this.#clock.now();
    return keys.some((k) => this.#recent(k, now).length >= this.#max);
  }

  failed(keys: string[]): void {
    const now = this.#clock.now();
    for (const k of keys) {
      const list = this.#recent(k, now);
      list.push(now);
      this.#failures.set(k, list);
    }
    if (this.#failures.size > 10_000) this.#prune(now); // bounded, whatever an attacker sends
  }

  // A success clears that name from that address; the address's own count stays.
  succeeded(keys: string[]): void {
    for (const k of keys) if (k.startsWith('pair:')) this.#failures.delete(k);
  }

  #recent(k: string, now: number): number[] {
    return (this.#failures.get(k) ?? []).filter((t) => now - t < this.#windowMs);
  }

  #prune(now: number): void {
    for (const [k, list] of this.#failures) {
      const keep = list.filter((t) => now - t < this.#windowMs);
      if (keep.length === 0) this.#failures.delete(k); else this.#failures.set(k, keep);
    }
  }
}
