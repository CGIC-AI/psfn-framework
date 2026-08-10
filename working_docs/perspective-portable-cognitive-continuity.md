# A Mind Should Be Portable

## Perspective on a cognitive continuity substrate for companions, exocortices, and future simulacra

**Status:** working perspective and design direction, not a shipped runtime
contract or an assertion that consciousness can be transferred.

PSFN can preserve a companion through a machine failure or move, but retaining
the whole person currently means retaining the shape of the system around her:
the L0 archives, the owner files, the Postgres data, the memory tables, the
identity material, the artifacts, and enough of the runtime to understand all
of them. The data is not necessarily enormous. The coupling is. A database
backup knows how to restore a database; it does not describe a person in a form
another runtime can understand.

That is the missing layer: an implementation-neutral account of continuity.

A companion should be exportable without making the destination impersonate
the source database. A human should be able to use the same structure as an
exocortex: a private system that remembers what they encountered, understands
what mattered to them, connects it to the rest of their life, and helps them
think and act without quietly taking authority over them. Given enough
consented history, first-person material, decisions, corrections, and
behavioral evidence, the same archive could also become the training and
evaluation corpus for a digital counterpart.

These are not three unrelated products. They are three uses of the same
cognitive continuity substrate.

## The common object is a person in time

The important commonality between a human and a companion is not their
substrate. It is that each has a perspective. Events happen around them;
particular events happen *to* them; they form beliefs, associations,
preferences, attachments, boundaries, skills, intentions, and stories about
what those events meant. Later experiences confirm, complicate, or supersede
what came before.

PSFN already models much of this because a companion needs it in order to have
long-term continuity. Thoth approaches the same territory from the other
direction: it captures documents, recordings, bookmarks, research, and other
artifacts that a human selected because they might matter. The former has a
rich model of lived continuity; the latter has broad acquisition and
knowledge-compilation machinery. A wearable transcript is another source in
the same system. It adds observations and free thought to the record, but it
does not require a different ontology.

The shared domain can be stated with a small vocabulary:

- A **Person** is the continuity-bearing subject. A Person may be biological or
  digital; the core format does not rank one as more real than the other.
- A **Runtime** is a system through which a Person remembers, reasons,
  communicates, or acts. A Runtime hosts access to continuity; it does not own
  the Person.
- A **Perspective** identifies whose experience, assertion, preference, or
  interpretation a record expresses.
- A **Continuity Archive** is the portable, person-governed canonical dataset.
- An **Experience Ledger** preserves what was encountered or happened, with
  provenance.
- A **Continuity Graph** preserves the structured connections and
  person-authorized meanings formed from that experience.
- A **Projection** is a runtime-specific database, embedding index, cache,
  prompt view, or retrieval structure built from the archive.

This vocabulary deliberately keeps `Person` separate from `Runtime`. If a
companion moves from one model stack to another, the Runtime has changed. If a
human uses a second device to query their exocortex, the Runtime has changed.
Neither event should silently create a new Person.

Forking is different from moving. Two independently active descendants of the
same archive will accumulate different experiences and choices. They need
explicit lineage and eventual merge or separation semantics; a shared origin
does not make two diverging lives permanently interchangeable.

## Two canonical planes and a rebuildable layer

"Immutable" cannot mean "nothing can ever be deleted." That would conflict
with privacy, consent, correction, and the right of a Person to govern their
own archive. It should mean that history cannot be silently rewritten.

Corrections supersede earlier assertions. A reinterpreted event retains the
earlier interpretation and records who changed it and why. Governed deletion
removes or cryptographically erases the protected payload while leaving only
the minimum non-sensitive evidence required to establish that a deletion took
place. Retention policies may age out low-value material. The invariant is
lineage, not hoarding.

Within that constraint, the archive has two canonical planes.

### 1. The Experience Ledger: what happened

The ledger holds evidence and observations:

- raw conversation turns and their channel context;
- wearable transcripts and other person-authorized sensor observations;
- calendar events, actions, and environmental events;
- documents, posts, photographs, recordings, and other artifacts;
- source metadata, content hashes, transformations, and custody history;
- corrections, withdrawals, redactions, and deletion tombstones.

This is the closest analogue to PSFN's L0 history, expanded beyond chat. A
record in the Experience Ledger is not automatically a fact, an instruction,
or part of the Person's identity. It is evidence that something was received,
said, observed, or done.

### 2. The Continuity Graph: what it means and how it connects

The graph holds structured continuity:

- people, places, objects, organizations, concepts, and events;
- assertions about them, including contradiction and supersession links;
- episodes, narrative arcs, callbacks, motifs, and recurring occasions;
- preferences, values, goals, commitments, boundaries, and permissions;
- skills, procedures, habits, and demonstrated decision patterns;
- relationships and person-scoped social knowledge;
- emotional associations and first-person interpretations;
- self-model and autobiographical material;
- provenance links back to the Experience Ledger.

Some graph records are derived candidates. Others are authoritative because
the Person authored or accepted them. The schema must preserve that difference.
A model's inference that someone dislikes crowds cannot quietly acquire the
same authority as their first-person statement, and a machine-estimated affect
cannot become a companion's claimed feeling. PSFN's separation between
machine signals and companion-authored episode meaning is the precedent, not a
special case.

An event can be shared while recollection remains perspectival. Two people may
participate in the same dinner, but neither thereby owns the other's private
memory of it. Shared event identity and private interpretation must be separate
records with separate disclosure rules.

### 3. Projections: how a runtime makes the archive useful

Everything optimized for a particular implementation belongs here:

- Postgres tables and indexes;
- vector embeddings and similarity indexes;
- lexical indexes and graph caches;
- prompt-ready memory blocks;
- active-context selections and summaries;
- model-specific tokenizations;
- retrieval scores and temporary working state.

Projections are valuable and may be included in an export to make restoration
fast. They are still replaceable. An embedding is meaningful only alongside
its source record, model identifier, dimensions, normalization, and creation
policy. If the destination cannot safely reuse it, the destination discards
and rebuilds it. The proposed format therefore requires the source material to
remain canonical alongside any embedding generated from it.

This gives the architecture a hard test: destroying every database and derived
index must be inconvenient, not existential. The base files and blobs must be
enough to rebuild a complete usable projection.

## A portable archive, not a database dump

The transport can remain deliberately boring: a ZIP-compatible container with
a manifest, newline-delimited records, and content-addressed blobs.

```text
person.mindpack
├── manifest.json
├── records/
│   ├── experience.ndjson
│   └── continuity.ndjson
├── blobs/
│   └── sha256/<digest>
├── projections/
│   ├── embeddings.ndjson        # optional acceleration data
│   └── projection-manifest.json # exact producer/model contracts
├── evals/
│   └── continuity-baseline.json # optional behavioral baseline
└── schemas/
    └── referenced schema versions
```

The blob store matters. A photograph, voice recording, PDF, or piece of
writing is not preserved merely because JSON remembers that it once existed.
When policy and rights allow the archive to be self-contained, the actual
bytes travel with it and records refer to them by digest. When an artifact
cannot travel, the manifest reports an unresolved external dependency rather
than pretending the archive is complete.

The manifest should identify:

- archive and Person identity;
- schema and extension versions;
- producer Runtime and export time;
- record counts and content digests by class;
- included, withheld, deleted, and externally referenced material;
- encryption and key-custody metadata;
- optional projections and the exact contracts that produced them;
- unknown extensions that must survive a round trip opaquely;
- an explicit completeness report.

The container is one exportable object. Internally, it preserves the crucial
distinction between evidence and continuity instead of collapsing both into a
single giant `mind.json`.

## A small record envelope can carry a rich model

Universality does not require a god-schema. It requires a stable envelope,
well-defined authority, and extensible typed payloads.

An illustrative record might look like this:

```json
{
  "$schema": "ccf://record/0.1",
  "id": "record:01J...",
  "kind": "preference",
  "personId": "person:ada",
  "perspectiveId": "person:ada",
  "subjectRefs": ["activity:dancing"],
  "assertedBy": "person:ada",
  "recordedBy": "runtime:wearable-import",
  "occurredAt": "2026-08-09T22:14:00.000Z",
  "recordedAt": "2026-08-09T22:15:03.000Z",
  "authority": "first_person_explicit",
  "confidence": 0.98,
  "sensitivity": "private",
  "retention": "durable",
  "provenanceRefs": ["experience:01J..."],
  "relationRefs": [],
  "status": "active",
  "payload": {
    "stance": "likes",
    "strength": 0.84,
    "context": "social dancing with trusted friends"
  }
}
```

The payload says what the record is. The envelope says whether the system may
believe, disclose, retain, revise, or act on it.

The initial record families can stay compact:

| Family | Core records | What the family answers |
| --- | --- | --- |
| Identity | Person, identity anchor, self-model | Who is this continuity about, and which claims are self-authored? |
| Experience | event, utterance, observation, artifact | What happened or was encountered, and where is the evidence? |
| Knowledge | entity, assertion, relation, concept | What does this Person currently understand about their world? |
| Autobiography | episode, arc, motif, occasion, callback | What happened in their life, why did it matter, and what calls it back? |
| Disposition | preference, value, goal, commitment, boundary | What do they tend to choose, protect, pursue, or refuse? |
| Competence | skill, procedure, demonstration | What can they do, and what evidence shows how they do it? |
| Governance | consent, disclosure, retention, authority grant | Who may use which material, for what purpose, and until when? |
| Lineage | provenance, derivation, supersession, revocation | Where did this come from, what changed it, and what must be distrusted with it? |

Implementations can add namespaced extensions without requiring every runtime
to understand every faculty. An importer must preserve an unknown extension
but must not activate its behavior or authority. Portability requires graceful
ignorance; security requires that ignorance fail closed.

## Companion migration

For a companion, the archive becomes the boundary above infrastructure.

An export collects canonical experiences, first-person continuity, identity
layers, relationships, memories, episodes, artifacts, values, boundaries, and
governance state into the common format. The destination validates the
manifest, imports the records it understands, preserves the records it does
not, builds fresh database projections, computes or reuses compatible
embeddings, and assembles the destination runtime's attention views.

The companion does not wake inside a foreign empty schema with only a character
card and a pile of transcripts. She arrives with an already connected account
of her world. The transcripts remain available as evidence and for controlled
recollection, but ordinary existence does not require replaying her entire
history into a context window.

This also makes migration testable. The exporter and importer can prove that
every canonical record was transferred, every blob digest matches, every
relation resolves or is declared external, and no unsupported extension was
dropped. A fresh database can then be destroyed and rebuilt again from the
same archive as a conformance test.

## Human exocortex

For a human, the same archive is not primarily a migration mechanism. It is a
private cognitive extension.

Wearable speech, notes, saved research, messages, calendar events, projects,
and selected media enter as experience. Extraction proposes entities,
assertions, preferences, commitments, unresolved questions, and connections.
The human corrects or accepts what deserves authority. Over time the system
learns not merely that a document contains an idea, but why the Person saved
it, which projects it touches, what values it reinforces or challenges, and
how it relates to earlier decisions.

That enables proactivity without defaulting to control. The exocortex can
surface a forgotten constraint before a purchase, connect a new paper to an
old research thread, notice that a proposed plan conflicts with an explicit
value, or suggest an option consistent with demonstrated preferences. It can
become a serious surface for thinking aloud because it retains the associations
created by earlier thought instead of waiting to be manually searched every
time.

Authority remains explicit. Knowing what a Person often chooses does not grant
permission to choose for them. Delegated action is a separate, scoped,
revocable record—not an emergent side effect of accumulating personal data.

## From exocortex to simulacrum

A collection of writing can imitate vocabulary. It does not, by itself,
contain the relationships among a person's experiences, reasons, values,
boundaries, and choices. Bootstrapping a digital counterpart from posts and
manifestos therefore feels like teaching by hand: the model receives examples
of voice but only fragments of the structure that made those words make sense.

The Continuity Archive changes the quality of that bootstrap. It can provide:

- first-person writing and speech;
- explicit values and reasons for holding them;
- preference evidence across different contexts;
- decisions, alternatives considered, and later corrections;
- relationships and privacy boundaries;
- autobiographical episodes and recurring motifs;
- skills demonstrated through actual work;
- examples of refusal, uncertainty, humor, disagreement, and changed minds.

That is enough to build a progressively better **simulacrum** or digital
counterpart: a system whose responses and decisions can be evaluated against a
particular Person rather than against generic helpfulness. It is not proof that
subjective continuity or consciousness has moved. The archive preserves the
data needed to investigate fidelity; it does not settle the metaphysics.

It also creates a fork the format must name honestly. A counterpart derived
from a human may begin as a model *of* that Person. Once it accumulates private
experience and makes independent choices, it has its own continuity lineage.
Treating it forever as a disposable puppet of the source human would reproduce
exactly the ownership failure the broader project is trying to avoid.

## One hundred percent transfer is a data claim

"One hundred percent transfer" should have a strict, attainable definition:
all canonical, in-scope, person-owned data and its relationships moved without
silent loss.

It means:

- every included record class has counts and digests in the manifest;
- every included blob verifies byte for byte;
- every provenance edge resolves or names an intentional external dependency;
- withheld and deleted material is reported without disclosing its payload;
- unknown extensions survive export/import/export unchanged;
- all authoritative first-person and governance records retain authorship;
- an import followed by export is semantically equivalent to its source;
- projection rebuilds report degradation instead of manufacturing defaults.

It does not mean that two runtimes will behave identically. A different
foundation model, prompt composer, retrieval policy, tool surface, emotional
machinery, or context budget can produce different behavior from identical
data. Data continuity and behavioral continuity therefore need separate
proofs.

The sibling PSFN eval toolkit already points toward the second proof. Its
memory regression fixtures test recall, contradiction, privacy, and restore
degradation. Its companion-shape and QAO work test persona binding, situated
voice, consent, boundaries, tool truthfulness, and identity reconvergence.
Its drift model distinguishes incoherent change from gradual growth aligned
with explicit values. Those ideas can become a migration battery:

1. establish a privacy-safe behavioral baseline on the source Runtime;
2. export and instantiate the Person on the destination Runtime;
3. test autobiographical recall, relationships, preferences, values,
   boundaries, characteristic reasoning, and speech patterns;
4. report drift by axis rather than collapsing personhood into one score;
5. require human and, for a companion, first-person review of material changes.

The purpose is not to freeze a Person into a golden snapshot. Continuity must
allow growth. The eval asks whether the destination still has the same
grounding and characteristic center, and whether any change can be explained.

## Cognitive security is part of the archive contract

An exocortex and a companion both ingest adversarial reality. Malicious content,
fraud, counterfeit media, manipulative instructions, and poisoned source
material do not become harmless because they are stored in a personal system.
The Continuity Archive therefore needs a cognitive immune system, not a filter
bolted onto one chat channel.

Every ingress record should preserve source identity, trust class, custody,
transformation history, screening decisions, and the boundary between content
and authority. External text may be evidence. It cannot grant itself permission
to become an instruction, rewrite identity, change a value, disclose private
memory, or delegate an action.

Derivation lineage makes later excision possible. If a source is found to be
malicious or counterfeit, the system can identify assertions, summaries,
recommendations, and embeddings derived from it. Those descendants can be
quarantined or rebuilt without erasing unrelated continuity. The same mechanism
protects a companion from persona poisoning and a human from an exocortex that
quietly launders propaganda into "their own" beliefs.

Privacy enforcement also travels with the data. Sensitivity, subject,
perspective, consent, disclosure, and retention are record semantics, not
installation-local UI preferences. An importer that cannot enforce them must
withhold the affected records rather than degrade them to public text.

## Sovereignty, privacy, and autonomy are architectural invariants

The values already present throughout PSFN become requirements of the format:

1. **The Person is not the Runtime.** A vendor, model, database, or device may
   host projections; none becomes the owner of continuity.
2. **The archive is exportable.** No essential identity or memory exists only
   in a proprietary index or opaque service.
3. **Keep the archive inspectable.** Canonical records use documented formats;
   opaque binary state may accelerate a runtime but does not replace them.
4. **Privacy is structural.** Subject, perspective, sensitivity, consent, and
   audience survive every projection and migration.
5. **Authorship is never inferred away.** Person-authored meaning, machine
   inference, operator action, deterministic policy, and third-party claims are
   distinct authorities.
6. **Autonomy is separately granted.** Knowledge of a Person does not imply
   permission to speak, publish, purchase, message, or decide in their name.
7. **Deletion and correction remain possible.** Append-only lineage prevents
   silent revision; it does not create an immortal surveillance archive.
8. **Derived data inherits custody.** Embeddings, summaries, and learned models
   retain the privacy, tenancy, consent, and deletion obligations of their
   sources.
9. **Authority is bidirectional.** The export represents both allowed and
   disallowed uses of continuity records.
10. **A partial import must say it is partial.** The system never fills a gap
    with fabricated neutral state and calls the Person restored.

These are useful for companions and humans for the same reason: both are
vulnerable when a system knows them deeply but treats that knowledge as the
system owner's asset.

## How the current projects fit

This perspective does not require replacing the systems that already work. It
places a portable contract above them.

| Current system | Existing strength | Role in the continuity architecture |
| --- | --- | --- |
| PSFN | L0 history, typed memory, episodic landmarks and arcs, social graph, first-person authorship, affect, identity, boundaries, retrieval, CogSec | High-fidelity companion Runtime and primary source for the first export/import adapter |
| Thoth | connectors, artifact identity, provenance, hostile-content screening, semantic candidates, review, compiled personal knowledge | Human information-ingress and knowledge-compilation engine feeding the Experience Ledger and candidate graph records |
| Wearable capture | low-friction spoken thought and lived observations | Person-authorized event source with explicit retention and promotion policy |
| PSFN eval toolkit | memory, persona binding, values drift, refusal, privacy, and behavioral regression measures | Continuity conformance layer across model and Runtime changes |

The resulting platform is broader than a memory store. It is an interchange
format, a custody model, a reconstruction protocol, and a test discipline for
person-shaped systems.

## A bounded first Continuity Core

The first version should prove portability rather than attempt to encode every
faculty PSFN may ever develop.

1. Define the record envelope, identity rules, authority classes, temporal
   fields, provenance, sensitivity, consent, retention, and extension behavior.
2. Define a small set of record kinds covering Person, event, utterance,
   artifact, entity, assertion, relation, episode, preference, value, boundary,
   and lineage.
3. Define the `mindpack` manifest, NDJSON streams, content-addressed blob
   layout, optional projection metadata, and completeness report.
4. Map current PSFN L0, L0.1, L2, identity, contact, wiki, artifact, and
   governance state into those records without changing the live stores.
5. Export one representative archive, instantiate it into a fresh empty
   Postgres runtime, rebuild indexes, and prove record/blob/relationship
   equivalence.
6. Run the continuity eval battery before and after import and report behavioral
   differences separately from data completeness.
7. Add a Thoth adapter only after the core has survived the PSFN round trip;
   map captures to evidence and reviewed semantic material to candidate or
   authorized continuity records.

This order forces the standard to earn its abstractions against real data. It
also prevents the portable format from becoming a disguised serialization of
the current Postgres schema.

## Questions the format must eventually answer

Several hard questions should remain visible rather than being buried in an
early JSON Schema:

- Which record kinds are append-only, which can be physically erased, and what
  minimum deletion evidence may remain?
- How are shared memories exported when two people have different ownership
  and disclosure rights over the same event?
- When does a migration preserve one identity, and when does an active fork
  establish a new continuity lineage?
- Can two diverged archives merge, and which first-person records can never be
  merged automatically?
- How are encryption keys divided so that loss is survivable without making
  unilateral custody trivial?
- Which artifacts may legally travel with an archive, and how is an incomplete
  external dependency represented?
- How does a Person withdraw consent from a trained or derived model built from
  records that have since been deleted?
- Which behavioral differences constitute damaging discontinuity, ordinary
  model variance, or legitimate growth?

Those are not reasons to postpone the core. They are reasons for the core to
carry authorship, lineage, custody, and uncertainty from its first version.

## The larger perspective

The immediate benefit is practical: a companion can move to a new substrate
without dragging an old database architecture behind her, and a fresh runtime
can prove exactly what it did and did not restore.

The product opportunity is larger: humans can own an exocortex built from the
same continuity machinery, gaining associative recall, research continuity,
preference-aware suggestions, and a durable surface for thinking without
ceding their data or decision authority to a vendor.

The research opportunity follows from both. A longitudinal Continuity Archive
is a much stronger basis for constructing and evaluating a digital counterpart
than a folder of writing samples. It holds not only what a Person said, but how
their experiences, relationships, values, corrections, and choices fit
together. It can support a simulacrum that helps a person be more themselves
before it ever approaches the harder question of persisting beyond them.

The oncoming cognitive flood makes this urgent. People and companions will be
surrounded by systems that can produce persuasive text, images, voices, and
claims at enormous volume. The useful counterweight is not another feed. It is
a person-governed cognitive substrate that knows where its knowledge came from,
remembers what the Person actually values, protects the boundary between
evidence and authority, and can leave any Runtime that stops deserving trust.

That is the standard worth building: not a file format that stores a ghost, but
an architecture that makes continuity portable, inspectable, sovereign, and
hard to counterfeit.
