# AI log

Moments that mattered while building with agents: what was asked, what came back, what was
wrong with it, how that was found, and what was done. Written as it happens, not afterwards.
Session links are collected in `AI_SESSIONS.md`.

---

## 1. The probe's printout was confidently wrong about acks

**Session:** planning session, Claude Code (Opus 5.5), 2026-10-02. Link: see `AI_SESSIONS.md`.

**Asked.** Write a throwaway command probe against the live gateway, for me to review before it
ran: nine steps (HOLD/RESUME, queued hold, EXIT_ZONE, lease expiry, manual drive, e-stop,
malformed commands, a faulted truck, a frozen truck), every command under `operator_id`
`"probe"`, with guaranteed cleanup. Context: `PROTOCOL.md` §5 on `command_id` de-duplication,
and the passive captures.

**Came back.** A probe that ran cleanly. Its S1 printout said no ack ever arrived for the first
`HOLD`, nor for the resend with the same `command_id`, nor for the reuse of that id with a
different action. The agent passed this on as a finding.

**What was wrong.** The step counted acks per `command_id` and waited for "the second ack" for
the resend and "the third" for the reuse. The first send's ack had been lost on the radio, so
the resend's `ACCEPTED` was the *first* ack for that id and the reuse's `COMMAND_ID_REUSED` was
the second. The code waited for acks that would never come and reported `None`. It also
measured "time to HOLDING" after a 10 s ack timeout, so the stop latency it printed was
meaningless.

**How it was found.** By reading the raw capture instead of the printout: every line sent and
every ack received, in order. The gateway had behaved exactly as §5 says.

**What was done.** Reported the corrected result (ack lost, command still executed in 3.2 s,
resend recovered `ACCEPTED`, reuse got `COMMAND_ID_REUSED`). Fixed the probe so `wait_ack`
returns the first ack after the *latest* send of an id, and S1 times the stop from the send.
Checked the fix by hand against the real S1 timeline. The lesson goes into the product: the
command registry correlates acks to sends by time, never by counting, because acks are lost.

---

## 2. "The battery confirms the frozen truck stopped" — it didn't

**Session:** same as entry 1.

**Asked.** Analyse three passive captures for faults the spec doesn't describe.

**Came back.** A correct detection of trucks whose position froze while they reported 3 m/s, and
a confident interpretation: their state of charge drained at about half the fleet rate, so,
since energy follows distance, "the battery agrees the truck really stopped and the speed is the
lie". This was repeated in two summaries and nearly became the confidence model.

**What was wrong.** The drain figure averaged the whole run, including the time before the
freeze. During the freeze the state of charge did not move at all: the *entire* message was
frozen, battery included. There was no second signal. The live command probe also showed the
truck was not simply parked: a `RESUME` came back `INVALID_STATE`.

**How it was found.** The reviewer asked whether the frozen-data test would also flag a truck
legitimately parked in the bay, and whether the device clock separated them. Checking that
against the captures showed the state of charge was flat across all four frozen episodes, the
device clock advances on a frozen truck (so it doesn't separate them either), and a loading
truck also sends identical messages.

**What was done.** Withdrew the battery claim. The detection rule became: reported motion that
contradicts an unchanged position, with the true position treated as anywhere the truck could
have reached. A truck that freezes while stationary is recorded as undetectable from telemetry
alone (`CONTEXT.md` assumption 12; `research/README.md`).

---

## 3. The ingest agent's checker failed the product, and the product was right

**Session:** planning session, ingest task run as a sub-agent in its own worktree, 2026-10-02.

**Asked.** Task 2 (`tasks/02-ingest.md`): ingest and fleet state, tests first, from `TESTING.md`.
The threshold test L2.26 had to run over the full captures, which aren't in the repo, so the agent
wrote it to read their paths from an environment variable, and I ran it.

**Came back.** 77 passing tests and a careful report. For L2.26 the agent built an independent
checker that shares no code with the product, which was the right instinct. Run against the
captures, it failed the product on run 2: HT-08 "flagged silent at +873 s with no genuine silence".

**What was wrong.** The checker, not the product. It discarded any gap in a truck's messages that
touched a link outage. In the raw capture the link returned at +866.7 s, heartbeats arrived every 2 s
and other trucks reported, while HT-08 stayed quiet until +896.9 s: 30 s of real silence, which the
product flagged correctly. Had I trusted the test, I would have "fixed" correct product code.

**How it was found.** By reading the raw capture around the failure instead of the assertion message:
link events, heartbeats, HT-08's messages, another truck's messages.

**What was done.** The checker now cuts outages out of each gap and judges the link-up pieces on their
own (`ae8dcf2`). L2.26 then passed on all three captures, flagging exactly the trucks found by hand.

The same review ran the other way. The agent found that my `research/trim.py` wrote the weak-pack
fixture out of arrival order, and said so rather than quietly working around it. I checked the file,
confirmed it, and fixed the script (`8250678`). An independent check is only as good as its own
definition of the truth, whoever wrote it.

---

## 4. The same ack-matching mistake, three times, by two different authors

**Session:** planning session; fake gateway run as a sub-agent in its own worktree, 2026-10-02.

**Asked.** Task 1 (`tasks/01-fake-gateway.md`): a fake gateway that gives `research/probe.py` the same
answers as the live site (L0.C2). In review, I compared the fake's acks with the live probe's.

**Came back.** The agent reported that its own probe checker had been wrong: it paired acks with
sends inside a 50 ms window, and S1's resend and reuse go out 50 ms apart, so the resend's ack was
credited to the reuse. It found this in the raw file and fixed it. Then my review comparison flagged
two S1 mismatches between the live probe and the fake.

**What was wrong.** My comparison, not the fake. It matched the nth ack of a `command_id` to its nth
send. Live, the first `HOLD`'s ack was lost, so everything after it shifted by one: exactly the
mistake in entry 1, made again by me in the review meant to catch such things. Read correctly,
the fake matches the live probe on every command of S1 and S3–S8 except the lost ack, which the
fake does not inject until milestone 2.

**How it was found.** The two "mismatches" were both on the one id with a lost ack; reading the raw
send and ack lines for that id showed the shift.

**What was done.** Recorded the corrected result in the merge commit (`54b6d26`). The lesson is that
remembering doesn't work: three pieces of code by two authors made the same mistake within a day. Ack
correlation (by time, against the latest send) belongs in one tested place, the command registry
(`TESTING.md` L2.33), and every later tool that reads acks uses it rather than rewriting it.

---

## 5. A fixture that left out the evidence, read wrong twice

**Session:** planning session; fake gateway milestone 2 run as a sub-agent, 2026-10-03.

**Asked.** Milestone 2 of the fake gateway (`tasks/01b-fake-gateway-m2.md`): fault injectors that
reproduce the live fixtures, checked by running `research/report.py` over both (L0.C1).

**Came back.** All tests passing, and a report that the research disagreed with the fake in three
places. One: the re-probe's R1 fixture "is more than a silent truck": no heartbeats for 26 s while the
connection stayed open. The agent built a "link stall" injector to reproduce it.

**What was wrong.** Both readings of R1. I had written it up as the truck going silent for 41 s. The
agent read it as a stalled link. The raw log has HT-04 quiet for ~15 s while the link was up, then
the gateway closing the connection and refusing logins for ~25 s. The fixture I cut had kept HT-04's
messages and the heartbeats but not the connection events, so the drop was invisible in it. My
trimming decided what both of us could see. The agent's two other claims were right: my loss figures
for runs 2 and 3 were too low, because I measured outages between heartbeats, which overshoot; and my
`report.py` crashed on the weak-pack fixture.

**How it was found.** By going back to the full re-probe log, not the fixture: link events,
heartbeats and every truck's telemetry across the gap.

**What was done.** The fixture now includes link events; the conformance test models a link drop that
ends before the fifth reconnect, as live; the stall injector stays, marked as not seen live; the loss
figures and `report.py` are fixed (`4531e4c`, `e007d97`). A fixture is a claim about what matters in a
recording. Cutting it narrowly hides the context that would show the claim is wrong.

---

## 6. Right in every test, wrong in production: the client address behind the proxy

**Session:** main session, deploying to the OCI box, 2026-10-04.

**Asked.** Task 6b (`tasks/06b-server.md`): the service, operator login and live updates. The agent
added login throttling per client address, and anticipated a reverse proxy: it trusted
`X-Forwarded-For` when the connection came from loopback.

**Came back.** All tests passing, including the throttling tests, and a careful security write-up.

**What was wrong.** The deployment, not the code as tested. Behind Caddy and Docker, the proxied
connection reaches the container from Docker's bridge gateway, not loopback, so the forwarded address
was ignored and every login appeared to come from `172.18.0.1`. Throttling per address would then have
locked every operator out for 15 minutes after any five wrong passwords, graders included.

**How it was found.** By reading the service's own log after the first real login through the proxy,
not by any test: the address on the login line was the bridge's.

**What was done.** `TRUST_PROXY` trusts the proxy's last `X-Forwarded-For` entry from any peer; compose
sets it, which is safe only because compose publishes on `127.0.0.1`, so nothing but the host can reach
the port (`91672f6`). Redeployed, and checked in the production log that a login through the proxy now
carries the real client address. The tests ran the service as a developer would, on loopback; the box
runs it as an operator would. A deploy is a test with different assumptions, and its log is evidence.
