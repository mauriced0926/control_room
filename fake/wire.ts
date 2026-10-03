// Lines as the live gateway writes them: Python's json.dumps defaults, i.e. ", " and ": " between
// items, and floats keep their ".0" (speed_mps 2.0, payload_kg 42000.0). The captures show which
// fields are floats; everything else (seq, t_device_ms, server_time_ms, effective_at_ms, the ack's
// lease timings, last_drive_seq, last_drive_sent_ms) is an integer. Field order is insertion order,
// as JSON.stringify's. Lengths matter: truncated lines are cut at a measured character count.
// Not matched: Python escapes non-ASCII as \uXXXX; nothing the fake sends has any.
const FLOAT_FIELDS = new Set(['soc_pct', 'speed_mps', 'offset_m', 'payload_kg', 'length_m', 'start_m', 'loop_length_m']);

export function toWire(x: unknown): string {
  return enc(x, false);
}

// Hand-rolled for speed: a 15-minute day writes ~55,000 lines (L0.C4 times it).
const KEYS = new Map<string, string>();
const key = (k: string): string => {
  let s = KEYS.get(k);
  if (s === undefined) { s = JSON.stringify(k) + ': '; KEYS.set(k, s); }
  return s;
};

function enc(x: unknown, float: boolean): string {
  if (x === null || x === undefined) return 'null';
  const t = typeof x;
  if (t === 'number') {
    const n = x as number;
    if (!Number.isFinite(n)) return 'null';
    return float && Number.isInteger(n) ? n + '.0' : '' + n;
  }
  if (t === 'string') return JSON.stringify(x);
  if (t === 'boolean') return x ? 'true' : 'false';
  if (t !== 'object') return 'null';
  if (Array.isArray(x)) {
    let out = '[';
    for (let i = 0; i < x.length; i++) out += (i ? ', ' : '') + enc(x[i], false);
    return out + ']';
  }
  let out = '{';
  let first = true;
  const o = x as Record<string, unknown>;
  for (const k in o) {
    const v = o[k];
    if (v === undefined) continue;
    out += (first ? '' : ', ') + key(k) + enc(v, FLOAT_FIELDS.has(k));
    first = false;
  }
  return out + '}';
}
