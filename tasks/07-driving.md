# Task 7: remote driving

**Goal.** An operator takes control of a truck and drives it along the route from the browser with the
keyboard, then hands it back. The graders will do exactly this, and so will a novice. Driving from the
desk is "slow and you're nervous; the worst part is not knowing if it's lagging until it's too late"
(Dave, `OPERATOR_NOTES.md`). This is the screen that answers him.

**Read first:** `CLAUDE.md` and everything it lists; `PROTOCOL.md` §6 closely; `UI.md` screen 3
("Driving") and the always-on e-stop; `research/README.md` on the drive probe (S5: echo age 200–620 ms
as a round trip, send gaps 100–106 ms, deadman never tripped at 10 Hz). Existing code: `src/registry.ts`
(`TAKE_CONTROL` / `RELEASE_CONTROL`, leases), `src/link.ts` (`sendDrive`, which refuses while the link
is down and queues nothing), `src/live.ts` and `src/http.ts` (the WebSocket and its limits),
`src/ui/*` including truck detail and its Take control button.

**Must pass:** `TESTING.md` L6.3 (browser drops mid-drive: the truck stops on its deadman and the service
sends nothing more), L7.1–L7.7, L7.9, L9.4 (stuck key, in Playwright) and L9.5 (hand-back), end to end
against the fake gateway.

## Scope

1. **The drive relay** in the service. Invariant 3: drive input is relayed only while fresh and never
   re-sent or synthesised. The browser sends input messages; the service forwards each one at once as a
   `drive` message with the lease from the registry, a `seq` it keeps strictly increasing per lease, and
   `sent_ms`; it drops input that is out of order, from a session that doesn't hold the lease, or too
   large to be a throttle. If input stops, nothing goes out, and the truck's own deadman stops it.
   Rate-limit to 20 Hz per lease. Never queue drive input across a link drop.
2. **Keyboard only.** Hold to drive forward, hold another key to reverse, release to stop; a throttle
   the operator can step down for care. While driving, the browser streams input at 10 Hz, including
   throttle 0 when no key is held, so the lease stays alive while the operator thinks. On blur or when
   the page is hidden it sends throttle 0 once and stops streaming (L7.5); the deadman then holds the
   truck, and the lease expires after 10 s if they don't come back.
3. **The driving view** (`UI.md`): a **lag meter** with input age and echo age (from
   `control.last_drive_sent_ms`), the deadman threshold marked; **deadman state** in words; speed and
   direction; distance to the next zone boundary in the direction of travel, with that zone's status.
4. **Never into a closed zone; always out** (L7.6). The relay refuses throttle that would carry the truck
   across a boundary into a zone that is `CLOSED`, or `CLOSING` and it can't clear, within its stopping
   distance plus telemetry age, and says so on screen. Driving out of such a zone is never refused,
   whichever way. This check sits in the service, not only the browser.
5. **Limp-home and tow** (L7.7): a limp-home truck shows its 1.0 m/s limit; a `BATTERY_DEPLETED` truck
   says "needs a tow" and Take control is not offered.
6. **Hand-back** (L7.9, L9.5): Release, then Resume, as two obvious steps. After release the truck shows
   "held by you: Resume" until someone resumes it. A forced takeover (L7.3) tells the first driver who
   took it, and their input is refused from then on; e-stop wins while anyone drives (L7.4).
7. **Interplay with the blast engine**, which may be merged by then: a truck the system has taken under
   `BLAST.md` B6a shows its lease as `system:B6a` until it expires; an operator must force-take it, and
   the screen says why the system has it.

## Ways to be wrong that matter

- The service sending a drive message the browser didn't just send: a dropped browser must stop the truck.
- A held key that keeps a truck moving after the window loses focus.
- A lag meter that measures the wrong thing. Echo age is a round trip plus up to 200 ms of telemetry
  sampling; say what each number is.
- Refusing to drive *out* of a closed zone. Limp-home may be the only way out.

## Working rules

Tests first; Playwright with real keyboard events against the running service on the fake gateway.
Never the real gateway; never read `.env`. Commit as you go on your branch, one logical change per
commit, adding paths explicitly (never `git add .`/`-A`). Before starting, make sure your branch is
based on local `main`, not a stale `origin/main`. Don't push and don't merge. Finish with: what passes,
screenshots of the driving view (look at them before describing them), the lag you measured against
the fake and how, and what a novice stumbled on if you can tell.
