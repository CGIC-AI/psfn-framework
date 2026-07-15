# W6 Review #1 Record — fixed point `72238bc8`

Date: 2026-07-13. Orchestrated as three independent, mutually-blind adversarial
reviews of the unreviewed W6 surface (`8a1dc0fe~1..72238bc8`), each given the
handoff invariants and explicit severity calibration (High requires a traced
failure interleaving; PASS is a valid verdict). None of the three saw another's
output. The orchestrator then verified every disputed claim against source
before grading.

## Verdict

**Review #1: PASS at `72238bc8`. No High findings. No confirmed Medium W6
defects. The fixed point does not move.**

Reviewer verdicts:

- Reviewer A (deep-reasoner): **PASS**, 3 Low/hardening notes. Re-ran focused
  suites at the hash: `substrate-agent.test.ts` 131/131,
  `tool-runtime-facade.test.ts` 22/22.
- Reviewer B (Opus): **PASS**, 2 Low/hardening notes. Independently re-ran the
  same focused suites green.
- Reviewer C (Codex): PASS-with-findings — no High, three claimed Mediums. All
  three de-escalate on verification (below).

## Invariants verified as holding (by at least two independent reviewers)

1. Candidate exclusivity: `handleIcpAutonomyCandidateTurn` runs under
   `turnRunReservation.runExclusive`; the writer is granted only when
   `activeReaders === 0`; foreign ingress computes `deferredFromExclusive`
   synchronously (no TOCTOU vs `writerActive`) and resumes as an ordinary
   attributed turn. Reservation release is in `finally`; verified for throw and
   cancellation legs.
2. Descendant seal: `assertNotCandidateDescendant` checks the AsyncLocalStorage
   attribution kind regardless of the `active` flag, so detached candidate
   descendants that outlive the callback still throw on any public re-entry
   (followUp/steer/handleMessage/observeMessage/abort). Proven by
   `substrate-agent.test.ts` detached-descendant assertions.
3. Fail-closed candidate start: `assertCandidateQueueEmpty` executes inside the
   exclusive callback after all readers drain; no new raw
   `agent.followUp`/`steer` can land once `writerActive` is set, closing the
   check-to-start window. The errored-loop test proves a pending accepted raw
   follow-up refuses the candidate and is later drained exactly once with
   attribution intact.
4. Notify scoping: `withCandidateExecutionGuard` denies all tools during a
   candidate turn except `notify` through the delegate ALS context;
   `candidateScopeActive` clears in `finally`; post-scope re-invocation fails
   the authorizer. No outward or inward scope leak found.
5. No lost/duplicated/mis-attributed ordinary ingress: record-on-success-only
   in `trySteerActiveRun`; deferred paths re-run as fully attributed ordinary
   turns; exactly-once redelivery proven in tests.
6. Recovery/fatigue non-regression: `git diff 8a1dc0fe~1..72238bc8` touches no
   fatigue/recovery/reservation-store source; those invariants hold by
   construction of the range.
7. RW lock hygiene: no reservation leak, no writer starvation (readers queue
   behind a head exclusive), no lost-wakeup or double-drain (grants resolve
   promises; `drain` never re-enters).

## Codex claimed Mediums — disposition after verification

1. **FIFO inversion via async author resolution** (`substrate-agent.ts`
   `trySteerActiveRun` awaiting `resolveAuthorContext` before the coordinator
   assigns FIFO position; a later system followUp can start first and the
   earlier steer then joins its raw queue as normal active-run steering).
   Mechanism is real; Reviewer A independently found the same and graded Low:
   FIFO position is call-order, callers are serialized per channel, and no
   cross-source global arrival-order invariant exists. Steering into an active
   ordinary run is accepted behavior. **Disposition: Low, hardening bead.**
2. **Idle internal whisper starvation** (`deferInternalFollowUp` pendings are
   flushed only from public `handleMessage`; coordinator-created fresh turns
   via `handleMessageUnderReservation` bypass the flush). Three-way convergence
   on the mechanism — the strongest cross-validated observation. Indefinite
   starvation requires a pathological all-fresh-turn sequence with no real
   inbound message ever; realistic effect is bounded delay of a self-note, no
   loss or duplication. **Disposition: Low/Medium boundary, fix as a follow-up
   bead (flush pendings on the fresh-ordinary path too), not a review reset.**
3. **Candidate post-turn background work outlives exclusivity** (background
   post-turn tasks are drained by the *next* full turn's `awaitPostTurnDrain`;
   the observation path awaits only auto-compaction). Verified against history:
   the observation path's compaction-only await predates the reviewed range
   (introduced with passive channel ingestion, `69d25921`); W6 only wrapped it
   in `runIngress`. The overlap applies identically to ordinary turns and leaks
   no candidate capability (notify deauthorized, descendant seal blocks
   re-entry). **Disposition: pre-existing design, out of W6 scope; optional
   hardening bead.**

## Low/hardening notes carried forward

- Flush `pendingOrdinaryInternalFollowUps` when coordinator-created fresh
  ordinary turns start, not only in public `handleMessage`.
- Assign FIFO position before awaiting author-context resolution (or document
  that ordering is call-order per serialized caller).
- Add dedicated unit tests for `turn-run-reservation.ts` and
  `turn-queue-ingress.ts` (currently integration-covered only).
- Add a test pinning that deferred intention whispers are never dropped and
  only ever refuse (never leak into) a candidate turn.
- `resolveInstalledAgentTurnTools` hard-throw (`agent-loop-patch.ts`) is a
  deliberate fail-closed tightening; no untested loop path found that runs
  outside a bound tool-turn context.

## Test-gate status (unchanged)

The full-suite late `ENOENT *.jsonl.write-lock` teardown failure remains a
separate, unexplained test-gate issue (see the fresh-eyes handoff). It is not a
W6 correctness finding and was excluded from reviewer scope. A bead should
track it; none exists yet.

## Loop post-mortem

Previous rounds reset because each review reported "a High," remediation moved
the hash, and the two-review sequence restarted. The three-reviewer round shows
the Highs were a severity-calibration artifact: under the traced-interleaving
bar, the same mechanisms grade Low. Going forward: only a High with a concrete
traced interleaving moves the fixed point; Medium/Low findings become beads.

## Next step

Review #2 (fresh, sequential, blind to this record) proceeds on the unchanged
hash `72238bc8`.
