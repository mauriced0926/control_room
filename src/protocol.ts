// Site Link Protocol 3.0 message shapes (dlh-candidate-package/PROTOCOL.md). These describe what the
// spec promises. What actually arrives is validated by ingest, because the live site breaks these
// shapes on purpose (research/README.md).

export const VEHICLE_STATES = ['TRAMMING', 'LOADING', 'DUMPING', 'CHARGING', 'HOLDING', 'IDLE', 'MANUAL', 'ESTOPPED', 'FAULT'] as const;
export type VehicleState = (typeof VEHICLE_STATES)[number];

export const TASKS = ['RETURN_TO_BAY', 'EXIT_ZONE'] as const;
export type Task = (typeof TASKS)[number];

export const DIRECTIONS = ['FWD', 'REV'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const CONTROL_MODES = ['AUTO', 'MANUAL'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

export const ZONE_STATUSES = ['OPEN', 'CLOSING', 'CLOSED'] as const;
export type ZoneStatus = (typeof ZONE_STATUSES)[number];

export const ACTIONS = ['HOLD', 'RESUME', 'RETURN_TO_BAY', 'EXIT_ZONE', 'TAKE_CONTROL', 'RELEASE_CONTROL', 'ESTOP', 'CLEAR_ESTOP'] as const;
export type Action = (typeof ACTIONS)[number];

export const REJECT_REASONS = [
  'BAD_COMMAND_ID', 'BAD_JSON', 'MISSING_OPERATOR', 'UNKNOWN_VEHICLE', 'UNSUPPORTED_ACTION',
  'INTERLOCK_ACTIVE', 'ESTOP_ACTIVE', 'LEASE_HELD', 'NOT_LEASE_HOLDER', 'INVALID_STATE', 'COMMAND_ID_REUSED',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const LEASE_EVENTS = ['GRANTED', 'RELEASED', 'EXPIRED', 'REVOKED'] as const;
export type LeaseEventKind = (typeof LEASE_EVENTS)[number];

export const DRIVE_REJECT_REASONS = ['NO_ACTIVE_LEASE', 'BAD_THROTTLE', 'BAD_SEQ', 'UNKNOWN_VEHICLE'] as const;
export type DriveRejectReason = (typeof DRIVE_REJECT_REASONS)[number];

export const AUTH_ERRORS = ['AUTH_REQUIRED', 'AUTH_TIMEOUT', 'BAD_AUTH', 'BAD_EMAIL', 'TOO_MANY_CONNECTIONS', 'SERVER_FULL'] as const;
export type AuthErrorReason = (typeof AUTH_ERRORS)[number];

// ---- gateway → client ----

export interface RouteSegment {
  segment_id: string;
  zone_id: string;
  start_m: number;
  length_m: number;
  kind: string; // the spec names bay, transit, load and dump; other values are passed through
}

export interface ZoneState {
  zone_id: string;
  status: ZoneStatus;
  effective_at_ms: number | null;
  reason: string | null;
}

export interface Hello {
  type: 'hello';
  protocol: string;
  site_id: string;
  server_time_ms: number;
  vehicles: string[];
  route: RouteSegment[];
  loop_length_m: number;
  zones: ZoneState[];
  leases: Array<{ vehicle_id: string; operator_id: string }>;
  site?: { name: string };
}

export interface Control {
  mode: ControlMode;
  operator_id: string | null;
  deadman: boolean;
  last_drive_seq: number | null;
  last_drive_sent_ms: number | null;
}

export interface Telemetry {
  type: 'telemetry';
  vehicle_id: string;
  seq: number;
  t_device_ms: number;
  state: VehicleState;
  task: Task | null;
  soc_pct: number;
  speed_mps: number;
  direction: Direction;
  segment_id: string;
  zone_id: string;
  offset_m: number;
  payload_kg: number;
  faults: string[];
  control: Control;
}

export interface Heartbeat {
  type: 'heartbeat';
  server_time_ms: number;
}

export interface ZoneEvent {
  type: 'zone_event';
  zone_id: string;
  status: ZoneStatus;
  reason: string | null;
  effective_at_ms: number | null;
  server_time_ms: number;
}

export interface CommandAck {
  type: 'command_ack';
  command_id: string; // "<missing>" or "<unparseable>" when the gateway couldn't read ours
  vehicle_id: string | null;
  status: 'ACCEPTED' | 'REJECTED';
  server_time_ms: number;
  reason?: RejectReason;
  holder?: string;
  lease_id?: string;
  lease_idle_timeout_ms?: number;
  deadman_ms?: number;
}

export interface LeaseEvent {
  type: 'lease_event';
  vehicle_id: string;
  event: LeaseEventKind;
  lease_id: string;
  operator_id: string;
  server_time_ms: number;
  reason?: string;
  by_operator?: string;
  forced?: boolean;
}

export interface DriveRejected {
  type: 'drive_rejected';
  vehicle_id: string;
  lease_id: string;
  reason: DriveRejectReason;
  server_time_ms: number;
}

export interface AuthError {
  type: 'auth_error';
  reason: AuthErrorReason;
}

export type GatewayMessage = Hello | Telemetry | Heartbeat | ZoneEvent | CommandAck | LeaseEvent | DriveRejected | AuthError;

// ---- client → gateway ----

export interface AuthMessage {
  type: 'auth';
  email: string;
}

export interface CommandMessage {
  type: 'command';
  command_id: string;
  vehicle_id: string;
  action: Action;
  operator_id: string;
  force?: true;
  lease_id?: string;
}

export interface DriveMessage {
  type: 'drive';
  vehicle_id: string;
  lease_id: string;
  seq: number;
  throttle: number;
  sent_ms?: number;
}

export type ClientMessage = AuthMessage | CommandMessage | DriveMessage;
