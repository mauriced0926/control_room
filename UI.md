# UI

The design spec the UI task builds from. The operators are in `OPERATOR_NOTES.md`; the cases these
screens must pass are in `TESTING.md` (L2.60–L2.64, L7, L9). It is prototyped against the replayed
`research/fixtures/` before it is wired to the live service, so it is designed around frozen, silent and
old trucks from the start, not retrofitted for them.

## Principles

1. **Answer the question before showing the data.** Priya's "is L4 South clear?" takes 2 seconds: a
   word, not a count of dots.
2. **Never show a guess as a fact.** A truck we're unsure of is drawn as a range over everywhere it
   could be, and labelled in words. When the data stops, the picture ages visibly; it never freezes
   looking current.
3. **Calm until it matters.** Built for a 12-hour shift, on one of four screens: dark, low glare,
   large type. Trucks move smoothly along the line; nothing else animates, pulses or flashes. Sound
   only for interrupts (assumption 11): distinct short tones, never continuous.
4. **Colour never carries meaning alone.** Every state also has a word, a shape or a pattern.
5. **Show what actually happened.** A command is "sent", "acknowledged" and "done" as three separate
   things, and a failure says why in plain words.
6. **One obvious next step.** Every alarm names its action; every held truck shows how to resume it.

## Always on screen

- **E-stop**, in a fixed place on every view: a distinct shape (octagon), not just red. One press per
  truck. Pressed while the site link is down, it shows **pending, not delivered**, with a cancel; it is
  sent automatically only if the link returns within 10 s, and otherwise asks again with the truck's
  current state (L7.8). It shows "done" only when telemetry confirms `ESTOPPED`.
- **Two link indicators: site and service.** Each shows its own age. If either drops, the whole picture
  greys and every age counter keeps counting (L9.2, L9.3).
- **Who else is on:** operators logged in, their roles, and who holds which truck's lease.
- **Sound armed.** Browsers block sound until the page is clicked. After login the operator clicks once
  to arm it; until then "Sound off" shows in a fixed place, because an interrupt nobody hears isn't one.

## Screens

**1. Overview** (the default, and what's on the screen most of the shift)

- **Track diagram, not a map.** The loop drawn like a metro line from `hello`'s route, in route order,
  with zones as labelled bands. Each band shows OPEN, a CLOSING countdown, or CLOSED. Trucks are chips
  on the line with their id. A truck we're sure of is a chip; a frozen or silent truck is a hatched bar
  over everything it could have reached, with its age. Held trucks show who held them.
- **Zone clearance panel.** One row per closing or closed zone: **CLEAR**, **NOT CLEAR** or **UNSURE**,
  in words, with the countdown. NOT CLEAR and UNSURE both say **"Radio the shot firer to hold the
  shot"** and list the reasons (truck, why: inside, can't get out in time, frozen, silent, faulted).
  UNSURE never looks like CLEAR (invariant 6; answer 1: in doubt, hold the shot). The operator can
  record "I've confirmed it's clear" over UNSURE or NOT CLEAR only with a reason, and both the
  recommendation and their decision go in the log.
- **Attention tray.** Interrupts at the top, each needing an attributed acknowledgement. Below them, the
  silent items, each showing the rule that kept it silent (L2.60–L2.62). Re-alerts at 15 minutes,
  escalates at 30; on nights, when the operator is the supervisor, escalation is more persistent
  alerting to them (L2.63).
- **Fleet table, sorted by attention:** truck, state, zone, SoC as the pack's own number with a flag
  when we doubt it (fractional, draining fast, can't reach the bay), control mode and lease holder, the
  data state in words (live, old 4 s, silent 32 s, contradicted), and the last command with its outcome
  and attempt count.

**2. Truck detail** (click any truck)

- Everything in its table row, plus faults (which, when, where), skew of its clock, battery drain against
  the fleet, and its controller restarts.
- **Command timeline:** each command as sent → acknowledged → effect seen, with times; or "retry 2 of 3";
  or failed with the reason in plain words ("HT-04 is being driven by Marta"). A command blocked by a
  lease is also shown to the lease holder (L8.1).
- Actions: Hold, Resume, Return to bay, Exit zone, Take control. A refusal from the safety check says
  why and what would make it allowed (L2.50–L2.52).

**3. Driving** (after Take control)

- **Lag meter:** input age and echo age, with the deadman threshold marked. **Deadman state** in words.
  Speed, direction, and distance to the next zone boundary with that zone's status.
- Keyboard: hold to drive, release to stop. Losing focus or hiding the window sends zero and stops
  streaming (L7.5).
- Driving into a closed zone is refused at the boundary; driving out never is (L7.6). A limp-home truck
  shows its 1.0 m/s limit; a `BATTERY_DEPLETED` truck says "needs a tow" instead of offering control.
- **Hand-back is two obvious steps:** Release, then Resume. After release the truck shows "held by you —
  Resume" until someone resumes it (L7.9, L9.5).
- A forced takeover says who took it, and when (L7.3).

**4. Audit**

- Answers "who moved HT-06 at 3:12?" directly: pick a truck and a time, and get every command around it
  — operator or system, the rule and inputs for system actions, the ack and the effect (L8.4).

## States each screen must show

| State | Track diagram | Fleet table | Driving view |
|---|---|---|---|
| Live | Solid chip | "live" | Normal |
| Old (> 2 s) | Chip greyed, age shown | "old 4 s" | Lag meter in warning |
| Silent (> 5 s) | Hatched range, age | "silent 32 s" | Deadman expected; says so |
| Contradicted (frozen) | Hatched range, "data frozen" | "contradicted" | Driving refused: position unknown |
| Site link down | Everything greys; banner with age | All rows aged | "Link down: truck will stop" |
| Service down | Banner "disconnected"; picture greys | All rows aged | Same |
| Zone CLOSING / CLOSED | Band with countdown / hatched band | Zone column marked | Boundary status ahead |
| Command pending / retrying / failed | Badge on chip | Outcome column | Banner |
| E-stop pending (link down) | Octagon badge "pending" | "e-stop pending" | Octagon "pending" |
| Fault / limp-home / tow | Chip with fault mark | Fault in words | Limit shown / refused |

## Prototype

A fixture player feeds `research/fixtures/` through ingest and fleet state into the UI, with time
controls, so each screen can be checked against frozen-truck, silent-truck, link-drop-in-notice,
two-zones-closing and weak-pack before it ever touches the gateway. Screenshots from the player become
the README walkthrough, revised after the novice test (L11).
