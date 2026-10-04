# control_room

## Running the service

Node 24.15 or later. From a fresh clone:

```sh
npm ci
GATEWAY_HOST=… GATEWAY_PORT=… GATEWAY_EMAIL=… npm start
```

Then open <http://127.0.0.1:8090/> and log in. One process holds the one gateway connection, the fleet
state, the command log and the HTTP server; any number of browsers connect to it.

| Variable | Required | Default | |
|---|---|---|---|
| `GATEWAY_HOST`, `GATEWAY_PORT`, `GATEWAY_EMAIL` | yes | | the site gateway |
| `PORT` | no | `8090` | 8080 is taken on the deploy box |
| `HOST` | no | `127.0.0.1` | the address to listen on; put a TLS proxy in front for anything else |
| `PUBLIC_ORIGIN` | no | | comma-separated origins browsers use when not on 127.0.0.1/localhost, e.g. `https://cr.example.com` |
| `DATA_DIR` | no | `data` | where the SQLite command and audit log is kept |
| `USERS_FILE` | no | `config/users.demo.json` | the operators; see below |

Blast safety is **not active** in this build yet: the service says so at start-up.

### Demo logins

These are **demo credentials**, for evaluating this build. Anyone who reads this file can log in with
them. Replace `config/users.demo.json` (or point `USERS_FILE` at your own file) before real use; make
each hash with `node src/users.ts hash`, which reads the password from stdin. The users file holds
only scrypt hashes, never passwords.

| User | Role | Password |
|---|---|---|
| `priya` | operator | `haul-priya-demo` |
| `dave` | operator | `haul-dave-demo` |
| `marta` | supervisor | `haul-marta-demo` |

## Tests

```sh
npm test               # fast
npm run test:slow      # the service end to end against the fake gateway over TLS, and throughput
npm run test:browser   # real Chrome through playwright-core
npm run typecheck
```

The end-to-end and browser tests start the fake gateway (`fake/`) on 127.0.0.1 with a throwaway
certificate made by `openssl` at test time. They never connect to the real gateway.
