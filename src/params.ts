// Every speed, delay and threshold the product relies on, with where it came from (CLAUDE.md
// invariant 7). Site geometry is not here: it comes from hello (site.ts). "measured" values are from
// the live gateway (research/README.md); "decided" values are ours, with the reason recorded.

export type Source = 'spec' | 'measured' | 'decided';

export interface Param {
  readonly value: number;
  readonly unit: 'm/s' | 'ms' | 'm' | '%';
  readonly source: Source;
  readonly ref: string;
}

const p = (value: number, unit: Param['unit'], source: Source, ref: string): Param => ({ value, unit, source, ref });

export const PARAMS = {
  // Speeds
  autoSpeedEmpty: p(3.0, 'm/s', 'spec', 'PROTOCOL.md §3, nominal speeds'),
  autoSpeedLoaded: p(2.0, 'm/s', 'spec', 'PROTOCOL.md §3, nominal speeds'),
  manualSpeedEmptyFull: p(4.0, 'm/s', 'spec', 'PROTOCOL.md §3, manual at full throttle'),
  manualSpeedLoadedFull: p(3.0, 'm/s', 'spec', 'PROTOCOL.md §3, manual at full throttle'),
  limpHomeSpeed: p(1.0, 'm/s', 'spec', 'PROTOCOL.md §6.6'),
  reverseSpeedEmpty: p(3.0, 'm/s', 'measured', 'research/README.md, probe S3: EXIT_ZONE reversed at 3.0 m/s'),
  reverseSpeedLoaded: p(2.0, 'm/s', 'spec', 'assumed from the autonomous loaded speed; not measured (CONTEXT.md assumption 6)'),

  // Work cycle
  loadTime: p(20_000, 'ms', 'spec', 'PROTOCOL.md §3, loads for about 20 s'),
  dumpTime: p(12_000, 'ms', 'spec', 'PROTOCOL.md §3, dumps for about 12 s'),
  chargeBelow: p(25, '%', 'spec', 'PROTOCOL.md §3, charges below 25 % at the end of the bay'),
  chargeTo: p(90, '%', 'spec', 'PROTOCOL.md §3, charges to 90 %'),

  // Commands and control
  supervisoryDelayMax: p(6_000, 'ms', 'spec', 'PROTOCOL.md §5, take effect 1 to 6 s after acceptance'),
  deadman: p(500, 'ms', 'spec', 'PROTOCOL.md §6.3; ~0.4 s measured in probe S4'),
  leaseIdleTimeout: p(10_000, 'ms', 'spec', 'PROTOCOL.md §6.4; 10.1 s measured in probe S4'),
  driveInterval: p(100, 'ms', 'spec', 'PROTOCOL.md §6.2, stream at 10 to 20 Hz'),
  exitZoneStopOutside: p(2, 'm', 'spec', 'PROTOCOL.md §5, stops about 2 m outside; 2.0 m measured in probe S3'),
  heartbeatInterval: p(2_000, 'ms', 'spec', 'PROTOCOL.md §4.3; 2.006 to 2.014 s measured'),

  // Data-confidence thresholds (TESTING.md "Thresholds"; owned by the ingest task)
  truckOldAfter: p(2_000, 'ms', 'decided', 'longest normal gap between one truck\'s messages was 1.67 s'),
  truckSilentAfter: p(5_000, 'ms', 'decided', 'flags only the known silent trucks in all three captures; leaves 5 s of the 10 s alarm budget'),
  frozenAfter: p(3_000, 'ms', 'decided', 'flags exactly the one frozen truck per capture, nothing else'),
  frozenMinReportedSpeed: p(0.5, 'm/s', 'decided', 'below this a truck may honestly be creeping'),
  frozenMaxMovement: p(0.05, 'm', 'decided', 'frozen positions repeat exactly; real motion at 0.5 m/s moves 1.5 m in 3 s'),
  linkDownAfter: p(5_000, 'ms', 'decided', '2.5 heartbeat intervals'),

  // Blast safety and operator attention
  cantClearAlarmWithin: p(10_000, 'ms', 'decided', 'CLAUDE.md invariant 5; TESTING.md L4.R1'),
  autoResumeWithin: p(15_000, 'ms', 'decided', 'TESTING.md L4.R3: command delay plus one retry, with margin'),
  estopAutoSendWithin: p(10_000, 'ms', 'decided', 'TESTING.md L7.8: a pending e-stop is sent on reconnect only within 10 s'),
  realertAfter: p(15 * 60_000, 'ms', 'decided', 'TESTING.md L2.63'),
  escalateAfter: p(30 * 60_000, 'ms', 'decided', 'TESTING.md L2.63'),
} as const satisfies Record<string, Param>;

export type ParamName = keyof typeof PARAMS;
