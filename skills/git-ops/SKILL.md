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
- `repo_status` to inspect branch and dirty state.
- `repo_diff` to inspect changes.
- `repo_apply_patch` for targeted edits.
- `repo_commit` when the change is verified.
