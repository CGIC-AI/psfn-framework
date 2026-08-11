# Local Delivery and Internal Review Workflow

This reproduces PSFN's pre-PR gate and internal reviews on another machine.

## Prerequisites and setup

Install Git, Node.js 24 LTS (24.19.0 or newer 24.x), npm, a running Docker engine,
authenticated GitHub CLI, and UBS 5.3.7. Install UBS from its immutable tag after
verifying the installer:

```bash
ubs_installer="$(mktemp)"
curl -fsSL \
  https://raw.githubusercontent.com/Dicklesworthstone/ultimate_bug_scanner/v5.3.7/install.sh \
  -o "$ubs_installer"
printf '%s  %s\n' \
  '1a5fbf3f487df5de8e23f439c5b07ce1d0db1b9991b39ead983a51f89ba603e2' \
  "$ubs_installer" | sha256sum -c -
bash "$ubs_installer" --easy-mode
```

Keep UBS in `PATH`; the gate pins it with `--no-auto-update`. Semgrep, actionlint,
and zizmor use pinned Docker images and need no host install.

Before running the local gate, configure the ignored or external privacy
blocklist and the approved maintainer identity without placing either value in
tracked files. Repository maintainers configure the matching GitHub variables:

```bash
git config publicSanitize.localBlocklist '<absolute-path-to-private-blocklist.json>'
git config --add delivery.allowedCommitEmail '<approved-maintainer-email>'
gh variable set DELIVERY_ALLOWED_COMMIT_EMAILS --body '<approved-maintainer-email>'
gh variable set LOCAL_GATE_STATUS_ACTOR --body "$(gh api user --jq .login)"
```

Run once per clone/worktree:

```bash
npm ci
npm run tools:doctor
npm run hooks:install
git config --get core.hooksPath       # .githooks
gh alias list | grep '^gated-pr:'     # !npm run pr:publish -- "$@"
```

The hook installer replaces nothing; run it separately in every worktree. The
privacy blocklist may be shared by absolute path across worktrees; the local gate
fails closed when the configured file is absent.

The integration harness keeps one labeled Postgres container alive per exact
test image, Vitest invocation, and worker pool, then creates an isolated
database for each test-file harness. Invocation and worker scoping isolates
simultaneous test commands and cluster-wide roles while still reusing warm
containers across files in one gate. Normal teardown drops each harness's
databases and roles; high-churn workers replace their verified test container
with a clean running one instead of serially dropping dozens of databases.
Either path leaves a warm container for another file in that invocation.
Remove only those cached containers when needed with:

```bash
docker ps -aq --filter label=io.local-gate.test-postgres=true |
  xargs -r docker rm -f
```

## Implement and gate

Use targeted tests and `npm run lint:changed -- --base origin/main` while
editing. A bead is an ownership unit, not automatically a PR: batch compatible
ready beads into one coherent train. The standard publication window is 800–2,500
counted changed lines, at most 25 files, and at most 8 commits; 15 files, 1,500
lines, and 5 commits are planning targets. The floor discourages tiny PRs that
incur separate flat-price external reviews, but none of these numbers justifies
padding, splitting, reshaping, or delaying coherent ready work. Tag an
out-of-window PR `change-budget:exception`, state the coherent variance in one
line, and finish delivery.

Commit coherent checkpoints and push the same-name non-main branch immediately:

```bash
git push -u origin HEAD
```

The pre-push hook blocks direct `main`, mismatched refs, branch deletion, and
ordinary non-fast-forward history rewrites. It does not run the broad gate;
checkpoint push is remote backup, not publication. After a required rebase,
only `pr:publish` may update the branch: it revalidates the exact gate
attestation and uses `--force-with-lease` against the exact observed remote head.

Before PR publication or update:

```bash
git fetch origin main
git rebase origin/main
npm run gate:pre-pr
```

The sequential gate always owns delivery rules and budgets, changed-file lint,
Semgrep diff scanning, and changed-file UBS 5.3.7. Full root lint, build,
baselined typecheck, repository hygiene, and product tests capped at eight
workers with fail-fast enabled run only for root runtime/build-graph or root
lockfile changes. UI changes use their focused checks instead
of the backend/Postgres suite; Semgrep rule tests and changed-workflow
actionlint/zizmor run only when their own files change.

The publication gate refuses dirty, detached, `main`, empty, or non-rebased
delivery. Attestation and logs live under the worktree Git directory in
`local-delivery-gate/`, never in tracked files. The cache matches only the exact
head and base. `npm run pr:publish` runs and verifies the same gate before
publishing the exact head; never use `--no-verify` in the normal flow.

Greptile is not part of ordinary publication. Its repository config reviews only
PRs explicitly labeled `review:greptile` and does not rescan later pushes. Never
apply that label or mention the bot without explicit operator authorization for
the paid review; while credits are disabled, do not request it at all.

## Internal adversarial review

Pin the committed range:

```bash
review_base="$(git merge-base origin/main HEAD)"
review_head="$(git rev-parse HEAD)"
git diff --stat "$review_base..$review_head"
git diff --check "$review_base..$review_head"
```

Review is optional and risk-selected. Use at most one independent reviewer on
the frozen final train when the actual diff changes authentication,
authorization, isolation, destructive persistence, concurrency, a new execution
surface, or production deployment behavior with meaningful rollback risk. Give
that reviewer the immutable range:

```text
First restate the intent of immutable range <base>..<head> in one sentence and
say whether the implementation has the right shape. Then review it against the
bead acceptance criteria and AGENTS.md. Refute it with concrete, reproducible
failure scenarios.

Record implementer model/family, reviewer model/family, trust boundaries, and
whether family independence is satisfied.

Blocking findings are only P0/P1 partner-data security/privacy/isolation,
companion welfare/consent/autonomy, real data or secret loss, a broken core
acceptance path, or a mandatory gate. Include path:line, reproduction, impact,
minimal remedy, and regression test.

Report every other observation as nonblocking; it triggers no fixes or beads.
Do not approve on plausibility or review outside the immutable range.
```

Tracker priority alone never selects review intensity. Ordinary fixes proceed on
focused tests and the final gate without model review. The implementer reproduces
any alleged blocker and fixes accepted findings once; the focused regression is
the closure proof. A second reviewer requires an explicit operator request or a
single concrete high-impact claim that remains materially ambiguous. Do not run
per-bead review followed by another train or seam review.

## Publish and return

Write a PR body with summary, validation, and bead IDs, then run:

```bash
gh gated-pr --title "<type(scope): outcome>" --body-file <body.md>
```

The wrapper fetches and gates the base, pushes through the cached hook, publishes
an authenticated exact head/base commit status, creates or updates the PR, prints
its URL, and returns while checks continue asynchronously. Do not use raw
`gh pr create`/`edit`; GitHub rejects a stale status before installing
dependencies. Use `--wait` only when the operator explicitly asks this session to
monitor required checks.

GitHub has one five-minute policy job and one status aggregator. Drafts use no
runners, and labels do not retrigger CI. The policy job verifies the authenticated
exact-head local-gate attestation and enforces only change budget, commit identity,
and generic public-sanitation policy. It does not install project dependencies or
repeat local lint, build, typecheck, tests, hygiene, UBS, Semgrep, or specialist
checks.

On a later external failure, return evidence to the owning implementer. An
external P0/P1 badge is not itself a severity ruling. Gate a corrected final head
once. Never rerun Actions, re-request review, toggle labels to manufacture events,
or start successive general review sweeps.

## Troubleshooting

- Docker/UBS unhealthy: repair it and rerun `npm run tools:doctor`; skip nothing.
- Hook/alias conflict: inspect with the operator; the installer replaces nothing.
- Stale base: fetch, rebase once, commit, and gate the new exact range.
- Dirty or changed head: stop and resolve ownership; only committed state is attested.
- External checks unavailable: report the state and move to other implementation;
  local green is not merge authority, but passive waiting is not implementation.
