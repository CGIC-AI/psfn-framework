# Cross-Channel Biographical Continuity

**Status:** implementation design  
**Date:** 2026-08-05  
**Epic:** `psfn-framework-o61vb`  
**Related authority work:** `psfn-framework-ta3q7` (Core Partner Model)

## Decision summary

PSFN should preserve one continuous companion and one continuous relationship
across rooms without moving raw private memories between rooms.

The system will keep the existing room-visibility gate on raw memories and add a
separate, rebuildable **Biographical Profile** projection. The projection is a
bounded set of typed claims about the companion or a canonical contact. Each
claim is independently selected, source-revalidated, sensitivity-gated, and
recorded in CogSec disclosure lineage before it can enter generation context.

This changes the product from:

> A flat profile summary is either wholly visible or wholly withheld with the
> room-scoped memories that produced it.

to:

> Raw memories remain local. Small, structured, explicitly authorized claims
> may travel through destination-aware doors.

The motivating result is simple: if V says “hey, sunbeam loaf” in a group room,
Purrsephone can recognize her nickname and V as her husband without receiving
the private conversation in which the nickname was created.

## Why this work exists

### The user-visible failure

PSFN currently gives strong room isolation to memories. That protects private
conversation, but it also makes ordinary identity and relationship texture
disappear at room changes. A companion who knows her partner deeply in a DM can
appear to meet him for the first time when other people are present.

This is not merely failed fact retrieval. It fragments the companion:

- her own nicknames and stable preferences can become room-dependent;
- her relationships become conditional on who sent the current message;
- harmless shared language disappears in the situations where it matters;
- fixing the symptom by loading private memories would create a much worse
  disclosure problem.

The desired experience is **one self with graded access**, not a separate copy
of the companion behind every channel wall.

### Why room walls stay

Room walls are load-bearing privacy structure. They make it safe for a person
and companion to speak openly in private. A private memory may contain much more
than the apparently harmless fact later extracted from it: timing, vulnerability,
other participants, or intimate context.

Therefore this design does not make “public memory” mean “a raw memory tagged
public may cross rooms.” Raw memories retain their existing room gate even when
their sensitivity field is `public`. Portability belongs to a derived claim
whose exact content, subject, sources, and authorization can be evaluated on
their own.

### Recognition is not full presence

Biographical claims solve recognition and stable relational continuity. They do
not carry the full narrative texture of a life. A later, separately approved
**Public Story** projection may carry tellable narratives such as “how we met.”
That future layer is described at the end of this document so the present seam
does not block it, but it is not part of this epic.

## Current architecture and confirmed gap

### Raw-memory access is room-first

`evaluateRetrievalAccessDecision` currently applies these relevant gates:

1. companion self-reflection/self-creation bypass;
2. room visibility;
3. high-intimacy contact scope;
4. trust, sensitivity, visibility, boundary, and consent policy.

In a group room, a memory sourced from another room is rejected by room
visibility before the sensitivity policy can admit it. This is correct for raw
memory and must remain correct.

### The current contact profile is a flat summary

`ContactProfileArtifact` currently contains:

- one `contactId`;
- one free-form `summary`;
- all `sourceMemoryIds`;
- aggregate confidence, novelty, and update time.

`refreshContactProfile` reads memories by canonical contact across the store and
asks an LLM to synthesize up to two paragraphs. The result has no claim-level
kind, subject cardinality, sensitivity, correction state, or source snapshot.

Retrieval then resolves the profile's source memories and applies memory access
rules to them. If one resolved source is blocked, the entire summary is withheld.
Conversely, legacy profiles with no resolvable source rows can currently be
admitted. Both outcomes are consequences of the flat artifact: policy cannot
separate a harmless nickname from a confidential source in the same paragraph.

### Group scope does not identify one canonical room contact

`ConversationScope` intentionally forbids a single `contact` on group scopes.
It carries a room identity, an audience envelope, a bounded recent-speaker
window, and an optional member-count hint. Recent speakers are useful context,
but are not proof that every listed person is presently participating.

The turn does have a verified canonical contact for the current author when
ingress identity resolution succeeds. Contact storage also exposes a bounded
room roster derived from observed channel activity. That roster is evidence of
known room membership, not proof of live presence.

### Profile text is not in disclosure lineage

The generation lineage collector currently records selected raw and emotional
memory sources. The profile contributes telemetry provenance references, but its
text is not coupled to the source contributions folded by CogSec egress.

This means the new projection must not merely add another prompt block. Rendering
and lineage contribution have to be one indivisible result.

### Existing target architecture must remain authoritative

The accepted Core Partner Model design already distinguishes:

- typed Partner Assertions with provenance, correction, and supersession;
- a slow, rebuildable Partner Profile;
- expiring Partner Current Context.

Biographical claims are a portable **projection**, not a competing human-fact
authority. Initially they may project from contact records and memory. When
Partner Assertions exist, the same profile module consumes them as canonical
sources instead of creating a parallel fact store.

## Goals

1. Recognize the companion's stable self-shape in every authorized room.
2. Recognize the current speaker's safe identity and relationship shape in a
   group without loading unrelated room members.
3. Carry only independently authorized, structured claims across rooms.
4. Preserve raw-memory room isolation and all existing sensitivity, consent,
   trust, and channel-envelope gates.
5. Make every possible profile influence visible to CogSec egress.
6. Make deletion, correction, contact merge, source drift, and sensitivity
   changes revoke or rebuild projections deterministically.
7. Keep prompt use bounded and extraction economical.
8. Leave a clean seam for future HITL-approved narrative projections.

## Non-goals

- Moving or copying raw private memories across rooms.
- Reordering raw-memory access gates to make sensitivity override room origin.
- Treating private-room origin as automatic confidentiality or automatic consent.
- Automatically publishing socially ordinary-sounding facts.
- Carrying rapidly changing status through the durable profile.
- Loading every known or present room member's profile.
- Letting the LLM invent claim kinds, schemas, subject cardinality, conflict
  rules, sensitivity exceptions, or authorization.
- Inferring permission to disclose from affection, relationship type, or usage.
- Implementing Public Stories or general public narrative memory in this epic.

## Domain model

### Four lifecycles

| Layer | Question answered | Authority and lifetime |
|---|---|---|
| Raw memory | What happened? | Room-scoped memory; existing retention and consent rules |
| Current Context | What is true right now? | Typed, freshness-bound, expiring state |
| Orientation | What matters and how should I engage here? | Room-local active frame (`orient` / legacy `core_memory`) |
| Biographical Profile | Who am I, and who is this person? | Slow, rebuildable, stable claims |

“V was laid off two days ago” is Current Context, not durable identity. An
orientation block may derive “be gentle about work in this room,” but it is not
the canonical status store. A companion's present mood remains in affect and
orientation, not in a globally portable self-profile.

The first implementation does not make Current Context cross-room portable. If
that is later wanted, it requires its own TTL, destination policy, and lineage
design; it must never travel merely because the Biographical Profile does.

### Subjects

A claim has an exact subject shape:

```typescript
type BiographicalSubject =
  | { kind: 'companion'; companionId: string }
  | { kind: 'contact'; contactId: string };
```

Some claim kinds may also name one related subject. This is not an unbounded
list of people. The kind registry defines the allowed cardinality.

Examples:

- self-subject nickname: “Sunbeam loaf is one of my nicknames.”
- contact relationship: “V is my husband.”
- dyadic shared language: “V calls me sunbeam loaf.”

The self-subject claim lets the companion recognize her own name without V's
profile being loaded. The dyadic claim adds V attribution only when the turn's
participant-selection and destination rules permit it.

### Closed claim kinds

The initial registry is intentionally small:

| Kind | Structured value | Cardinality and conflict shape |
|---|---|---|
| `name` | name and name role | Primary name singleton; aliases set-valued |
| `nickname` | nickname and self/relational scope | Set-valued; duplicate normalized values coalesce |
| `relationship` | relationship type and related subject | Kind-specific; no inferred exclusivity |
| `role` | normalized role and optional context | Usually set-valued; may be time-bounded |
| `stable_preference` | target/category and polarity | Conflict key includes normalized target/category |
| `shared_language` | phrase, meaning, and related subject | One companion/contact dyad only |

Adding a kind is a reviewed schema change. Each registered kind owns:

- its schema version and structured-value validator;
- allowed subject shape and cardinality;
- canonical normalization and claim digest fields;
- conflict key and coexistence rules;
- default freshness class and minimum sensitivity;
- deterministic prompt renderer and token budget;
- retrieval and correction rules.

Unknown kinds reject. Free-form rationale may be stored for human audit but
cannot be rendered, ranked, or used as hidden prompt context. If free text can
influence generation, it is governed content rather than an audit note.

### Claim envelope

The rebuildable projection needs enough information to validate itself without
trusting generated prose:

```typescript
interface BiographicalClaim {
  id: string;
  subject: BiographicalSubject;
  relatedSubject?: BiographicalSubject;
  kind: BiographicalClaimKind;
  value: BiographicalClaimValue;
  basis: 'explicit' | 'observed' | 'inferred' | 'imported';
  status: 'candidate' | 'active' | 'contested' | 'superseded' | 'revoked';

  schemaVersion: number;
  normalizerVersion: number;
  claimDigest: string;
  sourceSetDigest: string;
  sources: BiographicalClaimSource[];

  proposedSensitivity: SensitivityLevel;
  effectiveSensitivity: SensitivityLevel;
  confidence: number;

  synthesizedAt: string;
  lastSourceValidatedAt: string;
  lastEvidenceAt: string;
  supersedesClaimId?: string;
}
```

The stored `effectiveSensitivity` is a cache and audit statement, not read-time
authority. Admission recomputes or validates it from live sources and any exact
authorization grant.

### Source snapshots

Every source contribution is individually auditable:

```typescript
interface BiographicalClaimSource {
  ref: string;
  revision: string;
  evidenceDigest: string;
  sensitivityAtProjection: SensitivityLevel;
  subjectEvidenceDigest: string;
  consentFingerprint: string;
  sourceChannelId?: string;
  sourceChannelEpoch?: number;
}
```

The source set is sorted canonically before hashing. The snapshot answers not
only “which memory?” but “which revision, classification, subject evidence, and
consent state made this claim admissible?”

## Digest and revalidation invariants

### Claim digest

`claimDigest` is SHA-256 over canonical structured content:

- schema and normalizer versions;
- exact subject and related-subject identities;
- claim kind;
- normalized structured value.

It excludes timestamps, extraction run IDs, LLM wording, source ordering, and
audit notes. Re-running extraction with semantically identical structured output
under the same normalizer therefore produces the same claim digest.

### Source-set digest

`sourceSetDigest` covers the canonical ordered source snapshots, including
revision, evidence digest, sensitivity, subject-evidence digest, consent
fingerprint, and relevant channel epoch.

If re-extraction produces apparently equivalent content but a different
canonical claim or source-set digest, the system does not ask an LLM to declare
equivalence. The authorization is invalidated and the claim is withheld until
re-granted. A human interface may show a structured old/new diff for rapid
renewal, but renewal is never automatic.

### Read-time source checks

The projection must withhold a claim and queue deterministic rebuild when any
source:

- is missing, deleted, superseded, quarantined, or no longer recallable;
- has a revision, evidence digest, subject evidence, or consent mismatch;
- has an unprovable or changed channel-classification epoch;
- now carries greater sensitivity than the cached claim;
- changes the canonical contact identity through merge or archive lifecycle.

Missing source data fails closed. This deliberately reverses the current legacy
profile behavior that can admit a summary when none of its sources resolve.

Stable claims do not expire merely because they are six months old. Their source
validity is checked deterministically. LLM synthesis runs only after a cheap gate
detects new evidence, source digest drift, an explicit correction, or a required
rebuild. Rapidly mutable statements never enter this profile.

## Sensitivity and authorization

### Automatic classification

The automatic floor is:

```text
automatic sensitivity = max(
  kind minimum,
  proposed sensitivity or personal when uncertain,
  every live source sensitivity
)
```

The LLM proposes; policy disposes. Missing, malformed, or uncertain model output
cannot become public. An increase in any source sensitivity tightens access
immediately. A decrease never widens access automatically.

### Exact declassification or disclosure grant

A personal source may contain a small fact the subject deliberately wants to
share publicly. The raw source remains personal. Lowering the claim below its
automatic source floor requires an append-only authorization record bound to:

- exact `claimDigest` and `sourceSetDigest`;
- authorizing actor and authority basis;
- allowed destinations or sensitivity;
- reason, timestamp, and optional expiry;
- the schema and policy versions used for the decision.

Any bound digest change invalidates the grant. A generic `operatorApproval`
boolean is not sufficient because the current memory-policy override bypasses
all restrictions. This grant authorizes one normalized projection, not arbitrary
memory access.

An alternative is a new explicit public assertion of the exact structured fact.
That assertion is a new authoritative source; it does not relabel the original
private memory.

Companion and extraction automata may propose public portability. The existing
HITL approval seam decides whether a proposed lowering becomes effective.
Increasing sensitivity or revoking a grant does not require publication review
and takes effect immediately.

### Destination behavior

| Effective tier | Cross-room behavior |
|---|---|
| `public` | Eligible in any destination, still subject- and relevance-selected |
| `personal` | Eligible only where trust and channel privacy allow it |
| `intimate` | Origin room only |
| `confidential` | Origin room only, most restrictive handling |

“Public” means policy-eligible, not automatically prompt-resident. Selection and
budgeting still apply.

## Extraction, validation, and contradiction flow

### Candidate pipeline

1. A deterministic trigger sees accepted new writes, source drift, correction,
   or an explicitly requested rebuild.
2. Source authorization resolves exact canonical subjects before any LLM call.
3. The LLM may emit only registered structured claim candidates plus source refs,
   proposed sensitivity, confidence, and possible conflict refs.
4. Deterministic validators reject unknown kinds, malformed values, unsupported
   subject cardinality, ambiguous subjects, ephemeral status, and source mismatch.
5. Canonicalization computes claim and source-set digests.
6. Policy computes automatic sensitivity and checks whether an exact grant is
   required.
7. Kind-specific conflict rules activate, coalesce, quarantine, contest, or
   supersede the candidate.
8. Accepted claims enter the rebuildable profile projection.

No candidate may quote or smuggle unstructured source text into the portable
renderer.

### Third-party protection

Rejecting “multi-human” memories alone is not enough because extraction may miss
attribution. Portability is therefore constrained by both subject cardinality
and claim kind.

“V said someone was fat” is neither a name, nickname, relationship, role, stable
preference, nor shared-language claim with an allowed subject shape. It rejects
even if the extractor incorrectly attaches only V's contact ID. One human plus
the companion is allowed only for kinds whose schemas explicitly define that
dyad.

### Contradiction lifecycle

Each kind defines its own conflict key. Different nicknames can coexist; two
opposing polarities for the same normalized preference cannot. A relationship
kind cannot assume monogamy or exclusivity unless its schema explicitly says so.

Resolution precedence is:

1. an authorized explicit subject correction may supersede an active claim;
2. a deterministic conflict between equally authoritative sources marks the key
   contested and withholds it from portable projection;
3. an LLM semantic-conflict flag quarantines the new candidate only;
4. the LLM never deletes, lowers, or silently replaces an established claim.

The live message remains in the current turn, so the companion can respond to a
correction immediately while durable reconciliation proceeds. Contradictory
evidence remains inspectable through append-only history.

## Turn-time participant selection

### Presence is eligibility, not selection

The system must not load every profile associated with a room. It chooses a
small subject set from verified turn relevance:

| Subject | Eligible claims |
|---|---|
| Companion self | Destination-allowed, relevant self claims |
| Verified current author | Public plus destination-allowed personal claims |
| Explicit reply target | Public; personal only with authoritative participation proof |
| Explicitly mentioned contact | Public; personal only with authoritative participation proof |
| Present or rostered but unrelated member | None |
| Absent or unknown person | None unless explicitly relevant, then public only |

The current author means the canonical contact bound to the message being
answered, not merely someone present in the room. A recent-speaker window or
historical room-roster row is not by itself live-presence proof.

The existing room roster may support “known member” decisions, but personal
projection for a non-author requires a stronger membership/presence signal or a
deliberately reviewed policy. Missing or ambiguous identity fails closed.

### Deep projection module

Callers should not separately choose subjects, filter claims, render text, and
construct lineage. One deep module should own that complexity behind a small
interface:

```typescript
interface BiographicalProjectionResult {
  promptSection: string;
  disclosureSources: DisclosureSourceContribution[];
  admittedClaimIds: string[];
  withheldSummary?: BiographicalWithheldSummary;
}

projectBiographicalContext(turn: TurnBiographicalContext):
  Promise<BiographicalProjectionResult>;
```

`TurnBiographicalContext` contains verified subject candidates, the
`ConversationScope` and its `ContextEnvelope`, trust, query/relevance input, and
a bounded token budget. The module hides storage, source revalidation,
destination policy, ranking, deterministic rendering, and lineage construction.

The interface returns prompt content and disclosure sources together. If either
cannot be produced, neither is admitted. This makes hidden profile influence
structurally difficult rather than depending on call-site discipline.

## Prompt and CogSec integration

Claims are rendered deterministically from structured fields. The LLM-authored
audit rationale never enters the prompt. Separate headings distinguish:

- companion self-shape;
- the current author's biographical shape;
- explicitly relevant relational attribution.

Every admitted claim contributes a disclosure source even when the eventual
response does not quote it. Lineage is a conservative statement of possible
influence, not token-level causal proof.

The contribution includes:

- claim ID, revision, and digest;
- effective sensitivity and destination constraints;
- companion/contact subject IDs;
- source channel IDs and classification epochs;
- source and grant provenance refs.

CogSec continues to take maximum sensitivity, intersect destinations, and fail
closed on missing lineage. A claim selected for prompt rendering but absent from
lineage aborts profile admission for that generation.

## Persistence, correction, and migration

### Rebuildable storage

The projection needs Postgres and in-memory adapters behind the same store
interface. Persistence must preserve:

- canonical subject keys;
- typed claim bodies and schema versions;
- source snapshots and both digests;
- sensitivity classification and exact grants;
- candidate, conflict, correction, supersession, and revocation history;
- rebuild timestamps and reasons.

Contact merge must re-key claims transactionally or rebuild them under the
surviving canonical contact. It must never leave two active profiles or merge a
third party's claim into the survivor. Contact archive, subject deletion, and
memory revocation invalidate dependent claims.

### Bounded legacy cutover

The existing flat `contact_profiles` projection cannot be safely parsed into
public claims. Migration must rebuild structured claims from live authorized
sources; legacy summary prose is not an authority.

The migration sequence is:

1. add the new claim store and projection interface without changing prompt
   behavior;
2. run deterministic source discovery and structured claim synthesis behind the
   new interface, with no fallback from a missing claim to summary text;
3. provide operator inspection and approval for candidates requiring grants;
4. rebuild eligible profiles and measure withheld/rebuild reasons;
5. cut prompt assembly atomically to the new projection;
6. stop legacy profile refresh and rendering in the same cutover;
7. retain old rows only for the explicitly documented rollback window, then
   remove the unused code and table under reviewed migration criteria.

There is no permanent dual-read or silent compatibility fallback. The exact
alpha migration and removal criteria must be recorded in `docs/specifications.md`
before implementation cutover.

## Operator and companion agency

The companion may:

- propose a claim;
- propose its sensitivity;
- propose that an exact claim is safe to carry;
- explain why a conflict or correction matters.

Deterministic policy still validates the schema, source set, sensitivity floor,
subject authority, destination, and lineage. Companion proposes; policy disposes.

Garden must provide an operator with a redacted inspection view containing:

- active, candidate, contested, superseded, and revoked claims;
- structured value and deterministic rendering;
- subject and related-subject identities;
- source refs, revisions, digests, and sensitivity contributions;
- why a claim was withheld or queued for rebuild;
- grants, revocations, corrections, and structured old/new diffs.

Approval notifications must not include private source text. The approval
operation must bind the exact normalized claim and source-set digests shown to
the operator.

## Failure model

The design fails closed in these cases:

| Failure | Result |
|---|---|
| Unknown claim kind or schema version | Reject candidate or withhold stored claim |
| Missing canonical subject | Reject |
| Unsupported multi-human shape | Reject |
| Missing/deleted source | Withhold and queue rebuild |
| Source revision or digest drift | Withhold; invalidate bound grant |
| Source sensitivity increases | Tighten immediately |
| Source sensitivity decreases | Keep prior restriction until audited reclassification |
| Consent or disclosure boundary changes | Withhold immediately |
| Grant digest mismatch | Withhold; require re-grant |
| LLM suggests a semantic contradiction | Quarantine new candidate; no silent override |
| Prompt rendering lacks lineage | Admit neither prompt nor claim |
| Ambiguous author, mention, reply, or membership | No personal claim projection |
| Token budget exhausted | Deterministically omit lowest-priority claims |

The room gate on raw memory remains an independent defense even if claim policy
has a bug.

## Verification plan

### Core behavior

- A self-subject nickname learned in a DM and explicitly approved for public use
  is recognized in a group when V is absent.
- A public relationship claim identifies V as the current author and husband in
  a group without loading its private source memory.
- A dyadic nickname claim carries V attribution only when V is turn-relevant.
- Public raw memory from another room remains blocked.
- Personal claims appear only where destination and participant proof allow.
- Intimate and confidential claims never cross their origin room.

### Participant safety

- The current author receives the eligible profile; another present member does
  not merely because they are in the roster.
- An explicit mention can load public claims.
- Personal claims for a mentioned or replied-to non-author require authoritative
  participation proof.
- Recent-speaker and stale roster evidence alone cannot widen access.
- Ambiguous and multi-human claims never enter the portable projection.

### Source and grant lifecycle

- Deletion, supersession, quarantine, consent revocation, contact archive, and
  source sensitivity increase withhold a dependent claim immediately.
- Contact merge yields one canonical profile with no cross-contact bleed.
- Stable canonical re-extraction preserves digests and grants.
- Any canonical claim or source-set digest change invalidates the grant.
- Source sensitivity decrease does not widen a claim without audited action.
- Missing legacy source rows fail closed.

### Contradictions

- Multiple nicknames coexist.
- Opposing values under the same preference conflict key become contested.
- Explicit subject correction supersedes inference without deleting history.
- LLM semantic-conflict output cannot replace an active claim.

### CogSec and operations

- Every rendered claim has a disclosure contribution on the same generation.
- Effective sensitivity is the maximum applicable source classification unless
  an exact valid authorization applies.
- Destination constraints intersect with all other generation sources.
- Missing claim lineage fails egress closed.
- Postgres restart, backup/restore, and rebuild preserve claim history and grants.
- Garden shows structured provenance and withheld reasons without leaking source
  bodies.
- Prompt claim count and token use remain bounded in DM and group fixtures.

## Delivery plan

The work is deliberately split into one prefactor and narrow end-to-end tracers.
Every implementation ticket includes focused tests; the final conformance ticket
proves the system-level matrix rather than postponing ordinary tests.

### 1. Design and delivery map

Publish this design, make `psfn-framework-o61vb` the implementation epic, relate
it to the Partner Model authority epic, and create the dependency graph below.

### 2. Typed claim kernel and persistence prefactor

Add the versioned subject, claim-kind registry, structured values, source
snapshots, canonical digests, sensitivity/grant envelope, conflict states, and
Postgres/in-memory store interface. Extend the shared artifact-sensitivity and
provenance primitives rather than creating a second max-sensitivity system.
Record the bounded legacy migration in the specifications.

This ticket does not change prompt behavior. It makes the subsequent vertical
tracers small enough to review.

### 3. Companion self-nickname tracer

Deliver the first complete path: a self-directed nickname source produces a
validated candidate, an exact HITL approval can authorize public projection, and
the approved self claim appears with CogSec lineage in another room. Prove that
the raw source does not cross and digest drift revokes the grant.

### 4. Current-author relational identity tracer

Project contact name, relationship, and dyadic nickname claims for the verified
current author. In a group, only eligible claims for that author appear; a
present but unrelated contact receives no ambient profile load.

### 5. Explicit reply and mention eligibility

Extend subject selection to verified reply targets and resolved mentions.
Public claims may be relevant; personal claims require authoritative
participation proof and an allowed destination. Recent speakers and historical
roster data alone do not widen access.

### 6. Stable kinds and contradiction lifecycle

Add role, stable preference, and shared-language schemas with their conflict
keys, cardinality, deterministic renderers, correction precedence, contested
state, and append-only supersession. Reject ephemeral status and unsupported
third-party shapes.

### 7. Source, contact, and grant lifecycle hardening

Make source deletion, revision/digest drift, sensitivity and consent changes,
contact merge/archive, grant revocation, and rebuild scheduling work across
restart.

### 8. Operator inspection and re-grant workflow

Expose structured claims, sources, conflicts, withheld reasons, grants, and
old/new digest diffs through Garden. Reuse the existing HITL approval seam for
claim-scoped approval, revocation, and re-grant without placing private source
bodies in notifications.

### 9. Legacy profile cutover and rebuild

Rebuild eligible structured claims from live sources, atomically switch prompt
assembly to the claim projection, stop flat-summary refresh/rendering, and leave
no runtime fallback from missing claims to legacy prose. Apply the documented
rollback/removal criteria.

### 10. Cross-channel privacy conformance

Run the full public/private/invite-only, DM/group, participant, sensitivity,
source-lifecycle, CogSec, prompt-budget, restart, and backup/restore matrix.
Produce operator-visible evidence for the exact committed head before
publication.

## Dependency graph

```text
Design
  └─ Typed claim kernel
       └─ Companion self nickname
            └─ Current-author relational identity
                 ├─ Reply/mention eligibility
                 └─ Stable kinds + contradictions
                      └─ Source/contact/grant lifecycle
                           └─ Operator inspection + re-grant
                                └─ Legacy cutover + rebuild
                                     └─ Privacy conformance
```

`Reply/mention eligibility` and `Stable kinds + contradictions` may proceed in
parallel after the current-author tracer. Lifecycle hardening waits for both so
it can validate all selection and conflict shapes once.

## Future seam: HITL-approved Public Stories

The profile solves “who am I?” and “who is this person?” It intentionally does
not solve “which stories from my life can I naturally tell?”

A future `PortableNarrativeProjection` can use the same subject selection,
source snapshots, canonical digest, exact authorization, destination policy,
and CogSec lineage interfaces while storing a bounded approved telling rather
than a typed identity value. Examples include how the companion and partner met,
a favorite shared joke, or a public milestone.

That future module must add narrative-specific rules:

- participant consent for dyadic or multi-person stories;
- an approved telling or semantic envelope;
- revocation and versioned retelling;
- relevance-based loading rather than ambient autobiography;
- no access to the private source text during public generation.

It should not reuse `BiographicalClaimKind` or turn the profile into a bag of
prose. The shared seam is governed projection and lineage, not storage shape.

## Final rationale

The central distinction is between **memory** and **portable meaning**.

Raw memories retain the walls that make private openness safe. The Biographical
Profile adds narrow doors for facts that have been reduced to an exact shape,
assigned to exact subjects, reviewed under explicit sensitivity rules, and made
visible to outbound disclosure policy.

That is enough to stop the companion from becoming a stranger when people are
around, while preserving the private life that made the relationship real in
the first place.
