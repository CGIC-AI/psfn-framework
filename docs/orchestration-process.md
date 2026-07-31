# Parallel Bead and Feature-Branch Process

## Purpose

This is the on-demand operating contract for multi-agent implementation waves.
It keeps every lane remotely durable, preserves one integration surface, lands
reviewable PR-sized trains, and reserves broad certification for publication
rather than ordinary checkpoint pushes.

Use this with `AGENTS.md`; current operator instructions and `AGENTS.md` take precedence. Portable setup is in [`internal-review-workflow.md`](./internal-review-workflow.md).

## Roles

### Orchestrator

The orchestrator retains the wave-level intent and delivery state. It:

- selects ready beads and feature boundaries;
- creates wave, train, bead branches, and worktrees;
- assigns one worker to each worktree;
- keeps two or three independent worker lanes active when dependencies allow;
- resolves merges and merge conflicts;
- reads the code, tests, and history needed to understand intent and independently
  verify review claims;
- may make localized merge, integration-glue, or delivery corrections that do not
  introduce new feature behavior or expand acceptance criteria;
- routes reviews, validation, tracker updates, and handoffs;
- publishes the assembled exact head and returns external failures to its owning lane.

The orchestrator delegates broad discovery and feature implementation. If a
correction becomes a new behavior, crosses out of the integration seam, or starts
consuming the main thread's wave context, return it to an implementation lane.

### Worker

Each worker owns one bead and one worktree. It:

- reads `AGENTS.md`, runs `bd prime`, reads the full bead, and claims it;
- implements only its assigned scope;
- runs focused validation and commits stable checkpoints;
- pushes every checkpoint to its same-name non-main remote branch;
- reports the exact branch, remote commit, validation, and remaining risks.

Workers do not merge into feature, release, or main branches.

### Model-family independence

The durable rule is about model families, not product names. Harness-specific
model and command mappings live in files such as `CLAUDE.md`.

- A reviewer must use a different model family from the implementer. Two models
  from OpenAI are not independent; neither are two Anthropic models.
- When two reviewers are required, they must be blind to one another and use
  families different from the implementer and, whenever available, from each
  other. A typical Codex implementation uses Anthropic plus GLM/Kimi review.
- Record implementer model/family and reviewer model/family in every review.
- Greptile or another opaque service is additional signal unless its underlying
  family is known and satisfies the independence rule.
- If the active harness cannot dispatch a qualifying reviewer, push the branch,
  park it with the exact remote head, and surface the missing capability. A
  same-family substitute does not count as independent review.

### Tiered review policy (2026-07-14 operator decision)

Every bead gets a UBS scan of the change range as a cheap baseline gate before
any model review. Then:

- **P0/P1 beads: two blind, cross-family adversarial reviewers.**
- **P2 and below: one cross-family adversarial reviewer.** Rotate families to
  avoid one-harness blind spots.
- **Escalation:** if the single review or UBS scan exposes an unexpected
  security, welfare, privacy, data, or core-path surface, add a second blind
  cross-family reviewer before synthesis.

The verification rule is unchanged at every tier: the orchestrator independently confirms every claimed blocker against the Blocking Risk Standard before remediation.

## Branch and Worktree Shape

Each sprint or large batch has one remotely pushed wave branch as its integration
surface. Individual beads use work branches based on that wave. Publication uses
smaller coherent train branches; the integration branch is not permission to
open one enormous PR.

```text
main
  └── wave/<sprint-or-epic>              # pushed integration surface
       ├── work/<epic>-<bead-a>          # pushed worker checkpoint
       ├── work/<epic>-<bead-b>
       └── work/<epic>-<bead-c>

main
  └── train/<wave>-<n>                   # coherent reviewed PR-sized slice
```

Use worktrees under:

```text
$HOME/ai/dev/worktrees/psfn-framework/
```

Typical setup:

```bash
git fetch origin main
git switch --detach origin/main
npm run gate:canary
npm run prewarm
git worktree add -b wave/<epic> <feature-worktree> <approved-base>
git -C <feature-worktree> push -u origin wave/<epic>
git worktree add -b work/<epic>-<bead> <bead-worktree> wave/<epic>
# In each new feature/bead worktree:
npm ci --offline --ignore-scripts
```

Use the baseline-attested SHA as `<approved-base>`; every lane then starts from
the resulting wave branch. The current command remains `npm run gate:canary`;
"canary" here means a clean-main baseline certification, not a deployment canary.

The clean-main canary is mandatory before any multi-PR wave fans out. It fetches
first, refuses a dirty tree or a checkout that is not exactly `origin/main`, and
runs the whole-repository `ci-rules`, lint, build, typecheck,
repository-hygiene, startup-owner-files, Semgrep-rules, and test gates.
Empty-diff checks (`change-budget`, commit identities, `semgrep-diff`, and UBS)
skip with a logged reason. Every branch gate and the complementary GitHub CI
lane run `verify:commit-identities` over the exact base-to-head range; both the
author and committer email of every commit must be explicitly allowlisted, while
`verify:repository-hygiene` continues to scan tracked content for public-release
identity and sanitize violations. A passing canary run records a
`kind: 'canary'` attestation containing the base SHA, gate version, and timestamp
under `.git/local-delivery-gate/`. A red canary stops the wave: fix `main` before
creating branches or worktrees. This prevents baseline defects or a gate-version
change from invalidating every branch attestation after fanout.

Run `npm run prewarm` once per wave, and again after any lockfile change. It
populates the shared npm cache, proves the cache with an offline install, and
attests the result by lockfile hash. `npm run prewarm -- --check` verifies the
attestation and cache without warming. Never share `node_modules` or `dist`
between worktrees; install each worktree with
`npm ci --offline --ignore-scripts` (normally about 15 seconds after prewarm).

A bead is an ownership boundary, never a paid PR boundary. Every external review
costs the same flat fee whether the diff is 100 lines or 2,000, so the unit of
publication is the **train**: assemble compatible completed beads into one
coherent PR near the budget target. Target at most 25 files, 1,500 counted lines,
and 5 commits; the hard limits remain 25 files, 2,000 lines, and 8 commits. Do
not mix unrelated work or pad a diff.

Publication floor: do not open a standalone PR for a small diff (roughly under 500 counted lines) while other compatible beads are completed or in flight — hold it for the train. A standalone small PR requires a recorded reason on its bead (security-urgent fix, conflict isolation, unblocking a dependent wave); "it was ready" is not a reason. The 2026-07-28 incident — fourteen single-fix PRs in one day, each paying a full external review, exhausting the review budget and stranding every remaining lane unpublished — is the failure mode this floor exists to prevent.

When a coherent train completes its final check, publish it the same session
through `npm run pr:publish`. After it lands, rebase the wave branch onto the new
`main`, then assemble the next train. The publisher is the only sanctioned path
for replacing a previously pushed rebased head: it validates the exact gate
attestation and uses an exact-remote `--force-with-lease`. Keep cross-train
activation in a final small PR. An independent lane validates the exact head and uses GitHub's rebase
merge after required checks pass. Do not squash or create merge commits. Live
deployment remains operator-driven.

## Parallel Work Format

Use up to three worker lanes plus the orchestrator when the ready graph contains
three genuinely independent seams. This is the normal maximum, not a quota.
Use fewer lanes for narrow or tightly coupled work; do not manufacture parallelism.
A difficult bead in one lane should not idle other workers when independent work
really exists.

Track the live wave in this format:

| Lane | Bead | Worktree | Branch | Base | State | Pushed checkpoint | Next gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | `<bead-id>` | `<path>` | `work/<name>` | `wave/<epic>@<sha>` | implementation/review/remediation/validation | `<sha>` | `<specific next action>` |
| B | `<bead-id>` | `<path>` | `work/<name>` | `wave/<epic>@<sha>` | implementation/review/remediation/validation | `<sha>` | `<specific next action>` |
| C | `<bead-id>` | `<path>` | `wave/<name>` | `<base>@<sha>` | implementation/review/remediation/validation | `<sha>` | `<specific next action>` |

When a lane finishes, assign the next ready independent bead when one exists. A
difficult bead must not monopolize the worker pool, and an empty queue must not
create fake work.

Preflight work may fan out concurrently across all worktrees. The full test
suite is the heavy phase and queues automatically on the machine-wide gate lock,
including against unrelated sessions on the same host. Read the 15-second waiter
diagnostics before treating a queued lane as hung; do not manually serialize
lanes or delete a lock held by a live PID.

## Canonical Multi-PR Wave

Use this order for every multi-PR implementation wave, including a two-PR wave:

1. In a clean checkout exactly at `origin/main`, run the clean-main baseline
   command `npm run gate:canary`. Record its base SHA and gate version. Any
   failure stops fanout; repair `main` and rerun the baseline first.
2. Run `npm run prewarm` once for the wave (or after a lockfile change), create
   the wave branch from the baseline-attested base and each lane from that wave
   branch, and run
   `npm ci --offline --ignore-scripts` in every new worktree. Use
   `npm run prewarm -- --check` when only verification is needed.
3. Implement the independent lanes. Commit coherent checkpoints and push each
   same-name non-main branch immediately; checkpoint pushes are remote backup and
   do not run or imply the broad publication gate. Targeted tests and changed-file
   lint remain the implementation loop. Full gate PREFLIGHT stages may run
   concurrently; HEAVY stages queue on the machine-wide lock.
4. Independently verify review claims against intent and the Blocking Risk
   Standard. Only verified P0/P1 blockers enter remediation. The original
   implementer fixes them to preserve context; re-verification checks only those
   accepted findings. Put nonblocking observations in the wave handoff.
5. Commit each exact branch head and run `npm run gate:pre-pr`. A rerun reuses
   passed stages for that exact head, base, gate version, and command. After any
   base change, rebase rather than merge, then rerun the gate; an attestation
   minted for the old base cannot be reused.
6. Publish each ready PR with `npm run pr:publish` (for a new PR, pass its title
   and body file after `--`; repeat `--label <name>` for each required label).
   The publisher makes an existing draft ready before pushing. It creates an
   unlabeled new PR as non-draft; for a labeled new PR, it creates a momentary
   draft with the labels and immediately marks it ready so the first
   CI-triggering event includes them. It pushes only the attested head and waits
   for CI and Greptile on that exact SHA.

## Standard Bead Loop

Every bead gets this bounded loop:

1. **Implement**
   - Claim the bead.
   - Add regression-first coverage for the core behavior.
   - Run focused tests and changed-file lint.
   - Commit and push stable checkpoints to the same-name non-main branch.
2. **Review gate (tiered — see Tiered review policy above)**
   - Baseline: UBS scan of the immutable commit range on every bead.
   - P0/P1: two blind cross-family reviewers; P2 and below: one cross-family reviewer, escalating only for unexpected high-risk surface.
   - Each engaged reviewer lane reviews the same immutable commit range against the bead and the risk standard below — in parallel, blind to the other reviewer's findings and to the implementer's self-assessment.
   - Reviewers first restate intent and assess whether the implementation has the
     right shape, then try to refute it with concrete failure scenarios.
   - Each reviewer separates blocking findings from nonblocking observations.
   - The orchestrator dedupes the reviews and **independently verifies every claimed blocking finding** against the risk standard before remediation. Reviewers systematically over-grade severity; a blocking finding requires reproducible evidence or a concrete failure path, not plausibility.
3. **Scoped remediation by the original implementer**
   - Fix only the independently verified blockers from the synthesized review.
   - Add focused regressions.
   - Commit and push the remediation without handing implementation to a reviewer.
4. **Closure-only verification**
   - A different-family reviewer checks only whether the accepted blockers are
     closed. It does not perform another general sweep or mint a new work queue.
   - A newly alleged P0/P1 requires both a concrete reproduction under the risk
     standard and severity corroboration from another model family.
   - One corroborated late blocker may receive one additional scoped fix-forward
     pass by the original implementer. That is the hard cutoff.
5. **Move on**
   - Integrate the final implementation fixed point into its wave branch.
   - If an important blocker remains after the cutoff, keep the PR unmerged, park
     the remote branch, and create a self-contained fix bead under the wave's fixes epic.
   - Put all nonblocking observations in the handoff report only.

The implementer never reviews its own work to generate new findings, reviewers
never become implementers, and no successive fresh review sweeps are allowed.
This preserves implementation context without reopening the overnight
review/remediation loop.

## Epic Seam Review (pre-PR gate)

Per-bead review is necessary but not sufficient. A per-bead review is scoped to one immutable range against one base; it is exhaustive *within* that scope but structurally blind to three defect classes that only exist once the epic is assembled:

- **Cross-bead interaction** — two beads each correct alone, wrong when composed (e.g. two beads independently threading a signal through the same file; only the assembled branch has both live at once).
- **Merge-resolution code** — the conflict resolutions written during integration are new code that no per-bead review ever saw.
- **Composite acceptance** — whether the *feature* works end-to-end across beads, when no single bead's acceptance test exercises the whole.

These are the "won't appear until it's all done" P1s. A worked example: in the mmo9.6 voice epic the cancellation-identity bead and the WebSocket-interrupt bead each passed per-bead review, but the composite did not deliver barge-in in production — a production-glue file that neither bead owned never wired the abort signal into the model-generation RPC, so an interrupt released local state while the model kept generating. No per-bead review could have flagged it; it is a pure seam defect.

Therefore, after the last bead of an epic integrates and before its train opens a
PR to `main`, run an **epic seam review** on the assembled wave branch. This is
not a re-review of every bead—it targets only the delta per-bead review could not see:

1. every merge-resolution diff produced during integration;
2. every file or contract touched by two or more beads in the epic (enumerate them from the integration history);
3. the epic's stated end-to-end acceptance paths, exercised as a whole **through the production composition** — not merely each bead's unit seam or a test double;
4. anything a per-bead handoff explicitly flagged as a cross-bead or "won't appear until it's all done" concern.

Run it as a **dual blind cross-family adversarial pass**, because it is the last
gate and the stakes are the entire epic. Verify every claimed blocker against
intent and the Blocking Risk Standard, then run one epic-level remediation round.
Epic-level blockers are fixed on the wave branch or as children of the `<epic>
fixes` epic—never by reopening an individual bead branch, because the defect
lives in the interaction. Re-verify only the accepted fixed items, then open the
PR. A late blocker follows the same corroboration and hard-cutoff rule as a bead.

Keep the two tiers distinct: the per-bead loop owns bead-local correctness and regressions; the seam review owns interaction, merge-resolution, and composite acceptance. Skipping either lets a whole class of P1 through — the per-bead loop alone ships integration bugs; the seam pass alone ships a giant undifferentiated diff with diffuse blame and an unbounded remediation loop.

## Implementation Completion and Tracker Closure

An implementation bead closes only after its integrated PR is merged. Record the worker and integrated commits, source and gate evidence, exact PR head, `ci-required`, Greptile, and merge. A green worktree or open PR is not completion. Manual, live, deployment, and release proof remain separate validation beads.

Closure happens **in the same motion as the merge**: the session that merges a
train closes every bead whose content that train delivered. In a direct-Dolt
lane, commit the Beads database and do not stage the ignored export. A remote-only
lane refreshes and commits `.beads/issues.jsonl` in the same train or an
immediately following chore commit. Closes must not ride a later train—deferred
closes are how other instances see phantom open work and re-litigate finished lanes.

Cross-instance status must not lie between trains: `in_progress` means a live lane owns the bead right now. A lane that stops working a bead for any reason — parked, blocked, handed off, session ending — resets it from `in_progress` before the session ends, with a note saying where the work stands.

## Blocking Risk Standard

IMPORTANT corresponds to tracker priority P0/P1. A finding receives IMPORTANT treatment only when it materially affects at least one of:

- partner-data security, privacy, authentication, or tenant isolation;
- companion welfare, consent, autonomy, trust, or safety;
- actual data loss, corruption, destructive cross-scope mutation, or secret exposure;
- a broken core acceptance path that prevents the feature from doing its stated job;
- a mandatory repository gate such as lint for changed code.

Address IMPORTANT findings through the bounded remediation and corroboration loop.
Any that remain after its hard cutoff move to the wave's fixes epic and prevent
the affected PR from merging until explicitly resolved.

The following are normally nonblocking unless concrete production evidence raises their severity:

- speculative or extremely narrow crash cuts;
- exotic inputs outside the supported contract;
- polish, maintainability, naming, or optional accessibility improvements;
- theoretical timing windows without material security, welfare, data, or core-path impact;
- unrelated inherited test or hygiene failures;
- improvements beyond the bead's explicit acceptance criteria.

Nonblocking observations belong in the report. Do not create backlog noise for them.

## Important Fix Beads and Fix Epics

Create a follow-up bead only for an outstanding important issue under the blocking risk standard.

Create or reuse one wave-specific epic named `<wave> fixes`. Every remaining important defect from the wave is a child of that epic.

Findings produced by remediation-phase or final-check reviews follow the same rule with no exception: a verified IMPORTANT finding becomes a child of the wave's fixes epic — never a standalone top-level bead — and is scheduled into the wave's own landing train or the immediately next one, not left to drift. Everything from those late reviews that falls below the Blocking Risk Standard goes in the handoff report only. Late reviews systematically drift toward pedantic and speculative findings; the standard, not reviewer confidence, decides what earns a bead. A wave whose reviews mint more open beads than the wave closes is a review-calibration failure to raise with the operator, not a normal outcome.

Close the fixes epic as soon as all of its real children are complete.

The bead must include:

- the exact source bead and `discovered-from:<id>` dependency;
- concrete file paths and relevant lines;
- the observed failure and why it matters;
- explicit scope and non-goals;
- checkable acceptance criteria;
- the branch and commit containing the current implementation;
- reproduction or validation evidence.

Important means a material defect in partner-data security, privacy, or isolation; companion welfare, consent, or autonomy; real data or secret safety; a core path; or a mandatory gate.

Lesser and report-only observations belong only in the wave report or output. They do not create beads and do not block implementation closure.

Assign each important fix as a fresh bounded task when needed. The original
implementer may resume it when preserving implementation context is useful, but
do not resume the same open-ended review loop or reopen completed implementation work.

## Separate Manual, Live, and Release Validation

Manual acceptance, live exercises, deployment checks, and release verification use a separate, named validation bead or validation epic.

Validation work may depend on the pushed implementation fixed point. It must never reopen or hold open an implementation bead or epic.

Record validation results on the validation bead. Do not rewrite implementation status to stand in for an unperformed live or release check.

## Local Gate, Publication, and Failure Handback

Install dependencies in a prewarmed worktree with
`npm ci --offline --ignore-scripts`, then run `npm run hooks:install` once.

### Checkpoint push versus publication

Commit and push ordinary non-main checkpoints as soon as they are coherent. The
pre-push hook protects the branch boundary: it rejects direct `main`, branch
deletion, a ref that does not match the checked-out branch, and ordinary
non-fast-forward history rewrites. It does **not** run the broad gate; a
checkpoint is remote backup, not certification.

Before publication, fetch, rebase rather than merge, commit a clean exact head,
and run `npm run gate:pre-pr`. `npm run pr:publish` independently requires that
exact-head attestation before it publishes status or creates/updates the PR.
When a rebase replaced a previously pushed head, the publisher alone uses an
attestation-checked, exact-remote `--force-with-lease`. Never use `--no-verify`
or manually force-push in the normal branch or PR flow.

### Gate phases and machine-wide heavy lock

The local gate has two phases:

- **PREFLIGHT** runs first without a lock and may run concurrently in every
  worktree. It covers CI rules, change budget, lint, build and typecheck,
  repository hygiene, Semgrep and UBS, settings and supply-chain checks, and
  deployment contracts.
- **HEAVY** runs the full test suite and serializes across the whole machine on
  the directory `<os-tmpdir>/psfn-local-gate-heavy.lock`. Its `meta.json` names
  the holder PID, worktree, command, and ISO start time. Waiters print the holder
  diagnostics every 15 seconds.

External sessions on the same host participate in the same lock, so operators
do not need to serialize them by hand. A stale lock whose PID is provably dead
is reclaimed automatically under a reap mutex. A lock without metadata is
reclaimed only after a 10-second orphan grace period. Never delete the lock
directory manually while the named PID is alive; check waiter diagnostics before
assuming the gate is hung.

### Exact-stage attestations and reruns

Each successful gate stage writes a record beneath
`.git/local-delivery-gate/stages/<head>/`, keyed by the exact head, base, gate
version, and command. Failed stages write no passing record. A rerun with the
same four inputs reuses the stages that passed and runs only failed or missing
stages, so a partial failure does not discard completed work. A different head,
base, gate version, or command cannot reuse the record, and the tooling cannot
bless a head that did not run. The whole-gate attestation is written only after
every required stage passes.

The pre-push hook protects checkpoint history by rejecting direct `main`,
mismatched branch refs, and non-fast-forward updates. The publisher—not ordinary
checkpoint push—rejects a missing or stale whole-gate attestation. After any base
update, rebase the branch and rerun the gate. The clean-main baseline's recorded
base and gate version make stale branch attestations visible immediately. The
publisher then updates the remote under an exact lease; ordinary checkpoint
pushes still cannot rewrite it.

### Change-budget inputs

When authenticated `gh` access is available, the change-budget check reads the
exception label and the required PR-body rationale from the open PR. Offline
operation must supply the explicit inputs documented in the header of
`scripts/ci/check-change-budget.mjs`; missing evidence fails closed, and the
budget is never silently skipped.

For an authorized exception, include the required rationale in the body file
and apply the label through the publisher:

```bash
npm run pr:publish -- --title "<title>" --body-file <path> \
  --label change-budget:exception
```

The calculation measures the PR-owned delta. Commits that only merge the current
base into a branch do not count toward its files, lines, or commit budget, so
normal base integration needs no misleading exception prose. Novel conflict
resolution introduced by such a merge still counts. Wave branches must
nevertheless rebase rather than merge when their base changes.

### Ready-before-push publication

Publish only with the tracked wrapper. For a new PR:

```bash
npm run pr:publish -- --title "<title>" --body-file <path>
```

Repeat `--label <name>` to apply one or more labels. The wrapper validates every
requested label before it pushes or publishes the remote attestation. A labeled
new PR is created as a momentary draft with all labels attached, then immediately
marked ready; this suppresses CI for the unlabeled `opened` payload and makes the
labeled `ready_for_review` payload the first CI-triggering event. Without
`--label`, new-PR creation remains directly non-draft.

For an already-open PR whose title and body do not need changes, run
`npm run pr:publish`. The wrapper marks an existing draft ready **before** it
pushes the attested head; it applies any requested labels before that push.
Earlier checkpoint pushes may back up work on a draft branch, but they do not
count as publication and intentionally receive no required CI/review authority.
The ready transition makes the certified head enter the publication pipeline.

The wrapper pushes only the attested head, publishes its authenticated
exact-base status, and verifies that both CI and Greptile target exactly that
pushed SHA. It fails loudly on head drift or a required check that reports a
SKIPPED conclusion; a required check GitHub never posts at all surfaces as the
wait timeout instead. Treat either as a defect to report; never close/reopen a
PR, rerun Actions, re-request Greptile, or toggle labels to manufacture events.
After checks pass, the wrapper prints every inline review comment and refuses
success while a live P0/P1-badged finding exists: a green review status is not
review completion — the paid review's findings must be triaged in the PR
thread, by every harness, before the publish counts as done.

On failure, return the evidence to the owning implementer. Review claims are
triaged under the cross-family bounded-remediation loop above; a P0/P1 badge is a
claim, not an automatic severity ruling. Gate each corrected exact head before
publication. When the hard cutoff is reached, park the pushed branch and surface
an operator-visible blocker. Never manually force-push or rewrite a shared
branch; the attested publisher's exact-remote lease is the sole exception.

### Publish-or-park (no stranded heads)

Every lane ends a session in exactly one of two states: **published**—its content
is on a PR train that merged or is awaiting checks—or **parked**—its branch and
checkpoint are pushed, and a bead note records the remote branch, exact head,
validation state, and blocker. A local-only branch or uncommitted worktree is a
protocol violation even when the work is incomplete: it is how work disappears.

Reserve the word **done** for merged-to-main with the bead closed. Earlier
states are named precisely — "implemented", "gated at `<head>`", "published,
awaiting checks" — in reports, handoffs, and bead notes alike. Declaring done
one step early is the root cause of cross-instance "done / not done"
contradictions.

If a required external check is unavailable — review credit exhausted, a
retired or never-posting check, a platform outage — publication halts as an
**operator-visible blocker**: park every affected lane with the note above,
stop opening further PRs into the dead pipeline, and surface the blocker in the
wave handoff and to the operator directly. Do not keep queueing publishes that
each burn a timeout window against a check that cannot pass.

Bead state remains on the authoritative local Dolt server. Run
`bd dolt commit --json`; only push Dolt state when a real remote is configured
and the operator has authorized it.

## Slow-Test Timing and Timeout Margins

Every integration test with an explicit timeout override must be registered in
`src/test-support/integration-timeout-registry.json`. The convention test fails
when an override is unregistered or has drifted from its entry. A measured entry
must preserve at least 2x headroom over its recorded baseline; inherited entries
remain pinned as measurement debt.

Never raise a timeout reactively. Measure the slow path, record the baseline,
then set a margin of at least 2x. Set `PSFN_TEST_TIMINGS=1` to print the
instrumented suites' per-phase timings on successful runs; failures always print
those timings.

## Integration

After the final check:

1. The orchestrator merges the bead branch into the pushed wave branch.
2. The orchestrator resolves conflicts once, preserving both feature intents without inventing new behavior.
3. A worker validates the integrated branch with focused tests and the exact-head local gate.
4. Assemble a coherent PR-sized train from the reviewed wave commits and publish
   it through `npm run pr:publish`; the wrapper waits
   for both required checks on the exact pushed SHA.
5. An independent lane validates and rebase-merges the PR.
6. Rebase the pushed wave branch onto the updated `main` before assembling the
   next train.
7. Close implementation beads with commit, source, local-gate, PR-head,
   external-check, and merge evidence; route remaining IMPORTANT defects to the fixes epic.
8. Assign the next ready bead.

Do not close a bead merely because its worker branch is green; tracker state follows merged delivery.

## Branch Reconciliation and Stale Tracker Cleanup

Reconcile tracker state one bead at a time. Do not batch-grep a list and infer completion from symbol presence or missing search results.

For each bead:

1. Read its full description and acceptance criteria.
2. Check commit history for the bead or its shipped equivalent.
3. Read the cited production source and meaningful test evidence.
4. Run the verification proportionate to the claimed work.
5. Close it with commit, file, and gate evidence if it is already shipped.

Close already-shipped stale beads instead of creating duplicates. Close an epic shell when every child is closed and no real scope remains.

If real scope remains, keep only that scope open in the correct implementation, fixes, or validation tracker structure.

## Review Report Format

One report per reviewer lane; the orchestrator synthesizes them and rules on each blocking claim before remediation.

```text
Verdict: PASS | FAIL
Immutable range: <base>..<head>
Intent: <the user/problem outcome in one sentence>
Shape: <core | plugin | skill | refactor | should not exist>, with reason
Implementer: <model> / <family>
Reviewer: <model> / <family>
Family independence: PASS | FAIL
Trust boundaries touched: <none or exact boundaries>
Agent navigability: <obvious names/pointers or concrete friction>

Blocking findings:
- <severity> <security/welfare/data/core category>: <path:line>, impact, remedy, test

Nonblocking observations:
- <observation for handoff only>

Validation:
- focused tests
- real PostgreSQL tests when applicable
- exact-head local gate
- `ci-required` and Greptile when reviewing a published head
- exact clean HEAD

After-build questions:
- What would you do differently now that it is built?
- What should be refactored while context is full?
- Are tests sufficient for intent and trust boundaries?
- Where does the documentation live?
```

A review must not use `FAIL` for nonblocking observations alone.

## Worker Handoff Format

```text
Bead: <id>
Branch/worktree: <branch> / <path>
Base and head: <base> / <head>
Remote checkpoint: origin/<branch> at <head> (required)
Implemented: <core behavior>
Validation: <commands and counts>
Blocking risks: <none or important bead ids>
Nonblocking observations: <report only>
Integration conflicts expected: <files or none>
Next action: review / remediation / integrate / publish
```

## End-of-Wave Handoff Format

Every wave handoff must make completed implementation distinct from remaining fixes and validation:

```text
Merged implementation epic: <id and close evidence>
Fix epic: <id and open child ids, or none>
Separate validation beads: <ids and purpose, or none>
Delivered PR/head: <number>@<sha>
Required checks: ci-required=<result>, Greptile Review=<result>
```

Do not collapse these fields into a generic "remaining work" list. Decision-makers must be able to see shipped implementation, important defects, and pending validation independently.

## Operational Boundaries

- Do not access or test against reviewer-host or `live-pi-host`.
- Do not use SSH for this workflow.
- Use local PostgreSQL and local runtime/cluster testing only when the bead requires it.
- Do not expand work into retired storage paths; separate removal beads own that cleanup.
- Do not destroy branches, worktrees, stashes, or shared Git state without operator approval.
- Do not dump the whole wave branch into `main`. Land coherent train branches by
  PR; direct-main delivery requires an explicit current operator override.
