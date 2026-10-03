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
  queueing: 'spec' | 'pessimistic'; // L0.P: 'spec' as PROTOCOL.md §5 says; 'pessimistic' also drops queued commands without notice
  queuedDropProbability: number;  // guessed: L0.P pessimistic version only; queuing is unverified live (S2 never ran)
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
  firstBlastMinMs: number;        // measured: the first CLOSING came 60 s after connecting in all three captures (each a fresh day)
  firstBlastMaxMs: number;
  blastSpacingMinMs: number;      // measured: 276-318 s between CLOSINGs
  blastSpacingMaxMs: number;
  closedMinMs: number;            // measured: closed for 66-111 s
  closedMaxMs: number;
  cancelProbability: number;      // measured: 2 cancelled of 7 blasts across the three captures
  secondZoneProbability: number;  // guessed: two zones closing at once seen once (probe session)
  secondZoneOffsetMs: number;     // measured once: two zones CLOSING 30 s apart (fixture two-zones-closing)
  blastBay: boolean;              // open question 5: can BAY be closed? false until answered; the bay-closing injector turns it on

  // ---- Milestone 2: the radio, acks and faults. Used only when the matching fault is switched on
  // (fake/faults.ts). Rates are from research/README.md "Radio and blast statistics" and the full
  // captures; "1 of N" values are single observations.

  // Radio, telemetry only (heartbeats, zone events and lease events arrived complete and on time live)
  lossProbability: number;        // measured: 2.9-3.4 % of seqs never arrived (incl. truncated), runs of 1, rarely 2 or 3
  duplicateProbability: number;   // measured: 1.97-2.09 %, always byte-identical
  duplicateMaxDelayMs: number;    // measured: the copy arrived 0-900 ms after the first (p90 826 ms)
  lateProbability: number;        // measured: 4.89-5.09 % arrived behind a higher seq
  lateMinDelayMs: number;         // measured: reorder depth 1-8 messages at 5 Hz, i.e. ~0.25-1.7 s late
  lateMaxDelayMs: number;
  truncateProbability: number;    // measured: 0.18-0.21 % of all lines, always telemetry
  truncateMinChars: number;       // measured: cut after 193-209 characters
  truncateMaxChars: number;

  // Acks (probe log, send to ack on the probe's clock; the ack's server_time_ms is when the gateway got the command)
  ackDelayMinMs: number;          // measured: 157-2536 ms over 22 acks, median ~570; log-uniform fits the quartiles
  ackDelayMaxMs: number;
  ackDelayInvalidMinMs: number;   // measured: BAD_COMMAND_ID 97 ms, BAD_JSON ~120 ms (the gateway answers these itself)
  ackDelayInvalidMaxMs: number;
  lostAckProbability: number;     // measured once: 1 of 25 acks never arrived (S1's HOLD, which still executed)
  ignoredProbability: number;     // measured once: 1 of 9 ACCEPTED supervisory commands had no effect (S4's RESUME)

  // Link drops (whole site link; logins accepted then closed while down)
  linkFirstAfterMs: number;       // guessed from two runs: the first drop came 353 and 374 s in, none in the 6-minute run
  linkInNoticeMaxMs: number;      // measured: both first drops started 1 and 17 s after a CLOSING
  linkDownMinMs: number;          // measured, bounded by reconnect attempts: 35-45, 11-21 and 35-45 s
  linkDownMaxMs: number;
  linkSpacingMinMs: number;       // measured: second drop 472 and 519 s after the first
  linkSpacingMaxMs: number;

  // Per-truck faults (one truck each on a live day)
  frozenFromMinMs: number;        // measured: froze 160, 180 and 225 s in, while moving, and stayed frozen to the end
  frozenFromMaxMs: number;
  silentFirstMinMs: number;       // measured: first silence 28, 46 and 91 s in
  silentFirstMaxMs: number;
  silentMinMs: number;            // measured: silences of 24-55 s, seq not advancing across them
  silentMaxMs: number;
  talkMinMs: number;              // measured: 18-150 s of normal reporting between silences
  talkMaxMs: number;
  seqResetMinMs: number;          // measured: reset 101, 108 and 178 s in
  seqResetMaxMs: number;
  hydFaultMinMs: number;          // measured: HYD_PRESSURE_LOW 291, 328 and 332 s in
  hydFaultMaxMs: number;
  depletedMinMs: number;          // guessed: BATTERY_DEPLETED on its own (live it came from the weak pack, 465 and 508 s in)
  depletedMaxMs: number;
  weakFactorMin: number;          // measured: weak packs drained 5.0-5.2x the fleet median
  weakFactorMax: number;
  weakDiesMinFraction: number;    // measured: died 0.62 and 0.73 of the way from the load point to the dump point (in the incline)
  weakDiesMaxFraction: number;
  skewMinMs: number;              // measured: one truck's clock 3475-3483 s ahead (~58 min)
  skewMaxMs: number;
  clockJitterMs: number;          // measured: every other truck's clock within ±3.3 s of the gateway's
  malformedProbability: number;   // measured: each of four defects in 1.5-2.5 % of the malformed truck's messages
  fractionDigits: number;         // measured: fractional SoC sent with 4 decimals (0.8201)
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
  queuedDropProbability: 0.25,
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
  firstBlastMaxMs: 60_000,
  blastSpacingMinMs: 276_000,
  blastSpacingMaxMs: 318_000,
  closedMinMs: 66_000,
  closedMaxMs: 111_000,
  cancelProbability: 2 / 7,
  secondZoneProbability: 0.2,
  secondZoneOffsetMs: 30_000,
  blastBay: false,

  lossProbability: 0.028,
  duplicateProbability: 0.02,
  duplicateMaxDelayMs: 900,
  lateProbability: 0.05,
  lateMinDelayMs: 250,
  lateMaxDelayMs: 1_700,
  truncateProbability: 0.0019,
  truncateMinChars: 193,
  truncateMaxChars: 209,

  ackDelayMinMs: 150,
  ackDelayMaxMs: 2_600,
  ackDelayInvalidMinMs: 50,
  ackDelayInvalidMaxMs: 150,
  lostAckProbability: 1 / 25,
  ignoredProbability: 1 / 9,

  linkFirstAfterMs: 300_000,
  linkInNoticeMaxMs: 20_000,
  linkDownMinMs: 15_000,
  linkDownMaxMs: 42_000,
  linkSpacingMinMs: 460_000,
  linkSpacingMaxMs: 530_000,

  frozenFromMinMs: 150_000,
  frozenFromMaxMs: 230_000,
  silentFirstMinMs: 25_000,
  silentFirstMaxMs: 95_000,
  silentMinMs: 24_000,
  silentMaxMs: 55_000,
  talkMinMs: 18_000,
  talkMaxMs: 150_000,
  seqResetMinMs: 90_000,
  seqResetMaxMs: 190_000,
  hydFaultMinMs: 280_000,
  hydFaultMaxMs: 340_000,
  depletedMinMs: 300_000,
  depletedMaxMs: 600_000,
  weakFactorMin: 5.0,
  weakFactorMax: 5.2,
  weakDiesMinFraction: 0.55,
  weakDiesMaxFraction: 0.8,
  skewMinMs: 3_475_000,
  skewMaxMs: 3_484_000,
  clockJitterMs: 3_300,
  malformedProbability: 0.02,
  fractionDigits: 4,
});

// TESTING.md L0.P: the two versions of what is unverified live. Each L4 run uses one of them.
export const SPEC_VERSION: Readonly<Partial<Behaviour>> = Object.freeze({ queueing: 'spec', reverseSpeedLoaded: 2.0 });
export const PESSIMISTIC_VERSION: Readonly<Partial<Behaviour>> = Object.freeze({ queueing: 'pessimistic', reverseSpeedLoaded: 1.5 });
