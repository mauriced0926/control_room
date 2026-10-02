# CLAUDE.md

Control-room software for Deep Level Haulage's autonomous haul trucks. Read before any task.

## Read first

1. `dlh-candidate-package/BRIEF.md`, then `OPERATOR_NOTES.md`, then `PROTOCOL.md`, in that order.
2. `CONTEXT.md`: findings, open questions and the numbered assumptions. Treat them as decisions.
3. `PLAN.md` (frozen: never edit it, except its final "What changed" section, and only when asked).
4. `research/README.md`: what the live gateway actually does, verified against assumed.
5. `TESTING.md`: the cases your task must pass.

## Invariants

These are not negotiable. If a task seems to need one broken, stop and ask.

1. **Time is injected.** No component reads the wall clock directly. Everything takes a clock,
   so blast scenarios run in milliseconds in tests.
2. **`operator_id` comes from the server-side session,** never from the browser's payload.
3. **Drive input is relayed only while fresh,** and never re-sent or synthesised by the service.
   Silence means stop: a browser that goes quiet must let the deadman stop the truck.
4. **No model on the control path.** Nothing an LLM produces sends a command.
5. **Blast safety: get every truck out that can be got out; alarm for the rest.** Every truck
   that can be cleared from a closing zone, or held before entering it, in the time left is
   outside when it closes. For a truck that can't, a can't-clear alarm ("radio the shot firer
   to hold the shot", with the truck, the zone and the reason) goes up within 10 s of
   `CLOSING`, or of the data first allowing that conclusion, whichever is later. The alarm
   never replaces evacuation (`TESTING.md` L4).
6. **Blast safety: never wrongly clear.** The system never recommends "clear" while any truck
   might be inside. "Might" includes old, silent and contradicted data.
7. **Nothing site-specific is a constant.** We will be run against a site we haven't seen.
   Route, segments, zones, loop length and vehicle list come from `hello`; notice length comes
   from each `zone_event`'s `effective_at_ms`. Speeds and delays are parameters with their source
   noted (spec or measured), never literals scattered through the code.

The rest of `CONTEXT.md`'s assumptions bind too. The ones most often forgotten: `ACCEPTED` is
not done, so confirm the effect in telemetry. Order by `seq` within a controller run and age
against `server_time_ms`, never the device clock. Stopping needs no person. The system restarts
only trucks it held for a blast, once that zone reopens; every other hold waits for a person. The
safety check sits below every command path, operators' included.

## How to work

- Tests first, from the cases in `TESTING.md`. Replay `research/fixtures/` rather than inventing data.
- Done means the tests pass **and** every claim in your summary was checked against raw data:
  logs, captures, the database. Never check a claim only against your own printout.
  (`AI_LOG.md` entry 1 is why.)
- If the simulator seems to behave wrongly, write it down. Never work around it silently.
- Keep it small. A focused system that is right beats a broad one.

## Repository hygiene

- **Never `git add .` or `git add -A`.** Add paths explicitly. The repo is on exFAT, where macOS
  writes a `._` file beside every file, and the repo goes public.
- **Never print `.env`** or echo `GATEWAY_EMAIL`, a key or a password into output, logs, commits
  or fixtures. Credentials come from the environment only; `.env.example` lists them.
- Commit as you go, one logical change per commit. The history is read.
