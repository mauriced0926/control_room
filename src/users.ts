// Operators and their passwords (BRIEF.md: "a hard-coded user list is acceptable"). The list lives in
// a JSON file (USERS_FILE); passwords are stored only as scrypt hashes from node:crypto, never in
// plain text. The repo ships config/users.demo.json with three demo users whose plain passwords are
// written in README.md for the graders: demo credentials, to be replaced.
//
// The user id is what the gateway's statutory log records as operator_id, so it is restricted to a
// short, plain form, and may never look like the system's own "system:<rule>".
//
// Make a hash for a new user (reads the password from stdin, prints only the hash):
//   node src/users.ts hash
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Role } from './registry.ts';

export interface User {
  id: string;   // the operator_id sent to the gateway
  name: string; // shown to other operators
  role: Role;
}

interface StoredUser extends User { passwordHash: string }

export const USER_ID = /^[a-z][a-z0-9._-]{0,31}$/;
const RESERVED = /^system/; // the registry sends the system's commands as "system:<rule>"

// scrypt cost for new hashes: N = 2^15, r = 8, p = 3, one of the settings OWASP's Password Storage
// Cheat Sheet lists as its minimum (32 MiB of memory per hash).
export const DEFAULT_COST = { N: 2 ** 15, r: 8, p: 3 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;

function scryptAsync(password: string, salt: Buffer, keyLen: number, o: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, keyLen, o, (e, k) => (e ? reject(e) : resolve(k))));
}

const maxmem = (N: number, r: number) => 256 * N * r; // twice what scrypt needs

// "scrypt$N$r$p$<salt base64url>$<key base64url>"
export async function hashPassword(password: string, cost: { N: number; r: number; p: number } = DEFAULT_COST): Promise<string> {
  if (typeof password !== 'string' || password.length < 8) throw new Error('a password needs at least 8 characters');
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, KEY_LEN, { ...cost, maxmem: maxmem(cost.N, cost.r) });
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface Parsed { N: number; r: number; p: number; salt: Buffer; key: Buffer }

function parseHash(h: string): Parsed | null {
  const parts = h.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, 'base64url');
  const key = Buffer.from(parts[5]!, 'base64url');
  // Bounds, so a bad file can't make one login take minutes or gigabytes.
  const pow2 = Number.isInteger(Math.log2(N));
  if (!pow2 || N < 2 ** 10 || N > 2 ** 20 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  if (salt.length < 16 || key.length < 32 || key.length > 64) return null;
  return { N, r, p, salt, key };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parseHash(stored);
  if (!h || typeof password !== 'string') return false;
  const key = await scryptAsync(password, h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: maxmem(h.N, h.r) });
  return timingSafeEqual(key, h.key);
}

// ---- the user list ----

export function parseUsers(json: string): StoredUser[] {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { throw new Error('the users file is not valid JSON'); }
  const list = (doc as { users?: unknown } | null)?.users;
  if (!Array.isArray(list) || list.length === 0) throw new Error('the users file has no "users" list');
  const seen = new Set<string>();
  return list.map((u: unknown, i): StoredUser => {
    const o = (u ?? {}) as Record<string, unknown>;
    const where = `users[${i}]`;
    if (typeof o.id !== 'string' || !USER_ID.test(o.id)) throw new Error(`${where}: id must be lower case letters, digits, ".", "_" or "-", up to 32`);
    if (RESERVED.test(o.id)) throw new Error(`${where}: an id may not start with "system": that is how the system's own commands are logged`);
    if (seen.has(o.id)) throw new Error(`${where}: id ${o.id} appears twice`);
    seen.add(o.id);
    if (typeof o.name !== 'string' || o.name.trim().length === 0 || o.name.length > 64) throw new Error(`${where}: name must be 1-64 characters`);
    if (o.role !== 'operator' && o.role !== 'supervisor') throw new Error(`${where}: role must be "operator" or "supervisor"`);
    if (typeof o.passwordHash !== 'string' || !parseHash(o.passwordHash)) throw new Error(`${where}: passwordHash is not a scrypt hash from "node src/users.ts hash"`);
    if ('password' in o) throw new Error(`${where}: a plain "password" field is not allowed; store only passwordHash`);
    return { id: o.id, name: o.name.trim(), role: o.role, passwordHash: o.passwordHash };
  });
}

export class UserBook {
  readonly #users: Map<string, StoredUser>;
  #dummy: string | null = null;

  constructor(users: StoredUser[]) {
    this.#users = new Map(users.map((u) => [u.id, u]));
  }

  static fromFile(path: string): UserBook {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { throw new Error(`cannot read the users file at ${path}`); }
    return new UserBook(parseUsers(text));
  }

  get size(): number { return this.#users.size; }

  find(id: string): User | undefined {
    const u = this.#users.get(id);
    return u && { id: u.id, name: u.name, role: u.role };
  }

  list(): User[] {
    return [...this.#users.values()].map((u) => ({ id: u.id, name: u.name, role: u.role }));
  }

  // The user, or null. An unknown name costs the same scrypt work as a wrong password, so the
  // answer's timing doesn't say which names exist.
  async verify(id: string, password: string): Promise<User | null> {
    const u = typeof id === 'string' ? this.#users.get(id) : undefined;
    if (!u) {
      this.#dummy ??= await hashPassword('not-a-real-password');
      await verifyPassword(String(password), this.#dummy);
      return null;
    }
    return (await verifyPassword(String(password), u.passwordHash)) ? this.find(id)! : null;
  }
}

// ---- command line: hash a password from stdin ----

if (import.meta.main) {
  if (process.argv[2] !== 'hash') {
    console.error('usage: node src/users.ts hash   (reads the password from stdin, prints the hash)');
    process.exit(2);
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const pw = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  console.log(await hashPassword(pw));
}
