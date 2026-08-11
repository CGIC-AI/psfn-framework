# Implementation-First Multi-Bead Process

## Purpose

Use this document only when several implementation beads are being worked as one
delivery wave. `AGENTS.md` and the current operator instruction take precedence.

The purpose of orchestration is to increase delivered functionality per unit of
time and model cost. It is not to maximize the number of lanes, reviews, tracker
events, attestations, or process artifacts. If orchestration is slower than one
agent implementing the work sequentially, do not orchestrate.

## 2026-08-03/04 Failure Review

The P1 runtime-truth wave demonstrated a process failure. Small changes reached a
passing, pushed train, but publication was delayed while agents repeated review,
tracker, bus, gate, and external-check work. The process consumed more attention
than the implementation and made a ready PR feel unfinished.

The causes were in this repository's own instructions:

| Cause | Negative effect | Replacement rule |
| --- | --- | --- |
| Review intensity was derived from bead priority. | A small P1 fix automatically paid for UBS plus two model reviews. | Priority orders work. Actual diff risk selects validation and review. |
| Review happened per bead and again at the assembled epic seam. | The same code was repeatedly reviewed, synthesized, remediated, and re-verified. | Review the final train once. Focused tests own bead-local correctness. |
| A second reviewer and closure reviewer were routine. | Review generated more review instead of implementation. | At most one independent reviewer by default. Add another only for a concrete unresolved high-risk question or an explicit operator request. |
| Every lane and phase generated bus traffic and tracker evidence. | Coordination artifacts became work with no downstream reader. | Use direct messages and concise bead notes by default. Use a bus only for concurrent writers who need durable shared findings. |
| Clean-main canary and broad gates were run before or during fanout. | Whole-repository certification ran before the final publishable diff existed. | Run focused checks while implementing and `gate:pre-pr` once on the frozen final train head. |
| PR publication waited synchronously for CI and Greptile. | A created, ready PR held the agent idle for up to 45 minutes and could spend paid review budget. | Publication ends when the PR is created. Checks are asynchronous; waiting is explicit opt-in. |
| Every bead became a separate PR and paid scan. | The operator reports about $230 spent this month, roughly 70% on low-value reviews, because even tiny PRs cost another flat-price scan. | Batch compatible beads into a train to amortize paid scans, but treat the 800-line floor as a guide: tag an under-floor PR as a variance and ship it rather than blocking or padding it. |
| Worktree isolation was confused with PR ceremony. | Removing worktrees would make concurrent agents and subagents collide, especially across overlapping systems. | Every concurrent writer gets a branch and worktree. Many worktrees may still integrate into one train and one PR. |
| Agents stayed with published work until merge and tracker closure. | Delivery monitoring displaced the next ready implementation. | Mark `published, awaiting checks`, return the URL, and move on. The merger or later reconciliation closes beads. |
| Implementation beads and epics stayed open after merge for manual or live validation. | Delivered work accumulated as apparently unfinished backlog for months. | Delivery to `main` closes the implementation bead or epic. Create a new testing/validation bead for every remaining proof; later failures create new bug beads and never reopen delivered implementation work. |

These are not suggestions. If any later section, older document, skill, or tool
default appears to recreate these loops, this section wins unless the operator
explicitly requests the extra work.

## Value and Time Guardrails

Before performing a process action, name which of these it buys:

1. prevents a concrete plausible defect in the current diff;
2. protects unpushed work from loss;
3. coordinates a concurrent writer who otherwise lacks needed information; or
4. satisfies the one final publication gate.

If none applies, skip it.

- Spend no more than 10 minutes on setup before the first useful implementation
  edit. The ordinary setup is `bd prime`, bead claim, target inspection, and
  branch/worktree verification.
- Keep coordination, review, tracker, and publication overhead below roughly 25%
  of active wave time. If it crosses that boundary, stop optional process and
  implement.
- Do not dispatch an agent merely to produce confidence, restate a diff, or check
  another agent's paperwork. Dispatch only a bounded independent implementation
  seam or a risk-triggered final-train review.
- Never leave an implementation lane idle while compatible ready functionality
  exists. A check, reviewer, or PR may continue asynchronously.
- Operator urgency words such as `ship`, `publish`, `hurry`, or `now` cancel all
  optional review and reporting. Complete only the minimum safe focused checks,
  final gate, and requested delivery.

## Choose the Smallest Topology

### One train lane is the default for one writer

Use one branch and worktree when:

- changes touch overlapping files or contracts;
- the same agent can implement them without blocking;
- setup and integration would cost more than parallelism saves; or
- the train is already comfortably within the hard PR limits.

One writer may claim and implement several compatible beads sequentially in one
train lane. Record each bead in the PR body; do not create a PR per bead.

### Worktree isolation is mandatory for concurrent writers

When two or more agents or subagents write concurrently, each writer uses a
distinct branch and worktree. This rule applies even when work touches the same
system or overlaps files: overlap requires explicit file ownership and integration
ordering, never concurrent edits in one checkout. Parallelism should still reduce
wall time enough to repay setup and conflict-resolution cost. Workers run focused
tests and push coherent checkpoints; they do not run broad gates or commission
reviews.

Do not open a wave branch, train branch, and bead branch when a single train
branch is sufficient. A wave integration branch is useful only for multiple
concurrent lanes or multiple PR trains.

```text
main
  └── train/<wave>-<n>          # default: one publishable lane

main
  └── wave/<wave>               # only when concurrent integration is needed
       ├── work/<bead-a>
       ├── work/<bead-b>
       └── train/<wave>-<n>
```

Use worktrees under `$HOME/ai/dev/worktrees/psfn-framework`. Worktrees are writer
isolation, not PR boundaries: integrate compatible lanes into one train. A lone
writer doing sequential work need not create one worktree per bead.

## Roles

### Implementer

The implementer owns the behavior through focused validation:

- reads and claims the scope;
- inspects the production entrypoint before designing a parallel abstraction;
- implements the smallest coherent fix or feature;
- adds regression coverage proportional to the changed behavior;
- runs focused tests and changed-file lint;
- commits and pushes coherent non-main checkpoints; and
- reports branch, head, focused validation, and any concrete remaining risk.

### Orchestrator

An orchestrator exists only when there are concurrent lanes. It keeps the intent,
assigns independent seams, resolves integration, assembles the train, and runs the
single final publication gate. It does not commission routine reviewer swarms,
duplicate worker investigations, or turn status reporting into a separate phase.

When one lane finishes, give it another independent implementation bead if that
saves time. Otherwise release it. Empty agent slots are not a defect.

## Train Composition and Change Budget

A bead is a scope and acceptance boundary, not a PR boundary. Combine compatible
ready beads into a coherent train.

Hard PR limits:

- 25 files;
- 2,500 counted changed lines; and
- 8 commits.

These limits are not set in stone: variances are fine when the change is
coherent. Tag an out-of-window PR `change-budget:exception` with a one-line
reason, then finish the work. Never reshape, split, or delay a ready change just
to fit the numbers.

Planning targets are 15 files, 1,500 lines, and 5 commits. They are suggestions,
not split points. A coherent commit may span up to the PR hard limits. The
publication floor is 800 counted changed lines because each PR can incur a flat
paid-review cost regardless of diff size. Hold and batch compatible ready work
when that is cheap; never add unrelated filler, and never delay a ready fix just
to reach the floor — tag the variance and ship it.

## Canonical Wave

1. **Select and group.** Read ready beads, group compatible work into a train, and
   identify only genuinely independent seams.
2. **Set up once.** Fetch the intended base. Create one train worktree, plus worker
   worktrees only for concurrent seams. Install dependencies only where missing.
   A whole-repository clean-main canary is not a routine prerequisite.
3. **Implement.** Workers make production and test edits, run focused checks, and
   push coherent checkpoints. No per-bead model review, UBS ceremony, or broad
   gate runs here.
4. **Integrate.** Assemble compatible commits into the train. Resolve conflicts
   once and exercise the affected production composition or contract with focused
   tests.
5. **Review only if risk-triggered.** Freeze the train and apply the review policy
   below. A low-risk train proceeds without a model review.
6. **Certify once.** Commit the clean final head and run `npm run gate:pre-pr` once.
   Fix attributed failures with focused commands before one new final-head run.
7. **Publish and leave.** Run `npm run pr:publish`, return the PR URL, mark beads
   `published, awaiting checks`, and assign the next implementation work. Do not
   wait for CI, Greptile, or merge unless the operator explicitly requests it.
8. **Close on main.** When the train lands on `main`, close every delivered
   implementation bead and implementation epic immediately with the merge
   evidence. If validation remains, create its new testing bead before closure.

## Proportional Review Policy

### Priority is not risk

P0/P1 means the outcome should be delivered soon. It does not imply that the diff
touches a dangerous boundary. Do not select reviewers from tracker priority,
changed-line count alone, or a desire for reassurance.

### No model review by default

Focused tests plus the final gate are sufficient for ordinary fixes, tests,
documentation, UI truth/display changes, local refactors, and owner-file changes
that stay within an existing validated contract.

### One independent review when concrete risk justifies it

Use one independent reviewer on the frozen final train when the diff changes one
or more of:

- authentication, authorization, tenant/companion isolation, secrets, or consent;
- destructive persistence, schema migration, backup/restore, or irreversible data
  mutation;
- concurrency, queue ownership, process boundaries, or distributed coordination;
- a new externally reachable execution surface;
- production deployment behavior with meaningful rollback risk; or
- a broad cross-subsystem contract whose failure is not covered by focused tests.

Give the reviewer the immutable base/head, intent, relevant acceptance criteria,
and exact risk question. The reviewer reports concrete reproducible blockers, not
general improvements. The implementer verifies and fixes accepted blockers once.
Do not schedule a closure reviewer; rerun the focused regression that proves the
fix.

When the operator selects the Pi review lane, new reviews use the exact model
selector `zai-coding-cn/glm-5.2`. Do not redo historical or already in-flight
reviews solely to update that selector.

### CLI delegation: Kimi first pass and Pi review

Run either CLI from the worktree it owns. Before invoking it, resolve the Bead,
branch, immutable base, and current head yourself; do not ask the model to infer
its assignment from the backlog. Prompts must name the outcome, owned files or
seam, acceptance criteria, allowed validation, prohibited actions, and the exact
handoff format.

Use Kimi Code with the exact `kimi-code/kimi-for-coding` selector for a bounded
implementation pass. The orchestrator claims and updates the Bead; Kimi owns only
the named worktree and branch:

```bash
BEAD_ID="psfn-framework-..."
WORKTREE_PATH="$HOME/ai/dev/worktrees/psfn-framework/<lane>"
BASE_SHA="<full-base-sha>"

cd "$WORKTREE_PATH"
test "$(git rev-parse HEAD)" = "$BASE_SHA"
kimi --auto --model kimi-code/kimi-for-coding --prompt "
Read AGENTS.md and the complete Bead $BEAD_ID before editing.
You own only this worktree and its current non-main branch.

Outcome: <one concrete implementation outcome>.
Owned seam/files: <paths or symbols>.
Acceptance: <paste the relevant checkable clauses>.
Validation: run focused tests and changed-file checks only.

Do not work another Bead, mutate Beads/Dolt, open a PR, merge, deploy, touch live
state, or run broad gates. Preserve unrelated changes. Implement the smallest
coherent solution, commit it, push the current branch, and stop.

Return exactly: branch and full head SHA; implemented behavior; focused commands
and results; remaining concrete risk or blocker; next action for the orchestrator.
"
```

When the operator explicitly requests the two-model review sequence, Kimi is the
first-pass reviewer. Run it against a clean immutable head and save its output.
The prompt is read-only even though Kimi needs normal tool access to inspect the
repository and run a focused reproduction:

```bash
BEAD_ID="psfn-framework-..."
WORKTREE_PATH="$HOME/ai/dev/worktrees/psfn-framework/<review-lane>"
BASE_SHA="<full-base-sha>"
HEAD_SHA="<full-head-sha>"
REVIEW_OUT="/tmp/${BEAD_ID}-kimi-review.txt"

set -o pipefail
cd "$WORKTREE_PATH"
test "$(git rev-parse HEAD)" = "$HEAD_SHA"
test -z "$(git status --short)"
kimi --auto --model kimi-code/kimi-for-coding --prompt "
Perform a read-only first-pass review of Bead $BEAD_ID over the immutable range
$BASE_SHA..$HEAD_SHA. Read AGENTS.md, the complete diff, and the affected
production path and tests.

Acceptance: <paste the complete relevant Bead clauses>.

Look only for concrete correctness, security, isolation, data-loss, or acceptance
blockers introduced by this range. You may run a focused reproduction. Do not edit
files, mutate Git or Beads, open or inspect PRs, read prior model-review output, or
run the broad gate.

Return VERDICT: PASS or VERDICT: BLOCK. For every blocker give severity, file and
line, violated acceptance clause, causal path, and a reproducible check. Separate
nonblocking observations. State every command you actually ran.
" | tee "$REVIEW_OUT"
test "$(git rev-parse HEAD)" = "$HEAD_SHA"
test -z "$(git status --short)"
```

The implementer verifies and fixes accepted Kimi blockers. Then freeze the new
head and give Pi a blind independent review; do not include the Kimi transcript or
verdict in the Pi prompt. Every new Pi review uses
`zai-coding-cn/glm-5.2` exactly:

```bash
BEAD_ID="psfn-framework-..."
WORKTREE_PATH="$HOME/ai/dev/worktrees/psfn-framework/<review-lane>"
BASE_SHA="<full-base-sha>"
HEAD_SHA="<full-final-head-sha>"
REVIEW_OUT="/tmp/${BEAD_ID}-glm52-review.txt"

set -o pipefail
cd "$WORKTREE_PATH"
test "$(git rev-parse HEAD)" = "$HEAD_SHA"
test -z "$(git status --short)"
pi --approve --no-extensions --no-skills --no-prompt-templates \
  --model zai-coding-cn/glm-5.2 --thinking medium \
  --name "${BEAD_ID}-glm52-review" \
  --tools read,grep,find,ls,bash --print "
Independently review Bead $BEAD_ID over immutable range $BASE_SHA..$HEAD_SHA.
Read AGENTS.md, the complete diff, and the affected production path and tests.

Acceptance: <paste the complete relevant Bead clauses>.

This is a blind review: do not read Agent Bus, Bead notes, prior model output, PR
discussion, or review artifacts.

Look only for concrete correctness, security, isolation, data-loss, or acceptance
blockers introduced by this range. You may run a focused reproduction. Do not edit
files, mutate Git or Beads, open a PR, merge, deploy, touch live state, or run the
broad gate.

Return VERDICT: PASS or VERDICT: BLOCK. For every blocker give severity, file and
line, violated acceptance clause, causal path, and a reproducible check. Separate
nonblocking observations. State every command you actually ran.
" | tee "$REVIEW_OUT"
test "$(git rev-parse HEAD)" = "$HEAD_SHA"
test -z "$(git status --short)"
```

If either post-run integrity check fails, the review is invalid: preserve the
unexpected changes for inspection and do not treat its verdict as independent
evidence. Do not automatically rerun Kimi after a fix or commission a third
reviewer. Verify the accepted blocker locally, add its focused regression, and
continue unless the operator explicitly asks for another review.

A second model reviewer is exceptional. It requires either an explicit operator
request or one concrete high-impact claim that remains materially ambiguous after
the first review and local reproduction. Never use two reviewers merely because
the bead is P0/P1. Never run per-bead review plus train/epic review.

Greptile is a paid, explicitly triggered review. Repository configuration limits
automatic review to PRs carrying `review:greptile` and disables repeat review on
pushes. Do not apply that label, mention the bot, or otherwise trigger a review
unless the operator explicitly requests the spend; priority alone is never enough.
The service is unavailable until its next renewal, so do not request it while the
credit pool is disabled. When requested after renewal, apply the label once to the
frozen final train, never per bead, and triage findings asynchronously.

## Focused Validation and One Final Gate

During implementation:

- run the smallest test that exercises the changed behavior;
- run adjacent contract checks only when the changed boundary demands them;
- run changed-file lint or typecheck where relevant; and
- never run the full suite after each edit, checkpoint, bead, or integration.

Before the final gate, verify only:

1. the train is within hard limits and based on the intended fetched base;
2. the worktree and branch are correct and clean;
3. focused tests for all included beads pass;
4. accepted risk-review blockers, if any, are covered; and
5. no planned source edit remains.

Then run `npm run gate:pre-pr` on the committed final head. The gate owns broad
PREFLIGHT and HEAVY checks. Its exact-head attestation is reused by
`npm run pr:publish`; do not invoke the gate again on the unchanged head.

If the gate fails, reproduce the specific failed stage, fix its verified cause,
and run that focused command to green. Finish all source edits before committing
one new final head and invoking the broad gate once more. Do not commission a
model review of a gate failure unless the fix itself introduces a risk trigger.

## Publication Is Asynchronous

Publish through the tracked wrapper:

```bash
npm run pr:publish -- --title "<title>" --body-file <path>
```

The default command validates the exact-head attestation, pushes the branch,
creates or updates the ready PR, prints its URL, and returns. CI and external
services continue asynchronously.

Only when the operator explicitly asks this session to monitor checks, opt in:

```bash
npm run pr:publish -- --wait --title "<title>" --body-file <path>
```

Do not poll a PR in the foreground, spend a subagent on passive waiting, repeatedly
rerun Actions, re-request Greptile, or toggle labels to manufacture events. The
waiter requires Greptile only when `review:greptile` is present. A
later merge/triage session handles failures and closes delivered beads. If a
required check is unavailable, report that fact; it does not undo implementation
or justify waiting on every other ready lane.

## Delivery Closure and Testing Split

An implementation bead's lifecycle ends when its implementation is present on
`main`. The merging session or the next reconciliation sweep closes it
immediately and cites the main commit or merged PR. Do not keep implementation
beads or epics open for manual, live, deployment, regression, release, or
acceptance testing.

If proof remains after delivery, create a new testing or validation bead before
closing the implementation bead. The new bead must:

- use `kind:chore` and `system:testing` unless a more specific testing contract
  is already canonical;
- link `discovered-from:<implementation-id>`;
- name the exact environment, command, fixture, or observable evidence required;
- define independent pass/fail acceptance criteria; and
- create a new bug bead for any failure it discovers.

Never reopen the delivered implementation bead, and never keep an implementation
epic open as a testing umbrella. This split does not weaken focused checks or the
single pre-PR gate on the implementation train; it prevents post-delivery testing
from falsifying implementation status.

## Tracker and Handoff Discipline

Beads should preserve state without becoming a second implementation:

- one claim before edits;
- a checkpoint note only when another session may need to resume;
- one publication note with branch, exact head, focused tests, gate result, and PR;
- immediate implementation closure after merge by the merging session or the
  next reconciliation sweep, with any remaining proof moved to a new testing
  bead.

Do not append command-by-command progress, duplicate the same evidence across
multiple beads, or keep an agent idle to close a bead in the same motion as merge.
Use the status `published, awaiting checks` accurately.

A worker handoff needs only:

```text
Beads: <ids>
Branch/head: <remote branch>@<sha>
Implemented: <outcome>
Validation: <focused commands and final gate if run>
Concrete remaining risk: <none or exact risk>
Next action: integrate | publish | async checks | fix <failure>
```

## Bus Use

Direct agent messages, commits, and bead notes are the default. Open an agent bus
only for two or more concurrent writers who need durable cross-lane findings and
when that record will reduce rather than add coordination time.

Do not open a bus merely because a wave has multiple phases or reviewers. Do not
install an embedding model, embed every message, deduplicate routine status, or
make bus lint a publication gate unless the run actually relied on the bus as its
handoff record.

## Git and Operational Safety

- Push coherent non-main checkpoints so work is remotely durable.
- Direct pushes to `main` remain prohibited without a current explicit operator
  exception.
- At assignment and before the first edit, every writer and subagent verifies its
  explicit worktree path, owned branch, HEAD, and expected base. Repeat the check
  before commit, merge, cherry-pick, rebase, or revert; abort on mismatch.
- Never manually force-push, delete worktrees/branches/stashes, or rewrite shared
  history. The exact-head publisher is the only normal lease-protected update path.
- Preserve fail-closed security and configuration contracts.
- Live deployment remains operator-directed and follows `docs/operations.md`.
- Manual, live, deployment, and release validation are separate work. They do not
  reopen a completed implementation loop or delay unrelated feature work; track
  them in new testing beads whose failures create new bugs.
