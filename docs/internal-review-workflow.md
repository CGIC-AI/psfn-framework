# Local Delivery and Internal Review Workflow

This reproduces PSFN's pre-PR gate and internal reviews on another machine.

## Prerequisites and setup

Install Git, Node.js 22+, npm, a running Docker engine, authenticated GitHub CLI,
and UBS 5.3.5. Install UBS from its immutable tag after verifying the installer:

```bash
ubs_installer="$(mktemp)"
curl -fsSL \
  https://raw.githubusercontent.com/Dicklesworthstone/ultimate_bug_scanner/v5.3.5/install.sh \
  -o "$ubs_installer"
printf '%s  %s\n' \
  '1a5fbf3f487df5de8e23f439c5b07ce1d0db1b9991b39ead983a51f89ba603e2' \
  "$ubs_installer" | sha256sum -c -
bash "$ubs_installer" --easy-mode
```

Keep UBS in `PATH`; the gate pins it with `--no-auto-update`. Semgrep, actionlint,
and zizmor use pinned Docker images and need no host install.

Run once per clone/worktree:

```bash
npm ci
npm run tools:doctor
npm run hooks:install
git config --get core.hooksPath       # .githooks
gh alias list | grep '^gated-pr:'     # !npm run pr:publish -- "$@"
```

The installer replaces nothing; run it separately in every worktree.
Repository maintainers must also configure the only GitHub identity allowed to
publish local-gate statuses:

```bash
gh variable set LOCAL_GATE_STATUS_ACTOR --body "$(gh api user --jq .login)"
```

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
small beads into one coherent unit, aiming for at most 25 files, 1,500 counted
lines, and 5 commits. Never batch unrelated changes or add filler.

Commit coherent checkpoints and push the same-name non-main branch immediately:

```bash
git push -u origin HEAD
```

The pre-push hook blocks direct `main`, mismatched refs, and non-fast-forward
history rewrites. It does not run the broad gate; checkpoint push is remote
backup, not publication.

Before PR publication or update:

```bash
git fetch origin main
git rebase origin/main
npm run gate:pre-pr
```

The sequential gate always owns delivery rules and budgets, changed-file lint,
Semgrep diff scanning, and changed-file UBS 5.3.5. Full root lint, build,
baselined typecheck, repository hygiene, and product tests capped at eight
workers with fail-fast enabled run only for root runtime/build-graph or root
lockfile changes. UI and deployment changes use their focused checks instead
of the backend/Postgres suite; Semgrep rule tests and changed-workflow
actionlint/zizmor run only when their own files change.

The publication gate refuses dirty, detached, `main`, empty, or non-rebased
delivery. Attestation and logs live under the worktree Git directory in
`local-delivery-gate/`, never in tracked files. The cache matches only the exact
head and base. `npm run pr:publish` runs and verifies the same gate before
publishing the exact head; never use `--no-verify` in the normal flow.

## Internal adversarial review

Pin the committed range:

```bash
review_base="$(git merge-base origin/main HEAD)"
review_head="$(git rev-parse HEAD)"
git diff --stat "$review_base..$review_head"
git diff --check "$review_base..$review_head"
```

Give each reviewer that same range without sharing another reviewer's output.
Every reviewer must use a model family different from the implementer; dual
reviews also use different reviewer families whenever available:

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

Use two blind cross-family reviewers for P0/P1 or high-risk composite work. One
cross-family reviewer is enough for P2 and below unless concrete unexpected
high-risk behavior appears. The orchestrator reproduces alleged blockers and
returns only verified P0/P1 findings to the original implementer. Final review
is closure-only: it checks accepted findings, not the whole range again. A newly
alleged P0/P1 needs a concrete reproduction plus severity corroboration from a
second model family; one corroborated late blocker gets one last scoped pass.
Then stop and park the pushed branch if a blocker remains. A multi-bead seam pass
covers only merge resolutions, shared contracts, and composite acceptance.

## Publish and wait

Write a PR body with summary, validation, and bead IDs, then run:

```bash
gh gated-pr --title "<type(scope): outcome>" --body-file <body.md>
```

The wrapper fetches and gates the base, pushes through the cached hook, publishes
an authenticated exact head/base commit status, and waits for `ci-required` and
`Greptile Review`. Do not use raw `gh pr create`/`edit`; GitHub rejects a stale status
before installing dependencies.

GitHub has one complementary delta runner and one status aggregator. Drafts use
no runners; labels do not retrigger CI. Clean root builds, UI checks, and
deployment contracts run only for applicable paths. GitHub never runs the full
repository product/Postgres suite, while local lint, typecheck, hygiene, UBS,
Semgrep, and specialist checks are not repeated wholesale.

On external failure, the wrapper returns evidence to the owning implementer.
Triage review claims under the bounded cross-family loop above; an external P0/P1
badge is not itself a severity ruling. Gate every corrected exact head. Never
rerun Actions, re-request review, toggle labels to manufacture events, or start
successive general review sweeps. At the hard cutoff, park the pushed branch and
surface the blocker.

## Troubleshooting

- Docker/UBS unhealthy: repair it and rerun `npm run tools:doctor`; skip nothing.
- Hook/alias conflict: inspect with the operator; the installer replaces nothing.
- Stale base: fetch, rebase once, commit, and gate the new exact range.
- Dirty or changed head: stop and resolve ownership; only committed state is attested.
- External checks unavailable: stop; local green is not merge authority.
