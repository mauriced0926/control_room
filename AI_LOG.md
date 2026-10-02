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
