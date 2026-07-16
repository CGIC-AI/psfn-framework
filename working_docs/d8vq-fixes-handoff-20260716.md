# d8vq fixes wave — handoff (2026-07-16)

Epic `psfn-framework-d8vq` (follow-ups from the mmo9.7 P2 polish reviews): all five children implemented, single-pass Pi-reviewed (@high), remediated where verified, merged to `feat/mmo9-7-fixes`. One P1 was found and fixed (d8vq.1). Everything below is **nonblocking**, recorded per the delivery loop, deliberately not filed as beads — except the one item explicitly flagged for an operator decision.

## Verified-and-fixed
- **d8vq.1 P1:** the first-cut per-final WS scan swallowed split phrases (`["don't","stop"]` → silent drop). Fixed `8890c5a9f7`: per-final classification is authoritative only for control-only sessions (every non-empty final classifies as a control; last-wins on mixed intents); mixed-content sessions defer to the joined-transcript verdict. Deliberate safe-direction trade: content-then-"stop" multi-final sessions go to the model (pre-existing documented limitation).

## ⚑ Operator-decision item (from d8vq.2's review; pre-existing, inherited from mmo9.7.4)
`preemptionProtected` is **caller-asserted**: any client that can send a workSpec over the RPC boundary can self-declare preemption protection and dodge foreground preemption for that attempt. mmo9.7.4's welfare design intended escalation to be **supervisor-granted**. d8vq.2 did not introduce or widen this (the field existed in-process before), but the wire now makes the assertion crossable. If welfare escalation is meant to be privileged, a follow-up should make the gateway strip/deny caller-supplied `preemptionProtected` unless the supervisor granted it (e.g. a signed/queue-side marker instead of a request field).

## Nonblocking observations

### d8vq.1 (voice)
- Involuntary WS disconnect path is not covered by the leave-reset analogue (Discord-only fix was in scope); WS reconnect semantics unchanged.
- Interim/partial transcripts are never control-scanned (finals only) — prior behavior, documented.

### d8vq.2 (RPC work-spec)
- `LLMClient` does not forward `options.workSpec` to an injected `transport` (client.ts ~1178/~1647) — latent only for a hypothetical direct-transport autonomous composition production doesn't use; such a composition already fails the agent-side recorder guard.
- Version skew: old-agent→new-gateway is byte-identical legacy (absent spec); new-agent→old-gateway silently drops the spec at the old gateway (guard then enforces only in-process, i.e. the pre-d8vq.2 status quo) — acceptable during rollout, worth knowing.

### d8vq.3 (drift tests)
- EXPLAIN assertions prove the lane index is *selectable and selected* for lane-filtered queries under `enable_seqscan=off`, not globally optimal; hand-written SQL mirrors (not derives from) the store's builder; CHECK regex takes the first textual occurrence (fails red on surprises). Three LOW robustness notes, all safe-direction.

### d8vq.4 (subagent televis)
- The new integration test's comment overstates a throw path that cannot occur (parity is tautological for builder-produced specs); test still pins the collapsed-visibility behavior. Cosmetic.

### d8vq.5 (appraisal cache)
- `engaged:true` accounting quirk on the observability side is pre-existing (not introduced).
- `viewerMemorySubjectContactId` empty on the appraisal lane is by design (no per-contact content in the appraisal system prompt).

## Validation
Tip validated with the combined suites (llm, voice, discord voice, subagents, emotion, gateway, PG integration incl. drift round-trips, turn-observability) — result recorded in the PR description. UBS on every diff; the single new-code critical flagged all wave was a false positive (`tokenCeiling !== undefined` matching a secret-comparison heuristic).
