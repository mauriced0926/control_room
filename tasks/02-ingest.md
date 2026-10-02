# Task 2: ingest and fleet state

**Goal.** Turn the gateway's unreliable stream into a fleet picture that never shows a guess as a
fact: what each truck last reported, how sure we are, and where it could be. Everything downstream
(blast engine, UI, alerts) reads this.

**Read first:** `CLAUDE.md`, then everything it lists. `research/fixtures/` is the real data; replay
it rather than inventing cases. `UI.md`'s states table is what the operator will see from your output.

**Must pass:** `TESTING.md` L2.1–L2.6 (geometry and reachable sets), L2.10–L2.17 (ingest per fault
class), L2.20–L2.23 (restart versus duplicate), L2.24–L2.26 (frozen detection and the thresholds over
the full captures), L2.27–L2.28 (battery), and L3.1–L3.5, L3.8, L3.10 (fixture replay). L2.7–L2.8
belong to the blast engine; L3.6–L3.7 need the command registry; L3.9 needs the gateway link.

## Scope

In `src/`, using `src/clock.ts`, `src/protocol.ts`, `src/site.ts` and `src/params.ts` as they are. If
one of them needs to change, make that a separate commit and say why.

1. **Parse and validate** one line at a time: truncated or non-JSON lines are dropped and counted;
   unknown `type`s are ignored; each telemetry field is validated on its own, so one bad field makes
   that field unknown (keeping its last known value and age) without discarding the message. Every
   repair or rejection is a data-quality event, counted per truck and per kind.
2. **Ordering:** per-truck controller runs. Duplicates dropped; older messages never overwrite newer
   state; a large `seq` drop while `t_device_ms` moves forward starts a new run (`seq-reset`).
3. **Time:** ages against server time, estimated from `server_time_ms` on heartbeats and other
   messages plus the injected clock. Never from `t_device_ms`; that is shown only as per-truck skew.
4. **Confidence per truck:** live, old, silent or contradicted, using the thresholds in `params.ts`
   (owned by this task; change them only with L2.26 re-run over the full captures). A frozen or silent
   truck has a **reachable range** on the loop: everywhere it could have got to since its last
   believable position, at the speeds it could have had. Ranges wrap.
5. **Battery:** SoC is shown as the pack reports it, flagged when fractional, never scaled. Drain rate
   per truck against the fleet median; whether the truck can reach the bay by the shorter direction on
   what it has, at its own drain rate.
6. **Zones:** current status of every zone from `hello` and `zone_event`s, with `effective_at_ms`.
7. **Output:** a fleet-state object the blast engine and UI can read, plus an event stream of changes
   and data-quality events. Keep it plain data so the UI's fixture player can use it directly.

L2.26 needs the full captures, which aren't committed. Write the test to read paths from
`DLH_CAPTURES` and skip when unset; I will run it against the captures and report the result.

## Ways to be wrong that matter

- Flagging a loading, held or parked truck as frozen. The negatives (L2.25a–d) matter as much.
- Scaling a fractional SoC, or using `t_device_ms` for anything but skew.
- A frozen truck's range that doesn't widen with time.
- Hard-coding anything from this site (L1.3 will fail the build).
- Trusting your own printout. Check claims against the fixture files.

## Working rules

Tests first. Commit as you go on your worktree branch, one logical change per commit, adding paths
explicitly (never `git add .`/`-A`), with the attribution line from the repository's existing commits.
Don't push and don't merge; I review and merge. Finish with: what passes, what doesn't, every
threshold or rule you chose and why, and anything in the fixtures that surprised you.
