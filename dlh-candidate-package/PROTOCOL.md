# Site Link Protocol 3.0

Deep Level Haulage, site DLH-1

This is the interface to the site gateway. On the real site, the gateway is the box at the portal that bridges the underground radio network to the control room. For this exercise, the simulator plays the gateway, the radio network and the vehicles.

## 1. Transport

- **TCP with TLS**, one connection per client. Several clients may connect at the same time with the same email. They share one site, and every client receives every broadcast message.
- **Newline-delimited JSON (NDJSON)** in both directions. Each message is one JSON object on one line, UTF-8, terminated by `\n`. The maximum line length is 64 KiB.
- **Authenticate first** (section 1.1). The gateway sends `hello` once you have authenticated.
- The gateway disconnects any client that falls more than about 4 MB behind on reading.
- The radio network is not reliable. Messages can be delayed, lost, duplicated or reordered, and the whole site link can drop. The gateway does not queue anything for a disconnected client.

### 1.1 Logging in

The first line you send on every connection must be:

```json
{"type":"auth","email":"you@example.com"}
```

- `email` is the address you applied with. It identifies you; there's no password.
- **Your site.** Every email has one site: a running copy of the mine, with its trucks, faults and blasting schedule. Every connection with your email joins that same site.
- **A fresh day.** When your site starts (your first connection, or after about 30 minutes with nothing connected), it starts a new random day. Which trucks misbehave, when blasts happen and when the link drops all change. Build for that, not for one particular day.
- On success the gateway replies with `hello` (section 4.1), which includes `"site": {"name": "<your email>"}`.
- On failure it replies once, then closes the connection:

  ```json
  {"type":"auth_error","reason":"BAD_EMAIL"}
  ```

  | Reason | Meaning |
  |---|---|
  | `AUTH_REQUIRED` | The first line wasn't a login message. |
  | `AUTH_TIMEOUT` | Nothing was sent within 10 s. |
  | `BAD_AUTH` | The first line wasn't valid JSON. |
  | `BAD_EMAIL` | The email field is missing or isn't an email address. |
  | `TOO_MANY_CONNECTIONS` | More than 16 connections to one site. |
  | `SERVER_FULL` | Try again shortly. |

- During a site link outage (section 1), the gateway accepts the login and then closes the connection before sending `hello`. Retry with backoff.

## 2. Time

- `server_time_ms` is the gateway's clock in Unix milliseconds. It is NTP-disciplined and is the only authoritative clock on site.
- `t_device_ms` is the vehicle controller's clock. Vehicle clocks are **not** disciplined.

## 3. Site geometry

The haul route is a single one-way loop, 1600 m long. Position is measured in metres along the loop, and `hello.route` gives every segment's `start_m` and `length_m`. Vehicles in autonomous mode travel forward (increasing position) and wrap from the end of `SEG-TIP-1` back to `SEG-BAY`.

| Segment | Zone | Start m | Length m | Kind |
|---|---|---|---|---|
| SEG-BAY | BAY | 0 | 80 | bay (parking and charging) |
| SEG-DEC-1 | DECLINE | 80 | 250 | transit |
| SEG-DEC-2 | DECLINE | 330 | 250 | transit |
| SEG-L4N-1 | L4_NORTH | 580 | 200 | transit |
| SEG-DRAW-12 | DRAW_12 | 780 | 60 | load (draw point) |
| SEG-L4S-1 | L4_SOUTH | 840 | 200 | transit |
| SEG-INC-1 | INCLINE | 1040 | 250 | transit |
| SEG-INC-2 | INCLINE | 1290 | 250 | transit |
| SEG-TIP-1 | TIP | 1540 | 60 | dump |

The autonomous duty cycle works like this:
- An empty vehicle that reaches the end of `SEG-DRAW-12` loads for about 20 s.
- A loaded vehicle that reaches the end of `SEG-TIP-1` dumps for about 12 s.
- A vehicle below 25 % state of charge that reaches the end of `SEG-BAY` charges to 90 %.

Nominal speeds:

| Mode | Empty | Loaded |
|---|---|---|
| Autonomous | 3.0 m/s | 2.0 m/s |
| Manual, at full throttle | 4.0 m/s | 3.0 m/s |

Energy use is roughly proportional to distance travelled, and higher when loaded.

## 4. Messages from the gateway

### 4.1 `hello`

The gateway sends this once per connection.

```json
{"type":"hello","protocol":"3.0","site_id":"DLH-1","server_time_ms":1790000000000,
 "vehicles":["HT-01","HT-02"],
 "route":[{"segment_id":"SEG-BAY","zone_id":"BAY","length_m":80.0,"kind":"bay","start_m":0.0}],
 "loop_length_m":1600.0,
 "zones":[{"zone_id":"DECLINE","status":"CLOSING","effective_at_ms":1790000090000,"reason":"BLAST_WINDOW"}],
 "leases":[{"vehicle_id":"HT-04","operator_id":"jsmith"}]}
```

`zones` and `leases` describe the state of the site when you connected.

### 4.2 `telemetry`

Each vehicle sends telemetry at about 5 Hz.

```json
{"type":"telemetry","vehicle_id":"HT-03","seq":1842,"t_device_ms":1790000001234,
 "state":"TRAMMING","task":null,"soc_pct":63.1,"speed_mps":2.0,"direction":"FWD",
 "segment_id":"SEG-L4S-1","zone_id":"L4_SOUTH","offset_m":112.4,"payload_kg":42000.0,
 "faults":[],
 "control":{"mode":"AUTO","operator_id":null,"deadman":false,
            "last_drive_seq":null,"last_drive_sent_ms":null}}
```

| Field | Meaning |
|---|---|
| `seq` | Per-vehicle message counter, incremented by the vehicle controller. |
| `state` | One of `TRAMMING`, `LOADING`, `DUMPING`, `CHARGING`, `HOLDING`, `IDLE`, `MANUAL`, `ESTOPPED`, `FAULT`. |
| `task` | `null`, `RETURN_TO_BAY` or `EXIT_ZONE`. This is the supervisory task the vehicle is executing. |
| `soc_pct` | Battery state of charge, 0 to 100. |
| `speed_mps`, `direction` | Speed magnitude and direction of travel (`FWD` or `REV`). |
| `offset_m` | Metres from the start of `segment_id`. |
| `control.mode` | `AUTO` or `MANUAL`. |
| `control.operator_id` | Operator holding the control lease, if any. |
| `control.deadman` | `true` when a leased vehicle has stopped because no fresh drive input arrived. |
| `control.last_drive_seq`, `control.last_drive_sent_ms` | Echo of the last drive message the vehicle applied (section 6). |

### 4.3 `heartbeat`

The gateway sends this every 2 s: `{"type":"heartbeat","server_time_ms":...}`

### 4.4 `zone_event`

```json
{"type":"zone_event","zone_id":"INCLINE","status":"CLOSING","reason":"BLAST_WINDOW",
 "effective_at_ms":1790000120000,"server_time_ms":1790000000000}
```

A zone moves through `OPEN` → `CLOSING` → `CLOSED` → `OPEN` (reason `CLEARED`). A `CLOSING` zone can also go straight back to `OPEN` with reason `CANCELLED`. Closures are scheduled by the site's blasting crew, not by you. **Site rule: no vehicle may be inside a zone while it is CLOSED.** The vehicles do not know about zones. Enforcing the rule is the control room's job.

### 4.5 `command_ack`

```json
{"type":"command_ack","command_id":"...","vehicle_id":"HT-03","status":"ACCEPTED",
 "server_time_ms":1790000000500}
```

- Acks are broadcast to every connected client, like everything else.
- The ack and the vehicle's telemetry travel independently. Either can arrive first.
- If the `command_id` itself is missing or the line can't be parsed, the ack carries `command_id` `"<missing>"` or `"<unparseable>"`.
- `status` is `ACCEPTED` or `REJECTED`.
- `ACCEPTED` means the vehicle controller has received the command and queued it for execution.
- `REJECTED` includes a `reason`, and for `LEASE_HELD` also includes `holder`.
- A `TAKE_CONTROL` that is accepted includes `lease_id`, `lease_idle_timeout_ms` and `deadman_ms`.

| Reason | Meaning |
|---|---|
| `BAD_COMMAND_ID` | Missing or invalid `command_id`. |
| `BAD_JSON` | Unparseable line. |
| `MISSING_OPERATOR` | No `operator_id`. |
| `UNKNOWN_VEHICLE` | `vehicle_id` is not on the roster. |
| `UNSUPPORTED_ACTION` | Unknown action. |
| `INTERLOCK_ACTIVE` | The vehicle has a fault (see `faults`). Only `ESTOP` is accepted, plus `TAKE_CONTROL`/`RELEASE_CONTROL` if the fault allows limp-home driving (section 6), and `CLEAR_ESTOP` if the vehicle is e-stopped. A fault cannot be cleared from the control room. |
| `ESTOP_ACTIVE` | The vehicle is e-stopped. Only `ESTOP` and `CLEAR_ESTOP` are accepted. |
| `LEASE_HELD` | Another operator holds manual control. |
| `NOT_LEASE_HOLDER` | `RELEASE_CONTROL` was sent with the wrong `lease_id`. |
| `INVALID_STATE` | The action does not apply to the vehicle's current state. |
| `COMMAND_ID_REUSED` | This `command_id` was already used with a different payload. |

### 4.6 `lease_event`

```json
{"type":"lease_event","vehicle_id":"HT-04","event":"REVOKED","lease_id":"L-00012-9f3a",
 "operator_id":"jsmith","reason":"FORCED_TAKEOVER","by_operator":"mlee","server_time_ms":...}
```

`event` is one of:
- `GRANTED` (includes `forced`)
- `RELEASED`
- `EXPIRED` (reason `NO_DRIVE_INPUT`)
- `REVOKED` (reason `FORCED_TAKEOVER`, `ESTOP` or `FAULT`)

### 4.7 `drive_rejected`

```json
{"type":"drive_rejected","vehicle_id":"HT-04","lease_id":"L-...","reason":"NO_ACTIVE_LEASE","server_time_ms":...}
```

`reason` is one of `NO_ACTIVE_LEASE`, `BAD_THROTTLE`, `BAD_SEQ` or `UNKNOWN_VEHICLE`. The gateway sends at most one per vehicle per reason per second.

## 5. Commands

```json
{"type":"command","command_id":"6f1c...","vehicle_id":"HT-03","action":"HOLD","operator_id":"jsmith"}
```

- `command_id` is chosen by the client, is unique per command, and is at most 128 characters. The gateway de-duplicates on it. Resending the same `command_id` with the same payload returns the original result and does not execute the command again.
- `operator_id` is required. It is recorded in the site's statutory log.

| Action | Extra fields | Effect |
|---|---|---|
| `HOLD` | | Stop in place. |
| `RESUME` | | Resume the autonomous duty cycle from `HOLDING` or `IDLE`. If a command is queued (see below), RESUME cancels it instead. Otherwise it is rejected with `INVALID_STATE`. |
| `RETURN_TO_BAY` | | Drive to the bay by the shorter direction, charge to 90 %, then park `IDLE`. If the vehicle is already charging, it finishes charging and parks `IDLE`. |
| `EXIT_ZONE` | | Leave the zone the vehicle was in **when the command was accepted**. It drives to that zone's nearest boundary (forward or reverse), stops about 2 m outside it, and holds. If the vehicle has already left that zone by the time the command takes effect, it simply holds where it is. Rejected with `INVALID_STATE` in `BAY`. |
| `TAKE_CONTROL` | `force` (JSON `true`, optional) | Take manual control (section 6). `force: true` revokes another operator's lease. Taking control interrupts loading, dumping or charging. |
| `RELEASE_CONTROL` | `lease_id` | Release manual control. The vehicle holds. |
| `ESTOP` | | Emergency stop. Accepted in every state, including while another operator holds the lease. Revokes any lease. |
| `CLEAR_ESTOP` | | Leave `ESTOPPED`. The vehicle holds. |

While a lease is held, the supervisory actions `HOLD`, `RESUME`, `RETURN_TO_BAY` and `EXIT_ZONE` are rejected with `LEASE_HELD`.

**Queuing.** A vehicle that is `LOADING` (about 20 s), `DUMPING` (about 12 s) or `CHARGING` finishes that work before it executes `HOLD`, `RETURN_TO_BAY` or `EXIT_ZONE`. The command is queued, and only one command can be queued at a time: a newer one replaces the older one.

Supervisory commands normally take effect 1 to 6 seconds after they are accepted. Lease operations and `ESTOP` take effect as soon as the vehicle receives them.

## 6. Manual control

1. Send `TAKE_CONTROL`. If it is accepted, the ack carries `lease_id`. The vehicle enters `MANUAL`, stops, and waits for drive input.
2. Stream drive messages:

   ```json
   {"type":"drive","vehicle_id":"HT-04","lease_id":"L-00012-9f3a","seq":1,"throttle":0.6,"sent_ms":1790000000000}
   ```

   - `throttle` runs from -1.0 to 1.0. Positive means forward along the loop, negative means reverse, and 0 means stop.
   - `seq` is an integer that must increase with every message within a lease, starting at 1 or higher. The vehicle applies a drive message only if its `seq` is higher than the last one applied. Anything else is discarded.
   - `sent_ms` is optional. The vehicle echoes it back in telemetry as `control.last_drive_sent_ms`.
   - Drive messages are not acknowledged. Telemetry is the feedback channel.
   - The throttle is not rate-limited. Stream at 10 to 20 Hz.
3. **Deadman.** If the vehicle receives no fresh drive message for 500 ms, it stops and reports `control.deadman: true`. It moves again as soon as fresh input arrives.
4. **Lease idle timeout.** If the vehicle receives no fresh drive message for 10 s, the lease expires (`lease_event` `EXPIRED`) and the vehicle holds. It does **not** return to autonomous operation by itself.
5. Only one operator holds a vehicle's lease at a time. A second `TAKE_CONTROL` from the operator who already holds the lease returns the existing lease.
6. **Limp home.** Some faults still allow manual driving at a reduced speed of 1.0 m/s. `HYD_PRESSURE_LOW` does; `BATTERY_DEPLETED` does not, and that truck needs a tow.
   - A faulted truck under manual control reports `state: MANUAL` and keeps its `faults` list.
   - When manual control ends (release, expiry or e-stop clear), it returns to `FAULT`, not `HOLDING`.
   - Supervisory commands stay rejected with `INTERLOCK_ACTIVE`.

Vehicles have no collision sensing and no knowledge of zones, in either mode.

## 7. Other behavior

- Messages with an unknown `type` are ignored.
- A line longer than 64 KiB closes the connection.

## 8. Connecting

We host the gateway:

| | |
|---|---|
| Host | `dlh-gateway.fly.dev` |
| Port | `443` |
| TLS | Yes, with a standard publicly trusted certificate |
| Login | Your email address, in the auth message |

- Quick check from a terminal:

  ```
  openssl s_client -quiet -connect dlh-gateway.fly.dev:443
  ```

  Then paste `{"type":"auth","email":"you@example.com"}` and press Enter.
- We run your system against sites of our own that you won't have seen.
- **Your system must read `GATEWAY_HOST`, `GATEWAY_PORT` and `GATEWAY_EMAIL` from environment variables.** We point it at our own sites by giving it a different address.
- **The gateway logs all traffic from your email address.** We may look at how your system behaved during development.
