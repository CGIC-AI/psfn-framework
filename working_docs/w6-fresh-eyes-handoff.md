# W6 Fresh-Eyes Handoff

## Fixed point and boundaries

- Worktree: `/home/ada/ai/dev/worktrees/psfn-framework/icp-autonomy`
- Branch: `feat/icp-autonomy`
- Pre-handoff code HEAD: `72238bc8952a063efd236cf21e0a0afc6d81fd42`
  (`fix(icp): own idle queue ingress`)
- Upstream: `refs/remotes/origin/feat/icp-autonomy` at
  `f864831a10010a0b12732d21df74331de7ee08ed`; this is also the merge base.
- Before this document, the worktree was clean, 0 behind / 16 ahead, and the W6
  commits were unpushed. The document commit is intentionally not self-recorded;
  use `git log -1 --oneline` for its hash.
- Do not use main, live infrastructure, SSH, the Pi/PSFN-PI, or a Dolt remote.
  The separate dirty SQLite worktree was not entered, edited, cleaned, or tested.

The branch is a review candidate, not a finished feature branch. Do not merge it
and do not close either W6 bead before the review and test-gate debt below is
resolved.

## Tracker state

`psfn-framework-s10mc.6.6` is **in progress**, claimed by `axAilotl`, and has not
been closed.

Exact title:

> [S10 ICP] Integrate soft conversational allowance, social charge, closeout
> reserve, and cross-channel anti-evasion

Scope: extend the existing `FatigueBudgetPort` and charge system so autonomous
ICP begins naturally, becomes progressively intentional, and stops at fatigue
plus the configured one-to-two response closeout reserve. It covers a
relationship/channel/intent-derived soft allowance (roughly 6–8 combined
messages for an ordinary trusted conversation, not a universal hard count),
shared activity observability, per-companion fatigue/choice, the
`companion_social` charge lane, prompt-visible maturing/charge/wrap/final states,
typed continuation evidence, marginal charge policy, deterministic overcharge
triggers plus reviewed ICP continuation evidence, hard suppression after fatigue
and reserve exhaustion, decaying initiation pressure, causal-root anti-evasion
across channels/episodes, daily-reset review, Garden telemetry, and strict
charge-policy owner schema/tests. Non-goals are human-attention fatigue,
unlimited importance exemptions, dollar accounting, and shard budgets.

Acceptance: policy tests must prove relationship/channel/intent-sensitive
allowance, progressive guidance, the social charge switch, bounded continuation,
finite closeout, and final suppression; human turns remain free; companions keep
independent fatigue choices; channel hopping and recursive episodes cannot reset
relationship pressure; decline/silence and elapsed time affect initiation
pressure without daily quotas; strict config/Garden metadata exists; existing
fatigue regressions, targeted tests, settings-contract, build, and lint pass.

Dependencies recorded on `.6.6`:

- Parent-child: `psfn-framework-s10mc.6`, still **open**.
- Blocked by `psfn-framework-s10mc.6.1`, **closed**.
- Downstream, `.6.7` and `.6.8` depend on `.6.6`; neither may treat it as done.

The parent epic remains open. `.6.5` is in progress and `.6.7`–`.6.9` are open.
Use `bd show psfn-framework-s10mc.6.6 --json` and
`bd show psfn-framework-s10mc.6 --json` as the exact tracker authority; do not
infer parent completion from this branch.

### Pushed W1–W4 baseline

The upstream fixed point `f864831a` contains the four closed, independently
reviewed ICP workstreams:

- `.6.1` contracts/durable state: implementation fixed point `39b74962`.
- `.6.2` deterministic availability/permit broker: `3f184c49`.
- `.6.3` target-channel continuity: `0365ab43`.
- `.6.4` canonical contact/availability/notify tooling: code `43453c61`, status
  document `f864831a`.

Their detailed evidence is in their bead close reasons. Do not re-audit or
duplicate it unless a W6 interaction specifically challenges it.

## W6 commit line

The local W6 range is `f864831a..72238bc8`, ordered oldest to newest:

1. `484072be` — durable social fatigue regulation.
2. `63c6fb6a` — initial W6 validation record.
3. `c730a9c2` — shared fatigue reservation lifecycle hardening.
4. `a8647eac` — hardened validation record.
5. `1d4b00bd` — second-round fatigue review gaps.
6. `c040a62c` — fail-closed recovery seams.
7. `fe9e0223` — restart recovery seams.
8. `393111b2` — replay identity and candidate scheduling.
9. `42f2970a` — candidate dispatcher registration and recovery binding.
10. `faae4fe5` — observed-recovery and production candidate-notify binding.
11. `d47d4057` — remediation gate record.
12. `c19b16da` — candidate notify scope isolation.
13. `8a1dc0fe` — prompt harness binding to turn tools.
14. `ca2b3d5b` — candidate notify turn isolation.
15. `3d9578eb` — reservation of all candidate run ingress.
16. `72238bc8` — ownership of idle queue ingress.

The latest code adds an explicit FIFO coordinator for idle `followUp`/`steer`
inputs, keeps ordinary active-run queuing, and integrates that coordinator with
the exclusive candidate-turn reservation. See the commit diff and the key files
below instead of relying on this summary alone.

## Validation evidence at `72238bc8`

Latest recorded gates:

- Focused W6 selection: **216/216 passed**.
- `src/core/agent/substrate-agent.test.ts`: **131/131 passed**.
- `npm run lint`: passed.
- `npm run build`: ESM and DTS passed.
- `npm run verify:repository-hygiene`: passed.
- `git diff --check`: passed.
- `npm run verify:settings-contract`: passed at the `c19b16da`-era checkpoint;
  later commits through `72238bc8` do not change settings/config owners.
- Fallow: `/tmp/fallow-w6-c19b16da.json`, exit 0. Review found no new W6
  boundary, policy, dependency-cycle, catalog, unresolved-reference, or clone
  signal; remaining output was broad complexity noise. This scan predates
  `8a1dc0fe..72238bc8`, so it is evidence, not a substitute for reviewing those
  queue/tool-isolation commits.

Do **not** claim the latest full suite passed. Two normal full-suite attempts
completed all test assertions with **720 files / 8,342 passed / 3 skipped**, but
Vitest exited 1 both times because of a late unhandled `ENOENT` involving a
session path matching `*.jsonl.write-lock`. The exact named test
`SubagentFaculty > cancels active bounded workers without crossing into shard semantics`
passes **1/1** when isolated.

### Unresolved full-suite teardown failure

Known:

- Reproduced twice after otherwise-green normal full-suite runs.
- The unhandled error arrived late around the unrelated subagent cancellation
  teardown and referenced a missing `*.jsonl.write-lock` path.
- Relevant code surfaces are
  `src/faculties/subagents/faculty.test.ts` (the cancellation test and synchronous
  temp-root deletion), `src/faculties/subagents/faculty.ts` (cancel/run lifecycle),
  and `src/persistence/sessions/store.ts` (journal write-lock creation/removal).
- The isolated cancellation test passed 1/1.
- No bead currently matches `write-lock`, `subagent cancellation`, or `ENOENT`.

Unknown:

- The exact generated temp path and full stack were not preserved in a durable
  log available to this handoff.
- Causality is not proven. A plausible race is late canceled-worker/session work
  outliving test cleanup, but do not record that as the diagnosis without a
  controlled reproduction.
- The root interrupted immutable read-only diagnosis before repeated isolated or
  serialized full-suite runs. No serialized verdict exists and no bead was
  created.

Treat this as a test-gate issue, not as a confirmed W6 correctness or security
defect. Use the diagnosing-bugs workflow only if the orchestrator explicitly
assigns this investigation.

## Review state and current risk

The exact code HEAD `72238bc8` has had **no independent immutable review**.
`.6.6` still requires **two fresh, sequential independent reviews**. Review #2
has never started: each previous review-#1 attempt found a High, remediation
changed the fixed point, and the two-review sequence reset. A review of an older
hash does not count for `72238bc8`.

There is no currently confirmed open W6 correctness or security defect after
`72238bc8`. The open W6 risk is review debt concentrated in the newest ownership
fix: a fresh reviewer must try to break candidate isolation with idle and active
follow-up/steer, ordinary message, observation, error/cancellation, raw pending
queue, tool phase, post-turn phase, and detached-descendant interleavings. The
review must also verify that the fix did not make ordinary ingress disappear,
duplicate, lose attribution, or enter the candidate's prompt/tool scope. This is
an unverified attack surface, not a statement that a defect exists.

Keep the unrelated ENOENT test-gate problem separate. Until it is explained or
a clean full-suite exit is obtained, the branch cannot honestly claim a green
latest full suite even if both W6 reviews pass.

## Implemented and test-covered invariants

These are the intended invariants to verify against source, not substitutes for
the fresh reviews:

- The existing per-companion fatigue engine stays authoritative; a shared
  Postgres reservation/root fence adds cross-process last-slot serialization,
  restart durability, and DM/room/episode anti-reset without creating a second
  fatigue engine.
- Human-authored turns remain free. Autonomous ICP progressively enters the
  `companion_social` lane, exposes wrap/final-closeout state, and cannot mint
  reserve through importance.
- Recovered target-channel observations must bind correlation/channel/source and
  fatigue state before model, gateway, permit, journal, consume, or delivery
  effects.
- Candidate execution starts at the dispatcher registered by
  `buildAgentControlPlane`, rechecks live capability/registration/overlay policy,
  and exposes `notify` only for that candidate turn.
- A candidate turn owns provider, tool, and post-turn phases exclusively.
  Foreign ingress waits and resumes as an ordinary attributed turn; candidate
  descendants cannot escape their owner.
- Idle follow-up and steer inputs run as fresh FIFO ordinary turns rather than
  entering the raw agent queue. A candidate start fails closed if accepted raw
  ordinary queue ingress is still pending.

## Key artifacts

Planning/status:

- `working_docs/s10-icp-autonomy.md`
- `working_docs/sprint-10-next-steps.md` (its W6 hash/status text predates the
  latest queue-isolation commits; use this handoff plus git for the fresh review)
- `bd show psfn-framework-s10mc.6.6 --json`

Primary implementation/review surface:

- `src/core/agent/substrate-agent.ts`
- `src/core/agent/substrate-agent/turn-run-reservation.ts`
- `src/core/agent/substrate-agent/turn-queue-ingress.ts`
- `src/core/agent/substrate-agent/tool-runtime-facade.ts`
- `src/app/agent/icp-autonomy-candidate-dispatcher.ts`
- `src/app/agent/control-plane.ts`
- `src/app/agent/icp-target-channel-initiation.ts`
- `src/app/agent/icp-target-channel-recovery.ts`
- `src/core/agent/fatigue/`
- `src/core/agent/substrate-agent/turn-execution/icp-fatigue-regulation.ts`
- `src/persistence/postgres/icp-fatigue-regulation-reservation-store.ts`

Primary tests:

- `src/core/agent/substrate-agent.test.ts`
- `src/core/agent/substrate-agent/tool-runtime-facade.test.ts`
- `src/core/agent/substrate-agent/turn-execution-runtime.test.ts`
- `src/app/agent/icp-autonomy-candidate-dispatcher.test.ts`
- `src/app/agent/icp-target-channel-initiation.test.ts`
- `src/persistence/postgres/icp-fatigue-regulation-reservation.integration.test.ts`

## Recommended first commands

Read-only orientation:

```bash
pwd
git status --short --branch
git log --oneline --decorate f864831a..HEAD
git show --stat --oneline 72238bc8
git diff --check f864831a..72238bc8
bd show psfn-framework-s10mc.6.6 --json
bd show psfn-framework-s10mc.6 --json
```

Only if the root explicitly assigns ENOENT reproduction:

```bash
npm test -- src/faculties/subagents/faculty.test.ts -t "cancels active bounded workers without crossing into shard semantics"
npm test -- --no-file-parallelism --maxWorkers=1
```

Do not mutate the bead, implementation, tests, branch, or external state during
an immutable review.

## Bounded takeover prompt

> Independently adversarial-review exact W6 code fixed point `72238bc8` on
> `feat/icp-autonomy`, read-only. Confirm the worktree and hash first. Read
> `AGENTS.md`, bead `psfn-framework-s10mc.6.6`, the W6 plan, and the actual diff
> `f864831a..72238bc8`. Focus on the newest candidate-run/queue-ingress ownership
> boundaries and then verify recovery and fatigue invariants were not regressed.
> Attempt concrete interleavings across idle/active follow-up, steer, ordinary
> message, observation, tool, post-turn, error/cancel, pending raw queue, and
> detached descendant paths. Report PASS or findings with severity, exact source
> references, and a reproduction. Do not edit, commit, close beads, push, merge,
> use main/live/SSH/Pi, or touch a Dolt remote. Review #2 may start only after a
> fresh review #1 passes on the unchanged hash.

## Suggested skills

1. `adversarial-review` — use first for each immutable W6 review.
2. `diagnosing-bugs` — use only if separately assigned the ENOENT teardown issue.
3. `beads-bv` — use for graph-aware read-only tracker triage if needed.
4. `beads-workflow` — use only when the orchestrator authorizes tracker mutation
   after review/validation; do not mutate beads during the immutable review.
