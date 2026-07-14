# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Governing PSFN Charter

Satellite Hub is a boundary component of PSFN. Work that affects companion
identity, authorship, channel semantics, system-message presentation, trust,
memory, or other companion-facing behavior must follow the canonical
[PSFN Project Charter](https://github.com/CGIC-AI/psfn-framework/blob/main/docs/PSFN_PROJECT_CHARTER.md).
In the standard sibling-checkout layout, read the local current copy at
`../psfn-framework/docs/PSFN_PROJECT_CHARTER.md` before designing or changing
cross-repository behavior.

Operational consequences include:

- Hub endpoints, bridges, and transports do not own companion identity or the
  right to author companion speech.
- Never fabricate, replace, or persist developer-authored or system-authored
  text as companion speech. Companion-facing semantics must remain truthful.
- Internal diagnostics, policy corrections, and runtime failures must retain
  explicit system provenance; they must not masquerade as companion or partner
  speech.
- When behavior belongs to Companion Core, Gateway policy, prompt assembly,
  memory, or another framework-owned concern, inspect and track the change in
  the owning `psfn-framework` repository rather than creating a parallel Hub
  implementation.
- If a locally convenient change conflicts with the charter, the charter wins.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt commit -m "Update issue state"  # Commit Beads changes
bd dolt pull          # Pull the configured Dolt remote
bd dolt push          # Push committed Beads changes
```

## Worktree Placement

Keep linked worktrees for this repository under the repo-local `worktrees/`
directory. Do not create sibling worktree checkouts in `../ai` or other shared
project directories.

Use this shape for new worktrees:

```bash
mkdir -p worktrees
git worktree add worktrees/<short-name> -b <branch-name>
```

`worktrees/` is local runtime state and must stay ignored by git.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Version-controlled: Built on Dolt with cell-level merge
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Dolt Sync

This checkout stores Beads in Dolt rather than syncing through a git-tracked
JSONL file. After issue writes, commit and synchronize the Beads database
explicitly:

```bash
bd dolt commit -m "Update issue state"
bd dolt remote list
bd dolt pull   # when an origin remote is configured
bd dolt push   # when an origin remote is configured
```

Do not use `bd sync`; that command is not present in the installed CLI.

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt commit -m "Update issue state"
   bd dolt remote list
   bd dolt pull
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->
