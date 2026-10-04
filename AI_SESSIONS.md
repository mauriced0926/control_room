# AI sessions

Share links to every agent session in the build, in order. Each must open without signing in.
Secrets are removed before sharing; where a tool cannot share a link, the transcript is exported
to `ai-sessions/` instead.

| # | Date | Tool | What it covered | Link |
|---|---|---|---|---|
| 1 | 2026-10-01 to 02 | Claude Code (Opus 5.5) | Close read, live-gateway captures and command probe, `research/`, `CONTEXT.md` revisions, `PLAN.md`, `CLAUDE.md`, test strategy, foundation code, UI spec, task briefs, and review and merge of every agent's work | *to come* |
| 1a | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 1, fake gateway milestone 1 (`tasks/01-fake-gateway.md`) | Exported: [`ai-sessions/2026-10-02-task-01-fake-gateway.md`](ai-sessions/2026-10-02-task-01-fake-gateway.md) (full transcript in the `.jsonl` beside it) |
| 1b | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 2, ingest and fleet state (`tasks/02-ingest.md`) | Exported: [`ai-sessions/2026-10-02-task-02-ingest.md`](ai-sessions/2026-10-02-task-02-ingest.md) (full transcript in the `.jsonl` beside it) |
| 1c | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 1b, fake gateway milestone 2, first attempt: stopped by the account's session limit while still reading | Exported: [`ai-sessions/2026-10-02-task-01b-fake-gateway-m2-attempt-1.md`](ai-sessions/2026-10-02-task-01b-fake-gateway-m2-attempt-1.md) (full transcript in the `.jsonl` beside it) |
| 1d | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 6a, UI Overview, first attempt: stopped by the session limit while still reading | Exported: [`ai-sessions/2026-10-02-task-06a-ui-overview-attempt-1.md`](ai-sessions/2026-10-02-task-06a-ui-overview-attempt-1.md) (full transcript in the `.jsonl` beside it) |
| 1e | 2026-10-03 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 1b, fake gateway milestone 2 (`tasks/01b-fake-gateway-m2.md`); resumed once after a session limit | Exported: [`ai-sessions/2026-10-03-task-01b-fake-gateway-m2.md`](ai-sessions/2026-10-03-task-01b-fake-gateway-m2.md) (full transcript in the `.jsonl` beside it) |
| 1f | 2026-10-03 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 6a, fixture player and Overview screen (`tasks/06a-ui-overview.md`) | Exported: [`ai-sessions/2026-10-03-task-06a-ui-overview.md`](ai-sessions/2026-10-03-task-06a-ui-overview.md) (full transcript in the `.jsonl` beside it) |
| 1g | 2026-10-03 | Claude Code sub-agent (Opus 5.5), in its own worktree | Tasks 3 and 4, gateway link and command registry (`tasks/03-04-gateway-link-and-registry.md`); resumed once after a session limit | Exported: [`ai-sessions/2026-10-03-task-03-04-link-registry.md`](ai-sessions/2026-10-03-task-03-04-link-registry.md) (full transcript in the `.jsonl` beside it) |
| 1h | 2026-10-03 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 6b, the service, operator login and live updates (`tasks/06b-server.md`) | Exported: [`ai-sessions/2026-10-03-task-06b-server.md`](ai-sessions/2026-10-03-task-06b-server.md) (full transcript in the `.jsonl` beside it) |

Sub-agent sessions run inside session 1 and have no share link of their own, so their transcripts are
exported with `tools/export_session.py`, which drops every email field and replaces every email
address, then refuses to finish if one survives. Images an agent looked at (its own screenshots) are
replaced by a note of their size; the screenshots that matter are in `docs/screenshots/`.
