// Parsing and validation of what the gateway actually sends (TESTING.md L2.10-L2.17). The live site
// breaks the PROTOCOL.md shapes on purpose: truncated lines, lowercase states, offsets as strings,
// null or missing fields, fractions for percentages. Each telemetry field is checked on its own, so
// one bad field makes that field unknown without discarding the rest of the message. Every repair
// or rejection is reported as an issue named `<field>:<problem>`.
import { CONTROL_MODES, DIRECTIONS, TASKS, VEHICLE_STATES, ZONE_STATUSES } from './protocol.ts';
import type { ControlMode, Direction, Task, VehicleState, ZoneStatus } from './protocol.ts';
import { normalise } from './geometry.ts';
import { PARAMS } from './params.ts';
import type { Site } from './site.ts';

export type ParseResult =
  | { ok: true; msg: Record<string, unknown> & { type: string } }
  | { ok: false; reason: 'blank' | 'unparseable' | 'not_object' | 'no_type' };

export function parseLine(line: string): ParseResult {
  if (line.trim() === '') return { ok: false, reason: 'blank' };
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  return classify(v);
}

export function classify(v: unknown): ParseResult {
  if (!isObject(v)) return { ok: false, reason: 'not_object' };
  if (typeof v.type !== 'string' || v.type === '') return { ok: false, reason: 'no_type' };
  return { ok: true, msg: v as Record<string, unknown> & { type: string } };
}

export interface Issue {
  field: string;
  kind: string; // `${field}:${problem}`
  repaired: boolean; // true when the value was still used (e.g. a numeric string)
  detail: string;
}

export interface PositionFields {
  segmentId: string;
  zoneId: string;
  offsetM: number;
  loopM: number;
}

export interface ControlFields {
  mode: ControlMode;
  operatorId: string | null;
  deadman: boolean;
  lastDriveSeq: number | null;
  lastDriveSentMs: number | null;
}

// A field that is undefined here is unknown in this message.
export interface TelemetryFields {
  vehicleId: string;
  seq: number | undefined;
  tDeviceMs: number | undefined;
  state?: VehicleState;
  task?: Task | null;
  socPct?: number;
  speedMps?: number;
  direction?: Direction;
  position?: PositionFields;
  payloadKg?: number;
  faults?: string[];
  control?: ControlFields;
}

export interface Validated {
  fields: TelemetryFields | null; // null: not attributable to a truck at all
  issues: Issue[];
}

export function validateTelemetry(m: Record<string, unknown>, site: Site | undefined): Validated {
  const issues: Issue[] = [];
  const note = (field: string, problem: string, repaired: boolean, value: unknown) =>
    issues.push({ field, kind: `${field}:${problem}`, repaired, detail: `${field} was ${show(value)}` });

  if (typeof m.vehicle_id !== 'string' || m.vehicle_id === '') return { fields: null, issues: [{ field: 'vehicle_id', kind: 'vehicle_id:invalid', repaired: false, detail: `vehicle_id was ${show(m.vehicle_id)}` }] };

  const num = (field: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number | undefined => {
    const raw = m[field];
    if (!(field in m)) { note(field, 'missing', false, raw); return undefined; }
    if (raw === null) { note(field, 'null', false, raw); return undefined; }
    let v: number | undefined;
    let repaired = false;
    if (typeof raw === 'number') v = raw;
    else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) { v = Number(raw); repaired = true; }
    if (v === undefined || !Number.isFinite(v) || (opts.integer && !Number.isInteger(v)) ||
        (opts.min !== undefined && v < opts.min) || (opts.max !== undefined && v > opts.max)) {
      note(field, 'invalid', false, raw);
      return undefined;
    }
    if (repaired) note(field, 'string', true, raw);
    return v;
  };

  const enumOf = <T extends string>(field: string, allowed: readonly T[], raw: unknown): T | undefined => {
    if (raw === undefined) { note(field, 'missing', false, raw); return undefined; }
    if (raw === null) { note(field, 'null', false, raw); return undefined; }
    if (typeof raw !== 'string') { note(field, 'invalid', false, raw); return undefined; }
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    const up = raw.toUpperCase();
    if ((allowed as readonly string[]).includes(up)) { note(field, 'lowercase', true, raw); return up as T; }
    note(field, 'invalid', false, raw);
    return undefined;
  };

  const fields: TelemetryFields = {
    vehicleId: m.vehicle_id,
    seq: num('seq', { min: 0, integer: true }),
    tDeviceMs: num('t_device_ms'),
  };

  const state = enumOf('state', VEHICLE_STATES, m.state);
  if (state) fields.state = state;

  if (m.task === null) fields.task = null;
  else {
    const task = enumOf('task', TASKS, m.task);
    if (task) fields.task = task;
  }

  const soc = num('soc_pct', { min: 0, max: 100 });
  if (soc !== undefined) fields.socPct = soc;
  const speed = num('speed_mps', { min: 0 });
  if (speed !== undefined) fields.speedMps = speed;
  const direction = enumOf('direction', DIRECTIONS, m.direction);
  if (direction) fields.direction = direction;
  const payload = num('payload_kg', { min: 0 });
  if (payload !== undefined) fields.payloadKg = payload;

  if (Array.isArray(m.faults) && m.faults.every((f) => typeof f === 'string')) fields.faults = [...m.faults];
  else note('faults', m.faults === undefined ? 'missing' : 'invalid', false, m.faults);

  const control = validateControl(m.control, note);
  if (control) fields.control = control;

  const offset = num('offset_m');
  const position = validatePosition(m, offset, site, note);
  if (position) fields.position = position;

  return { fields, issues };
}

function validatePosition(
  m: Record<string, unknown>, offset: number | undefined, site: Site | undefined,
  note: (field: string, problem: string, repaired: boolean, value: unknown) => void,
): PositionFields | undefined {
  if (offset === undefined) return undefined;
  if (typeof m.segment_id !== 'string') { note('segment_id', m.segment_id === undefined ? 'missing' : 'invalid', false, m.segment_id); return undefined; }
  if (!site) { note('position', 'no_site', false, m.segment_id); return undefined; }
  const seg = site.segment(m.segment_id);
  if (!seg) { note('position', 'unknown_segment', false, m.segment_id); return undefined; }
  if (m.zone_id !== seg.zoneId) { note('position', 'zone_mismatch', false, `${String(m.zone_id)} on ${seg.segmentId}`); return undefined; }
  const tol = PARAMS.offsetTolerance.value;
  if (offset < -tol || offset > seg.lengthM + tol) { note('position', 'offset_out_of_segment', false, `${offset} on ${seg.segmentId} (${seg.lengthM} m)`); return undefined; }
  const loopM = site.toLoop(seg.segmentId, offset)!;
  return { segmentId: seg.segmentId, zoneId: seg.zoneId, offsetM: offset, loopM: normalise(site.loopLengthM, loopM) };
}

function validateControl(raw: unknown, note: (field: string, problem: string, repaired: boolean, value: unknown) => void): ControlFields | undefined {
  if (!isObject(raw)) { note('control', raw === undefined ? 'missing' : 'invalid', false, raw); return undefined; }
  let mode: ControlMode | undefined;
  if (typeof raw.mode === 'string') {
    const up = raw.mode.toUpperCase();
    if ((CONTROL_MODES as readonly string[]).includes(up)) {
      mode = up as ControlMode;
      if (up !== raw.mode) note('control.mode', 'lowercase', true, raw.mode);
    }
  }
  if (!mode) { note('control.mode', 'invalid', false, raw.mode); return undefined; }
  const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    mode,
    operatorId: typeof raw.operator_id === 'string' ? raw.operator_id : null,
    deadman: raw.deadman === true,
    lastDriveSeq: optNum(raw.last_drive_seq),
    lastDriveSentMs: optNum(raw.last_drive_sent_ms),
  };
}

// zone_event and hello zone entries. An unreadable status is unknown (null), never assumed open.
export interface ZoneFields {
  zoneId: string;
  status: ZoneStatus | null;
  effectiveAtMs: number | null;
  reason: string | null;
}

export function validateZone(raw: unknown): { zone: ZoneFields | null; issues: string[] } {
  if (!isObject(raw) || typeof raw.zone_id !== 'string' || raw.zone_id === '') return { zone: null, issues: ['zone:no_zone_id'] };
  const issues: string[] = [];
  let status: ZoneStatus | null = null;
  if (typeof raw.status === 'string') {
    const up = raw.status.toUpperCase();
    if ((ZONE_STATUSES as readonly string[]).includes(up)) {
      status = up as ZoneStatus;
      if (up !== raw.status) issues.push('zone.status:lowercase');
    }
  }
  if (status === null) issues.push('zone.status:invalid');
  const eff = raw.effective_at_ms;
  const effectiveAtMs = typeof eff === 'number' && Number.isFinite(eff) ? eff : null;
  if (eff !== null && eff !== undefined && effectiveAtMs === null) issues.push('zone.effective_at_ms:invalid');
  return { zone: { zoneId: raw.zone_id, status, effectiveAtMs, reason: typeof raw.reason === 'string' ? raw.reason : null }, issues };
}

export function serverTimeOf(m: Record<string, unknown>): number | undefined {
  const v = m.server_time_ms;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  if (v === undefined) return 'missing';
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
