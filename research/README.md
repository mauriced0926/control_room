# research/

What the live gateway actually does, measured before any of the product was built. The
findings feed `CONTEXT.md` (assumptions) and `PLAN.md`; the fixtures are the seed for the
fake gateway's fault injection and the failure tests.

## How it was gathered

Three passive captures (6, 15 and 15 minutes, each on a fresh simulated day) and one command
probe, on 2026-10-01 and 2026-10-02.

> **The probe sent real commands to the hosted gateway** (about 10:11–10:17 local time on
> 2026-10-02), all with `operator_id: "probe"` and `command_id`s of the form `probe-<run>-<n>`,
> so they are attributable in the site's statutory log. They included HOLD, RESUME, EXIT_ZONE,
> TAKE_CONTROL with about 3 s of manual driving, RELEASE_CONTROL, ESTOP and CLEAR_ESTOP, and a set
> of deliberately malformed commands. Cleanup resumed every truck it touched except HT-10, whose
> real state could not be observed (see `frozen-truck`); it was left for the simulator's
> daily reset.
>
> **A second probe sent real commands on 2026-10-03, 10:39:53–10:46:02 EDT** (steps Q1–Q3 and R1, below),
> also under `operator_id: "probe"`: four HOLD/RESUME/EXIT_ZONE pairs and their cleanup, only while the
> zones involved were `OPEN`. Every truck it touched was confirmed moving again in telemetry.

## Files

| File | What it is |
|---|---|
| `capture.py` | Passive recorder. Authenticates and writes every line; sends nothing else. |
| `probe.py` | The command probe: steps S1–S9 by default; the re-probe's Q1–Q3 and R1 with `--steps=Q1,Q2,Q3,R1`. Dry run by default; `--live` sends. |
| `report.py` | Per-run report over a capture: link drops, blast timeline, per-truck faults. |
| `trim.py` | Cuts the fixtures below out of the full captures (9–25 MB each; not committed). |
| `fixtures/*.jsonl` | One failure case per file. First line says what it shows and which run it came from. |

Scripts read `GATEWAY_HOST`, `GATEWAY_PORT` and `GATEWAY_EMAIL` from the environment
(`set -a; . ./.env; set +a`), and `SSL_CERT_FILE` if set (needed on a python.org macOS
Python, which ships without a CA bundle). Auth lines are never recorded and the email is
replaced in everything written. Python 3.7+, standard library only.

## Fixtures

| Fixture | Shows |
|---|---|
| `frozen-truck` | Whole telemetry message frozen for minutes: identical fields, `seq` and `t_device_ms` still advancing in real time, `TRAMMING` at 2.0 m/s with no change in position. Contrast: a LOADING truck also sends identical bodies, but at speed 0 in a stationary state. |
| `seq-reset` | `seq` drops from 887 to 1 mid-run while the device clock carries on. |
| `silent-truck` | One truck silent for 53 s while heartbeats show the link is up. |
| `truncated-lines` | Every unparseable line from a 15-minute run (0.18 %): JSON cut off mid-object. |
| `fractional-soc` | `soc_pct` sent as a fraction (0.82 meaning 82 %), all run. |
| `accepted-then-ignored-resume` | RESUME `ACCEPTED`, truck stays HOLDING for 70 s; a RESUME under a new `command_id` moves it in 1.3 s. That second RESUME's ack was not received before the probe exited 5 s later. |
| `reverse-exit-zone` | EXIT_ZONE reverses an empty truck at 3.0 m/s up DECLINE into BAY, toward the trucks behind it. |
| `two-zones-closing` | DRAW_12 and TIP `CLOSING` at the same time. |
| `link-drop-in-notice` | Link drops 1 s after a `CLOSING` and stays down 45 s; the `hello` on reconnect still carries the zone state. |
| `weak-pack` | A truck drains about 5× faster than the fleet and stops with `BATTERY_DEPLETED` in the incline, 508 s in. Thinned: the weak truck at 1 Hz plus its `FAULT` messages, every other truck at 0.2 Hz as the fleet baseline. |
| `queued-hold-dropped` | Re-probe Q1: a `HOLD` sent 0.2 s into loading is `ACCEPTED`, but after loading the truck drives straight into the next zone and never holds. |
| `resume-during-pending-hold` | Re-probe Q3: a `RESUME` sent while a `HOLD` is within its 1–6 s delay is `REJECTED INVALID_STATE`, and the `HOLD` still takes effect; then a `RESUME` with no ack and no effect, and a retry that works. |
| `loaded-reverse-into-silence` | Re-probe R1: a loaded truck reverses at 2.0 m/s, goes silent for 41 s, and reappears holding 2 m outside the zone. |

## Radio and blast statistics

Measured from the three passive captures (6, 15 and 15 minutes). These are the ranges the fake
gateway must reproduce (`TESTING.md` L0.C3).

| Statistic | Run 1 | Run 2 | Run 3 | How it was counted |
|---|---|---|---|---|
| Telemetry received per truck | 4.80 Hz | 4.44 Hz | 4.60 Hz | Messages over time span; trucks send ~5 Hz, the rest is loss and outages |
| Duplicates | 2.09 % | 1.97 % | 1.97 % | Same `seq` already seen in that controller run |
| Reordered | 4.96 % | 5.09 % | 4.89 % | Arrived with a `seq` below the highest already seen |
| Lost | 3.38 % | 2.68 % | 2.51 % | `seq`s never received, excluding those sent during whole-link outages |
| Truncated lines | 0.19 % | 0.21 % | 0.18 % | Unparseable lines over all lines |
| Notice (`CLOSING` → `effective_at`) | 120 s | 120 s | 120 s | Every closure |
| Closed for | 102 s | 103, 111 s | 74, 66 s | `CLOSED` → `OPEN` |
| Between `CLOSING`s | 280 s | 312, 318 s | 276, 302 s | |
| Cancelled blasts | 0 | 1 | 1 | |
| Link drops | none | 46, 22 s | 49 s, plus one still down when the capture ended | Gaps between heartbeats over 3 s |
| Normal gap between one truck's messages | max 0.99 s | max 1.36 s | max 1.67 s | Excluding silent trucks and outages |

Earlier summaries quoted reordering as "~6 %". That came from `report.py`, which counts a message as
reordered when its `seq` is below the *previous* message's rather than the highest seen, and so
counts some messages twice. The table above uses the stricter count.

## Verified, and not

| Behaviour | Status |
|---|---|
| Acks can be lost while the command still executes; resending the same `command_id` returns the original result | Verified (S1) |
| Same `command_id` with a different payload → `COMMAND_ID_REUSED` | Verified (S1) |
| `ACCEPTED` does not guarantee execution | Verified once (S4 RESUME) |
| EXIT_ZONE reverse speed, empty: 3.0 m/s; stops ~2 m outside the zone | Verified (S3) |
| EXIT_ZONE reverse speed, loaded: 2.0 m/s | **Measured, thinly** (re-probe R1): 1.99 m/s by the truck's own clock over 2.4 m, after which it went silent; the rest of the 56 m was covered in a 41 s gap, which needs at least 1.31 m/s. Consistent with 2.0; keep testing 1.5 as the pessimistic case |
| A `HOLD` queued behind LOADING is carried out when loading ends | **Not seen.** Re-probe Q1: `ACCEPTED`, then dropped; the truck drove on into the next zone. One sample, so it may be the accepted-then-ignored fault landing on a queued command. Treat queued commands as unreliable: confirm, and retry when the work ends |
| `RESUME` cancels a queued command | **Untested.** Q3's truck finished loading before the `RESUME` arrived, so nothing was queued |
| `RESUME` while a supervisory command is within its 1–6 s delay | **Seen once** (Q3): `REJECTED INVALID_STATE`, and the pending `HOLD` still took effect ~5.6 s after it was sent. A command on its way can't be called back |
| A newer queued command replaces an older one | **Untested.** Q2 never ran: L4_SOUTH was closed for its whole 180 s window |
| Accepted-then-ignored | **Seen again** in the re-probe's cleanup: a `RESUME` with no ack and no effect; a retry under a new `command_id` worked |
| Deadman after TAKE_CONTROL with no input; lease expiry 10 s → HOLDING | Verified (S4). The "~0.4 s" was measured on the probe's receive times, which can lag (the fake-gateway work saw a GRANTED logged 142 ms late), so it may understate; the spec's 500 ms is the safer figure |
| Drive at 10 Hz: send gaps 100–106 ms, deadman never tripped, applied seq advanced every telemetry sample; echo age 200–620 ms is round trip plus up to 200 ms telemetry sampling | Verified for ~4 s of driving in one session; arrival gaps at the truck are not observable |
| Frozen telemetry is told apart from a stopped truck by motion that contradicts position, not by the device clock (which keeps ticking) | Verified across 4 frozen episodes |
| A truck that freezes while stationary (e.g. HOLDING) | **Not detectable** from telemetry alone; only by a command response that contradicts it |
| S9's `RESUME` → `INVALID_STATE` on the frozen truck, 40 s after its `EXIT_ZONE` was accepted | Consistent with `PROTOCOL.md` §5 if the truck was still carrying out the `EXIT_ZONE`: `RESUME` is only accepted from `HOLDING`/`IDLE` or to cancel a queued command. So a `RESUME` cannot stop an `EXIT_ZONE` in progress; `HOLD` first |

The S1 printout during the live probe was wrong (it miscounted acks for a resent id); the
raw log was right. `probe.py` here has the fix. See `AI_LOG.md`, entry 1.

## Open in the spec

Questions `PROTOCOL.md` leaves open, found while building the fake gateway. The fake picks an answer
for each (marked "guessed" in `fake/behaviour.ts`); none has been checked live.

- A drive message with a stale `seq`: §6.2 says it is discarded, yet `BAD_SEQ` exists. Which applies?
- Whether `CLEAR_ESTOP` takes effect at once, like `ESTOP`, or after the 1–6 s supervisory delay.
- Whether a loaded truck sent `RETURN_TO_BAY` dumps first.
- Which faults allow limp-home driving, beyond `HYD_PRESSURE_LOW` (yes) and `BATTERY_DEPLETED` (no).
- The charge rate: no `CHARGING` was ever captured. The fake uses 0.1 %/s, from Sam's "ten-minute charge".
- One live dump lasted 4.4 s (HT-10, run 3) against the spec's "about 12 s".

## Re-probe, 2026-10-03

10:39:53–10:46:02 EDT, `research/probe.py --steps=Q1,Q2,Q3,R1`. The steps were first run against the
fake gateway, to test the probe itself; the fake's answers are its guesses, not findings.

| Step | Live result |
|---|---|
| Q1 `HOLD` to a truck 0.2 s into loading | `ACCEPTED`. Loading ended 20.0 s later; the truck drove on into L4_SOUTH and never held (`queued-hold-dropped`) |
| Q2 `HOLD`, then `EXIT_ZONE`, to a loading truck | Did not run: L4_SOUTH, the zone after the draw point, was closing or closed for the whole 180 s window |
| Q3 `HOLD`, then `RESUME`, to a loading truck | The only loading truck was 19.4 s into its load, so loading ended before the `RESUME` arrived. The `RESUME` was rejected `INVALID_STATE` and the `HOLD` took effect ~5.6 s after sending (`resume-during-pending-hold`) |
| R1 `EXIT_ZONE` to a loaded truck 47 m into L4_SOUTH | Reversed at 2.0 m/s, then telemetry went silent for 41 s; reappeared holding at 838.0 m, 2 m outside (`loaded-reverse-into-silence`) |
| Cleanup | All trucks confirmed moving; one `RESUME` needed a retry |

What it means for the blast engine: a truck held at the draw point, next to a closing zone, can
leave the moment loading ends, because its queued `HOLD` may never be carried out; and a command
already sent can't be cancelled.
