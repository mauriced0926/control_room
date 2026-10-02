# Plan

Written before building and left as written; what changed is recorded at the end. Evidence
behind these decisions is in `research/README.md`; the full assumptions are in `CONTEXT.md`.

## Who the users are and what they need

- **Control-room operators** (Priya on days with one colleague, Dave alone on nights). Haul is
  one of four screens. They need to answer "is L4 South clear?" in ten seconds without counting
  dots; to know whether a command *worked*, not just whether it was received; to see where a
  truck last was and how long ago, and never a confident picture that is wrong; to be
  interrupted only when something needs them in the next minute; and to know who is driving
  which truck.
- **The shot firer** (Ken) needs a "clear" he can trust, to hear early when a truck cannot get
  out, and trucks moving again after a call-off.
- **The supervisor** (Marta) needs every command tied to a named operator or a named rule, and
  findable in minutes.
- **Maintenance** (Sam) needs which fault, when and where, and weak packs flagged before they die
  in the incline. **The mine manager** (Lena) needs trucks stopped only when they must be.

## Questions

Asked, with the assumption I'm building on until they answer:

1. How does a "can't clear" reach the shot firer? — *The operator phones; we show what to say.*
2. May the system restart trucks after a cancelled blast? — *No. One click resumes everything it held.*
3. Who owns headway, given trucks can't sense each other and `EXIT_ZONE` reverses? — *We do, during
   evacuation. The probe reversed a truck at full speed toward the trucks behind it.*
4. Is "the system did it, under rule X" acceptable in the statutory log? — *Yes, named rule and inputs.*

Would still ask: can BAY itself be closed, where `EXIT_ZONE` is refused? And is an `ACCEPTED`
command that never executes expected behaviour, or a fault to report?

## The MVP

**Is:** one service that keeps the site safe with no browser open, and a browser UI that is the
operators' whole working surface.

1. **A fleet picture that admits doubt.** Every truck's last known position and its age. Live, old,
   silent and contradicted data are shown as different things, never smoothed over.
2. **Commands confirmed by effect.** Acks are not trusted: each command is checked in telemetry
   against a deadline, retried visibly under a new id, and refusals are explained in the
   operator's words, including who holds the lease.
3. **Blast safety, coordinated.** For each closing zone, hold trucks before they enter, hold
   upstream trucks before reversing the one below them, and budget against the time actually
   left after a link drop. Recommend clear or not clear with the doubts listed. The operator
   tells the shot firer. Unclear means not clear.
4. **E-stop** for any operator on any truck, always reachable. **Remote driving** by keyboard, with
   input lag and deadman state on screen.
5. **Battery warnings:** drain against the fleet, and whether the truck can reach the bay.
6. **Alerting that earns its sound:** interrupt only for action needed in the next minute; everything
   else visible but silent, with the rule that silenced it inspectable.
7. **Two or more named operators** with roles, an audit log of every command, and recovery from
   link drops on its own. Starts with `docker compose up` on port 8090; port 8080 is taken.

**Isn't:** no model on the control path, and no plain-language queries in this version. No
automatic resume after a blast. No gamepad. No headway control outside evacuation. No single
sign-on, multi-site view or handover screen. No automatic return-to-bay for weak packs: we warn,
the operator decides.

## How the work is broken down

Riskiest first. I own the rules: blast safety, data confidence, command outcomes. I also own the
operator experience, and I review every safety-related change line by line. Agents take bounded
tasks. Each task has a written spec, tests written before code, the fixtures in
`research/fixtures/`, and a `CLAUDE.md` holding the invariants. A task is done when its tests pass
*and* its claims have been checked against raw data, not against its own output.

1. **Fake gateway** with fault injection seeded from the fixtures, before anything depends on it.
2. **Ingest and fleet state:** validation, controller restarts, per-truck confidence.
3. **Gateway link:** reconnect with backoff, replay in-flight commands, link status.
4. **Command registry:** confirmation by effect, retries, attribution, audit log.
5. **Blast engine,** tested per fixture and in combination: a link drop during the notice, a
   frozen truck in a closing zone, two zones at once.
6. **Server, operator login, live updates;** then the **UI** (fleet, blast panel, command outcomes),
   then **driving**.
7. **Deploy and soak:** compose, reverse-proxy route, restart on reboot, and a 15-minute
   unattended run against the live gateway.

Steps 1 and 2 run in parallel in separate worktrees. The UI starts once the state model is
fixed. Stack: TypeScript on Node 24 as a single process, SQLite through the built-in
`node:sqlite` (no native build on ARM), and a plain browser UI. This fits one OCPU.

## How it's tested

Against how it will be judged: unattended on an unseen site, and driven
by a novice. Time is injected, so blast scenarios run in milliseconds.
Pure logic is table-tested per fault class; the nine research/fixtures/
are replayed as regressions. Blast safety is property-tested over seeded
random days from a fake gateway that knows true positions — 200 seeds in
CI, the full set before submission, every failing seed kept. Two rules:
a can't-clear alarm within 10 s of the data allowing it, and never
"clear" while the system believes a truck might be inside. Both are
checked against the truth for every fault it can detect; for the one it
can't, violations are measured and reported as the limit of
enforcement. Unnecessary holds are counted. The fake gateway must
reproduce the live fixtures and probe before its results count, and
unverified behaviour is tested both ways. Process kills, browser drops,
stuck keys, slow reads and a reboot are tested on purpose. A live soak
runs beside a monitor whose code shares nothing with ours. One person
who has never seen it does three timed tasks. Detail in TESTING.md.

## What changed

*(Written when finished.)*
