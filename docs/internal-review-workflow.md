# Local Delivery and Internal Review Workflow

This reproduces PSFN's pre-PR gate and internal reviews on another machine so
broad failures stay local and GitHub/Greptile remain external confirmation.

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

Keep UBS in `PATH`; do not update it in place. The gate passes
`--no-auto-update`. Semgrep and zizmor run through digest-pinned Docker images,
so they need no host install. Fallow remains end-of-wave hygiene.

Run once per clone/worktree:

```bash
gh auth status
npm ci
npm run tools:doctor
npm run hooks:install
git config --get core.hooksPath       # .githooks
gh alias list | grep '^psfn-pr:'      # !npm run pr:publish --
```

The installer stops rather than replacing an unrelated hook or alias. Hook
configuration is worktree-specific; run it in every new worktree.

## Implement and gate

Use targeted tests and `npm run lint:changed -- --base origin/main` while
editing. A bead is an ownership unit, not automatically a PR: batch compatible
small beads into one coherent unit, aiming for at most 25 files, 1,500 counted
lines, and 5 commits. Never batch unrelated changes or add filler.

Before the first push or PR update:

```bash
git fetch origin main
git rebase origin/main
git status --short
npm run gate:pre-pr
```

The sequential gate owns delivery rules and budgets; full lint, build,
baselined typecheck, repository hygiene, and tests; Semgrep rule/diff scans;
UBS 5.3.5; and applicable settings, supply-chain, deployment, Garden, companion
UI, and changed-workflow checks.

It refuses dirty, detached, `main`, empty, or non-rebased delivery. Attestation
and logs live under the worktree Git directory in `psfn-local-gate/`, never in
tracked files. The cache matches only the exact head and base. The pre-push hook
invokes the same gate and prevents recursion; never use `--no-verify`.

## Internal adversarial review

Pin the committed range:

```bash
review_base="$(git merge-base origin/main HEAD)"
review_head="$(git rev-parse HEAD)"
git diff --stat "$review_base..$review_head"
git diff --check "$review_base..$review_head"
```

Give each reviewer that same range without sharing another reviewer's output:

```text
Adversarially review immutable range <base>..<head> against the bead acceptance
criteria and AGENTS.md. Refute it with concrete, reproducible failure scenarios.

Blocking findings are only P0/P1 partner-data security/privacy/isolation,
companion welfare/consent/autonomy, real data or secret loss, a broken core
acceptance path, or a mandatory gate. Include path:line, reproduction, impact,
minimal remedy, and regression test.

Report every other observation as nonblocking; it triggers no fixes or beads.
Do not approve on plausibility or review outside the immutable range.
```

Use Opus and Pi, independently and blind, for P0/P1 or high-risk composite work.
One alternating reviewer is enough for P2 and below unless concrete unexpected
high-risk behavior appears. The orchestrator reproduces alleged blockers,
combines verified ones into one remediation commit, and performs one targeted
final check. Do not restart the review cycle. A multi-bead seam pass covers only
merge resolutions, shared contracts, and composite acceptance.

## Publish and wait

Write a PR body with summary, validation, and bead IDs, then run:

```bash
gh psfn-pr --title "<type(scope): outcome>" --body-file <body.md>
```

The wrapper fetches and gates the base, pushes through the cached hook, publishes
one exact head/base marker, and waits for `ci-required` and `Greptile Review`.
Do not use raw `gh pr create`/`edit`; GitHub rejects missing or stale markers
before installing dependencies.

GitHub has one complementary delta runner and one status aggregator. Drafts use
no runners; labels do not retrigger CI. Clean install/build/tests run only for
applicable code paths, while local lint, typecheck, hygiene, UBS, Semgrep, and
specialist checks are not repeated.

On external failure, the wrapper returns evidence to the owning lane. Make one
evidence-driven corrective commit and publish the new exact head once. Never
rerun Actions, re-request Greptile, toggle labels to create events, or start
successive review/fix agents. A second failure is an operator-visible blocker.

## Troubleshooting

- Docker unhealthy: start it and rerun `npm run tools:doctor`; skip nothing.
- UBS mismatch: reinstall pinned 5.3.5 above; do not update it.
- Hook/alias conflict: inspect with the operator; the installer will not replace it.
- Stale base: fetch, rebase once, commit, and gate the new exact range.
- Dirty worktree: commit only the intended unit; uncommitted state is never attested.
- Head changed while waiting: stop and resolve ownership before publishing again.
- Actions, Greptile, billing, or required checks unavailable: stop; local green is not merge authority.
