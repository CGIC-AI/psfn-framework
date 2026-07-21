# Parallel Bead and Feature-Branch Process

## Purpose

This is the operating contract for multi-agent implementation waves. It keeps broad gates and internal review local, batches compatible work into economical PRs, and reserves GitHub for a small clean-environment delta plus Greptile.

Use this with `AGENTS.md`; current operator instructions and `AGENTS.md` take precedence. Portable setup is in [`internal-review-workflow.md`](./internal-review-workflow.md).

## Roles

### Orchestrator

The orchestrator does not implement feature code. It:

- selects ready beads and feature boundaries;
- creates feature branches, bead branches, and worktrees;
- assigns one worker to each worktree;
- keeps two or three independent worker lanes active when dependencies allow;
- resolves merges and merge conflicts;
- routes reviews, validation, tracker updates, and handoffs;
- publishes the assembled exact head and returns external failures to its owning lane.

### Worker

Each worker owns one bead and one worktree. It:

- reads `AGENTS.md`, runs `bd prime`, reads the full bead, and claims it;
- implements only its assigned scope;
- runs focused validation and commits stable checkpoints;
- reports the exact branch, commit, validation, and remaining risks.

Workers do not merge into feature, release, or main branches.

### Model lineup (current)

- **Orchestrator: Claude (Fable)** — plans, decomposes, dispatches, synthesizes, integrates. Never bulk-reads code itself; investigation/search fan-out runs on opus/sonnet subagents (see CLAUDE.md subagent model rule).
- **Worker / primary implementer: Codex** — `gpt-5.6-sol`. Scale reasoning effort to bead difficulty: `high` for routine/small beads, `xhigh` only for genuinely hard work (novel design, concurrency, security-sensitive paths). Effort is a large latency multiplier; do not default to xhigh.
- **Reviewer A: Opus 4.8** @ high.
- **Reviewer B: Pi agent** — GLM 5.2 @ xhigh, an independent third harness. Dispatched identically to Reviewer A and blind to Reviewer A's findings. Engaged per the tiered review policy below, not on every bead.
- Claude-side tool/dispatch wiring for these roles lives in `CLAUDE.md`.

### Tiered review policy (2026-07-14 operator decision)

Every bead gets a UBS scan of the change range as a cheap baseline gate before any model review. Then:

- **P0/P1 beads: dual blind adversarial review** (Reviewer A + Reviewer B, both mandatory).
- **P2 and below: one adversarial reviewer is fine** (alternate A/B to avoid single-harness blind spots).
- **Escalation:** if the single review or UBS scan looks suspicious — multiple blocking findings, a messy or surprising implementation, or touches to security/welfare/data paths that were not expected — add the second blind reviewer before synthesis. The two reviews stay blind to each other regardless of when they are dispatched.

The verification rule is unchanged at every tier: the orchestrator independently confirms every claimed blocker against the Blocking Risk Standard before remediation.

## Branch and Worktree Shape

Large epics roll up to feature branches. Individual beads use short-lived work branches based on the feature branch.

```text
main or release branch
  └── feat/<epic>
       ├── work/<epic>-<bead-a>
       ├── work/<epic>-<bead-b>
       └── work/<epic>-<bead-c>
```

Use worktrees under:

```text
$HOME/ai/dev/worktrees/psfn-framework/
```

Typical setup:

```bash
git worktree add -b feat/<epic> <feature-worktree> <approved-base>
git worktree add -b work/<epic>-<bead> <bead-worktree> feat/<epic>
```

A bead is an ownership boundary, not automatically a paid PR boundary. Batch compatible small beads into one coherent unit; do not buy a standalone Greptile review for a routine tiny patch when it can safely join the next unit. Target at most 25 files, 1,500 counted changed lines, and 5 commits; the hard limits remain 25 files, 2,000 lines, and 8 commits. Do not mix unrelated work or pad a diff.

When a coherent feature completes its final check, publish it the same session through `gh gated-pr`. An independent lane validates the exact head and uses GitHub's rebase merge after `ci-required` and `Greptile Review` pass. Do not squash or create merge commits. Live deployment remains operator-driven.

## Parallel Work Format

Run three worker lanes plus the orchestrator by default; drop below three only when ready independent beads run out. Prefer independent seams; do not create fake parallelism across tightly coupled files. Serial single-lane waves pay full wall-clock latency with no amortization — a difficult bead in one lane must not idle the other two.

Track the live wave in this format:

| Lane | Bead | Worktree | Branch | Base | State | Pushed checkpoint | Next gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | `<bead-id>` | `<path>` | `work/<name>` | `feat/<epic>@<sha>` | implementation/review/remediation/validation | `<sha>` | `<specific next action>` |
| B | `<bead-id>` | `<path>` | `work/<name>` | `feat/<epic>@<sha>` | implementation/review/remediation/validation | `<sha>` | `<specific next action>` |
| C | `<bead-id>` | `<path>` | `feat/<name>` | `<base>@<sha>` | implementation/review/remediation/validation | `<sha>` | `<specific next action>` |

When a lane finishes, immediately assign the next ready independent bead. A difficult bead must not monopolize the worker pool.

## Standard Bead Loop

Every bead gets this bounded loop:

1. **Implement**
   - Claim the bead.
   - Add regression-first coverage for the core behavior.
   - Run focused tests and changed-file lint.
   - Commit a stable checkpoint.
2. **Review gate (tiered — see Tiered review policy above)**
   - Baseline: UBS scan of the immutable commit range on every bead.
   - P0/P1: both reviewer lanes; P2 and below: one reviewer lane, escalating to the second when the first review or the UBS scan looks suspicious.
   - Each engaged reviewer lane reviews the same immutable commit range against the bead and the risk standard below — in parallel, blind to the other reviewer's findings and to the implementer's self-assessment.
   - Reviewers are prompted to refute the work with concrete failure scenarios, not to approve it.
   - Each reviewer separates blocking findings from nonblocking observations.
   - The orchestrator dedupes the reviews and **independently verifies every claimed blocking finding** against the risk standard before remediation. Reviewers systematically over-grade severity; a blocking finding requires reproducible evidence or a concrete failure path, not plausibility.
3. **One remediation**
   - Fix the verified blocking findings from the synthesized review.
   - Add focused regressions.
   - Commit the remediation.
4. **One final check**
   - Confirm the remediation and required gates.
   - Do not start another review/remediation cycle.
5. **Move on**
   - Integrate the final implementation fixed point into its feature branch.
   - If an important blocker remains, create a self-contained fix bead under the wave's fixes epic for a fresh agent.
   - Put all nonblocking observations in the handoff report only.

The same agent must not repeatedly fix findings generated by successive fresh reviews. A newly discovered blocker does not authorize another pass.

## Epic Seam Review (pre-PR gate)

Per-bead review is necessary but not sufficient. A per-bead review is scoped to one immutable range against one base; it is exhaustive *within* that scope but structurally blind to three defect classes that only exist once the epic is assembled:

- **Cross-bead interaction** — two beads each correct alone, wrong when composed (e.g. two beads independently threading a signal through the same file; only the assembled branch has both live at once).
- **Merge-resolution code** — the conflict resolutions written during integration are new code that no per-bead review ever saw.
- **Composite acceptance** — whether the *feature* works end-to-end across beads, when no single bead's acceptance test exercises the whole.

These are the "won't appear until it's all done" P1s. A worked example: in the mmo9.6 voice epic the cancellation-identity bead and the WebSocket-interrupt bead each passed per-bead review, but the composite did not deliver barge-in in production — a production-glue file that neither bead owned never wired the abort signal into the model-generation RPC, so an interrupt released local state while the model kept generating. No per-bead review could have flagged it; it is a pure seam defect.

Therefore, after the LAST bead of an epic integrates and **before** the PR to main opens, run an **epic seam review** on the assembled feature branch. This is NOT a re-review of every bead — it targets only the delta per-bead review could not see:

1. every merge-resolution diff produced during integration;
2. every file or contract touched by two or more beads in the epic (enumerate them from the integration history);
3. the epic's stated end-to-end acceptance paths, exercised as a whole **through the production composition** — not merely each bead's unit seam or a test double;
4. anything a per-bead handoff explicitly flagged as a cross-bead or "won't appear until it's all done" concern.

Run it as a **dual blind adversarial pass** (two independent reviewers), because it is the last gate and the stakes are the entire epic. Verify every claimed blocker against the Blocking Risk Standard, then run **one** epic-level remediation round. Epic-level blockers are fixed on the feature branch or as children of the `<epic> fixes` epic — never by reopening an individual bead branch, because the defect lives in the interaction, which belongs to no single bead. Re-verify the fixed items, then open the PR.

Keep the two tiers distinct: the per-bead loop owns bead-local correctness and regressions; the seam review owns interaction, merge-resolution, and composite acceptance. Skipping either lets a whole class of P1 through — the per-bead loop alone ships integration bugs; the seam pass alone ships a giant undifferentiated diff with diffuse blame and an unbounded remediation loop.

## Implementation Completion and Tracker Closure

An implementation bead closes only after its integrated PR is merged. Record the worker and integrated commits, source and gate evidence, exact PR head, `ci-required`, Greptile, and merge. A green worktree or open PR is not completion. Manual, live, deployment, and release proof remain separate validation beads.

## Blocking Risk Standard

IMPORTANT corresponds to tracker priority P0/P1. A finding receives IMPORTANT treatment only when it materially affects at least one of:

- partner-data security, privacy, authentication, or tenant isolation;
- companion welfare, consent, autonomy, trust, or safety;
- actual data loss, corruption, destructive cross-scope mutation, or secret exposure;
- a broken core acceptance path that prevents the feature from doing its stated job;
- a mandatory repository gate such as lint for changed code.

Address IMPORTANT findings in the one remediation pass. Any that remain move to the wave's fixes epic and prevent the affected PR from merging until explicitly resolved.

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

Assign each important fix to a fresh agent when needed. Do not keep the original worker in a review loop or reopen the completed implementation work.

## Separate Manual, Live, and Release Validation

Manual acceptance, live exercises, deployment checks, and release verification use a separate, named validation bead or validation epic.

Validation work may depend on the pushed implementation fixed point. It must never reopen or hold open an implementation bead or epic.

Record validation results on the validation bead. Do not rewrite implementation status to stand in for an unperformed live or release check.

## Local Gate, Publication, and Failure Handback

Run `npm ci && npm run hooks:install` once per worktree. Before any push, fetch and rebase, commit a clean exact head, then run `npm run gate:pre-pr`. The gate owns full lint, build, typecheck, repository hygiene, proportional tests, Semgrep, UBS, budgets, and applicable specialist checks. Its attestation is valid only for the exact head and base; the pre-push hook blocks missing or stale attestations, direct `main`, and recursion. Never use `--no-verify`.

Publish only with `gh gated-pr --title "<title>" --body-file <path>`. It pushes the attested head, publishes an authenticated exact-base commit status, and waits for `ci-required` plus `Greptile Review`. GitHub uses one complementary delta runner and one status aggregator; drafts allocate no runners, labels do not retrigger CI, and local lint/Semgrep/UBS are not repeated.

On failure, the publisher returns evidence to the owning lane. Make at most one evidence-driven corrective commit and publish the new exact head once. Never rerun Actions, re-request Greptile, toggle labels to manufacture events, or start another review/fix loop. A second failure is an operator-visible blocker. Keep stable checkpoints green and push them through the hook; never force-push or rewrite a shared branch.

Bead state remains on the authoritative local Dolt server. Run `bd dolt commit --json`; only push Dolt state when a real remote is configured and the operator has authorized it.

## Integration

After the final check:

1. The orchestrator merges the bead branch into the feature branch.
2. The orchestrator resolves conflicts once, preserving both feature intents without inventing new behavior.
3. A worker validates the integrated branch with focused tests and the exact-head local gate.
4. Publish the coherent branch through `gh gated-pr` and wait for both required checks.
5. An independent lane validates and rebase-merges the PR.
6. Close implementation beads with commit, source, local-gate, PR-head, external-check, and merge evidence; route remaining IMPORTANT defects to the fixes epic.
7. Assign the next ready bead.

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
```

A review must not use `FAIL` for nonblocking observations alone.

## Worker Handoff Format

```text
Bead: <id>
Branch/worktree: <branch> / <path>
Base and head: <base> / <head>
Remote backup: origin/<branch> at <head>, or blocked reason
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
- Do not merge feature branches into main during the implementation wave; when the wave completes, open the PR to main immediately (see Branch and Worktree Shape).
