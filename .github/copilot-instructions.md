# GitHub Copilot Instructions

## Issue Tracking with bd

This project uses **bd (beads)** for issue tracking - a Git-backed tracker designed for AI-supervised coding workflows.

**Key Features:**
- Dependency-aware issue tracking
- Auto-sync with Git via JSONL
- AI-optimized CLI with JSON output
- Built-in daemon for background operations
- MCP server integration for Claude and other AI assistants

### Critical Rules

- Use bd for ALL task tracking
- Run `bd sync` at the end of every session
- Always include `.beads/issues.jsonl` when committing changes
- Avoid markdown TODO lists

### Essential Commands

```bash
bd ready --json
bd create <title> -t bug|feature|task -p 0-4 --json
bd update <id> --status in_progress --json
bd close <id> --reason "Done" --json
bd sync
```

### Workflow Expectations

1. Check `bd ready --json` for unblocked work.
2. Claim and work through `bd update <id> --status in_progress`.
3. Create `/ link new issues with `discovered-from` if you uncover more work.
4. Close via `bd close <id> --reason "Done"` when completed.

### Additional Guidance

- Use `bd <command> --help` when learning new flags.
- Run `bd ready --json` before asking what to work on.
- Store AI planning docs in `history/` to keep the root clean.
