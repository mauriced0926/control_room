# Task 1: fake gateway, milestone 1

**Goal.** A deterministic fake of the site gateway that plays trucks, commands, leases and blasts
well enough that `research/probe.py` gets the same answers from it as it got from the live site.
It becomes the oracle for the blast-safety tests (`TESTING.md` L4), so it must be right before it is
broad. Fault injectors are milestone 2, a separate task.

**Read first:** `CLAUDE.md`, then everything it lists. `research/README.md` and the fixtures are the
ground truth for behaviour; `PROTOCOL.md` fills the rest.

**Must pass:** `TESTING.md` L0.M, L0.C4 and L0.C2. Not yet: L0.F, L0.C1, L0.C3, L0.S, L0.P
(design for them, so milestone 2 adds rather than rewrites).

## Scope

1. **Model (L0.M)** in `fake/`, not `src/` (it is test infrastructure). Takes a `Clock` from
   `src/clock.ts` and a seed; never reads the wall clock. The site comes from a config object (route,
   vehicles, notice length), with a default matching DLH-1's `hello` in the fixtures. Nothing
   site-specific is hard-coded in the model itself: a different config must just work.
   - Trucks move along the loop at the spec's speeds, with the duty cycle (load ~20 s at the end of the
     load segment, dump ~12 s at the end of the dump segment, charge below 25 % to 90 % at the end of
     the bay), energy proportional to distance and higher when loaded.
   - Telemetry at ~5 Hz per truck with the fields in `PROTOCOL.md` §4.2; heartbeats every 2 s.
   - Commands per §5 with their effects 1–6 s after acceptance (lease operations and e-stop at once);
     de-duplication on `command_id` (same payload → original result; different payload →
     `COMMAND_ID_REUSED`); every rejection reason in §4.5 where it applies; queuing behind LOADING /
     DUMPING / CHARGING with the newest replacing the older, **behind a parameter** (L0.P: spec version
     only for now).
   - `EXIT_ZONE`: nearest boundary, forward or reverse at the autonomous speed for the load state, stop
     ~2 m outside, hold. `RETURN_TO_BAY`: shorter direction, charge to 90 %, park `IDLE`.
   - Leases per §6: `TAKE_CONTROL` (with `force`), drive messages with `seq` rules, deadman at 500 ms,
     lease expiry at 10 s → `HOLDING`, `RELEASE_CONTROL` with `lease_id`, `lease_event`s, limp-home.
   - A blast schedule: `CLOSING` with the configured notice, `CLOSED`, then `CLEARED` or `CANCELLED`.
   - **Truth access** for tests: the true position and state of every truck, separate from what is sent.
2. **Transport:** an in-process API for tests (push messages in, receive lines out), and a TCP + TLS
   NDJSON server with the auth flow from §1.1, for `probe.py`. Use a test certificate generated at
   test time; never commit a private key.
3. **Determinism (L0.C4):** the same seed and the same inputs give a byte-identical output stream.
4. **Probe conformance (L0.C2):** run `research/probe.py --live` against the fake (point it there
   with `GATEWAY_HOST`, `GATEWAY_PORT`, `SSL_CERT_FILE`) and compare the ack sequence and reasons for
   S1, S3–S8 with the live probe's, which are in `research/README.md` and the fixtures. Where the live
   ack was lost (S1's first HOLD), the fake has no loss in milestone 1, so the expected sequence is the
   spec's. Write the comparison as a test that runs the probe as a subprocess, skipped if `python3` is
   missing.

## Ways to be wrong that matter

- Getting the clock wrong: the fake must run a 15-minute day in well under a second with a
  `ManualClock`.
- Making commands take effect instantly. The 1–6 s delay is what makes blast evacuation hard.
- Letting a truck keep moving under a lease without fresh drive input.
- Trusting your own printout. Check the probe comparison against the probe's raw output file.

## Working rules

Tests first. Commit as you go on your worktree branch, one logical change per commit, adding paths
explicitly (never `git add .`/`-A`), with the attribution line from the repository's existing commits.
Don't push and don't merge; I review and merge. If the spec and the research disagree, follow the
research and write the difference down in your summary. Finish with: what passes, what doesn't, every
place you guessed, and anything that looked wrong in `PROTOCOL.md` or the research.
