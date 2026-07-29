# GitHub Copilot Instructions

**[AGENTS.md](../AGENTS.md) is the operating contract for this repository** —
issue tracking, the delivery loop, validation gates, configuration ownership,
parallel-work safety, and session completion. Read it first and follow it; when
this file and AGENTS.md disagree, AGENTS.md wins. [CLAUDE.md](../CLAUDE.md) adds
repo orientation.

## Issue Tracking with bd

This project uses **bd (beads)** for all tracked work. Run `bd prime` at the
start of a session for the full command reference and workflow.

### Essential Commands

```bash
bd ready --json                # Find unblocked work
bd show <id> --json            # View issue details
bd update <id> --claim --json  # Claim work
bd create "Title" --description "Self-contained details" -t task -p 2 --json
bd close <id> --reason "Done, with evidence" --json
```

### Rules (see AGENTS.md for the authoritative version)

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Do **not** rely on `bd sync`; this repo uses the `bd dolt` subcommands against
  a local shared Dolt server. Verify it with `bd dolt show` or `bd dolt test`.
- `.beads/` is intentionally git-ignored local export/runtime state. Do not
  `git add .beads`. The single un-ignored `.beads/issues.jsonl` snapshot is only
  committed by off-machine remote-lane workers, per AGENTS.md.
- Keep issue descriptions self-contained (summary, files, steps, acceptance) and
  link discovered follow-up work with `discovered-from:<parent-id>`.
- Keep AI planning and scratch documents out of tracked product docs; use beads
  and, when a scratch file is genuinely needed, `working_docs/`.
