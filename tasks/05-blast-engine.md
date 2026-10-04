# Task 5: the blast engine

**Goal.** Keep trucks out of closed zones without anyone watching, as `BLAST.md` specifies, and prove
it over seeded random days against a fake gateway that knows where every truck really is.

**Read first:** `CLAUDE.md` and everything it lists. **`BLAST.md` is the specification**: every rule
B1–B16 is built as written, each system action carries its rule id, and anything that seems wrong in
it is reported, not quietly changed. `TESTING.md` L4 and L5 are the proof.

**Must pass:** `TESTING.md` L2.1–L2.8 and L2.50–L2.59, L4 (all), the CLOSING column of L5, the full
L1.2 (a blast cycle in under 100 ms of real time), and L6.1's "acts on the hello snapshot within the
time left" half.

## Scope

1. **Path prediction** (`BLAST.md`, inputs): forward along the loop with duty stops from segment kinds,
   their duration and the speed after them; shared by B2 and B6.
2. **The engine** (`src/blast.ts`): evaluates on every snapshot change, on `CLOSING`, on `hello` after
   a reconnect, and on command deadlines; issues commands only through the registry, with the system
   actor's rule set to the B-rule (`system:B3` at the gateway); persists its holds and their reasons
   with the command log (B14); emits alarms in the shape of `src/alarms.ts` (`source: 'blast'`).
3. **The safety gate.** The engine provides the registry's `SafetyGate`, replacing
   `ALLOW_ALL_GATE_NO_BLAST_SAFETY`, so every command path, operators' included, passes the same check
   (L2.50–L2.53). **The swap is its own commit**: the gate implementation, the one line in
   `src/service.ts` (or wherever the service builds the registry) that installs it, removing the
   "blast safety not active" warning and banner, and nothing else. The user reads that diff before merge.
4. **Clearance** (B11): the engine owns the verdict. `src/clearance.ts` (provisional, from the UI task)
   becomes the engine's, or calls it; the UI keeps its shape. During a link drop, every zone not open is
   UNSURE (B13), and the frame carries the last verdict and its age for the UI's "was CLEAR, 12 s ago".
5. **Unconfirmable commands** (B16) need the registry: bounded retries, then "can't verify: data
   silent/frozen". Change the registry in its own commit, with the reason.
6. **Auto-resume** (B12), including `HOLD` before `RESUME` for a truck still carrying out `EXIT_ZONE`,
   and resuming a B6a truck once its lease has expired to `HOLDING`.

## The L4 run, reported before merge

Run the property tests over **200 seeds**, under **both** versions of `TESTING.md` L0.P (spec and
pessimistic), on the fake's live day plus the site variants (L4.S). Report a table, per version:

- **L4.R0** (trucks that could be got out are out), **L4.R1** (can't-clear alarm within 10 s),
  **L4.R2a** (never "clear" while believed inside), **L4.R2b** (against the truth, detectable faults),
  **L4.R3–R5** (auto-resume): passes and failures, with every failing seed listed.
- **L4.R2c** (the undetectable fault, run separately): the count of violations, not a pass/fail.
- **Metrics:** **M1** unnecessary holds, **M2** time sat after a reopen, **M3** false alarms; median and
  worst, per day.

Every failing seed goes into `test/seeds/regressions` and runs in CI from then on. A rule that fails
is reported with the seed and what happened, not loosened to pass. Do not merge; I review the numbers
with the user first.

## Ways to be wrong that matter

- A system that does nothing and alarms about everything: L4.R0 exists to fail it.
- Sending `EXIT_ZONE` to a truck you're unsure of (B1), or into another closing zone (B4).
- Trusting "the fake says so" outside the L4 oracle: the engine reads only `FleetState`.
- Hard-coding this site: L4.S runs a different one.
- Reading the wall clock: the whole L4 run must take minutes, not hours.

## Working rules

Tests first. Never the real gateway; never read `.env`. Commit as you go on your branch, one logical
change per commit, adding paths explicitly (never `git add .`/`-A`). Before starting, make sure your
branch is based on local `main`, not a stale `origin/main`. Don't push and don't merge. Another agent
is building the truck-detail screen and attention tray in parallel; stay out of `src/ui/` except what
item 4 needs, and say in your report what the UI must show that it doesn't yet.
