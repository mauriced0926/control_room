# AI sessions

Share links to every agent session in the build, in order. Each must open without signing in.
Secrets are removed before sharing; where a tool cannot share a link, the transcript is exported
to `ai-sessions/` instead.

| # | Date | Tool | What it covered | Link |
|---|---|---|---|---|
| 1 | 2026-10-01 to 02 | Claude Code (Opus 5.5) | Close read, live-gateway captures and command probe, `research/`, `CONTEXT.md` revisions, `PLAN.md`, `CLAUDE.md`, test strategy, foundation code, UI spec, task briefs, and review and merge of every agent's work | *to come* |
| 1a | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 1, fake gateway milestone 1 (`tasks/01-fake-gateway.md`) | Exported: [`ai-sessions/2026-10-02-task-01-fake-gateway.md`](ai-sessions/2026-10-02-task-01-fake-gateway.md) (full transcript in the `.jsonl` beside it) |
| 1b | 2026-10-02 | Claude Code sub-agent (Opus 5.5), in its own worktree | Task 2, ingest and fleet state (`tasks/02-ingest.md`) | Exported: [`ai-sessions/2026-10-02-task-02-ingest.md`](ai-sessions/2026-10-02-task-02-ingest.md) (full transcript in the `.jsonl` beside it) |

Sub-agent sessions run inside session 1 and have no share link of their own, so their transcripts are
exported with `tools/export_session.py`, which drops every email field and replaces every email
address, then refuses to finish if one survives.
