# Deep Level Haulage: Control Room Platform

## The situation

An underground mine runs a fleet of twelve autonomous battery-electric haul trucks. They carry rock (ore) from deep in the mine up to a dumping point, around a single one-way loop of tunnel about 1.6 km long. On each lap, a truck:
1. Starts at the **bay**, where trucks park and recharge.
2. Drives down a sloping tunnel (the **decline**) to the lower level.
3. Follows the level's tunnels (**L4 North**) to the **draw point**, where it is loaded with ore.
4. Carries the load along **L4 South** and up a second sloping tunnel (the **incline**).
5. Empties the load at the **tip**, then returns to the bay and starts the next lap.

Each of these stretches is a named zone in `PROTOCOL.md` §3.

The trucks operate themselves. People in a control room on the surface supervise them. These operators need to see what every truck is doing, step in when something is wrong, and sometimes drive a truck by hand from their desk. When a truck breaks down in a tunnel, the operator has to drive it back to the bay.

Several times a shift, the blasting crew closes a section of tunnel for a blast, with about two minutes' notice. **No truck may be inside a closed section.** (The blasting crew keeps people out of the area; that's not your concern here.) The trucks don't know about blasts, so keeping them out falls to the control room.

Two things make this harder than it sounds:
- **The radio network is unreliable.** Messages from the trucks can arrive late, out of order, twice or not at all, and the whole connection to the site sometimes drops.
- **The trucks' data isn't always right.** Some of what they report will be wrong, inconsistent or incomplete. Part of the job is noticing when, and deciding what to do about it.

You are building the control room's software: the first version the operators will actually use.

## What we're looking for

We're hiring a product-minded engineer who builds with AI agents. We'll look at five things. All of them matter:

1. **How you build with AI.** Using AI coding tools and agents is **required**. Speed matters, and so does knowing exactly what you shipped. Show us how you plan with an agent, what context you give it, how you catch it when it's wrong, and how you test.
2. **How you understand the problem.** Who is this for, what do they actually need, and what did you ask to find out?
3. **The operator's experience.** You don't need to be a designer. But an operator should be able to tell at a glance what's happening and what to do next, and should find the tool pleasant enough to use for a 12-hour shift.
4. **How you handle things going wrong.** Unreliable data, commands that don't work, a link that drops. Does your system notice, and does it tell the operator clearly? Have you thought about what happens at scale, and about security, even where you haven't built for them?
5. **Your trade-offs.** Where you spent your time, what you kept simple, what you left out, and why.

## What you get

- `OPERATOR_NOTES.md`: notes from conversations with the people who will use this. Read these before you read the spec.
- `PROTOCOL.md`: the gateway interface specification.
- **A hosted site simulator** that plays the radio network, the vehicles and the blasting schedule. We run it, and you connect with your email address. Connection details are in `PROTOCOL.md` §8.

- **Questions.** Send them to jon.seitel@gmail.com. We answer within one business day, and anyone who asks the same question gets the same answer. Asking is encouraged. What you ask tells us how you think.

## The minimum the operators need

1. **Live fleet picture.** Every truck's state, position, charge and control mode, presented so an operator can trust it. Where the system isn't sure, it should say so.
2. **Supervisory commands.** An operator can send `HOLD`, `RESUME`, `RETURN_TO_BAY` and `EXIT_ZONE` to a truck and see clearly what actually happened.
3. **Remote driving.** An operator can take control of a truck and drive it along the route from a browser, using keyboard or gamepad, then hand it back.
4. **Emergency stop.** Any operator can stop any truck immediately, whatever else is going on.
5. **Blast safety.** No truck is inside a zone while it is `CLOSED`, including when nobody is watching the screen.
6. **More than one operator.** At least two operators can use the system at the same time. Every command is attributable: to an authenticated operator, or, for commands your system sends on its own, to the system and the rule that triggered it. How you authenticate operators is up to you; a hard-coded user list is acceptable.
7. **Resilience.** The site link will drop. Your system should recover on its own, and operators should never be misled about what they are looking at while it is down.

That's the floor. Beyond it, what you build is your call, based on what you learn about the operators.

**Keep it small.** We would rather see a focused system that is right, clear and well-tested than a broad one. The written deliverables below are short on purpose. Most of them fall out of working normally with an agent.

Use any language, framework, libraries and infrastructure you like.

## What to send us

A git repository, as a link or a bundle. **Commit as you go and keep the history.** We read it: it shows how you and your agents worked.

It should contain:

1. **The code.** It should start with a single command, and `docker compose up` is ideal. It must take the gateway connection from the `GATEWAY_HOST`, `GATEWAY_PORT` and `GATEWAY_EMAIL` environment variables. Tell us which port to open and which credentials to use.
2. **`PLAN.md`**, written **before** you start building, then left as it was. It covers:
   - who the users are and what they need, in your words;
   - the questions you asked us, and what you'd still ask;
   - what the MVP is, and what it deliberately isn't;
   - how you broke the work down for yourself and your agents.

   Add a short section at the end, written when you've finished, on what changed from the plan and why.

   One page is plenty. **Don't wait for answers to your questions before you start.** List them as open, make an assumption, and record in the final section what the answers changed.
3. **Your agent context,** kept in the repo as you used it: instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules` or similar), specs, task breakdowns, prompts you reused. We want to see how you set your agents up to succeed.
4. **`AI_LOG.md`.** Not a transcript. Five to ten entries, each on a moment that mattered:
   - what you asked the agent to do and what context you gave it;
   - what came back;
   - **what was wrong with it, how you found out** (a test, the simulator, reading the code, using the UI), **and what you did about it.**

   Include at least one case where the agent was confidently wrong. Link each entry to the session it came from.
5. **Links to your AI sessions.** List them in `AI_SESSIONS.md`: share links for your Claude, Codex or other agent sessions, covering the whole build. We read them to see how you actually worked with the agents.
   - Check that we can open each link without signing in to your account.
   - If a tool can't share a link, export the transcript into an `ai-sessions/` folder instead.
   - Remove secrets (API keys, passwords) before sharing.
   - We won't judge the messy parts. Dead ends and corrections are expected, and often the most useful thing to see.
6. **`README.md`**, covering:
   1. How to run it, and how to run the tests.
   2. **A walkthrough for a new operator**: the handful of things they'll do most, in their words, not yours. Screenshots welcome.
   3. Your architecture, in one diagram and a few paragraphs.
   4. **What you found wrong with the data, the link and the commands, and how the system and the operator deal with each.**
   5. The blast-safety rule: how your system enforces it, and the cases where it can't.
   6. How an operator would know if your system was showing them something untrue.
   7. What you tested and why, including how you tested failure behavior.
   8. **Decision log:** your five most important decisions. **At least one must be about the operator experience**, and if a designer you've worked with shaped it, say how. For each decision, give the options you considered, what you chose, and what would make you change your mind.
   9. **Where your time went:** total hours, and a rough breakdown (for example, 20 % understanding the problem, 40 % blast safety, and so on). Then what you'd do next with another day and with another month.
   10. **Around the corner:** the company runs 30 sites and about 4,000 trucks. The largest site has 140+ trucks, and head office wants to watch every site live. What changes, what breaks first, and which security risks would you close before this ran a real mine? Name them even if you didn't build for them.

## What we'll do with it

1. We run your system, unattended, for about 15 minutes against a site you haven't seen.
2. We use it ourselves as operators, including someone who has never seen it before, and we drive a truck through it.
3. We read your plan, your agent context, your AI log and sessions, your commit history and your code.
4. Then we talk, for up to an hour:
   - getting to know you;
   - your walkthrough of the system;
   - a deep dive into your design decisions and how it behaves;
   - how you'd take this forward and build the team around it.

## Ground rules

- **There is no time limit.** Deciding what to build, what to do well, and what to leave out is part of the exercise.
- The simulator is ours, and its internals are part of what's being tested. If you think it's behaving wrongly, say so in the README.
- The work is yours. We will only use it to evaluate your candidacy.
