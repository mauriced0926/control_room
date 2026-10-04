# Task 6c: truck detail, command buttons, and the attention tray

**Goal.** Let an operator act on a truck and see exactly what happened, and let the screen ask for
attention only when it is needed. `UI.md` is the design: its "Truck detail" and "Attention tray"
sections, and the always-on elements.

**Read first:** `CLAUDE.md` and everything it lists; `UI.md` (it wins on how things look);
`OPERATOR_NOTES.md` again (Dave turned the old system's sound off in month one; Priya's near miss with
a truck someone else was driving). Existing code: `src/ui/*`, `src/live.ts` (the hub and its frames),
`src/registry.ts` (commands, their records and summaries), `src/refusals.ts`, `src/alarms.ts` (the
shared alarm shape: build against it).

**Must pass:** `TESTING.md` L2.60–L2.64 (alerting), L7.9 and L9.5 (hand-back's Resume step; driving
itself is a later task), L8.1 (a blocked command shown to the lease holder), L8.4 (the audit view:
"who moved HT-06 at 3:12?"), and the states in `UI.md`'s table for truck detail.

## Scope

1. **Truck detail** (`UI.md` screen 2): everything in the table row plus faults, clock skew, drain
   against the fleet, controller restarts; the **command timeline** (sent → acknowledged → effect seen,
   "retry 2 of 3", "can't verify", or failed with the reason in words); buttons for Hold, Resume,
   Return to bay, Exit zone and Take control, each going through the WebSocket to the registry. A
   refusal says why and what would allow it.
2. **The attention tray** (`UI.md`): interrupts at the top, each with an attributed acknowledgement;
   silent items below, each with the rule that kept it silent. Build the alarm store against
   `src/alarms.ts`: one cause, one alarm (`key`); re-alert at 15 minutes and escalate at 30; on nights,
   when the only operator logged in is the supervisor, escalation is more persistent alerting to them.
   Sound only for interrupts: distinct short tones, never continuous; "Sound off" until armed.
3. **Controller restart** (`UI.md`): not an interrupt. Truck detail, a silent tray item, and a small
   marker in the fleet table's data column for about a minute.
4. **Clearance panel during a link drop** (`UI.md`): UNSURE in full colour for every zone not open, the
   last call beneath it in grey with its age ("was CLEAR, 12 s ago"). The blast engine, built in
   parallel, will supply the verdict; until it merges, use the current provisional rule and the link
   status already in the frame.
5. **The audit view** (`UI.md` screen 4): pick a truck and a time; every command around it, operator or
   system with rule and inputs, the ack and the effect, from `store.history()`.

## Ways to be wrong that matter

- An interrupt for something that doesn't need action within a minute. That is how the old system
  got muted.
- An acknowledgement that isn't attributed to a logged-in operator.
- A command button that sends anything but an action and a truck: identity comes from the session.
- Showing "done" when the registry says "accepted" or "can't verify".

## Working rules

Tests first for the pure parts; Playwright (`npm run test:browser`) for what the operator sees, against
the running service on the fake gateway. Never the real gateway; never read `.env`. Commit as you go on
your branch, one logical change per commit, adding paths explicitly (never `git add .`/`-A`). Before
starting, make sure your branch is based on local `main`, not a stale `origin/main`. Don't push and
don't merge. The blast-engine agent works in parallel; stay out of `src/blast.ts` and
`src/clearance.ts`, and say in your report what you need from the engine.
