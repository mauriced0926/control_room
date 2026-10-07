# Closeout, 2026-10-07

Where the build stands at the end of the working sessions, for whoever writes `README.md` and PLAN's
"What changed". Short by design: the detail is in the files it points to.

## What's merged (all on `main`)

| Merge | What |
|---|---|
| `5aa1a51` | Task 1: ingest, fleet belief, confidence and ranges |
| `54b6d26`, `4ea9da2` | Task 2: the fake gateway (milestones 1 and 2: faults, truth log, site variants, `--day live`) |
| `bee9d70` | Task 3: site link and command registry (ack matching, confirmation, audit, safety gate seam) |
| `973631c` | Task 4: control-room overview UI |
| `a1851f4` | Task 6: server, sessions, logins, Docker, CI |
| `f8011c6` | Task 8: truck detail |
| `7206427` | Task 7: remote driving |
| `3c6b0bd` | Task 5: the blast engine and its safety gate (gate swap: `d3c38b5`) |
| `846fbc2` | `BLAST.md`: decisions 8-10 after the 200-seed run (recorded, not built) |

## Deploy

- Hosted at `https://dlh.150-136-98-129.sslip.io` (own Caddy block, container on `127.0.0.1:8090`).
  **The container is stopped and left stopped.** Start it on the box with `docker compose up -d` in
  `~/control_room` (the box's `.env` selects `~/control_room-secrets/compose.override.yaml`).
- Hosted passwords are only on the box, in `~/control_room-secrets/passwords.txt` (owner-only). The
  README's demo passwords do not work there (checked).
- The other site on the box (`150-136-98-129.sslip.io`) was checked after every change.

## The 200-seed L4 run (GitHub Actions run 37539398847, gate `d3c38b5`)

200 days of 15 minutes per set, 727 blasts (504 closed). Days failed, out of 200:

| Set | R0 | R1 | R2a | R2b | R3 | R4 | R5 |
|---|---|---|---|---|---|---|---|
| spec, live | 19 | 1 | 0 | 0 | 68 | 0 | 0 |
| pessimistic, live | 15 | 1 | 0 | 0 | 71 | 0 | 0 |
| spec, R2c fault | 18 | 1 | 0 | 0 | 93 | 0 | 28 |
| pessimistic, R2c fault | 14 | 1 | 0 | 0 | 95 | 0 | 27 |
| spec, site variants | 27 | 2 | 0 | 0 | 71 | 1 | 0 |
| pessimistic, site variants | 29 | 3 | 0 | 0 | 74 | 1 | 0 |

- **R2a/R2b (never wrongly clear): 0 of 1,200 days.** R2c (the undetectable freeze-while-stopped
  fault) is counted, not prevented: 457 CLEAR-over-a-truck moments on 4 days, and its truck inside a
  closed zone 92 times on 82 days, in each R2c set.
- **R0:** the largest share is B4 holding a truck that could have left forward (decision 8). The rest
  are late `EXIT_ZONE` and `RESUME` deadlines (below).
- **M1** unnecessary holds per day: median 4-5, worst 14-25. **M2** time sat after a reopen: median of
  day medians 3.8-3.9 s, worst 48.8-68.8 s (476 s in the R2c sets). **M3** false can't-clear alarms per day:
  median 5-6, worst 15-20; most are "can't confirm where it is" (decision 9).
- Full tables and every failing seed: the run's artifacts (`l4-*.txt`), not in the repo.

## Decided but not built

`BLAST.md` decisions 8-10: B4 lets a truck leave forward with the B2 guard; two can't-clear alarms
with M3 counting only "can't get out"; throttle 0 only in reply to fresh input (the driving relay
already does this).

## Known engine issues

- **B12 HOLD loop:** a truck still on an `EXIT_ZONE` at reopen can loop HOLD/RESUME; most R3 days are
  resumes landing after the 15 s budget (repeated `RESUME` every ~8 s).
- **Confirmation deadlines** for `RESUME` and `EXIT_ZONE` are too short for queued work, causing retries.
- **One late R1 alarm** (seed 5: alarm due 70 s, raised 90 s, after B4's hold).

## Harness fixes needed (the L4 checker, not the engine)

- R3 counts a reopen at the very end of the day (or with the link still down) as a failure.
- R5 failures on the R2c sets come from the undetectable truck and should count under R2c.
- Silent trucks are counted under R0 as "could have been cleared".

## Flaky or failing tests

Last full run on `main` at `3c6b0bd`, with type-check clean:

| Suite | Passed | What failed |
|---|---|---|
| fast | 407 of 410, plus 2 skipped | L1.2 timing (276 ms over its budget; load-sensitive) |
| slow | 13 of 15 | L4.S seed 103, spec and pessimistic |
| browser | 24 of 26 | the tray-interrupt test and the hand-back-after-driving test; both passed on their own branches, so probably an interaction with the engine's alarms and gate, but not diagnosed |

Other flaky or unrunnable tests:

- **"A 15-minute day under a second of CPU"** fails under load.
- **L2.26 and L0.C3** can't run locally: the full captures and probe logs were lost with a scratchpad wipe.

## Soak, 2026-10-07

SOAK_RESULT

## Hours

**16.4 h from commit times**: 146 commits in 13 sessions, where a gap over 90 minutes starts a new
session and each session gets 30 minutes added before its first commit. It's a lower bound: reading,
review and agent runs between commits aren't counted. `docs/hours.md` has the log kept from 2026-10-06.

## Left for README.md

- **Running it:**
  - `npm start`, `docker compose up`
  - ports
  - demo logins
  - env vars (`.env.example`)
- **Walkthrough:** `docs/soak-2026-10-07/` and `docs/screenshots/`.
- **Architecture:** the clock, ingest, fleet, link, registry, gate, engine, live hub and UI.
- **Findings** from `research/README.md`: data, link and command behaviour.
- **What it can't do:** `BLAST.md` "Limits of enforcement".
- **Decision log, hours, and around-the-corner work,** including the spacing note in `CONTEXT.md`.
- **The brag video:** in `brag-output/`, gitignored, not in the repo.

## Open notes for PLAN's "What changed"

- **From earlier:** `CONTEXT.md` "Decided since".
- **The site's answers to Q1-4,** and what they changed.
- **Auto-resume moved into the MVP.**
- **Coordinated evacuation was dropped.**
- **New rules:**
  - B6a, TAKE_CONTROL at a duty stop on a boundary
  - `system:<rule>` as operator ids
- **Re-probe findings:**
  - a queued HOLD can be dropped
  - RESUME can't recall a command still in its delay
  - loaded reverse speed
- **13 fixtures, not 9.**
- **Plain-language queries not built.**
- **Docker, amd64 CI and the hosted deploy,** with TRUST_PROXY and its own passwords.
- **The L4 200-seed run moved to GitHub Actions** (about 11 minutes, against hours locally).
- **BLAST decisions 8-10:**
  - B4 forward exit
  - the alarm split
  - throttle 0

## Loose ends

- **AI_LOG entries not yet written:**
  - The lost-click bug. My diagnosis (focus handling) was wrong; the driving agent found the real
    cause, fleet-table cells being rebuilt every frame (`816d944`).
  - The 3-seed samples hid the failures that the 200-seed run showed.
- **AI_SESSIONS row 1:** the main session's link is still "to come".
- **Git author email:** commits carry a placeholder (`you@youremail.com`).
