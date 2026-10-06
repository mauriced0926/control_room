// Every speed, delay and threshold the product relies on, with where it came from (CLAUDE.md
// invariant 7). Site geometry is not here: it comes from hello (site.ts). "measured" values are from
// the live gateway (research/README.md); "decided" values are ours, with the reason recorded.

export type Source = 'spec' | 'measured' | 'decided';

export interface Param {
  readonly value: number;
  readonly unit: 'm/s' | 'ms' | 'm' | '%' | '%/s' | 'count' | 'ratio' | 'bytes';
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
  reverseSpeedLoaded: p(2.0, 'm/s', 'measured', 'thinly: re-probe R1, 1.99 m/s by the truck\'s clock over only 2.4 m before it went silent (research/README.md); test 1.5 as the pessimistic case'),

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

  // Ingest: ordering, time and field repair (owned by the ingest task)
  reorderWindow: p(50, 'count', 'decided', 'deepest reordering in any fixture is 6 seqs; 50 is 10 s at 5 Hz. A larger seq drop with the device clock moving forward is a controller restart'),
  serverTimeSamples: p(8, 'count', 'decided', 'server-time offset is the max over the last 8 samples (16 s of heartbeats): delay only makes a sample low'),
  telemetryLatencyAllowance: p(1_500, 'ms', 'measured', 'a truck\'s t_device - rx spread is up to 1.25 s within one fixture (seq-reset fixture: 1.07 to 2.32 s), so a message may describe the truck that much earlier than it arrived'),
  deviceSkewFlagAbove: p(10_000, 'ms', 'decided', 'every truck in every fixture is within 3 s of arrival time except the skewed one, at about +58 min'),
  offsetTolerance: p(0.5, 'm', 'decided', 'offset_m may sit this far past its segment ends before the position is treated as unknown; no fixture goes past at all'),
  fractionalSocJump: p(2, '%', 'decided', 'healthy drain is under 0.1 % per message even for the weak pack; a drop of more than 2 points into the 0-1 range is a fraction, not a drain'),

  // Battery (owned by the ingest task)
  drainWindow: p(500, 'm', 'decided', 'drain rate is measured over the last 500 m travelled in each load state'),
  drainMinEvidence: p(60, 'm', 'decided', 'about 20 s at 3 m/s; at 0.01 % SoC resolution a healthy 0.36 % over 60 m reads within 3 %. The fleet median needs 3 other trucks with this much too: weak-pack replay flags the weak truck 34 s in (64 s at 100 m)'),
  drainMaxGap: p(10_000, 'ms', 'decided', 'over a longer gap the path travelled is not known; the interval is skipped'),
  drainRatioFlag: p(2, 'ratio', 'decided', 'healthy trucks are within 1 % of the fleet median (6.0 %/km empty, 9.0 loaded, weak-pack fixture); the weak pack is 5x'),
  fleetMinTrucks: p(3, 'count', 'decided', 'a fleet median needs at least 3 other trucks with enough evidence'),
  loadedDrainFactor: p(1.5, 'ratio', 'measured', 'fleet median 9.0 %/km loaded against 6.0 empty (weak-pack fixture); used only until the fleet itself gives a ratio'),
  batteryReserveFactor: p(1.25, 'ratio', 'decided', 'warn when charge is below 1.25x the estimated need, so the warning comes while there is still time to act'),

  // Gateway link (task 3)
  linkBackoffBase: p(500, 'ms', 'decided', 'first retry after a drop; doubles per failed attempt. The live capture tool used 2 s doubling to 10 s and reconnected cleanly'),
  linkBackoffMax: p(5_000, 'ms', 'decided', 'cap: once the site link returns we reconnect within 5 s, so a 21-49 s live outage costs at most 5 s more of a 120 s blast notice'),
  linkBackoffBusyBase: p(5_000, 'ms', 'decided', 'TOO_MANY_CONNECTIONS and SERVER_FULL (PROTOCOL.md §1.1, "try again shortly"): the gateway is loaded, so start slower'),
  linkBackoffBusyMax: p(30_000, 'ms', 'decided', 'cap for a loaded gateway; the link status says why we are waiting'),
  helloTimeout: p(5_000, 'ms', 'decided', 'a login with no hello within 5 s is an outage; live, hello came 85 ms after connecting and outage logins closed within 52 ms (link-drop-in-notice)'),

  // Command registry (task 4)
  commandUplinkAllowance: p(500, 'ms', 'measured', 'the gateway stamped all 11 fixture acks 43-58 ms after the probe sent (probe clock against gateway clock, so uplink plus their offset); about 10x margin. Acks themselves arrived 0.31-2.58 s after sending'),
  immediateEffectDeadline: p(3_000, 'ms', 'decided', 'ESTOP and lease operations take effect on receipt (PROTOCOL.md §5): uplink plus telemetry latency (1.5 s) plus margin'),
  commandMaxAttempts: p(3, 'count', 'decided', 'one accepted-then-ignored plus one more; both live retries worked first time (research/README.md). 3 x 8 s fits well inside a 120 s notice'),
  estopMaxAttempts: p(5, 'count', 'decided', 'an e-stop is worth more tries; 5 x 3 s is still 15 s'),
  chargeRate: p(0.1, '%/s', 'decided', 'guessed: no CHARGING was ever captured; Sam\'s "ten-minute charge". Used only for an estimate, never a deadline'),
  reconnectVerifyGrace: p(2_500, 'ms', 'decided', 'after a reconnect, a command too old to replay is checked against telemetry for this long (latency 1.5 s plus margin) before it is marked expired'),

  // Blast safety and operator attention
  reverseSpeedLoadedPlanning: p(1.5, 'm/s', 'decided', 'the blast engine plans a loaded reverse at the pessimistic speed TESTING.md L0.P tests (reverseSpeedLoaded is measured over only 2.4 m): a truck we think can clear and can\'t would get no alarm'),
  dutyStopBeforeEnd: p(0.05, 'm', 'measured', 'trucks load and dump at offset 59.95 of a 60 m segment (fixtures): the stop is inside the segment, short of its end'),
  blastExitMargin: p(5_000, 'ms', 'decided', 'BLAST.md "with the margin": a predicted exit must beat effective_at by this much to count, and an evacuation predicted to finish later than this before it raises the can\'t-clear alarm. Covers the 1-6 s delay being drawn late and telemetry describing the truck late'),
  blastHoldMarginM: p(10, 'm', 'decided', 'BLAST.md B6: added to the hold distance (6 s + age + latency) x speed. 10 m is 3.3 s at 3 m/s'),
  blastEvalInterval: p(250, 'ms', 'decided', 'the engine re-evaluates every truck at least this often while a zone is not open (last safe moments, silence, alarms); also on every zone event, reconnect and telemetry'),
  b6aTakeBeforeWorkEnds: p(8_000, 'ms', 'decided', 'BLAST.md B6a: take control this long before loading or dumping is due to end. TAKE_CONTROL acts on receipt (acked in 0.16-0.68 s live), and the work may have started up to 1.5 s before we saw it; 8 s leaves 5 s spare. Charging has no known end (the rate is guessed), so a charging truck is taken at once'),
  blastCommandCooldown: p(8_000, 'ms', 'decided', 'after a system command fails for good (the registry has retried it), the engine decides again no sooner than one confirmation deadline later, so a truck that ignores commands is not flooded'),
  cantClearAlarmWithin: p(10_000, 'ms', 'decided', 'CLAUDE.md invariant 5; TESTING.md L4.R1'),
  autoResumeWithin: p(15_000, 'ms', 'decided', 'TESTING.md L4.R3: command delay plus one retry, with margin'),
  estopAutoSendWithin: p(10_000, 'ms', 'decided', 'TESTING.md L7.8: a pending e-stop is sent on reconnect only within 10 s'),
  realertAfter: p(15 * 60_000, 'ms', 'decided', 'TESTING.md L2.63'),
  escalateAfter: p(30 * 60_000, 'ms', 'decided', 'TESTING.md L2.63'),

  // The service and the operators' browsers (task 6b)
  livePushMinInterval: p(250, 'ms', 'decided', 'at most 4 pictures a second to each browser: faster than a person reads, slow enough that 140 trucks fit; trucks report at 5 Hz and chips glide between frames'),
  liveFrameMaxInterval: p(1_000, 'ms', 'decided', 'a frame at least every second even when nothing arrived, so ages keep counting on screen and the frame doubles as the service heartbeat'),
  browserStaleAfter: p(3_000, 'ms', 'decided', 'the browser says "service disconnected" after 3 missed frames; src/ui/app.ts reads it from here'),
  liveMaxBufferedBytes: p(1_048_576, 'bytes', 'decided', 'a browser this far behind skips frames rather than queueing old pictures'),
  sessionIdleTimeout: p(30 * 60_000, 'ms', 'decided', 'a session ends 30 min after its last request with no screen open; an open screen keeps it alive, because logging out a watched control-room screen mid-shift hides alarms'),
  sessionMaxAge: p(14 * 3_600_000, 'ms', 'decided', 'a 12-hour shift plus handover: every session ends by then, screen open or not'),
  loginMaxFailures: p(5, 'count', 'decided', 'failed logins for one user name, or from one address, before further attempts are refused for the window'),
  loginFailureWindow: p(15 * 60_000, 'ms', 'decided', 'the window the failure count covers'),
  browserMessagesPerSecond: p(10, 'count', 'decided', 'a person presses at most a few buttons a second; more is a stuck script or an attack, refused and logged'),
} as const satisfies Record<string, Param>;

export type ParamName = keyof typeof PARAMS;
