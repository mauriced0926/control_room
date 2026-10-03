# Tasks 3 and 4: the gateway link and the command registry

**Goal.** One connection to the site that recovers on its own and never lets anyone mistake an old
picture for a current one; and one place that sends every command, knows what actually happened to
it, and records it. Everything that commands a truck (operators, the blast engine, auto-resume) goes
through the registry. Nothing else talks to the gateway.

**Read first:** `CLAUDE.md` and everything it lists. In `research/README.md`, read "Verified, and
not" and "Re-probe, 2026-10-03" closely: they are why this task exists. `AI_LOG.md` entries 1 and 4
are about the one mistake this task must make impossible.

**Must pass:** `TESTING.md` L2.30–L2.39 (registry), L2.40–L2.44 (link), the link and command rows of
L5 that milestone 1 of the fake can produce (link drops by closing the connection; the rest when
milestone 2 merges), L6.1 (the replay half: in-flight commands survive a restart), L6.2, L6.6, L7.8
(e-stop while the link is down), L8.1–L8.5.

## Scope

**Gateway link** (`src/link.ts`)
- TLS to `GATEWAY_HOST:GATEWAY_PORT`, auth with `GATEWAY_EMAIL`; credentials from the environment only.
- Reconnect with capped, jittered backoff; a login accepted then closed before `hello` is an outage.
- Link down after `PARAMS.linkDownAfter` without a heartbeat; link status is part of what the UI shows.
- On `hello`: hand the snapshot to `FleetState` (zones, leases, vehicles) and replay in-flight commands.
- Feed every line to `FleetState.ingestLine`; keep up with 12 trucks at 5 Hz plus bursts, never 4 MB
  behind (L6.2: measure it).
- One connection per service, whatever the number of browsers (L6.4 later relies on this).

**Command registry** (`src/registry.ts`)
- **Ack matching lives here and only here:** an ack belongs to the latest send of its `command_id`,
  matched by time, never by counting acks (L2.33). Export it for every tool that reads acks.
- Lifecycle: pending → sent → acknowledged (or no ack) → effect seen in telemetry, or failed with a
  reason in the operator's words (L2.39).
- **`ACCEPTED` is not done.** Each action has an effect predicate on `FleetState` (HOLD: `HOLDING`;
  RESUME: moving or back in its duty cycle; EXIT_ZONE: `task` set, then holding outside the zone;
  RETURN_TO_BAY: `task` set; ESTOP: `ESTOPPED`; and so on) and a deadline.
- **Deadlines depend on state** (L2.36): ~6 s normally; behind LOADING or DUMPING, the remaining work
  plus 6 s; behind CHARGING, no fixed deadline. The re-probe showed a queued `HOLD` can be
  `ACCEPTED` and never carried out, so a queued command is checked the moment the work ends and
  retried at once if it hasn't taken effect.
- **Retry** under a new `command_id` when the deadline passes, up to a set number of attempts, with
  the attempt count visible; then fail and alarm (L2.37). Never retry `COMMAND_ID_REUSED` (L2.34). A
  retry never displaces a different command we queued on that truck (L2.38).
- **A command on its way can't be called back:** `RESUME` within another command's 1–6 s delay is
  rejected (re-probe Q3). The registry doesn't pretend otherwise.
- **The safety check sits below every caller:** before sending, the registry asks a `SafetyGate`
  (an interface; the blast engine implements it later) whether the command is allowed, and records
  the refusal and its reason if not. Ship an allow-all gate for now, clearly named as such, with the
  interface tested.
- **Persist before sending** (L6.6), in SQLite through `node:sqlite`: every command, its sends, acks,
  effect and outcome; an append-only audit log in which system and operator actions sit together, each
  with who (an operator id or "system" plus the rule), what, when and why (L8.4, L8.5). On restart,
  commands still in flight are replayed; ones older than their deadline are marked expired, not sent.
- **E-stop while the link is down** (L7.8): pending and visible with a cancel; sent automatically only
  if the link returns within 10 s; after that it needs the operator to confirm again.
- **Leases:** `TAKE_CONTROL` / `RELEASE_CONTROL` and the lease ids from acks; a command blocked by
  `LEASE_HELD` is reported to the lease holder as well as the sender (L8.1); forced takeover only for a
  supervisor (L8.2). The registry takes the operator's identity from its caller, which will be the
  server's session; it never reads one from a browser payload (L8.3).
- Drive messages are not commands; the drive relay is a later task. Leave room for it.

## Ways to be wrong that matter

- Matching acks by counting. Three pieces of code did this in one day (`AI_LOG.md` entry 4).
- Treating `ACCEPTED` as done, or a queued command as safe.
- Sending a command before it is written down.
- A retry storm: a truck that can't comply (interlocked, leased) must fail with the reason, not be
  retried forever.
- Reading the wall clock: everything takes the injected `Clock`, including backoff and deadlines.

## Working rules

Tests first, against the fake gateway's in-process API and its TLS server; never the real gateway.
Replay `research/fixtures/` where they cover a case (`accepted-then-ignored-resume`,
`queued-hold-dropped`, `resume-during-pending-hold`, `link-drop-in-notice`). Commit as you go on your
branch, one logical change per commit, adding paths explicitly (never `git add .`/`-A`). Before
starting, make sure your branch is based on local `main`, not a stale `origin/main`. Don't push and
don't merge; I review, merge and push. Finish with: what passes, what doesn't, the registry's public
interface, every deadline, retry count and backoff you chose and why, and the L6.2 measurement.
