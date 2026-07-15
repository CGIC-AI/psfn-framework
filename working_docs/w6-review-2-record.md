# W6 Review #2 Record — fixed point `72238bc8`

Date: 2026-07-14. Fresh, sequential, independent review conducted after review
#1 passed (see `working_docs/w6-review-1-record.md`). The reviewer was blind to
all review-#1 findings and to the docs-only record commits, and reviewed the
unchanged code fixed point `72238bc8` on `feat/icp-autonomy`
(`git diff 8a1dc0fe~1..72238bc8`, ~1,993 lines). Read-only; targeted vitest
files re-run green at the hash.

## Verdict

**Review #2: PASS at `72238bc8`. No High or Medium defect with a traced
deterministic failure. The two-fresh-reviews requirement on
`psfn-framework-s10mc.6.6` is discharged at this hash.**

## Invariants verified as holding

1. **Candidate exclusivity + descendant seal** — triple-guarded: writer-only
   grant when `activeReaders === 0` with writer preference (no starvation);
   `assertNotCandidateDescendant` throws on any re-entry whose inherited
   AsyncLocalStorage attribution is `candidate-turn` (attribution persists
   after settle); `candidateScopeActive` flips false in `finally`, denying
   detached descendants even inside a still-live ALS snapshot.
2. **Fail-closed candidate start** — verified into the vendored dependency:
   `agent.hasQueuedMessages()` (`pi-agent-core/dist/agent.js:186`) covers both
   `steeringQueue` and `followUpQueue`, so any residual raw ingress refuses
   `handleIcpAutonomyCandidateTurn`.
3. **Notify scoping** — delegate-ALS reference equality plus
   `candidateScopeActive` plus live origin/request-context/capability/overlay
   re-validation; catalog, health map, adaptive state, and promoted-tool
   mutations are all candidate-scoped.
4. **No lost/duplicated/mis-attributed ingress** — verified the by-reference
   `message_start` splice in `observeAgentEvent` actually fires: injected
   follow-ups reach `emit(message_start, message)` by reference
   (`agent-loop.js:95`) while assistant `message_start`s are spread-cloned and
   can never false-match; the `enqueued` flag prevents re-enqueue.
5. **Recovery/fatigue non-regression** — the four commits touch no
   fatigue/recovery code; the exclusive reservation is strictly stronger than
   the removed `agent.waitForIdle()`; every production `agent.prompt` call runs
   inside `runWithTurnToolContext`, so the new fail-closed hard-throw in
   `resolveInstalledAgentTurnTools` cannot fire on a production main-agent turn.

## Low observations (not blocking; folded into existing beads)

- **O1 — fresh-ordinary `agent.prompt` TOCTOU.** Between a fresh-ordinary
  run's `agent.prompt` and its `agent_start` event, a concurrent
  `handleMessage` could hit pi-agent-core's "Agent is already processing"
  throw. Self-healing (both `finally` releases fire, no lock leak), loud, and
  mirrors the pre-existing concurrency contract; no deterministic reachable
  interleaving found. → appended to `psfn-framework-7eke`.
- **O2 — FIFO idle test fidelity gap.** The "multiple idle follow-up and steer
  inputs as fresh ordinary FIFO turns" test spies on `Agent.prototype.prompt`
  and never fires `agent_start`, so it does not exercise the
  `activePiQueueOwner` coalescing it appears to. → appended to
  `psfn-framework-7eke`.
- **O3 — whisper flush is `handleMessage`-only.** Same mechanism as review
  #1's cross-validated finding; delayed, never lost, and fails in the safe
  direction against candidates. → already tracked as `psfn-framework-srr2`.

Residual assumption (low risk): the scheduler loop variant
(`agentLoopWithScheduler`, not vendored in-repo) preserves the stock loop's
by-reference `message_start` emission for injected follow-ups; the stock loop
does and tests pass.

## Outcome for `psfn-framework-s10mc.6.6`

Both required fresh independent reviews have now passed on the unchanged code
fixed point `72238bc8`. The remaining blocker to closing `.6.6` is the
full-suite test gate: the late unhandled `ENOENT *.jsonl.write-lock` teardown
failure, tracked as `psfn-framework-k510` (recorded as blocking `.6.6`). Do not
close `.6.6` or merge the branch until `k510` is resolved and a clean
full-suite exit is recorded.
