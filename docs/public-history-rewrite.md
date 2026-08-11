# Public history rewrite

The public-release history cutover combines two concerns in one rewrite:

- remove the deleted session archives, Beads runtime log, and historical tracker
  snapshots that inflate clones;
- normalize commit identities and replace private identity, host, network, and
  path values throughout reachable history.

The preparation command is intentionally unable to update the source remote. It
creates a complete backup mirror and bundle, a separately rewritten mirror,
before/after ref maps and clone measurements, validation evidence, and a review-
only cutover plan with exact force-with-lease and rollback commands.

## Preconditions

1. Keep the repository private.
2. Freeze Git and Beads writers for the final preparation pass. A rehearsal may
   run without a freeze, but it is not a cutover artifact.
3. Commit the shared Dolt working set with `bd dolt commit --json`. Do not run
   `bd dolt push`.
4. Install the exact tool in a disposable virtual environment:

   ```bash
   python3 -m venv workspace/history-rewrite/filter-repo-venv
   workspace/history-rewrite/filter-repo-venv/bin/pip install git-filter-repo==2.47.0
   ```

5. Create ignored replacement and removal-path files. The replacement file
   contains every deployment-specific identity, path, host, and infrastructure
   value. Tracked code contains only generic patterns. The file uses the `git-filter-repo`
   `PATTERN==>REPLACEMENT` form. Prefix rules that must also rename historical
   filenames with `path-literal:` or `path-regex:`:

   ```text
   literal:private-host==>host.example.invalid
   regex:(?i)private-user==>example-user
   path-regex:(?i)private-companion==>companion
   ```

   The removal-path file contains one exact repository-relative historical path
   per line. Use it for private archives and identity-specific generated assets
   that must not survive under a genericized filename:

   ```text
   working_docs/example-session-archive.zip
   deployment/example-private-model.tflite
   ```

## Prepare and verify

Choose a new output directory for every run. The command refuses to reuse or
overwrite one:

```bash
npm run history:prepare -- \
  --source <complete-private-origin-url> \
  --output workspace/history-rewrite/<run-id> \
  --public-name "PSFN Maintainer" \
  --public-email "maintainer@example.invalid" \
  --filter-repo workspace/history-rewrite/filter-repo-venv/bin/git-filter-repo \
  --bd /absolute/path/to/bd \
  --private-replacements workspace/history-rewrite/private-replacements.txt \
  --private-remove-paths workspace/history-rewrite/private-remove-paths.txt
```

The command performs these checks before it reports success:

- source refs are unchanged between the beginning and end of preparation;
- the backup bundle and mirror pass strict Git fsck;
- the exact `git-filter-repo` package version is 2.47.0;
- all non-protected refs remain present, while `refs/dolt/*` stay byte-for-byte
  unchanged;
- current source-tree changes are completely explained by declared removals,
  filename genericization, and text replacement;
- the rewritten graph contains none of the removed archive/log paths and only
  one reachable `.beads/issues.jsonl` object;
- every rewritten author and committer email is the selected public identity;
- every CHANGELOG commit URL maps to a surviving rewritten commit;
- the current shared-Dolt export parses and passes `bd import --dry-run` after
  sanitization;
- full-clone object sizes are measured before and after;
- the post-rewrite marker activates bounded tracker-snapshot generations.

Review `validation-report.json`, `pre-refs.tsv`, `post-refs.tsv`, and
`CUTOVER_PLAN.md`. The bundle and raw tracker export contain private pre-rewrite
data and must remain in the ignored output directory.

## Server-owned refs are a publication blocker

GitHub pull-request refs are server-owned. An ordinary force-with-lease push can
rewrite branches and tags but cannot replace `refs/pull/*`. If the generated
plan reports changed server-owned refs, branch rewriting alone does not remove
the private or large objects reachable from those refs. Keep the repository
private and use an explicitly reviewed repository-recreation or hosting-provider
purge procedure before the public flip.

Never run `git push --mirror`. It would attempt to mutate server-owned pull refs
and the protected Dolt ref. The generated plan names every ref and contains only
the exact mutable head/tag operations plus their rollback leases.

## Authorization boundary

Preparation, local disposable-remote rehearsal, and review do not authorize a
remote cutover. A later operator instruction must explicitly approve the exact
artifact set and remote update. After an authorized cutover, re-clone working
copies rather than merging rewritten and pre-rewrite histories. Revalidate the
local companion runtime on the current PC with its existing OpenRouter
configuration; do not use a retired host or infer a different hardware target.
