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

## Files

| File | What it is |
|---|---|
| `capture.py` | Passive recorder. Authenticates and writes every line; sends nothing else. |
| `probe.py` | The command probe (steps S1–S9). Dry run by default; `--live` sends. |
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

## Verified, and not

| Behaviour | Status |
|---|---|
| Acks can be lost while the command still executes; resending the same `command_id` returns the original result | Verified (S1) |
| Same `command_id` with a different payload → `COMMAND_ID_REUSED` | Verified (S1) |
| `ACCEPTED` does not guarantee execution | Verified once (S4 RESUME) |
| EXIT_ZONE reverse speed, empty: 3.0 m/s; stops ~2 m outside the zone | Verified (S3) |
| EXIT_ZONE reverse speed, loaded: 2.0 m/s | **Assumed** from the spec's autonomous speeds; not measured |
| Commands queued behind LOADING / DUMPING / CHARGING; newer queued command replaces older | **Unverified**: S2 never ran (DRAW_12 was under a blast). To test in the fake gateway and re-probe |
| Deadman ~0.4 s after TAKE_CONTROL with no input; lease expiry 10 s → HOLDING | Verified (S4) |
| Drive at 10 Hz: send gaps 100–106 ms, deadman never tripped, applied seq advanced every telemetry sample; echo age 200–620 ms is round trip plus up to 200 ms telemetry sampling | Verified for ~4 s of driving in one session; arrival gaps at the truck are not observable |
| Frozen telemetry is told apart from a stopped truck by motion that contradicts position, not by the device clock (which keeps ticking) | Verified across 4 frozen episodes |
| A truck that freezes while stationary (e.g. HOLDING) | **Not detectable** from telemetry alone; only by a command response that contradicts it (S9: RESUME → `INVALID_STATE`) |

The S1 printout during the live probe was wrong (it miscounted acks for a resent id); the
raw log was right. `probe.py` here has the fix. See `AI_LOG.md`, entry 1.
