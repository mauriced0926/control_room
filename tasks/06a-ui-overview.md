# Task 6a: UI, the fixture player and the Overview screen

**Goal.** The operator's main screen, built against replayed fixtures before it touches the
gateway, so it is designed around frozen, silent and old trucks from the start. `UI.md` is the
design spec; this task builds its fixture player and its Overview screen.

**Read first:** `CLAUDE.md` and everything it lists; then `UI.md`, which wins over anything here on
how things look. Read `OPERATOR_NOTES.md` again before you design anything: Priya, Dave and Ken are
the users. The data comes from `src/fleet.ts` (`FleetState`, `FleetSnapshot`); read its types first.

**Must pass:** `TESTING.md` L9.1 (live, old, silent and contradicted trucks look different), and the
Overview states in `UI.md`'s table. Not yet: L9.2–L9.5, which need the service and driving.

## Scope, in priority order

1. **Fixture player:** replays a fixture from `research/fixtures/` through `FleetState` with a
   `ManualClock`, with play, pause, step and speed controls, and serves snapshots to the browser.
   No gateway, no commands: this task sends nothing anywhere.
2. **Track diagram:** the loop as a metro line from `hello`'s route, in route order, zones as labelled
   bands with their status (OPEN, a CLOSING countdown, CLOSED), trucks as chips. A frozen or silent
   truck is a hatched bar over its reachable range (`TruckView.range`), with its age. Ranges wrap.
   It must work for any site: test it with a different route (`test/site.test.ts` has one).
3. **Zone clearance panel:** for each closing or closed zone, CLEAR, NOT CLEAR or UNSURE, in words, with
   the countdown and the reasons; NOT CLEAR and UNSURE both say "Radio the shot firer to hold the
   shot". **The blast engine's rules are still being written.** For now implement only invariant 6,
   from belief: NOT CLEAR if a live or old truck is in the zone; UNSURE if only a silent, contradicted
   or unknown truck's range overlaps it; CLEAR only if no truck might be inside. Put that rule in one
   small pure function in `src/` with its own tests and a comment saying the blast engine will own it.
4. **Fleet table, sorted by attention:** truck, state, zone, SoC as the pack reports it with a flag when
   doubted (fractional, draining fast, can't reach the bay), control mode and lease holder, data state
   in words, and a placeholder for the last command (the registry isn't built yet).
5. **Always-on elements**, as far as they make sense without a service: the e-stop's place and shape
   (inert, labelled "not connected" in the player), the site-link indicator from heartbeat age, and
   "Sound off".

## How it is built

`PLAN.md` says a plain browser UI. No front-end framework, and no build step unless you justify one:
Node 24 can strip TypeScript types for the browser (`module.stripTypeScriptTypes`), so the server can
serve `.ts` modules directly. Keep UI code that doesn't need the DOM in pure functions, tested with
`node --test`. Product code still follows L1.1 and L1.3: time from the injected clock, nothing site-
specific. Dark, low glare, large type, colour never alone (`UI.md` principles).

## Screenshots

Take a screenshot of the Overview at each fixture's telling moment (the freeze, the silence, the link
drop, both zones closing, the weak pack's warning, and so on) and commit them under `docs/screenshots/`
with a short index saying what each shows. They become the README walkthrough. Use Playwright if it
runs on this machine (macOS 12); if not, use a headless Chrome directly, and say which.

## Ways to be wrong that matter

- An unsure truck drawn as a dot. A range is the point.
- UNSURE that looks anything like CLEAR, in colour, word or position.
- A picture that looks current when the data has stopped.
- Motion or flashing that isn't needed: only the trucks move.
- Hard-coding this site's zones or loop.

## Working rules

Tests first for the pure parts. Commit as you go on your branch, one logical change per commit,
adding paths explicitly (never `git add .`/`-A`). Before starting, make sure your branch is based on
local `main`, not on a stale `origin/main`. Don't push and don't merge; I review, merge and push.
Never connect to any gateway. Finish with: what passes, what doesn't, screenshots taken, every design
choice you made that `UI.md` didn't decide, and anything in `UI.md` that didn't work in practice.
