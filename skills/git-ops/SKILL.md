---
name: git-ops
description: Safely inspect and modify repositories with git tooling.
requires:
  binaries:
    - git
---
# Git Operations

Use this skill when changes require repository operations.

## Guardrails
- Prefer non-destructive commands.
- Review diff before commit.
- Keep commits scoped and descriptive.

## Tooling
- Use `repo` with `action="inspect"` and `target="status"` for branch and dirty state.
- Use `repo` with `action="inspect"` and `target="diff"` to inspect changes.
- Use `repo` with `action="patch"` for targeted edits when mutation is available.
- Use `repo` with `action="commit"` when the change is verified and mutation is available.
