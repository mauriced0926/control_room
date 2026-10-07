# AI sessions

Share links to every agent session in the build, in order. Each must open without signing in.
Secrets are removed before sharing; where a tool cannot share a link, the transcript is exported
to `ai-sessions/` instead.

| # | Date | Tool | What it covered | Link |
|---|---|---|---|---|
| 1 | 2026-10-01 to 02 | Claude Code (Opus 5.5) | Close read, live-gateway captures and command probe, `research/`, `CONTEXT.md` revisions, `PLAN.md`, `CLAUDE.md`, test strategy, foundation code, UI spec, task briefs, and review and merge of every agent's work | Exported: [`ai-sessions/2026-10-01-main-session.md`](ai-sessions/2026-10-01-main-session.md) (full transcript in the `.jsonl` beside it) |
| 1a | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 1, fake gateway milestone 1 (`tasks/01-fake-gateway.md`) | Exported: [`ai-sessions/2026-10-02-task-01-fake-gateway.md`](ai-sessions/2026-10-02-task-01-fake-gateway.md) (full transcript in the `.jsonl` beside it) |
| 1b | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 2, ingest and fleet state (`tasks/02-ingest.md`) | Exported: [`ai-sessions/2026-10-02-task-02-ingest.md`](ai-sessions/2026-10-02-task-02-ingest.md) (full transcript in the `.jsonl` beside it) |
| 1c | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 1b, fake gateway milestone 2, first attempt: stopped by the account's session limit while still reading | Exported: [`ai-sessions/2026-10-02-task-01b-fake-gateway-m2-attempt-1.md`](ai-sessions/2026-10-02-task-01b-fake-gateway-m2-attempt-1.md) (full transcript in the `.jsonl` beside it) |
| 1d | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 6a, UI Overview, first attempt: stopped by the session limit while still reading | Exported: [`ai-sessions/2026-10-02-task-06a-ui-overview-attempt-1.md`](ai-sessions/2026-10-02-task-06a-ui-overview-attempt-1.md) (full transcript in the `.jsonl` beside it) |
| 1e | 2026-10-03 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 1b, fake gateway milestone 2 (`tasks/01b-fake-gateway-m2.md`); resumed once after a session limit | Exported: [`ai-sessions/2026-10-03-task-01b-fake-gateway-m2.md`](ai-sessions/2026-10-03-task-01b-fake-gateway-m2.md) (full transcript in the `.jsonl` beside it) |
| 1f | 2026-10-03 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 6a, fixture player and Overview screen (`tasks/06a-ui-overview.md`) | Exported: [`ai-sessions/2026-10-03-task-06a-ui-overview.md`](ai-sessions/2026-10-03-task-06a-ui-overview.md) (full transcript in the `.jsonl` beside it) |
| 1g | 2026-10-03 | Claude Code sub-agent (Opus 5.5), in its own worktree | Tasks 3 and 4, gateway link and command registry (`tasks/03-04-gateway-link-and-registry.md`); resumed once after a session limit | Exported: [`ai-sessions/2026-10-03-task-03-04-link-registry.md`](ai-sessions/2026-10-03-task-03-04-link-registry.md) (full transcript in the `.jsonl` beside it) |
| 1h | 2026-10-03 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 6b, the service, operator login and live updates (`tasks/06b-server.md`) | Exported: [`ai-sessions/2026-10-03-task-06b-server.md`](ai-sessions/2026-10-03-task-06b-server.md) (full transcript in the `.jsonl` beside it) |
| 1i | 2026-10-04 to 06 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 6c, truck detail, command buttons and the attention tray (`tasks/06c-truck-detail-attention.md`); resumed after a weekly limit and a network outage | Exported: [`ai-sessions/2026-10-06-task-06c-truck-detail.md`](ai-sessions/2026-10-06-task-06c-truck-detail.md) (full transcript in the `.jsonl` beside it) |
| 1j | 2026-10-04 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 5, blast engine, first attempt: stopped by the account's weekly limit while reading | Exported: [`ai-sessions/2026-10-04-task-05-blast-engine-attempt-1.md`](ai-sessions/2026-10-04-task-05-blast-engine-attempt-1.md) (full transcript in the `.jsonl` beside it) |
| 1k | 2026-10-06 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 5, the blast engine (`tasks/05-blast-engine.md`); resumed after network outages and a rate limit | Exported: [`ai-sessions/2026-10-06-task-05-blast-engine.md`](ai-sessions/2026-10-06-task-05-blast-engine.md) (full transcript in the `.jsonl` beside it) |
| 1l | 2026-10-06 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 7, driving, first attempt: cut off by a network outage before committing | Exported: [`ai-sessions/2026-10-06-task-07-driving-attempt-1.md`](ai-sessions/2026-10-06-task-07-driving-attempt-1.md) (full transcript in the `.jsonl` beside it) |
| 1m | 2026-10-06 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 7, remote driving (`tasks/07-driving.md`), including finding the lost-click bug | Exported: [`ai-sessions/2026-10-06-task-07-driving.md`](ai-sessions/2026-10-06-task-07-driving.md) (full transcript in the `.jsonl` beside it) |

Sub-agent sessions run inside session 1 and have no share link of their own, so their transcripts are
exported with `tools/export_session.py`, which drops every email field and replaces every email
address, then refuses to finish if one survives. Images an agent looked at (its own screenshots) are
replaced by a note of their size; the screenshots that matter are in `docs/screenshots/`.
