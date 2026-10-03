# Task 6b: the service, operator login, and live updates to the browser

**Goal.** One process that starts with one command, connects to the site, and serves the operators'
screen live: the same Overview the fixture player shows, now fed by the real link, the fleet state and
the command registry, to two or more logged-in operators at once. The browser never talks to the
gateway, never holds the only copy of anything, and never supplies anyone's identity.

**Read first:** `CLAUDE.md` and everything it lists; `UI.md`; `BLAST.md` (only to know what's coming:
the blast engine plugs in later as the registry's `SafetyGate` and a source of alarms). The pieces you
wire together exist: `src/link.ts` (`GatewayLink`, `linkConfigFromEnv`, `attachRegistry`),
`src/registry.ts`, `src/store.ts`, `src/fleet.ts`, `src/ui/*` and `player/`.

**Must pass:** `TESTING.md` L6.3–L6.5 (L6.3's drive half waits for the driving task: test that no drive
path exists yet, or that it refuses), L8.2, L8.3 and L8.6 end to end through the server, L9.2 and L9.3
against the running service, and L13.1's "starts with only the three `GATEWAY_*` variables and no
Anthropic key" (outside Docker for now).

## Scope

1. **Entry point:** `npm start` runs `src/main.ts`. It reads `GATEWAY_HOST`, `GATEWAY_PORT`,
   `GATEWAY_EMAIL` (required), and `PORT` (default 8090; 8080 is taken on the deploy box), `HOST`
   (default 127.0.0.1), `DATA_DIR` (SQLite), `USERS_FILE` (optional). A missing variable is named in the
   error; no value is ever printed. It starts the link, fleet state, registry (with the existing
   allow-all gate, clearly logged at start-up as "blast safety not active"), and the HTTP server.
2. **Operators and login.** A hard-coded user list is acceptable (`BRIEF.md`). Users have a role,
   `operator` or `supervisor`. Passwords are stored as scrypt hashes (`node:crypto`), never in plain
   text, in a users file; ship a demo file with three users (two operators, one supervisor) whose demo
   passwords are written down for the graders in one place, and say plainly that they are demo
   credentials to be replaced. Sessions: a random id in an `HttpOnly`, `SameSite=Strict` cookie, held
   in memory, with an idle timeout; logout ends it. Every route and the live connection refuse an
   unauthenticated request (L8.6). Log in and out go in the audit log.
3. **Live updates.** A WebSocket per browser (use the `ws` package at an exact version, or explain the
   alternative you chose). The server pushes the snapshot (fleet, zones, link status, open commands,
   leases, alarms) on change, rate-limited to what a person can read, and a heartbeat so the browser can
   say "service disconnected" (L9.3). Check the `Origin` header against the server's own. One gateway
   connection whatever the number of browsers (L6.4).
4. **Commands from the browser.** Messages carry an action and a truck; the server takes the operator
   from the session (L8.3) and submits to the registry. Malformed or hostile messages are refused and
   logged, never crash the service (L6.5). Wire the always-on **e-stop** for real, including its pending
   state while the link is down (L7.8); other command buttons can wait for the truck-detail screen, but
   the path must exist and be tested.
5. **Who's on** (`UI.md`): the operators connected and their roles, and who holds which lease.
6. **The Overview, live.** Reuse `src/ui/*`; the player and the live service feed it the same snapshot
   shape. Keep the player working.

## Ways to be wrong that matter

- Taking `operator_id` from anything the browser sends.
- A route or socket that works without a session.
- A browser that can make the service open a second gateway connection.
- A browser that stops hearing from the service but keeps showing a current-looking picture.
- Logging a password, a session id or `GATEWAY_EMAIL`.
- Reading the wall clock outside `src/clock.ts`.

## Working rules

Tests first. End-to-end tests run the real service against the fake gateway over TLS (`fake/tls.ts`,
`--day live` in `fake/main.ts`), never the real gateway; never read `.env`. Commit as you go on your
branch, one logical change per commit, adding paths explicitly (never `git add .`/`-A`). Before starting,
make sure your branch is based on local `main`, not a stale `origin/main`. Don't push and don't merge;
I review, merge and push. Finish with: what passes, what doesn't, how to start it, the demo credentials
and where they're written, every security choice you made and why, and what you'd change before a real
mine used it.
