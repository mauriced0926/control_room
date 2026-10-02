# Initial Context — Deep Level Haulage control room

Working context for this build. Written before any code, updated as things are
learned. If you are an agent picking this up, read `BRIEF.md`,
`OPERATOR_NOTES.md` and `PROTOCOL.md` first — in that order, as the brief asks.
This file is what those documents do not say out loud.

## The system in one line

A control room for 12 autonomous haul trucks on a 1.6 km one-way underground
loop, connected to a site gateway over TLS + NDJSON, where the data is
unreliable on purpose and a blast can close a tunnel on about two minutes' notice.

## Where things are

- **Repo:** https://github.com/mauriced0926/control_room
- **Local working copy:** `/Volumes/Transcend/control_room`
- **Reference material:** `dlh-candidate-package/` — `BRIEF.md`,
  `OPERATOR_NOTES.md`, `PROTOCOL.md`. Read-only: they
  belong to Deep Level Haulage, not to us.
- **Deploys to:** `~/control_room` on the OCI ARM box (`ssh dronehal1`).
  Edit locally, build and run there.
- **Gateway:** `dlh-gateway.fly.dev:443`, TLS, auth with
  `GATEWAY_EMAIL`. All traffic from this email is logged by them.


## Findings from a close read

Four things that are in the materials but not stated plainly.

**1. The AI is in the build, not the product.** Every mention of AI or agents
across the three files — eleven of them — is about how the software is
constructed. `PROTOCOL.md` and `OPERATOR_NOTES.md` contain none. Nothing in the seven minimum requirements asks for a model in the control room, and Dave's
"I'd rather see nothing than see something wrong" argues against one. The
automation wanted here is deterministic and rule-based. No LLM on the control path in v1. An LLM may sit *beside* it: an operator can ask questions in plain language (answered from the fleet state and logs), or
phrase a command, which the model turns into a **proposal** — never an action.
The operator confirms it, and it then passes through exactly the same
deterministic checks as a button press. **Deferred:** `PLAN.md` leaves
plain-language queries out of this version.


**2. The protocol already encodes an autonomy policy: stopping is cheap,
starting is deliberate.** A truck can be stopped ten ways, four with no human
at all (deadman at 500 ms, lease idle expiry at 10 s, lease revocation, estop).
It can be started two ways, both a deliberate human act: `RESUME` — which is
*rejected* with `INVALID_STATE` unless the truck is already `HOLDING` or
`IDLE` — and fresh drive input after a deadman. §6.4 is decisive: when a lease
expires the vehicle holds and "does **not** return to autonomous operation by
itself." Match this. Our system stops trucks freely and never starts one by default 
without a person — with one exception the site asked for (answer 2): trucks the
system itself held for a blast are resumed by the system once the zone reopens.

**3. Reconnection is solvable, not lossy.** The gateway queues nothing for a
disconnected client, so an ack for an in-flight command is lost. But §5 says
resending the same `command_id` with the same payload returns the original
result without re-executing. So on reconnect, replay in-flight `command_id`s
and the gateway tells us what actually happened. Idempotent, no double
execution.

But the replay recovers the **ack**, not the **effect**. On the live site a
`RESUME` was `ACCEPTED` and the truck stayed `HOLDING` for 70 s
(`research/fixtures/accepted-then-ignored-resume.jsonl`). `ACCEPTED` means
queued at the vehicle, nothing more; only telemetry says a command worked.

**4. Automation precision is a function of data confidence.** When a position
is fresh, evacuate exactly the trucks in the zone — Lena: "don't stop trucks
that don't need stopping." When it is stale we cannot be precise, so get
**blunter**, not bolder: widen the set, hold more trucks, and tell the operator
we did and why. This inverts the usual instinct and the blast logic should be
built around it.

"Stale" is not only "old". The live site sends telemetry that arrives on time
and is wrong: a frozen message with `seq` and the device clock still
advancing. Confidence has to come from consistency as well as age.

## What the live site showed

Three passive captures and one command probe, before any code. Evidence,
fixtures and what is verified versus assumed: `research/README.md`. The short
version: each simulated day draws from the same fault catalogue (fractional
SoC, malformed fields, a ~58-minute clock skew, a `seq` reset, a frozen
message, a truck that goes silent, a weak pack that dies, a hydraulic fault),
with truck, place and time randomised. Link drops of 21–45 s landed inside a
120 s blast notice in two of three runs. Two zones can be `CLOSING` at once.

## Who decides what

| Decision | Owner |
|---|---|
| Blast evacuation, reconnect, dedupe, marking data stale | System, alone |
| Can this truck clear in time; is this pack weak | System computes, **human asserts** |
| Resuming trucks the system held for a blast, once the zone reopens | System, alone (answer 2), logged with rule and inputs |
| Manual driving, forced takeover, clearing an estop, resuming any other hold | Human decides, system executes and records/logs |
| Is the zone clear | System **recommends**, with the reasons it could be wrong; human checks each and decides |
| Telling the shot firer | Human only, by radio (answer 1) — "I don't fire until **they** tell me it's clear" |
| Clearing a fault | Never — `PROTOCOL.md` §4.5: "a fault cannot be cleared from the control room" |


Ken's interlock stays human-to-human. The system's job is to make that
sentence safe to say in ten seconds: it recommends clear or not clear, and
shows the evidence that would make it wrong — stale positions, faulted
trucks, anything near a boundary. A can't-clear alarm names the action:
"radio the shot firer to hold the shot", with the truck, the zone and the
reason. "Not clear" takes effect immediately and
needs no agreement. "Clear" requires the operator to acknowledge each doubt
before they can confirm it, and overriding a "not clear" to "clear"
requires a recorded reason. Both the recommendation and the decision go in
the log, so the disagreement between them is visible later.


Dave's two notes are one instruction, not a contradiction. "I don't want to be
babysitting" is a mandate to automate the routine. "Rather see nothing than
see something wrong" is a limit on **inference**, not on action. Act freely,
speak carefully.

## Questions to the site

Questions 1–4 were sent before any code and have been **answered**. The answers
go into `PLAN.md`'s "What changed" section at the end.

1. Telling the shot firer a truck cannot clear — operator phones Ken, or is
   there a channel to integrate with?
   **Answered:** the operator and Ken talk directly, by radio. Ken calls about
   two minutes before firing, around when the notice arrives, and doesn't
   fire until the operator says clear. In doubt, the operator asks him to hold
   the shot: costly, always right. The gateway can't reach the blasting crew.
   Clearing people isn't our problem; clearing trucks is.
2. May the control room start trucks moving on its own after a cancelled
   blast, or does resumption need a human?
   **Answered:** the system may restart trucks on its own once a zone reopens,
   whether the blast happened or was called off. No sign-off needed.
3. Who owns headway between trucks, given vehicles have no collision sensing
   and `EXIT_ZONE` may reverse?
   **Answered:** spacing is out of scope; assume it is handled elsewhere and
   don't build for it. The simulator doesn't model trucks interacting: they
   never block or hit each other, even reversing.
4. Is "the system did it, under the blast-evacuation rule" an acceptable
   answer to Marta's inspector?
   **Answered:** yes. The system acting on its own is expected, especially
   for blasts, since nights are one operator. Its actions go in the same log
   as the operators', showing what it did, when and why.

**What the answers changed:**

- **Auto-resume is in the MVP and on by default** (assumption 2). When a zone
  reopens (`CLEARED` or `CANCELLED`), the system resumes the trucks *it* held
  for that blast — never a truck an operator held, never one with a lease or a
  fault, and never into another zone that is closing or closed. The resume is
  confirmed like any other command and logged as the system, with rule and
  inputs.
- **Coordinated evacuation is dropped** (assumption 16): no upstream holds
  before reversing a truck out. With spacing out of scope they would only be
  unnecessary stops. Hold-before-entry stays; that is about the zone, not
  spacing.
- **A can't-clear alarm names the action:** "radio the shot firer to hold the
  shot", with the truck, the zone and the reason.
- **System and operator actions share one log,** with what, when and why.
- For the README's "Around the corner": on a real site, spacing would have to
  be owned somewhere. We were told not to build it here.

Still open:

5. Can BAY itself be closed for a blast? `EXIT_ZONE` is rejected in BAY, so
   remote driving would be the only way out.
6. Is a command that is `ACCEPTED` and then not executed expected vehicle
   behaviour, or a gateway fault? It changes whether we report it to the
   site as a defect.

Do not wait on these. Assumptions below; record what the answers change.

## Assumptions

1. **Safety lives in the service; the operators live in the UI.** A backend
   service holds the gateway connection, the fleet state, the command log and
   the blast rule, and runs whether or not anyone has a browser open. The
   browser UI is the operator's whole working surface — fleet picture,
   commands, the clearance check, remote driving — but it never holds the only
   copy of anything that matters. Safety cannot depend on someone having a tab
   open. ("nobody is watching the screen"; "unattended for 15 minutes")

   Remote driving runs browser → service → gateway, which adds a hop to the
   500 ms deadman loop. The service relays only fresh operator input and
   never re-sends or synthesises drive messages for a browser that has gone
   quiet — otherwise a dropped browser would keep a truck moving and defeat
   the deadman. Silence means stop.

2. **Stopping never needs a person; the system resumes only its own blast
   holds.** *(Revised by answer 2.)* Holds are not all alike, and the system
   tracks who placed each one and why. When a zone reopens (`CLEARED` or
   `CANCELLED`), the system resumes the trucks it held for that blast, on by
   default — never a truck an operator held (only they know why they stopped
   it), never one with a lease or a fault, and never into another zone that
   is closing or closed. The resume goes through command confirmation like
   any other command, and is logged as the system with the rule and inputs.
   Ken's "not sat there for an hour because nobody remembered" is answered
   by the system remembering.

   Every other hold stays until a person resumes it, because elapsed time
   does not make restarting safer. A long hold escalates rather than acts: it
   ages visibly on the screen, re-alerts, and reaches the supervisor if
   nobody responds.

   A hold can also become its own hazard — a weak pack held on the incline,
   or a stopped truck blocking the loop behind it. The system flags these
   rather than waiting them out.

3. **Never compute age from `t_device_ms`.** Vehicle clocks are explicitly not
   disciplined (one ran ~58 minutes ahead). Order by `seq` within a
   controller run, age against `server_time_ms`, treat the device clock as an
   opaque echo — and surface per-truck skew as a data-quality signal. A large
   `seq` drop while the device clock moves forward is a controller restart,
   not a duplicate: start a new run rather than discarding everything until
   `seq` catches up.
4. **On reconnect, replay in-flight `command_id`s** to recover their outcome.
   That recovers the ack only (finding 3).
5. **A faulted truck in a closing zone cannot be evacuated by us.**
   `INTERLOCK_ACTIVE` blocks `EXIT_ZONE`; limp-home at 1.0 m/s or nothing, and
   `BATTERY_DEPLETED` needs a tow. Escalate loudly; never report the zone clear.
6. **Re-check zone membership immediately before auto-issuing `EXIT_ZONE`.**
   The 1–6 s execution delay means a race survives anyway; prefer a spurious
   hold over a missed evacuation. Time to clear = distance to the nearer
   boundary ÷ speed, plus up to 6 s to take effect. Reverse at 3.0 m/s empty
   is measured; 2.0 m/s loaded is **assumed** from the spec, not measured.
7. **The CLOSED rule is unconditional** — it covers estopped, faulted and dead
   trucks. Not clear means not clear.
8. **A blocked command surfaces to the lease holder,** not only to whoever
   tried. This is Priya's near miss exactly.
9. **Forced takeover is a supervisor-role action.** Auth is ours to design; a
   hard-coded user list is acceptable per the brief.
10. **Block manual driving *into* a closed zone; never block driving *out*.**
    Limp-home may be the only way out.
11. **Alarm threshold: interrupt only for action needed inside the next
    minute.** Everything else is visible but silent, and the rule that
    silenced something is inspectable. Dave turned the old system's sound off
    in month one; that is the bar.
12. **Stale position widens the evacuation set** rather than narrowing it.
    "Stale" includes **contradicted**: a truck reporting motion (`TRAMMING`
    or `MANUAL`, speed > 0) whose position does not change is frozen, and
    its true position is anywhere it could have reached since the last
    position that moved. Not the device clock — it keeps ticking on a frozen
    truck — and not "identical messages", which a loading or held truck also
    sends. A truck that freezes while stationary is not detectable from
    telemetry alone; a command response that contradicts telemetry (a
    `RESUME` rejected `INVALID_STATE` for a truck reporting `HOLDING`) is the
    only signal, and is surfaced as one.
13. **SoC: show the pack's own number, plus a derived confidence** — in the
    MVP, kept simple: drain rate against the fleet, and whether the truck
    can reach the bay on what it has. A weak pack died in the incline in two
    of three runs. Never replace the vendor's number with ours; flag a
    fractional value rather than silently scaling it. Sending a weak truck
    home stays the operator's decision.
14. **The model proposes, never acts.** **Deferred:** plain-language queries
    are not in this version (`PLAN.md`). If built later, queries and command
    proposals are allowed; every command still needs operator confirmation
    and passes the same deterministic checks as the UI.
15. **Every supervisory command is confirmed in telemetry, against a
    deadline.** If the effect does not appear, retry under a **new**
    `command_id`, show the attempt count, and alert if it still fails.
    Retrying is safe because `HOLD`, `RESUME`, `RETURN_TO_BAY` and
    `EXIT_ZONE` do nothing extra when repeated: a second `HOLD` on a held
    truck is still a hold. The exception is **queuing**: behind `LOADING`
    (~20 s), `DUMPING` (~12 s) or `CHARGING` (unbounded) the deadline has to
    depend on state, and a newer queued command replaces the older one — so
    a retry must never displace a different command we queued. Queue
    behaviour is **unverified** (the probe's S2 never ran); test it in the
    fake gateway.
16. **Hold trucks before they enter a closing zone.** DECLINE takes ~167 s
    to cross against 120 s of notice, so a truck entering late cannot get
    through. *(Revised by answer 3:)* evacuation is per-truck. Spacing is out
    of scope and the simulator doesn't model trucks interacting, so there
    are no upstream holds before reversing a truck out; they would only be
    unnecessary stops.
17. **The blast budget survives a link drop.** A drop can eat 45 s of the
    120 s notice. On reconnect, act on the `hello` snapshot at once; plan
    against the time left, not the time given. Several zones can close at
    once.
18. **Remote driving shows its lag; the deadman risk is smaller than the
    round trip suggests.** Echo age was 200–620 ms, but that is a round trip
    plus up to 200 ms of telemetry sampling. At 10 Hz, send gaps were
    100–106 ms and the deadman never tripped in the probe. The driving view
    shows input age and deadman state; a link drop still stops the truck,
    by design.


## Reuse from an earlier project of mine (`drone-hal`)

Same author, same patterns, different domain. Carries over:

- **Two-clock observations** — every value holds when the device sampled it and
  when we received it, with per-field freshness scaled to the declared rate.
- **A command registry as the single authority on lifecycle,** with illegal
  transitions logged and discarded rather than applied.
- **The safety check sits below the command path,** so commands the system
  issues to itself are checked by the same code as an operator's.
- **Refusals carry a reason in the operator's language,** and the distinct
  kinds stay distinct rather than collapsing into "rejected".
- **A conformance observer** that speaks the protocol and asserts the other
  side behaves — the brief invites this: "the simulator is ours, and its
  internals are part of what's being tested."
- **Propose-then-confirm plain-language queries** — the model resolves intent;
  state, checks and dispatch stay deterministic. Deferred with the feature.

Does **not** carry over: lat/lon geometry (this is 1-D along a loop, with
wrap), and anything about aircraft.

## Deployment target

Oracle Cloud ARM box `dronehal1`, already in use by another project:

- 1 OCPU, 5.5 GiB RAM, 30 GB disk (~18 GB free), Oracle Linux 9, aarch64
- Node 22.23.2, git, rsync, Chromium dependencies installed; **no Docker**
- Caddy on 80/443 with a TLS cert via sslip.io; firewalld allows http/https
- **Port 8080 is taken** by an existing project — pick another and add a Caddy
  route
- **Nothing survives a reboot** — no systemd unit exists yet. Whatever runs
  here must restart on boot; the graders run the system unattended
- One OCPU is the real constraint, not memory

`docker compose up` is what the brief prefers, and the graders will likely
run it on x86, so the image must build for both amd64 and arm64. Must read
`GATEWAY_HOST`, `GATEWAY_PORT` and `GATEWAY_EMAIL` from the environment. Pin
Node 24: on Node 22, `node:sqlite` needs no flag but prints an
`ExperimentalWarning` at every start; on 24.15 it prints nothing.

## Working agreements

- **First commit is the `.gitignore`, before anything else is added.** The
  repo lives on an exFAT drive, so macOS writes a `._` resource-fork file
  beside every file; one careless `git add .` puts them in the graded history
  permanently. Never use `git add .` or `git add -A` — add paths explicitly.

  ```gitignore
  # macOS / exFAT
  ._*
  .DS_Store

  # secrets — the repo goes public
  .env
  .env.*
  !.env.example

  # build and dependencies
  node_modules/
  dist/
  *.tsbuildinfo

  # the original download; the unpacked files are committed instead
  *.zip
  ```

- **`PLAN.md` before code,** then left as written, with a short "what changed"
  section at the end.
- **Commit as you go.** The history is read and graded.
- **`AI_LOG.md` as we go, not at the end** — 5–10 entries on moments that
  mattered, including at least one where the agent was confidently wrong, how
  that was found, and what was done about it. Writing these retroactively
  shows.
- **Test the failure behaviour, not just the happy path.** Link drops, stale
  telemetry, commands that are accepted and then ignored, a zone closing on a
  faulted truck.
- When the simulator looks wrong, write it down rather than working around it
  silently. The brief asks for exactly that.

- **The repo goes public at submission.** Nothing secret is ever committed,
  even briefly — history can't be un-published once someone has cloned it.
  `GATEWAY_EMAIL` and any credentials live in `.env`, never in code; commit
  a `.env.example` with placeholders instead.
