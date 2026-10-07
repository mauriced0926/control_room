# Blast engine rules

**Reviewed and edited 2026-10-03.** The blast engine (`PLAN.md` task 5) is built from this.

What the blast engine decides, on what evidence, and what it leaves to people. It implements
`CLAUDE.md` invariants 5 and 6, and is tested by `TESTING.md` L4 and L5. Rule ids (B1…) are what the
audit log records against every system action, and what the gateway's statutory log sees: every
system command goes out with `operator_id` `system:<rule>`, for example `system:B3`.

## What it does and doesn't do

- **Does:** for every zone that is `CLOSING` or `CLOSED`, decide per truck whether to do nothing, hold it
  before it enters, get it out, or alarm; recommend CLEAR, NOT CLEAR or UNSURE; resume the trucks it
  held once the zone reopens.
- **Doesn't:** tell the shot firer (the operator does, by radio: answer 1); clear faults; move a truck
  someone is driving; manage spacing between trucks (answer 3).

## Inputs and timing

- Belief comes from `FleetState`: each truck's confidence (live, old, silent, contradicted, unknown) and
  its reachable range. Never from the fake's truth.
- **Time left** = `effective_at_ms` − estimated server now. Recomputed on every evaluation, so a link drop
  shrinks it (CONTEXT assumption 17).
- **Evaluate** on every snapshot change, and at once on `CLOSING`, on `hello` after a reconnect, and when
  a command's confirmation deadline passes.
- **Path prediction** is shared by every rule below: from the truck's position, forward along the loop,
  including each **duty stop** on the way (a load, dump or charge, at the end of a segment of that
  kind in `hello`'s route; charging only below the charge threshold), the time it spends there, and
  its speed after it (loaded or empty). Duty stops are found from segment kinds, never by name
  (invariant 7).
- **Time to clear** = remaining queued work (LOADING ~20 s, DUMPING ~12 s, from the truck's own
  history) + up to 6 s for the command to take effect + distance to the boundary `EXIT_ZONE` will pick
  ÷ speed for its load state + margin. Loaded reverse: 2.0 m/s, measured thinly by the re-probe; the
  1.5 m/s pessimistic version is tested too.
- **Queued commands are unreliable** (re-probe Q1: a `HOLD` queued behind loading was `ACCEPTED` and
  never carried out). Any command sent to a LOADING, DUMPING or CHARGING truck is checked the moment
  the work ends and retried at once. The engine never queues two different commands on one truck.

## Per truck, per closing zone

**B1. Unsure trucks are held, never sent out.** If the truck is silent, contradicted or unknown and its
range overlaps the zone or reaches it before it reopens: `HOLD`, and the zone is UNSURE. Not
`EXIT_ZONE`: it leaves the zone the truck is in *when accepted*, so if the truck is really just outside,
it could drive it *into* the closing zone. Raise the can't-clear alarm (B9). This holds a frozen truck
that is really outside too; the operator's way out is the B11 override, with a reason.

**B2. Inside, confident, leaving on its own: decide at the last safe moment.** If path prediction has
the truck out through the far boundary, duty stops included, with the margin to spare: no command yet.
Compute the **last safe moment**, the latest time at which `EXIT_ZONE` from where the truck will then be
still gets it out before `effective_at` with the margin. If the truck isn't out by then, send
`EXIT_ZONE` at that moment (B3). Not "if it looks late": the decision point is fixed in advance. (Lena:
don't stop trucks that don't need stopping.)

**B3. Inside, confident, can be got out in time.** `EXIT_ZONE`, unless B4 applies. Confirm the effect in
telemetry (the truck's `task` and direction) by the state-aware deadline; retry under a new id; alarm
if it still fails.

**B4. Never send a truck into another closing or closed zone.** If the boundary `EXIT_ZONE` would pick
puts the truck in another zone that is not `OPEN` and that it cannot also clear in time: `HOLD` instead,
raise the can't-clear alarm, and offer remote driving out the other way (L2.52).

**B5. Inside but cannot be got out in time:** too far, interlocked (fault, e-stop, depleted battery),
or under someone's lease. Raise the can't-clear alarm (B9) within 10 s. Still send `EXIT_ZONE` if it can
move at all and B4 allows: a truck that gets out late lets the shot go late rather than not at all.
A leased truck is never commanded; its lease holder gets the alarm with the countdown.

**B6. Outside, approaching: hold before entry.** A truck whose predicted path crosses into the zone
before it reopens, and which cannot pass all the way through before `effective_at` with the margin, is
held before the boundary. Pass-through uses path prediction, so a truck that would stop inside the zone
for a duty stop (loading at a draw point, say) and leave at loaded speed is judged on that. The `HOLD`
goes out when the truck is (6 s + telemetry age + latency allowance) × speed + margin from the boundary,
not at `CLOSING`: a truck far away may never need stopping. The 6 s stands until measured `HOLD`
timings say otherwise. Once `CLOSED`, every approaching truck is held.

**B6a. A truck working at a duty stop on a boundary.** Duty stops sit at segment ends (`PROTOCOL.md` §3),
and on this site each one is on a zone boundary, so a truck working there leaves straight into the next
zone when the work ends. A queued `HOLD` may be dropped, and a retry after the work ends takes up to 6 s.
Rule: for any truck LOADING, DUMPING or CHARGING at a segment end that is a boundary into a zone that is
`CLOSED`, or `CLOSING` and that it cannot pass through in time, the system takes it with `TAKE_CONTROL`
(`system:B6a`). That takes effect at once and interrupts the work (`PROTOCOL.md` §5); with no drive
input the deadman stops it, and the lease expires to `HOLDING` after 10 s, which the truck does not
leave by itself. Chosen over accepting entry, which fails L4.R0 by design, and over `ESTOP`, which needs
`CLEAR_ESTOP` and reads as an emergency. The system holds the lease only until it expires.

**B7. A command on its way can't be recalled.** Stopping an `EXIT_ZONE` in progress takes `HOLD`, not
`RESUME`: `RESUME` is rejected while a task is running (S9), and while another command is within its
1–6 s delay (re-probe Q3). The engine never relies on cancelling a command it has sent.

**B8. Several zones at once.** A truck is judged against every zone that is not `OPEN`; its exit path
must end in an `OPEN` zone (B4); a truck that one zone's rules would move and another's would hold is
held.

**B9. The can't-clear alarm.** Within 10 s of `CLOSING`, or of the data first allowing the conclusion,
whichever is later. It names the action ("Radio the shot firer to hold the shot"), the truck, the zone
and the reason in words. It interrupts (L2.60). It clears itself only when the truck is confirmed
outside, the zone reopens, or the blast is cancelled; never because time passed.

**B10. BAY closing.** `EXIT_ZONE` is refused in BAY, so every truck in BAY gets the can't-clear alarm at
once with "drive it out or hold the shot"; trucks approaching BAY are held before entry (B6); a truck
charging at the BAY's end is covered by B6a.

## Commands the engine can't confirm

**B16. Unconfirmable commands.** A command to a silent or contradicted truck can't be confirmed in
telemetry, because there is no believable telemetry. It is sent, retried a bounded number of times,
and then reported as **"can't verify: data silent"** or **"can't verify: data frozen"**, not as failed.
The truck stays UNSURE in every zone its range touches. When its data returns, the command's effect is
checked against it like any other.

## The clearance recommendation

**B11.** Per zone that is not `OPEN`, from belief only (invariant 6), judging **every truck by its
reachable range**, live and old trucks included. An old truck's range grows with its age: 2–5 s at
3 m/s is up to ~15 m, so a truck reported just outside and heading in may already be in.
- **NOT CLEAR** if a live or old truck reports a position inside.
- **UNSURE** otherwise, if any truck's range overlaps the zone (a live or old truck near the boundary,
  or any silent, contradicted or unknown truck), or the site link is down.
- **CLEAR** only if every truck's range is outside the zone and the link is up.

NOT CLEAR and UNSURE both carry "Radio the shot firer to hold the shot" and their reasons. The operator
may record "I've confirmed it's clear" over either, only with a reason; recommendation and override are
both logged.

## When a zone reopens

**B12. Auto-resume** (answer 2), on `CLEARED` or `CANCELLED`: within 15 s, resume every truck the system
held **for that zone**, confirmed in telemetry, unless it is now held for another zone (B8), has a lease
or a fault, or was also held by an operator. A truck still carrying out an `EXIT_ZONE` gets `HOLD`
first and `RESUME` once it is `HOLDING` (B7: `RESUME` is rejected while a task runs). A truck B6a took
is resumed once its lease has expired to `HOLDING`. Never resumes into a zone that is not `OPEN`
(L4.R5). An operator's hold is never resumed (L4.R4).

## Link and service

**B13. Link down.** Nothing can be sent. Every zone that is not `OPEN` becomes UNSURE; "link down while
a zone is closing" interrupts. On reconnect, act on the `hello` snapshot at once against the time left.
Commands in flight are replayed by the registry.

**B14. Service restart.** The engine's holds and their reasons are persisted with the command log, so a
restart mid-blast knows which trucks it held and for which zone (L6.1).

## Every decision is logged

**B15.** Each system action is logged as the system, with the rule id, the zone, the truck's belief
(confidence, range, time left, time to clear) and the command's outcome, in the same log as the
operators' (answer 4); the gateway sees `system:<rule>` as the operator.

## Limits of enforcement

For `README.md` §5, "the cases where it can't":

- **A silent truck's range grows to cover the whole loop within minutes** (at 3 m/s, both directions,
  1600 m takes under 5 minutes). Until its data returns, every closing zone is UNSURE. That is correct,
  and it means one silent truck can hold every shot on the site.
- **A truck that freezes while stopped and then moves** is undetectable from telemetry (`TESTING.md`
  L4.R2c); its violations are measured, not prevented.
- **A faulted truck that can't limp home**, a depleted battery, or a truck someone else is driving can't
  be got out by the system: the alarm is all it can do (B5).
- **Commands may be dropped or ignored** after `ACCEPTED`; the engine retries, but a truck that ignores
  every attempt is reported, not moved (B3, B16).

## Decisions from review (2026-10-03)

1. **B2:** yes, with the last-safe-moment guard: the decision point is computed in advance, not
   inferred from lateness.
2. **B5:** yes; a late exit shortens the held shot.
3. **B6's margin:** 6 s until measured `HOLD` timings say otherwise.
4. **Never queue two different commands on one truck:** agreed.
5. **B1 for a frozen truck that is really outside:** hold; the B11 override, with a reason, is the
   operator's way out.
6. **B6a:** approved, for every duty stop on a boundary, not only the draw point. Accepting entry fails
   L4.R0 by design; `ESTOP` reads as an emergency and needs clearing. The lease expires after 10 s.
7. **`operator_id`:** `system:<rule>`, so the statutory log carries the why.

Added in review: B11 judges every truck by range; path prediction (with duty stops) shared by B2 and
B6; B16 for commands that can't be confirmed; B12's `HOLD` before `RESUME`; the limits above.

## Decisions after the 200-seed run (2026-10-07), not yet built

8. **B4 lets a truck leave forward on its own** before holding it: if path prediction (with duty
   stops) has it out through the far boundary into an open zone in time, it gets no command, with
   the same last-safe-moment guard as B2. Holding is the fallback only when neither way works. The
   200-seed run traced the largest share of R0 failures to B4 holding such trucks.
9. **Two can't-clear alarms, not one.** "A truck is in there and can't get out" and "I can't confirm
   where truck X is" both say "Radio the shot firer to hold the shot", with their different reasons.
   M3 counts only the first. Most false alarms in the 200-seed run were the second kind.
10. **A refused drive input goes out as throttle 0**, only in reply to fresh operator input, never on
    a timer (CLAUDE.md invariant 3). The driving relay already behaves this way.
