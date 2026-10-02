// How the fake site behaves: speeds, timings, energy, blast statistics. Each value says where it
// came from: the spec (PROTOCOL.md), measured on the live gateway (research/README.md and the
// fixtures), or guessed (no evidence either way; to be re-checked against the live site).
//
// These are deliberately separate from the product's src/params.ts. The fake is the oracle the
// product is tested against; if it borrowed the product's beliefs, a wrong belief would make the
// oracle agree with it. Site geometry is not here: it comes from the site config (fake/dlh1.ts).

export interface Behaviour {
  // Simulation
  tickMs: number;                 // decided: physics step; deadman and blast times resolve to it
  telemetryPeriodMs: number;      // spec §4.2 "about 5 Hz"; t_device_ms steps of 200-202 ms measured
  heartbeatPeriodMs: number;      // spec §4.3, 2 s; 2.006-2.014 s measured

  // Speeds (m/s)
  autoSpeedEmpty: number;         // spec §3
  autoSpeedLoaded: number;        // spec §3
  reverseSpeedEmpty: number;      // measured: probe S3, EXIT_ZONE reversed at 3.0 m/s
  reverseSpeedLoaded: number;     // spec-assumed (2.0, the autonomous loaded speed); not measured. L0.P runs 1.5 too
  manualSpeedEmpty: number;       // spec §3, at full throttle
  manualSpeedLoaded: number;      // spec §3, at full throttle
  limpSpeed: number;              // spec §6.6, 1.0 m/s; guessed: scaled by |throttle| like the others

  // Work cycle
  loadMs: number;                 // spec §3 "about 20 s"
  dumpMs: number;                 // spec §3 "about 12 s"
  workStopBeforeEndM: number;     // measured: trucks load and dump at offset 59.95 of a 60 m segment
  payloadKg: number;              // measured: 42000.0 in every loaded message
  chargeBelowPct: number;         // spec §3
  chargeToPct: number;            // spec §3
  chargeRatePctPerS: number;      // guessed: no CHARGING seen live; Sam's "a ten-minute charge" (~60 % in 600 s)

  // Energy (% of charge per km travelled; nothing while stopped)
  drainEmptyPctPerKm: number;     // measured: fleet 5.99 %/km empty (weak-pack, reverse-exit-zone fixtures)
  drainLoadedPctPerKm: number;    // measured: fleet 9.00 %/km loaded (weak-pack fixture)

  // Commands and control
  commandDelayMinMs: number;      // spec §5 "1 to 6 seconds"; live: HOLD 3.2 s, EXIT_ZONE ~4 s, RESUME 1.3 s
  commandDelayMaxMs: number;
  queueing: 'spec';               // L0.P: 'spec' only in milestone 1; the pessimistic version is milestone 2
  deadmanMs: number;              // spec §6.3; deadman seen 0.4-0.6 s after the grant live
  leaseIdleTimeoutMs: number;     // spec §6.4; 10.1 s measured
  exitStopOutsideM: number;       // spec §5 "about 2 m"; 2.0 m measured (probe S3)
  driveRejectIntervalMs: number;  // spec §4.7, at most one per vehicle per reason per second
  limpHomeFaults: string[];       // spec §6.6: HYD_PRESSURE_LOW allows limp-home; others guessed not to
  depletedFault: string;          // spec §6.6 / measured: weak-pack fixture

  // Transport
  authTimeoutMs: number;          // spec §1.1
  maxConnections: number;         // spec §1.1
  maxLineBytes: number;           // spec §1, 64 KiB
  maxBehindBytes: number;         // spec §1, "about 4 MB"

  // Blasts (random schedule)
  firstBlastMinMs: number;        // guessed: the captures start mid-day
  firstBlastMaxMs: number;
  blastSpacingMinMs: number;      // measured: 276-318 s between CLOSINGs
  blastSpacingMaxMs: number;
  closedMinMs: number;            // measured: closed for 66-111 s
  closedMaxMs: number;
  cancelProbability: number;      // measured: 2 cancelled of 7 blasts across the three captures
  secondZoneProbability: number;  // guessed: two zones closing at once seen once (probe session)
  secondZoneOffsetMs: number;     // measured once: two zones CLOSING 30 s apart (fixture two-zones-closing)
  blastBay: boolean;              // open question 5: can BAY be closed? false until answered (L0.F adds it)
}

export const DEFAULT_BEHAVIOUR: Readonly<Behaviour> = Object.freeze({
  tickMs: 50,
  telemetryPeriodMs: 200,
  heartbeatPeriodMs: 2_000,

  autoSpeedEmpty: 3.0,
  autoSpeedLoaded: 2.0,
  reverseSpeedEmpty: 3.0,
  reverseSpeedLoaded: 2.0,
  manualSpeedEmpty: 4.0,
  manualSpeedLoaded: 3.0,
  limpSpeed: 1.0,

  loadMs: 20_000,
  dumpMs: 12_000,
  workStopBeforeEndM: 0.05,
  payloadKg: 42_000,
  chargeBelowPct: 25,
  chargeToPct: 90,
  chargeRatePctPerS: 0.1,

  drainEmptyPctPerKm: 6.0,
  drainLoadedPctPerKm: 9.0,

  commandDelayMinMs: 1_000,
  commandDelayMaxMs: 6_000,
  queueing: 'spec',
  deadmanMs: 500,
  leaseIdleTimeoutMs: 10_000,
  exitStopOutsideM: 2.0,
  driveRejectIntervalMs: 1_000,
  limpHomeFaults: ['HYD_PRESSURE_LOW'],
  depletedFault: 'BATTERY_DEPLETED',

  authTimeoutMs: 10_000,
  maxConnections: 16,
  maxLineBytes: 64 * 1024,
  maxBehindBytes: 4 * 1024 * 1024,

  firstBlastMinMs: 60_000,
  firstBlastMaxMs: 240_000,
  blastSpacingMinMs: 276_000,
  blastSpacingMaxMs: 318_000,
  closedMinMs: 66_000,
  closedMaxMs: 111_000,
  cancelProbability: 2 / 7,
  secondZoneProbability: 0.2,
  secondZoneOffsetMs: 30_000,
  blastBay: false,
});
