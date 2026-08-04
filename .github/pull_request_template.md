## Scope

Bead:

Why:

Non-goals:

## Validation

- [ ] Targeted local tests passed
- [ ] Changed-file lint passed
- [ ] `ci-required` passed
- [ ] Commits are coherent and ready for rebase merge

## Labels

- [ ] Apply exactly one `kind:*` label
- [ ] Apply `severity:*` for defects and `risk:*` for review depth
- `system:*` and `size:*` labels are maintained automatically

## Change budget

- [ ] This PR is inside the mandatory window: 800–2,500 counted changed lines, at most 25 files, at most 8 commits
- [ ] Compatible completed and in-flight work was bundled; this is not an avoidable small PR

## Change-budget exception

<!--
Leave blank unless a maintainer applied `change-budget:exception`.
This exception is only for a PR below 800 lines that is an otherwise-unlandable
blocker and cannot be combined safely with compatible work. Begin the rationale
with `BLOCKER:` and explain both facts. It cannot bypass the 25-file or
2,500-line maximum.
-->
