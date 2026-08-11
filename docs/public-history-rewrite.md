# Public history rewrite

Deleting files in a new commit does not remove private data from earlier Git
objects. Before making this repository public, rewrite every reachable mutable
ref and remove the private deployment surfaces from the full graph.

The preparation command is read-only with respect to the source remote. It
creates a backup mirror and bundle, a separate rewritten mirror, ref maps,
validation evidence, and exact lease-protected cutover and rollback commands.

## Preconditions

1. Keep the source repository private and freeze Git writers.
2. Install exactly `git-filter-repo==2.47.0` in an ignored environment.
3. Create an ignored replacement file containing every private identity,
   hostname, address, and operator path that may have appeared in history.
4. Create an ignored removal file containing every additional exact private
   path not covered by the built-in private-surface removal list.

Replacement rows use `PATTERN==>REPLACEMENT`. Use `path-literal:` or
`path-regex:` when the replacement must also rename historical filenames:

```text
literal:internal-host==>host.example.invalid
regex:(?i)operator-slug==>example-operator
path-regex:(?i)device-slug==>example-device
```

The built-in removal list strips all historical Beads snapshots, working docs,
deployment trees, shakedown material, private Trivy configuration, context
packets, module registries, and repository-local agent/editor integrations.

## Prepare and verify

Use a new output directory for every run:

```bash
npm run history:prepare -- \
  --source <complete-private-origin-url> \
  --output workspace/history-rewrite/<run-id> \
  --public-name "PSFN Maintainer" \
  --public-email "maintainer@example.invalid" \
  --filter-repo workspace/history-rewrite/filter-repo-venv/bin/git-filter-repo \
  --private-replacements workspace/history-rewrite/private-replacements.txt \
  --private-remove-paths workspace/history-rewrite/private-remove-paths.txt
```

Preparation verifies the backup, tool version, ref coverage, protected refs,
declared tree transformations, removed-path reachability, rewritten identities,
CHANGELOG commit links, and before/after clone size. Review
`validation-report.json`, both ref maps, and `CUTOVER_PLAN.md`.

The backup bundle and raw mirrors contain pre-rewrite private data. Keep the
output directory ignored and private.

## Server-owned refs

GitHub pull-request refs are server-owned. If the plan reports changed
`refs/pull/*`, branch and tag updates alone cannot make the repository safe.
Keep it private and use repository recreation or a reviewed provider-side purge
before publication.

Never use `git push --mirror`; it can target protected and server-owned refs.
The generated plan includes only exact mutable branch/tag operations protected
by force-with-lease.

## Authorization boundary

Preparation and local rehearsal do not authorize a remote history cutover. A
later operator instruction must approve the exact artifact set and remote
mutation. After cutover, replace old working copies with fresh clones so private
objects are not accidentally pushed back.
