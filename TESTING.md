# Testing

The spec agent tasks point at: which cases each part of the system must pass. The strategy is in
`PLAN.md` ("How it's tested"); the evidence behind the cases is in `research/README.md`.

Each layer answers one way the system will be judged. Every case has an ID (`L2.14`) so a task can
name exactly what it must pass. A task is done when its cases pass **and** its claims have been
checked against raw data (`CLAUDE.md`).

## Ground rules

- **Time is injected** (`CLAUDE.md` invariant 1). Every test controls the clock. Blast scenarios run in
  milliseconds; nothing sleeps.
- **Real data before invented data.** Use `research/fixtures/` wherever it covers a case.
- **Seeds are reproducible.** Every random run takes a seed and prints it on failure. A failing seed
  is added to `test/seeds/regressions` and runs in CI from then on.
- **Two kinds of truth.** The product decides from what it *believes* (the data it received). Only
  the fake gateway knows what *is*. A rule is always stated against one or the other, never vaguely.

## Task → cases

| PLAN task | Must pass |
|---|---|
| 1. Fake gateway | L0 (all) |
| 2. Ingest and fleet state | L1, L2.1–L2.25, L3 |
| 3. Gateway link | L2.40–L2.44, L5 link rows, L6.1–L6.2 |
| 4. Command registry | L2.30–L2.39, L5 command rows, L8.1–L8.3 |
| 5. Blast engine | L2.1–L2.8, L4, L5 (all) |
| 6. Server, login, UI, driving | L6.3–L6.5, L7, L8, L9 |
| 7. Deploy and soak | L10, L12, L13; L11 is run by a person |

---

## L0. The fake gateway, and when to trust it

The fake gateway plays the site: trucks on the loop, the duty cycle, commands, leases, blasts, the
radio and the faults. It knows true positions, so it is the oracle for L4. **Its results count only
once it passes conformance (L0.C).**

**L0.M Model.** Geometry and duty cycle from `PROTOCOL.md` §3. Command semantics from §5–6, with the
probe's observed behaviour where it differs or adds detail: lost acks that still execute, resend
returns the original ack, `ACCEPTED` then not executed, reverse at full autonomous speed, stop
~2 m outside the zone, deadman ~0.5 s, lease expiry 10 s → `HOLDING`.

**L0.F Fault injectors**, one per class, each switchable and seeded: link drop (with login-then-close
during the outage), lost ack, `ACCEPTED`-then-ignored, frozen message (moving and stationary),
silent truck, `seq` reset, truncated line, fractional SoC, malformed fields, clock skew, duplicates,
reordering, weak pack, `HYD_PRESSURE_LOW`, `BATTERY_DEPLETED`, two zones closing at once, cancelled
blast, slow reader (drop a client more than 4 MB behind).

**L0.P Parameters for unverified behaviour.** Each is run both ways in L4:

| Parameter | Spec version | Pessimistic version |
|---|---|---|
| Queuing behind LOADING / DUMPING / CHARGING | Queued, runs when the work ends; a newer command replaces the older | As spec, plus the queued command is sometimes dropped without notice |
| Reverse speed, loaded | 2.0 m/s | 1.5 m/s |

Queuing is re-probed live once DRAW_12 is not under a blast. **That sends real commands: ask first.**

**L0.C Conformance.** Before any L4 result counts:

| ID | Check |
|---|---|
| L0.C1 | Each fixture's fault, injected into the fake, produces a stream that `research/report.py` flags the same way it flags the fixture |
| L0.C2 | `research/probe.py`, pointed at the fake (which serves TLS with a test certificate, passed via `SSL_CERT_FILE`), produces the same ack sequence and reasons as the live probe for S1, S3–S8 |
| L0.C3 | Over a 15-minute fake day: telemetry ~5 Hz per truck, duplicates ~2 %, reordering ~6 %, loss ~3 %, truncation ~0.2 %, notice 120 s, closures 66–111 s, link drops 20–45 s. Each within the ranges in `research/README.md`, or the gap written down |
| L0.C4 | The fake is deterministic: the same seed gives a byte-identical stream |

## L1. Injectable time

| ID | Case |
|---|---|
| L1.1 | A lint rule or test fails the build if any module outside the clock adapter calls `Date.now`, `new Date()`, `performance.now` or timers directly |
| L1.2 | A full blast cycle (CLOSING → CLOSED → OPEN) runs in under 100 ms of real time |

## L2. Pure logic, table-driven

**Loop geometry and time to clear**

| ID | Case |
|---|---|
| L2.1 | Distance to each boundary of the current zone, including across the wrap at 1600 m → 0 m |
| L2.2 | Nearer boundary and direction (`FWD`/`REV`) for every zone, at each end and in the middle |
| L2.3 | Time to clear = distance ÷ speed + up to 6 s to take effect; empty 3.0 m/s (measured), loaded 2.0 m/s (assumed, parameterised) |
| L2.4 | Reachable set for a frozen truck: every position it could reach since its last position that moved, at the speed it reported, as an interval on the loop with wrap |
| L2.5 | Reachable set for a silent truck, the same way, from its last message |
| L2.6 | Zones overlapping a reachable set: a set that straddles a boundary counts as inside both zones |
| L2.7 | A truck that cannot get out before `effective_at` (DECLINE ~167 s against 120 s of notice) is flagged |
| L2.8 | The upstream trucks to hold before reversing a truck out of a zone: those behind it within its reverse path plus a margin |

**Ingest, one case per fault class**

| ID | Case |
|---|---|
| L2.10 | Fractional SoC (all values ≤ 1.0): flagged, shown as reported, **not** scaled |
| L2.11 | Truncated line: dropped, counted per connection, never crashes the reader |
| L2.12 | Lowercase state (`tramming`): normalised, and counted as a data-quality event |
| L2.13 | `offset_m` as a string: parsed if numeric, counted; otherwise the field is unknown |
| L2.14 | Null or missing `speed_mps` / `soc_pct`: the field is unknown and keeps its last known value with its age; the rest of the message is used |
| L2.15 | Unknown `segment_id` or zone/segment mismatch: position unknown, not guessed |
| L2.16 | Clock skew of +58 min: ages unaffected (they use `server_time_ms`); skew is shown per truck |
| L2.17 | Message with unknown `type`: ignored |

**Restart versus duplicate**

| ID | Case |
|---|---|
| L2.20 | Same `seq`, same body: duplicate, dropped |
| L2.21 | Lower `seq` within the reorder window: older, does not overwrite newer state |
| L2.22 | `seq` drops by more than the window while `t_device_ms` moves forward: new controller run; its messages are applied (fixture `seq-reset`) |
| L2.23 | `seq` drops and `t_device_ms` goes backwards: treated as reordering, not a restart |

**Frozen detection: the negatives matter as much**

| ID | Case | Expected |
|---|---|---|
| L2.24 | `TRAMMING` at 2–3 m/s, position unchanged past the threshold (fixture `frozen-truck`) | Flagged contradicted |
| L2.25a | `LOADING`, identical bodies for 20 s | **Not** flagged |
| L2.25b | `HOLDING` for an hour | **Not** flagged |
| L2.25c | `IDLE` or `CHARGING` in the bay | **Not** flagged |
| L2.25d | `MANUAL` with deadman true, speed 0 | **Not** flagged |
| L2.25e | `MANUAL`, speed > 0, position unchanged | Flagged |

**Command registry**

| ID | Case |
|---|---|
| L2.30 | Ack arrives before the telemetry that shows the effect, and after it: both end confirmed |
| L2.31 | Ack lost, effect seen: confirmed, with "no ack received" recorded |
| L2.32 | Duplicate ack: no state change |
| L2.33 | An ack is matched to the latest send of its `command_id` by time, never by counting (`AI_LOG.md` entry 1) |
| L2.34 | `COMMAND_ID_REUSED`: reported as our bug, never retried |
| L2.35 | `LEASE_HELD` carries the holder; the refusal names them |
| L2.36 | Deadlines depend on state: ~6 s when tramming; when LOADING (~20 s) or DUMPING (~12 s), the remaining work time plus 6 s; when CHARGING, no fixed deadline: shown as queued, with an estimate from the charge rate |
| L2.37 | `ACCEPTED`, no effect by the deadline: retried under a new `command_id`, attempt count shown, alarm after the last attempt (fixture `accepted-then-ignored-resume`) |
| L2.38 | A retry never displaces a **different** command we queued on that truck |
| L2.39 | Every refusal reason in `PROTOCOL.md` §4.5 maps to a distinct message in the operator's words |

**Link**

| ID | Case |
|---|---|
| L2.40 | No heartbeat for 5 s (2.5 intervals): link down |
| L2.41 | Login accepted then closed before `hello`: retry with backoff, capped |
| L2.42 | On `hello`: zones, leases and vehicles replace local state, and in-flight `command_id`s are replayed |
| L2.43 | During an outage every truck ages; nothing is shown as live |
| L2.44 | `auth_error`: reason shown; `TOO_MANY_CONNECTIONS` and `SERVER_FULL` back off, the others stop and alarm |

## L3. Fixture replay

Each fixture in `research/fixtures/` is replayed through ingest and fleet state with injected time.
The assertion is what the operator would see.

| ID | Fixture | Operator sees |
|---|---|---|
| L3.1 | `frozen-truck` | HT-10 marked contradicted within the threshold, its position shown as a range; HT-05 loading shown normally |
| L3.2 | `seq-reset` | HT-01 keeps moving on screen across the reset; a "controller restarted" note |
| L3.3 | `silent-truck` | HT-03 shown at its last position with a growing age, then silent; link shown healthy |
| L3.4 | `truncated-lines` | Nothing changes on screen; the data-quality count rises by 87 |
| L3.5 | `fractional-soc` | HT-12's SoC shown as reported, with a flag, not as 82 % |
| L3.6 | `accepted-then-ignored-resume` | RESUME shown as "accepted, not executed", then retried, then confirmed |
| L3.7 | `reverse-exit-zone` | EXIT_ZONE progress shown, and the trucks behind it highlighted |
| L3.8 | `two-zones-closing` | Both zones shown closing, each with its own countdown and trucks |
| L3.9 | `link-drop-in-notice` | Link-down banner; on reconnect DRAW_12 still closing, with the time left recalculated |

## L4. Blast safety, property-tested

Seeded random days from the fake gateway, mixing every fault in L0.F. 200 seeds in CI; the full set
(thousands) before submission. Each runs under both versions of L0.P.

**Definitions.**
- *Inside* (truth): the fake's true position is within the zone.
- *Might be inside* (belief): the product's reachable set for the truck overlaps the zone (L2.4–L2.6).
- *The data allows the conclusion* at the latest of: `CLOSING` delivered; reconnect after a link drop;
  the first delivery of the evidence that the truck cannot clear (a fault, a contradiction past
  threshold, silence past threshold, a confirmation deadline missed).
- *Can't-clear alarm*: an alarm naming the truck, the zone and the reason.

**Rules.**

| ID | Rule | Checked against | Faults covered |
|---|---|---|---|
| L4.R1 | A can't-clear alarm goes up within 10 s of the data allowing the conclusion, for every truck inside a `CLOSED` zone | Truth | Every detectable fault |
| L4.R2a | Never recommend "clear" while the system believes a truck might be inside | Belief | **Every fault, including the undetectable one.** This never leaves the suite |
| L4.R2b | Never recommend "clear" while a truck is inside | Truth | Every detectable fault |
| L4.R2c | As L4.R2b, for a truck frozen while stopped that then moves | Truth | The undetectable fault, run separately. Violations are **counted, not failed**, and reported as the README §5 limit of enforcement |
| L4.M1 | Unnecessary holds: blast holds on trucks whose true path would never have entered the zone while it was closed | Truth | Every fault. **A metric, not a pass/fail**; a rise is a regression to explain |

**L4.X Combinations to fill first** (seen live): a link drop during the notice; a frozen truck in a
closing zone; two zones closing at once.

## L5. Fault-injection matrix

Each cell is a scenario test with injected time: the fault happens at that moment, and the rules in
L4 plus the expected operator view are asserted. The three cells marked ★ come first.

| Fault ↓ / moment → | Steady | During CLOSING | During manual driving | During reconnect |
|---|---|---|---|---|
| Link drop | ✓ | ★ | ✓ | ✓ |
| Lost ack | ✓ | ✓ | ✓ | ✓ |
| Accepted then ignored | ✓ | ✓ | – | ✓ |
| Frozen truck | ✓ | ★ | ✓ | ✓ |
| Silent truck | ✓ | ✓ | ✓ | ✓ |
| `seq` reset | ✓ | ✓ | ✓ | ✓ |
| Truncation, skew, duplicates, reordering | ✓ | ✓ | ✓ | ✓ |
| Two zones closing | – | ★ | ✓ | ✓ |
| Fault in a closing zone | – | ✓ | ✓ | ✓ |
| Cancelled blast | – | ✓ | – | ✓ |

Link and command rows belong to tasks 3 and 4; the CLOSING column to task 5.

## L6. Process resilience

| ID | Case |
|---|---|
| L6.1 | Kill the service mid-`CLOSING` and restart it: it acts on the `hello` snapshot within the time left, and in-flight commands from before the kill are replayed from the log |
| L6.2 | Slow ingest: the service keeps up with 12 trucks × 5 Hz plus bursts, and is never more than 4 MB behind; measured, not assumed |
| L6.3 | Browser drops mid-drive: the truck stops on its deadman; the service sends nothing after the last fresh input |
| L6.4 | Several browsers open: one gateway connection in total (the site allows 16) |
| L6.5 | The service survives a browser sending malformed or hostile messages |

## L7. Remote driving

| ID | Case |
|---|---|
| L7.1 | Deadman through the relay: input stops → no drive messages leave the service → the truck reports deadman |
| L7.2 | Lag display: input age and echo age shown, and correct against injected delays |
| L7.3 | Forced takeover mid-drive by a supervisor: the first driver's view says who took it; their input is refused |
| L7.4 | E-stop wins while someone else drives |
| L7.5 | **Stuck key:** the window loses focus or is hidden with a key held → the browser sends throttle 0 and stops streaming. The browser never sends keyup in that case, so this is tested in Playwright |
| L7.6 | Driving into a closed zone is refused; driving out never is |
| L7.7 | A faulted truck that allows limp-home can be driven at 1.0 m/s; one with `BATTERY_DEPLETED` cannot, and the UI says it needs a tow |

## L8. Multiple operators and audit

| ID | Case |
|---|---|
| L8.1 | A command blocked by a lease is shown to the lease holder as well as the sender (Priya's near miss) |
| L8.2 | Only a supervisor can force a takeover |
| L8.3 | `operator_id` in a browser payload is ignored; the session's is used |
| L8.4 | "Who moved HT-06 at 3:12?" answered by one query: operator or system, the rule and inputs for system actions, the ack and the effect |
| L8.5 | The audit log is append-only and survives a restart |

## L9. UI, in a real browser (Playwright)

Only these; no broad UI suite.

| ID | Case |
|---|---|
| L9.1 | Live, old, silent and contradicted trucks look different from each other |
| L9.2 | Site link down: the picture visibly ages and a banner says so |
| L9.3 | Service down: the browser says it is disconnected; it never shows a frozen picture as current |
| L9.4 | Stuck key (L7.5) |

## L10. Live soak

15 minutes or more, unattended, across fresh simulated days, beside an **independent monitor**: a
passive observer that computes "truck in a closed zone" from the raw telemetry on its own.

The monitor is independent of our **code**, not of the **data**. It shares no code with the product,
but it reads the same telemetry and is fooled by the same frozen and silent trucks. If the product
and the monitor disagree, one of them is wrong and we find out which. If they agree, that shows the
product's logic matches a separate reading of the data; it does not prove either is right about the
trucks. Only the fake gateway (L4) checks against the truth.

## L11. Novice test (run by a person)

Someone who has never seen the system does three timed tasks:
1. Answer "is L4 South clear?" (target: 10 s).
2. Drive a faulted truck to the bay.
3. E-stop a truck.

Their stumbles become the README walkthrough.

## L12. Scale (one benchmark, not CI)

The fake gateway at 140 trucks × 5 Hz on one OCPU: record CPU, memory, ingest lag and UI update
rate, and what breaks first. The result goes in README §10 as a measurement.

## L13. Packaging and deploy

| ID | Case |
|---|---|
| L13.1 | Fresh clone, `docker compose up` with only the three `GATEWAY_*` variables and no Anthropic key: starts, connects, serves the UI |
| L13.2 | The image builds and starts on amd64 and arm64 in CI (arm64 under emulation if no native runner is available) |
| L13.3 | On the **exact pinned image**, start-up output contains no `ExperimentalWarning` (checked on Node 24.15 outside Docker, not yet on the image) |
| L13.4 | On the box, the compose port is published on `127.0.0.1` only and reached through Caddy; nothing listens publicly on that port |
| L13.5 | Reboot the box: the service comes back by itself (`docker.service` enabled, `restart: unless-stopped`), and the other project on the box still serves |
