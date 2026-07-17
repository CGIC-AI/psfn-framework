# Reflection gating and multi-admin escalation design note

**Bead:** `psfn-framework-opl1.16`

**Status:** Open design record; no runtime behavior is authorized or implemented by this note

**Date:** 2026-07-17

## Binding policy while this design remains open

The current privacy boundary remains unchanged:

1. Routine human visibility is limited to the viewer's self/co-subject scope, as established by a current executable subject projection. A role such as owner or admin is not a subject relationship and does not widen that scope.
2. Missing, stale, invalidated, ambiguous, unattributed, unbound, or otherwise unprovable subject classification fails closed before IDs, counts, snippets, embeddings, prompt previews, bodies, or derived content are constructed. Multi-subject records remain hidden unless a later accepted design defines and implements an authorization rule for them.
3. OPL1.15 is the exclusive non-subject privacy break-glass path. It requires trusted/local ingress, an identified principal, user-verified WebAuthn, an exact companion/action/resource selector, a stated reason, bounded expiry, single-use confirm-then-decide semantics, and complete content-free audit evidence. Discord possession, `mfa_enabled`, OAuth consent, an owner/admin role, a legacy token, or a trusted-host recovery credential alone cannot satisfy it.
4. Any future multi-admin review is an additional, conjunctive requirement inside OPL1.15. It cannot become an alternate route around OPL1.15, a routine owner/admin inspection path, or a substitute for any of OPL1.15's existing ceremony.
5. This note does not authorize routine human access to reflection artifacts, including owner-only access. Until an artifact has an accepted, executable subject projection, it remains hidden from human-facing surfaces; companion-private processing remains process-local.

“Self/co-subject” therefore describes the privacy invariant, not an any-subject rule. A viewer being one participant in a multi-subject record does not, by itself, prove that disclosing the whole record is safe.

## Live implementation map

The open design has to fit these existing contracts rather than create a parallel privacy system.

| Area | Current implementation | Design consequence |
| --- | --- | --- |
| Subject projection | `src/shared/contracts/memory-subject.ts` defines single-contact, multiple-contact, shared-room, companion-private, unbound, unattributed, and ambiguous classes, along with classification revision, classifier version, evidence digest, and invalidation state. | Reflection-derived artifacts need equally executable provenance. A label without versioned evidence and invalidation semantics is insufficient. |
| Classification | `src/faculties/memory/subject-classification.ts` classifies reflection, heartbeat, shard, and system/shard-scope memory as companion-private. Multiple explicit contacts become multiple-contact or shared-room; inconsistent evidence becomes ambiguous. | Source-type defaults are useful, but cannot prove that a human-readable reflection is safe for a particular subject after it combines inputs. Ambiguity must deny. |
| Pre-construction memory gate | `src/faculties/memory/postgres-store/subject-policy.ts` checks current classification, exact classifier version, source revision, and evidence digest before constructing results. It denies ambiguous, unattributed, and unbound records. | Future reflection and multi-subject gates must be pre-construction and cover metadata as well as bodies. Post-query redaction is not enough. |
| Effective product policy | `src/faculties/memory/subject-authorized-store.ts` currently permits a human contact context only for a single-contact record with a self relation; process-local companion context is limited to companion-private memory. The lower SQL primitive has a co-subject branch for multiple-contact/shared-room data, but the product wrapper does not enable it. | The current effective behavior for multi-subject memory is fail-closed. A dormant lower-level capability is not an accepted product decision and must not be activated incidentally. |
| Garden body access | `src/operator/garden/services/memory-body-gate.ts` requires a current exact projection with one single-contact subject matching the viewer. | Garden already supplies a strong model for exact, pre-body enforcement. Equivalent reflection surfaces must not infer access from role or route possession. |
| Reflection scope | `src/core/scheduler/heartbeat-template-runtime.ts` can run a reflection in canonical-contact/DM scope or in group scope. Group scope deliberately drops the canonical contact and retains room continuity. | A room-scoped run has no single viewer identity to inherit. Room membership cannot silently become proof of authorization over every contributing subject. |
| Reflection evidence | `src/core/scheduler/reflection-introspection-policy.ts` allows bounded read-only introspection in agent mode, including memory and session tools. `src/core/agent/substrate-agent/turn-execution/pre-turn-state.ts` and `src/faculties/memory/retrieval.ts` propagate a canonical contact to the subject-authorized memory store when one is present; a self-directed no-contact run is process-local. | The earlier concern that reflection reads “all memory” is no longer literally true for the current memory-store path: DM retrieval is subject-bound and no-contact scheduler retrieval is companion-private. The residual risk is broader: sessions, contact bundles, internal state, substrate evidence, and transformed summaries can still combine or indirectly reveal subject-scoped facts. Prompt instructions are not authorization. |
| Reflection outputs | `src/core/scheduler/heartbeat-template-runtime.ts` can write the result to reflection, daily-reflection, reflection-metacognition, and values journals, optionally publish it to a vault, and optionally send a heartbeat through Discord. | Input gating alone cannot close the privacy boundary. Every derived artifact and every sink needs compatible provenance and an authorization decision. |
| Fleet authorization | `src/boundary/fleet-auth/garden-route-authorization.ts` models subject relationships, `privacy_break_glass`, and conjunctive approval requirements such as CogSec plus an independent reviewer. `src/boundary/fleet-auth/role-action-policy.ts` grants actions by role but does not establish subject relationship. | Existing assurance and independent-review primitives are candidates for reuse after a decision. They do not currently authorize privacy disclosure, and role action grants must remain orthogonal to subject authorization. |

Garden values/reflection routes are currently action/role-oriented rather than subject-projected. They are a future enforcement seam, not evidence that reflection content is safe to expose. The vault, Discord, and journal paths also mean that fixing only Garden would leave the disclosure graph open.

## Reflection gating: closure over inputs, artifact, and sinks

A reflection is a derived artifact. Its privacy projection cannot safely be chosen only from the scheduler scope or output destination. It must be derived from the evidence actually admitted to the run and remain attached to the result through every write or send.

The minimum closure model for a future design is:

```text
authorized inputs
  -> bounded reflection execution
  -> versioned derived-artifact subject projection
  -> per-sink pre-construction authorization
  -> content-free decision audit
```

The derived projection should conservatively inherit the union of contributing subjects and the most restrictive unresolved state. Missing provenance, a stale input classification, an unattributed session, an unresolved multi-subject input, or a sink that cannot enforce the projection must make the artifact non-disclosable. A later source invalidation must make already-derived authorization stale rather than leaving a permanently valid copy.

Three broad models remain open:

- **Per-subject generation.** Construct a reflection from inputs already authorized for one exact subject, record that subject and the complete evidence basis, and permit only that subject's viewer relation. This gives the clearest routine human boundary but may omit shared context or create divergent accounts.
- **Union/taint projection.** Admit multiple inputs, attach the full union of subjects and unresolved states to the result, and require a future multi-subject authorization rule at every sink. This preserves context but is likely to leave many artifacts intentionally undisclosable.
- **Companion-private reflection.** Treat reflections as process-local derived state with no routine human view. Human disclosure would remain available only through OPL1.15. This is the safest default and matches the current source-type classification, but reduces product observability.

An owner-only exception is not a valid fourth model. It would confuse administrative authority with subject relationship and would bypass the binding self/co-subject rule.

An accepted design must answer all of the following before implementation:

- Whether DM reflection may produce a single-subject artifact, and which non-memory inputs must be proven subject-compatible before that projection is valid.
- Whether a group/room reflection is always companion-private or may carry a multi-subject projection; room membership alone must not be treated as complete subject evidence.
- Whether summaries, values updates, metacognition entries, prompt previews, and journal metadata are separate derived artifacts or one linked derivation graph.
- How vault publication, Discord delivery, Garden display, export, search, count, snippets, embeddings, telemetry, backups, and replay enforce the same projection without existence leaks.
- How classifier-version changes, source edits/deletion, contact merges/splits, and provenance invalidation revoke or reclassify already-produced artifacts.
- Whether content-free observability can expose a reflection's existence, state, or failed decision without revealing subject identity or sensitive content.

Until those questions are decided and implemented, reflection artifacts without a proven single-subject self/co-subject projection remain unavailable to routine human viewers.

## Multi-subject rows: fail-closed default

The current product wrapper denies routine access to multiple-contact and shared-room memory even though the lower SQL policy has machinery for a co-subject relation. That is the correct default while the meaning of co-subject disclosure remains undecided.

Possible future policies have materially different privacy properties:

| Candidate | Meaning | Principal risk |
| --- | --- | --- |
| Any-subject access | Any named participant may read the entire row. | One participant learns facts attributable to another participant or private context embedded in the same row. |
| All-subject/joint authorization | Disclosure requires a valid relationship or approval for every projected subject. | Consent/identity lifecycle, unavailable participants, revocation races, and proof composition become security-critical. There is currently no subject-consent workflow. |
| Per-subject derived view | Produce a separately classified and evidence-backed view for one subject. | Redaction or summarization can preserve indirect disclosures and needs provenance closure of its own. |
| Break-glass only | No routine view; exact non-subject access uses OPL1.15. | Operational friction, but the boundary is explicit and auditable. |

No candidate is selected here. The binding behavior remains: if a row or derived artifact names A and B, authorization as A does not imply access to B's contribution, authorization as B does not imply access to A's contribution, and an inability to prove the safe projection denies the whole result. “Both” is not implemented as a routine consent state; “neither” is the current result. This denial applies before existence-bearing metadata, not only to the body.

A later design must also define what happens when the subject set changes, one identity becomes unbound, one approval expires, one participant is removed from a room, or the source evidence is invalidated. Manually supplied contact IDs, room presence, owner/admin status, and historical participation cannot substitute for a current projection.

## Multi-admin escalation: only inside OPL1.15

Multi-admin escalation could reduce unilateral abuse during exceptional disclosure, but it is not itself a privacy authority. If adopted, its place is as an additional conjunct in OPL1.15 after the request has already satisfied the trusted-ingress, principal, user-verification, exact-target, reason, expiry, and single-use requirements.

The existing fleet authorization contract demonstrates that multiple approval requirements can be conjunctive and that an independent reviewer can be represented separately from CogSec approval. That is an implementation precedent only. A future privacy decision still needs to define:

- **Independence:** whether the requester, confirmer, reviewer, and CogSec approver must be distinct principals, and how shared devices or delegated credentials affect that proof.
- **Quorum and eligibility:** how many reviewers are required, which narrowly scoped capability qualifies them, and why owner/admin rank alone is insufficient.
- **Request binding:** how every approval is cryptographically or transactionally bound to the same companion, action, exact resource selector, reason, expiry, and content-free evidence digest.
- **Time and state:** approval order, expiry, cancellation, subject-projection changes, reviewer role removal, credential revocation, and concurrent decisions.
- **Single use and replay:** how a completed or failed ceremony cannot be replayed, broadened, or applied to a neighboring record, export, prompt preview, or derived artifact.
- **Failure behavior:** missing, stale, conflicting, duplicated, or unavailable approval denies without falling back to one administrator or a lower assurance level.
- **Audit and privacy:** how to prove who requested, reviewed, confirmed, and decided, and why, without copying protected content or subject-identifying material into logs.

Even a unanimous quorum must not authorize a wildcard query or general browsing session. The result remains one exact, bounded, audited OPL1.15 disclosure decision. There is no subject-consent workflow in this proposal, and multi-admin approval must not be mislabeled as consent from the affected subject.

## Future implementation seams, if a later decision is accepted

This note does not schedule or authorize implementation, but the live code suggests the following ownership boundaries for a future bead:

- Extend the shared subject/provenance contracts rather than introduce a reflection-only identity model.
- Compute a versioned derived-artifact projection from admitted inputs at the reflection orchestration boundary.
- Enforce the projection in a shared sink gate used by every journal, values, vault, Discord, Garden, search, export, and replay path.
- Keep human memory/profile/reflection access behind the same pre-construction subject policy; do not widen access in route handlers or role policy.
- Add a privacy-specific conjunctive approval ceremony to OPL1.15 only if separately accepted, reusing assurance and reviewer primitives without inheriting unrelated route permissions.
- Test IDs, counts, snippets, embeddings, prompt previews, bodies, outputs, error shape, and audit evidence so denial cannot leak existence or content.

## Required invariants for any future proposal

A future proposal is incomplete unless its tests can demonstrate these invariants:

1. A role grant never creates a subject relationship.
2. A subject relationship never bypasses OPL1.15 for non-subject content.
3. Multi-admin approval never replaces or weakens an OPL1.15 requirement.
4. A reflection's authorization is no broader than the union of its contributing evidence, and unknown evidence makes it non-disclosable.
5. Every sink enforces the same current projection before constructing existence-bearing output.
6. Stale classification, changed evidence, expired approval, replay, partial quorum, or unavailable policy fails closed.
7. Self/co-subject routine semantics remain intact for records with an accepted executable projection; ambiguous and unresolved multi-subject material remains hidden.
8. OPL1.15 remains the one exclusive non-subject break-glass path.

## Decision boundary

This note intentionally leaves reflection projection, multi-subject routine visibility, and multi-admin quorum semantics undecided. The fail-closed behavior above is the operative decision until a later, separately accepted design is implemented end to end. No part of this document grants owners, admins, reviewers, room members, or reflection viewers a new runtime capability.
