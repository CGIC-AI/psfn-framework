# Automata Bus event contract

Automata Bus is durable learned state for ephemeral PSFN workers. It records compact claims,
their evidence, and later changes to their standing. It is not a transcript store, a developer
coordination bus, or a replacement for the companion's own L2 memory.

The executable v1 contract is
[`src/faculties/automata/bus/contract.ts`](../src/faculties/automata/bus/contract.ts).
The language-neutral fixtures live under
[`src/faculties/automata/bus/conformance/v1`](../src/faculties/automata/bus/conformance/v1).

## Canonical v1 model

Every event belongs to one companion and carries a monotonically increasing sequence, a stable
event ID, a canonical timestamp, and structured work context:

- automaton class, run ID, and task ID;
- source session IDs and artifact references;
- an optional parent run ID.

A `finding` contains a claim, provenance, structured evidence, and verification state. Computed
claims require evidence, fetched claims require external evidence, testimony identifies its
source, and recalled claims remain pending until evidence supports them. Verification is separate
from provenance: verified or rejected findings identify the reviewer and the evidence or artifact
digest used for that judgment.

A `relation` explicitly corrects, supersedes, or retracts the current end of a finding lineage.
Corrections and supersessions contain a complete replacement finding. Retractions do not. A
relation may target only an earlier current lineage end, so competing branches are rejected and
every implementation derives the same current state. Audit history remains immutable.

The `finding-relations-v1` must-understand token owns relation semantics. A reader that encounters
a newer schema generation or an unsupported token returns `not-understood` and does not inspect
the event body. Malformed data from a generation the reader does understand is rejected, including
unknown fields. This distinction lets a future event remain intact without letting an old reader
guess at its meaning.

Postgres will be the canonical runtime store. A semantic index is derived, disposable state: it
may accelerate recall, but it cannot create, merge, correct, supersede, retract, or verify a claim.

## Pinned Agent Bus reconciliation

This contract adapts concepts from two exact Agent Bus revisions because neither line supplied a
stable release contract for PSFN:

- development fork `93ee245db060e9cdb9c9c32f6d31d76d0c5a491d`;
- upstream `7dba0e40a1ce4def8b1c4ac8670a94aa54f9116e`.

The revisions were read from Git objects, not from the dirty Agent Bus checkout. The conformance
manifest records both revisions. The adapted material is attributed under
[`third_party/agentbus`](../third_party/agentbus).

| Agent Bus capability | V1 decision | PSFN reason |
| --- | --- | --- |
| Finding provenance and provenance-specific evidence | Retained and tightened | Learned state needs inspectable support; structured evidence is safer than free-form evidence text. |
| Verification independent from provenance | Retained | How a claim originated and whether another worker verified it are different facts. |
| Structured run, work item, session, and artifact context | Adapted | PSFN uses companion, automaton class, run, task, session, artifact, and parent-run lineage rather than repository revisions and developer agent names. |
| Explicit correction, supersession, and retraction events | Retained | Immutable history needs an auditable way to change current standing. |
| Development-fork single-current-lineage rule and replacement materialization | Retained | Rejecting stale targets prevents branches and gives one deterministic current finding. |
| Upstream schema generations and must-understand tokens | Retained and fail-closed | Older readers can preserve unknown events without interpreting them. |
| Upstream language-neutral conformance manifest | Adapted | JSON fixtures let later Postgres, tool, and cross-language implementations prove the same outcomes. |
| Upstream generic relation fields on every message type | Omitted from v1 | Automata Bus relations change finding lineages only; a dedicated relation event keeps authorization and reduction narrow. |
| Upstream rank dimensions, disputes, and resolution reducer | Omitted from v1 | Reviewer scoring and contradiction proposals belong to a later reviewer policy; scores must not alter canonical truth. |
| Upstream malformed-JSONL quarantine by line number | Omitted from v1 | Typed ingress and transactional Postgres rows have no recoverable malformed line or stable line number. Invalid events are rejected before storage. |
| Development-fork JSONL append, file locks, fsync, and bounded file runs | Omitted | Postgres transactions and companion tenancy own durability and concurrency. JSONL is not a runtime store. |
| Development-fork local vector sidecar and embedding model | Semantics retained, implementation omitted | Embeddings remain derived state, but PSFN will use its Postgres/pgvector infrastructure and its own model ownership. |
| Finding/rank/question/answer/handoff/cost/note developer message family | Narrowed to finding and relation | Dispatch discussion and developer work accounting are outside the learned-state product boundary. |
| Dispatch roles, voice/viewer tools, PSFN wave adapters, and Beads traffic | Omitted | They coordinate development runs, not an ephemeral worker's durable learned state. |
| Python validators or subprocesses | Omitted | The companion runtime consumes the native TypeScript contract directly. |

## Projection rules

Given a validated per-companion history in sequence order:

1. A finding enters current state under its event ID.
2. A correction or supersession removes its current target, records the disposition, and enters
   its replacement under the relation event ID.
3. A retraction removes its current target and records the disposition without adding a
   replacement.
4. A later relation targets the latest replacement event ID, never a departed ancestor.

The production reducer applies these rules incrementally. The conformance reference reducer uses
a separate target-to-successor graph walk. Both reducers run against the correction and retraction
fixtures and must return byte-equivalent structured projections.

## Runtime boundary for following work

This slice establishes semantics only. Following Automata Bus work may map the event envelope to
companion-scoped Postgres tables, build derived lexical/vector indexes, and expose bounded tools,
but it must not change these outcomes silently. A semantic change requires a new schema generation
or must-understand feature token plus conformance fixtures.
