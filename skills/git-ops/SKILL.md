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
- Use `shell` (`action="exec"`, `script="git status --short"`) for branch and dirty state.
- Use `shell` (`action="exec"`, `script="git diff"`) to inspect changes.
- Use `file_editor` (`action="edit"` or `action="write"`) for targeted workspace file edits.
- Use `shell` (`action="exec"`, `script="git commit -m '...'"`) when changes inside a workspace checkout are verified.
