# Task 1b: fake gateway, milestone 2

**Goal.** Give the fake gateway the faults the live site has, the pessimistic versions of what we
haven't verified, and other sites, and prove it matches the live statistics. After this, its
results count as the oracle for blast safety (`TESTING.md` L4).

**Read first:** `CLAUDE.md` and everything it lists; `tasks/01-fake-gateway.md` (milestone 1);
`research/README.md`, especially "Radio and blast statistics", "Verified, and not" and "Open in the
spec". Milestone 1's code is in `fake/`.

**Must pass:** `TESTING.md` L0.F, L0.P, L0.S, L0.C1 and L0.C3, with L0.M, L0.C2 and L0.C4 still passing.

## Scope

1. **Fault injectors (L0.F)**, one per class, each switchable, seeded and recorded in the fake's truth
   log (which truck, when, what), so a test can ask "what was really wrong at time t". The classes are
   listed in L0.F. Their shapes come from the fixtures: a frozen truck repeats its whole message with
   `seq` and `t_device_ms` still advancing (`frozen-truck`); a truck that freezes while stationary
   then moves is its own injector, since it is the undetectable case (L4.R2c). Rates and lengths come
   from the statistics table. A "default day" turns on the live catalogue: one truck per fault class,
   at random, as the live site does.
2. **Ack latency.** Milestone 1 answers instantly; the live gateway doesn't. Measure the send-to-ack
   delay from the live probe log (ask me for it; it is not in the repo) or from
   `research/fixtures/accepted-then-ignored-resume.jsonl`, which has sends and acks, and model it.
   Lost acks and accepted-then-ignored commands are injectors.
3. **Pessimistic versions (L0.P)**, as parameters: queued commands sometimes dropped without notice;
   loaded reverse at 1.5 m/s. A live re-probe of queuing and loaded reverse speed runs at the start of
   the registry task; when its results land in `research/README.md`, update the spec versions to match
   in a separate commit.
4. **Site variants (L0.S):** a different route and zone names, 7 and 20 trucks, a 60 s notice; plus BAY
   closing.
5. **Conformance:** L0.C1 (each fixture's fault, injected, is flagged by `research/report.py` the same
   way) and L0.C3 (a 15-minute default day within the measured ranges; any gap written down).
6. **Number formatting:** milestone 1 serialises `2.0` as `2`. The live site sends `2.0`. Match it if it
   is cheap; otherwise write down why it doesn't matter to ingest.

## Ways to be wrong that matter

- A fault that the fake's truth log doesn't record: the blast tests then can't tell a correct alarm
  from a false one.
- Faults that happen to be easy: the live frozen truck reports motion; a link drop lands inside a
  blast notice in two of three live runs; the weak pack dies in the incline. Make sure the default day
  can produce each of these.
- Breaking determinism (L0.C4) with a new source of randomness.
- Trusting your own printout. L0.C1 runs `research/report.py`: compare against its output file.

## Working rules

Tests first. Commit as you go on your branch, one logical change per commit, adding paths explicitly
(never `git add .`/`-A`). Before starting, make sure your branch is based on local `main`, not on a
stale `origin/main`. Don't push and don't merge; I review, merge and push. Never connect to the real
gateway. Finish with: what passes, what doesn't, every place you guessed, and anything in the
research that disagrees with what you built.
