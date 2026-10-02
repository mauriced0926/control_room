// Seeded random numbers for the fake (L0.C4). sfc32, seeded through splitmix32. Each concern gets
// its own stream (`fork`), so a test's commands never shift the blast schedule or the initial
// placement, and milestone 2's fault injectors can add streams without disturbing these.

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export class Rng {
  #a: number; #b: number; #c: number; #d: number;

  constructor(seed: number) {
    const sm = splitmix32(seed);
    this.#a = sm(); this.#b = sm(); this.#c = sm(); this.#d = sm();
    for (let i = 0; i < 12; i++) this.#nextU32();
  }

  // A child stream named by `label`: same seed and label, same stream.
  fork(label: string): Rng {
    let h = 0x811c9dc5;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
    return new Rng((this.#nextU32() ^ h) >>> 0);
  }

  // Uniform in [0, 1).
  next(): number {
    return this.#nextU32() / 4294967296;
  }

  #nextU32(): number {
    const t = (((this.#a + this.#b) >>> 0) + this.#d) >>> 0;
    this.#d = (this.#d + 1) >>> 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) >>> 0;
    this.#c = ((this.#c << 21) | (this.#c >>> 11)) >>> 0;
    this.#c = (this.#c + t) >>> 0;
    return t;
  }

  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  hex(digits: number): string {
    let s = '';
    for (let i = 0; i < digits; i++) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }
}
