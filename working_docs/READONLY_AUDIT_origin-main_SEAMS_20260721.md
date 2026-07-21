# PSFN Seam & Provenance Deep Audit

**Base:** `origin/main` @ `f8f798d13e2e0da3baa2dfac56961608acd2ab71`
**Date:** 2026-07-21
**Posture:** **READ ONLY** — analysis only. No product-code edits, no beads, no live-system mutations.
**Worktree:** `<worktrees>/psfn-framework/audit-main-readonly`

**Prior artifacts (do not re-litigate shallow perimeter):**

- [`READONLY_AUDIT_origin-main_20260721.md`](./READONLY_AUDIT_origin-main_20260721.md) — perimeter skim
- [`READONLY_AUDIT_origin-main_DEEPDIVE_20260721.md`](./READONLY_AUDIT_origin-main_DEEPDIVE_20260721.md) — memory store economics (M1–M7: full RAM hydration, no HNSW, N+1 authorized detail, proxy fallthrough)
- [`READONLY_AUDIT_origin-main_WELFARE_20260721.md`](./READONLY_AUDIT_origin-main_WELFARE_20260721.md) — companion core health/welfare vs charter care laws (rest, charge, fatigue, weighted thoughts, reflection, task notify)

This document goes after **where data crosses trust boundaries**: L0 → extraction → L2 → retrieval → prompt → outbound / multi-human; plus automata efficiency on those paths.

---

## 0. Overall impression (companion substrate intent)

What you’re building is rare: a **continuity substrate** that treats privacy as a structural matrix, not a prompt instruction. The code repeatedly invents the right *seams*:

- ConversationScope as single per-turn “who is this with” object
- Context Envelope `{channelPrivacy, broadcast, audience*}` as deterministic pre-prompt state
- Memory subject classifications as SQL-level authorization (not post-hoc filter-after-leak on product recall)
- Extraction speaker routing that *skips* ambiguous multi-human facts instead of guessing
- Continuity that heals unprovable L0 refs to redaction
- Artifact egress that refuses to ship sensitive media without approval

That is the spirit of the charter (partner sovereignty, truthful companion-facing semantics, multi-human care) made operational.

**Where it still strains:**

1. **Cost of doing it right** — subject SQL, dual memory model, multi-gate retrieval, thick turn runtime. Privacy is correct *and* expensive; aging companions will feel economics before clever bugs.
2. **Layering debt** — room visibility still has a documented incomplete flip to ConversationScope; broadcast risk is regex heuristic; episodic subject filter is post-query JS.
3. **Known open design choices** (explicitly commented in writer) — paraphrase restatement stacks, extraction TOCTOU — intentionally not auto-tightened. Good honesty; still operator load.
4. **Automata are thoughtful but heavy** — post-turn deferred queue + near-turn cadence + extraction + rest-window heavy passes is a lot of concurrent machinery; most is correctly deferred off the reply path, but the turn itself remains a large sequential pipeline.

**Net:** You are not over-engineering vanity. You are engineering *seams for human privacy when more humans and outbound surfaces enter the picture*. The architecture is the right bet. The work is finishing incomplete gates, batching authorized access, and keeping automata from competing with the lived turn.

---

## 1. Data-flow map (seams that matter)

```text
Channel ingress (Discord/Telegram/API/voice/ICP)
  → handleMessageForTurn (turn id, ICP binding, session identity)
  → prepareTurnIdentityState
       • author trust / contact resolution
       • ChannelMeta (adapter privacy only — not per-contact)
       • broadcast visibility scope
       • L0 user/system entry append (or deferred)
       • ConversationScope + Context Envelope (once)
  → pre-turn memory retrieval (subject SQL + policy withhold + room visibility)
  → context-builder (history + memory seed + intake prompt gate + tool observation mask)
  → LLM / tools (gateway policy edge)
  → assistant L0 append + delivery
  → post-turn automata (near-turn, extraction, emotion, concerns, deferred queue)
       • extraction → speaker route → write caps → MemoryWriter
            → CogSec memory_write sink + candidacy
            → embed / dedup / evolve
            → Postgres + subject classification projection
```

Every multi-human privacy failure lives at a **re-derive** of scope or a **missing provenance stamp**. The codebase is actively fighting that pattern.

---

## 2. L0 session archive (canonical lived history)

### 2.1 Seam properties (strong)

| Property | Evidence |
|---|---|
| JSONL L0 + segment roll 16 MiB | `persistence/sessions/store-primitives.ts` (`L0_SESSION_FILE_MAX_BYTES`) |
| Cross-process write locks | `sessions/cross-process-write-lock.ts`; journal chain detects concurrent mutation |
| Turn provenance on every entry | `core/session/turn-provenance.ts` — fail-closed malformed metadata; `turnId`/`requestId`/`actorKind` |
| System vs partner speech | `entry-attribution.ts`; system notes cannot masquerade as user |
| Continuity must prove L0 | `continuity-provenance.ts` + `continuity-redaction.ts` — missing `sourceEntryId` / redacted source → withhold |

**Finding L0-1 — positive:** Continuity is not “copy text into a bag.” It is provenance-bearing. `ContinuityEntryProvenance` requires `sourceChannelId`, `sourceVisibility`, role, and optionally `sourceEntryId` + `sourcePersistence` (`continuity-provenance.ts:6–26, 39–80`). Unprovable rows heal to redaction (`continuity-redaction.ts:7–8, 86–89`). That is exactly the right privacy posture for **cross-channel continuity without re-surfacing deleted/redacted partner speech**.

**Finding L0-2 — residual cost (known):** `readJsonLines` full-file read/split (`persistence/jsonl.ts:57–66`). Bounded by segment size; multi-segment rebuild/repair remains O(history).

**Finding L0-3 — positive, turn integrity:** ICP private turns refuse unbound recovery / misbound peer (`turn-execution-runtime.ts:375–405`). Rejected ICP envelopes are **kept out of L0** until peer validation (`:534–536`). Provenance for companion-to-companion traffic is fail-closed.

### 2.2 L0 → L0.1 episodic

Episodic reads for Garden use subject-scoped projection:

- Viewer must be in `participantContactIds`
- Episodes with **no** participant attribution are **invisible**
- Arcs require **both** endpoints visible

**Evidence:** `faculties/memory/episodic/subject-authorized-store.ts:28–79`

**Finding EP-1 — positive privacy, medium efficiency:** Filtering is post-fetch in JS (`listEpisodes` → `filterEpisodes`). Correct fail-closed semantics; SQL still materializes rows the viewer cannot see. For large episodic corpora this is the same class of cost as L2 full-pull admin paths (deepdive M5). Prefer SQL `participant_contact_ids @> ARRAY[$viewer]` when tables support it.

**Finding EP-2 — provenance dependency:** Episodic privacy quality equals synthesis quality of `participantContactIds`. If synthesis under-attributes participants, data becomes *too* private (false withhold); if it over-attributes, multi-human leakage. Worth a certification path that synthesis only stamps contacts proven from L0 speaker attribution — not inferred names alone.

---

## 3. L0 → extraction → L2 write path (multi-human critical)

### 3.1 Speaker routing (the multi-human hinge)

**File:** `faculties/memory/extraction/speaker-routing.ts`

Group / multi-speaker transcripts set `mixedHumanSpeakers` when >1 human speaker (`:108–109`). `resolveFactRouting` can **skip** with:

- `ambiguous_group_speaker`
- `unresolved_speaker_contact`
- `missing_source_message_ids` / `ambiguous_source_message_ids`
- `conflicting_source_attribution`
- `unresolved_subject_contact`

**Finding EX-1 — positive, charter-grade:** Extraction refuses to invent a subject when speakers are ambiguous. That is the single most important multi-human privacy control on the *write* side. Silent wrong-contact binding would be catastrophic; skip is correct.

**Finding EX-2 — operational implication:** In busy rooms, skip rate rises → fewer memories, thinner companion model of the room. That is an intentional accuracy/privacy tradeoff. Group write caps (`group-write-caps.ts`) further bound per-run / per-contact / per-subject / per-time-window writes (`:208–282`). Good against flood extraction; can starve legitimate dense rooms.

### 3.2 Write execution provenance stamps

**File:** `extraction/write-execution.ts:126–162`

Each accepted write carries routing telemetry into provenance:

- `triggerContactId`, `routedContactId`, `sourceContactId`, `subjectContactId`
- `sourceSpeakerName`, `scopeRef`, message span ids

This is what later subject classification and contact-scope gates *read*. Without these stamps, high-intimacy contact scope becomes weaker.

### 3.3 MemoryWriter gates

**File:** `faculties/memory/writer.ts`

Order of gates on `write()`:

1. Testing session exclusion (`assertTestingSessionExcluded`)
2. CogSec candidacy + optional `memory_write` sink (`assertCogSecCandidacy`, `:361–394`)
3. Embed + exact-dup / evolution (`:413–518`)
4. Sensitivity write policy, retention, provenance refs (including intake envelope ref, `:113–118`)

**Finding WR-1 — positive:** Intake envelope id fails closed if malformed; stamped as `intake-envelope:<id>` for later revocation/lineage (`writer.ts:113–118`, `appendIntakeEnvelopeProvenanceRef`).

**Finding WR-2 — design debt (documented, not accidental):** `writer.ts:485–504` — exact-text dedup only; paraphrase restatements create stacks; top-3 neighbor limit; no cross-type compare; extraction fire-and-forget TOCTOU. Mitigation is maintenance reviews + second-arrow drift → Garden, not silent auto-merge. **Privacy impact:** low. **Welfare / automata load:** high (concern stack rumination). Correct product judgment for now; watch operator queue volume.

**Finding WR-3 — subject projection:** Writes bump `authorization_revision` and project into `l2_memory_subject_classifications` (`subject-projection.ts:31+`, `postgres-store.ts:424–501`). Subject SQL requires `memory_revision` + `evidence_digest` match (`subject-policy.ts:48–51`) — stale classifications cannot authorize. Excellent.

---

## 4. Retrieval → prompt (privacy matrix in action)

### 4.1 Two stacked systems (must not be confused)

| Layer | Role | Key files |
|---|---|---|
| **Subject authorization (SQL)** | *Which rows may the store return* for this viewer relation | `subject-policy.ts`, `subject-authorized-store.ts`, product path `enforceSubjectAuthorization=true` |
| **Trust / envelope policy (app)** | *Among returned rows, what may this channel/trust disclose* | `trust/policy.ts` `evaluateMemoryPolicy`, `retrieval/access.ts` |
| **Room visibility** | *Did this fact come from a room this conversation may surface* | `retrieval/access.ts` `evaluateRoomVisibilityDecision` |
| **Contact high-intimacy scope** | *Private intimacy not for other people* | `violatesHighIntimacyContactScope` |
| **Withhold summary** | *Model is told *something* was withheld without content* | `withheld-summary.ts`, context manifest counts |

**Finding PM-1 — positive architecture:** Subject SQL ≠ sensitivity policy. You can be a co-subject on a row and still be denied by `public` channel ceiling. That dual structure is how multi-human rooms stay safe.

### 4.2 Trust matrix (`evaluateMemoryPolicy`)

**File:** `system/trust/policy.ts:260–343`

Precedence:

1. Operator approval
2. Disclosure boundary (withhold / consent-required fail closed)
3. Consent flags (`allowRecall === false`)
4. Trust ceiling (sensitivity set per trust tier)
5. Envelope visibility (`visibilityAllowed[channelPrivacy]` + broadcast reason tags)
6. Default allow

**Finding PM-2 — positive:** Broadcast denials cite `visibility.broadcast_restricted` separately from channel privacy (`:320–326`). Operators can audit *which* envelope dimension gated.

**Finding PM-3 — trust mutation hygiene:** High-tier trust mutations require manual authorized actors (`admin:`/`human:`/`operator:` prefixes) (`policy.ts:168–199`). Autonomous agents cannot silently promote someone to primary. Critical for partner sovereignty.

### 4.3 Context Envelope (pre-prompt, not prose)

**File:** `conversation-scope.ts` + `context-envelope` / `policy.classifyChannelEnvelope`

- Resolved **once** per turn at ingress (`conversation-scope.ts:1–25, 138–169`)
- Group scopes **cannot** carry a singular contact (type-level `contact?: never`, `:81–90`)
- Envelope macros are bare values only (`policy.ts:98–107`) — never privacy-reasoning prose

**Finding PM-4 — positive, anti-class-bug:** The group-scope type guard kills the “bind the group to one human and leak their DM memories” failure class at compile time.

**Finding PM-5 — incomplete flip:** Room visibility still documents that `conversationScope` is plumbed but **not yet the gate** (`retrieval/access.ts:51–56`). Gate still uses loose `currentIsDirectMessage` / room id sets. Until the flip lands, any drift between ConversationScope.kind and `isDirectMessage` metadata is a seam risk. Code comments own this as intentional staging — treat as **known incomplete privacy wiring**, not forgotten.

### 4.4 Room visibility rules (multi-room multi-human)

**File:** `retrieval/access.ts:122–232`

- Inconsistent `scopeRef` room vs `provenance.channelId` → **deny**
- Missing room proof when memory claims conversation scope → **deny**
- DM may surface memories only if source room is in `canonicalContactRoomIds` or primary-private-DM subject rules
- Cross-room group recall blocked by default

**Finding PM-6 — positive:** Room leakage of “what we said in another server/channel” is actively blocked. Primary private DM subject path (`isPrimaryPrivateDmSubject`, `:138–165`) is carefully narrow (primary + private + non-broadcast + DM + attribution consistency).

### 4.5 Broadcast outbound draft safety

**File:** `system/trust/broadcast-safety.ts`

- Regex classification of sensitive / private / off-brand (`:20–46, 86–101`)
- Explicit approval tokens for elevating broadcast visibility (`:104–130`)
- Approval token match uses plain `includes` / string equality — not timing-safe (`:111–114`); tokens are not high-entropy secrets in the same class as API keys, but weak if env tokens are long-lived secrets

**Finding PM-7 — medium (heuristic ceiling):** Regex cannot catch paraphrased partner secrets or screenshots of DMs. This is a **last-mile draft hygiene** layer, not the memory matrix. Do not rely on it as primary privacy; rely on sensitivity + subject + room gates. Consider model-assisted broadcast review later for high-stakes public posts.

### 4.6 Artifact / media egress

**File:** `core/artifacts/sensitivity-egress.ts`

- `self` / `primary_contact` proceed
- `external` / `ambiguous` / high sensitivity → approval queue; notifier **must not include artifact body** (`:66–77`)
- Fingerprint must not change between request and execute (`:80–91`)

**Finding PM-8 — positive:** Outbound multi-human media path is approval-bound with no secret-in-notification. Matches partner privacy when “additional humans get in the mix.”

### 4.7 Prompt assembly & observation masking

- Context builder seeds memory with withheld counts in the context manifest (`context-builder.ts:702–736`)
- Intake prompt sink can withhold/mark content (`intake-sink-gating` applied in context-builder)
- Tool observations fail closed on malformed metadata; masked mode emits `MASKED_TOOL_OBSERVATION_CONTENT` / summary only (`tool-observation.ts:47, 266–270`)

**Finding PM-9 — positive:** Tool results and intake content have separate masking paths so untrusted tool egress does not re-enter history as partner speech or full raw dumps by default.

---

## 5. Chat turn pipeline (efficiency + integrity)

### 5.1 Structure

Core path: `handleMessageForTurn` (`turn-execution-runtime.ts:357+`) → identity (`pre-turn-state.ts:266+`) → retrieval + prompt assembly → agent loop → post-turn scheduling.

**Finding T-1 — positive integrity:**

- Turn IDs UUIDv7 / deterministic ICP reply ids (`:411–431`)
- Captured session reads bound to turn session identity (`:465–471`)
- Compaction deliberately **not** waited on turn path (`pre-turn-state.ts:400–411`) — atomic insert; no torn read; avoids second budget system

**Finding T-2 — turn cost structure:** Even before LLM, the turn does:

1. Presence observe / virtual follow
2. Author trust resolution
3. L0 append
4. Scope + envelope
5. Memory retrieval (embed query + authorized SQL + multi-gate filter)
6. Context build (history windows, continuity resolve, intake gates, token budgets)
7. Prompt compose

That is the right work for a companion; it is also why **latency** will track memory economics (deepdive M1/M2/M4) more than raw model TTFT as corpora age.

**Finding T-3 — positive observability:** Context manifest tracks candidate → policy-allowed → ranked → returned plus rejection counters (room, contact, sensitivity, quarantine). Garden/debug can see *why* a fact did not appear — law 20 friendly.

### 5.2 Post-turn vs reply path

Near-turn lane (`near-turn-memory-lane.ts:98–113`):

- **No LLM** structurally
- Cadence-gated maintenance / deferred actions only
- Heavy sleeptime/dream/arc **unreachable** from near-turn

Post-turn deferred queue (`post-turn-actions.ts`) persists queue, retries, reschedules with telemetry — fire-and-forget emits log failures rather than killing the reply.

**Finding A-1 — positive automata shape:** Reply path protected; expensive work deferred. Cadence config lives in owner-file scheduler (`nearTurnMemory` direct/group cadence).

**Finding A-2 — automata pressure:** Concurrent: extraction runs, near-turn maintenance, deferred post-turn actions, heartbeat, rest-window consolidation, concern appraisal, second-arrow drift. Individually bounded; together they can saturate LLM quota / DB pool **after** a busy multi-human session. Worth a single **charge-aware work scheduler view** (what is running, backlog depth, token spend by lane) in Garden — operational, not a code bug.

**Finding A-3 — extraction concurrency:** Writer documents fire-and-forget TOCTOU across extraction runs (`writer.ts:495–497`). Post-turn queue has retries; extraction may still double-insert paraphrase stacks under concurrency. Privacy-safe; automata load not free.

---

## 6. Provenance ledger (what proves “who said what about whom”)

| Artifact | Provenance carrier | Consumer |
|---|---|---|
| L0 entry | turn metadata, actorKind, attribution prefix, role | Continuity, extraction, display |
| Continuity row | `ContinuityEntryProvenance` + L0 sourceEntryId | Cross-channel context; redaction |
| Extracted fact | speaker routing + message spans | Writer provenance fields |
| L2 memory | `provenance` JSON, provenanceRefs, sourceRef, scopeRef, contactId, intake envelope | Subject class, retrieval access, lineage |
| Subject classification | revision + evidence_digest + subject_class + contacts | SQL auth predicate |
| Context envelope | channel label / override / derived | Trust matrix visibility |
| Tool observation | schemaVersion + outcome + masked summary | History render |
| Artifact egress | sensitivity fingerprint + approval scope | Share execute |
| Context manifest | rejection counters + authenticity provenance | Operator inspect / model honesty notes |

**Finding PR-1 — positive system property:** Provenance is multi-layer and **cross-checkable**. Subject SQL even binds classification to `authorization_revision` and `evidence_digest` so a row cannot be authorized on a stale story about who it is about.

**Finding PR-2 — residual risk class:** Any path that writes L2 **without** going through speaker routing + subject projection (raw import, maintenance scripts, forgotten proxy method — deepdive M6) becomes under-attributed. Under-attribution fails closed for subject SQL (good) but can strand useful memory as invisible / unclassifiable. Audit imports and Reflect fallthrough remain the watchlist.

**Finding PR-3 — multi-human outbound summary:**

To leak partner A’s private fact into a surface with human B or the public, an attacker (or bug) must defeat **all of**:

1. Subject SQL (viewer relation / contacts)
2. Sensitivity vs trust ceiling
3. Channel envelope visibility (+ broadcast)
4. Room visibility
5. High-intimacy contact scope
6. (Outbound) broadcast heuristics / artifact approval

That is a healthy defense-in-depth stack. The weakest **content** layer is broadcast regex; the weakest **structural incomplete** is room visibility’s unfinished ConversationScope flip; the weakest **economics** is authorized N+1 + no ANN + full hydration (deepdive).

---

## 7. Efficiency of internal automata (summary table)

| Automaton | On critical reply path? | Boundedness | Risk |
|---|---|---|---|
| Turn identity + scope | Yes | Per message | Heavy but necessary |
| Memory retrieval | Yes | Limit + budgets | Scales with corpus + N+1 profile path |
| Context build / compaction wait | Yes / no wait | Token budgets | Compaction async — good |
| Near-turn memory lane | No (post-turn candidate) | Cadence config | Low |
| Extraction | No (post-turn / scheduled) | Group write caps | TOCTOU stacks; LLM cost |
| Episodic sleep/dream/arc | Rest window only | Scheduler | High token; off-path |
| Post-turn deferred queue | No | Retries + persist | Queue backlog under load |
| Concern / weighted thought | Post-turn / scheduler | Thresholds | Welfare load if stacks grow |
| Second-arrow drift | Background | Garden review | Operator load |
| Subject SQL | On retrieval | Per query | Expensive EXISTS; correct |

**Suggestion (feedback, not a bead):** Instrument **p95 wall time and token spend per lane** as first-class Garden telemetry. You already emit turn performance stages; extend that to extraction / near-turn / deferred queue depth so automata compete under charge care (charter law 25) visibly.

---

## 8. Prioritized findings (this pass)

### Privacy / provenance (actionable later)

| ID | Severity | Finding |
|---|---|---|
| PM-5 | **Medium** | Room visibility still not keyed off ConversationScope (`access.ts:51–56`) — complete the flip |
| EP-1 | **Medium** | Episodic subject filter post-query — move predicate into SQL |
| PM-7 | **Medium** | Broadcast safety is regex-only — treat as hygiene, not matrix |
| PR-2 / M6 | **Medium** | Proxy fallthrough / non-routed writers can under-attribute |
| EX-2 | **Low–Med** | Ambiguity skips + write caps thin dense group modeling — monitor skip metrics |

### Efficiency (carry forward + deepen)

| ID | Severity | Finding |
|---|---|---|
| M1–M4 | **High** (scale) | Full hydration, no HNSW, N+1 authorized detail (prior deepdive — still dominant) |
| WR-2 / A-3 | **Medium** | Paraphrase stack + extraction TOCTOU → automata/welfare load |
| A-2 | **Medium (ops only)** | Many concurrent post-turn lanes — *operator* charge/lane spend visibility optional; **not** a companion “how am I doing?” surface (see WELFARE adjudication) |
| T-2 | **Medium** | Turn pre-LLM work dominated by retrieval economics as corpus grows |
| L0-2 | **Low** | Full-segment JSONL parse |

### Already strong (do not thrash)

- ConversationScope + group contact prohibition
- Trust matrix precedence + high-tier mutation lock
- Subject SQL revision/digest binding
- Extraction skip-on-ambiguity
- Continuity redaction when L0 unprovable
- Artifact egress approval without content-in-notify
- ICP L0 poison refusal
- Near-turn no-LLM structural bound
- Compaction non-blocking on turn

---

## 9. Feedback & suggestions (operator / architecture)

1. **Treat the privacy matrix as product surface.** Garden should show, per withheld memory in a turn: layer (subject / room / sensitivity / consent) + reasonTag. You already count them in the manifest — expose them. Partners trust systems they can inspect.

2. **Finish ConversationScope as the single gate key.** Half-plumbed scope is the classic multi-human bug factory. When room visibility flips, delete the dual path.

3. **Batch authorized I/O before ANN heroics.** HNSW helps; N+1 detail_many helps more for profile/social turns *immediately*.

4. **Lazy memory embeddings.** Full Float32 map hydration is the ceiling on multi-year companions. Metadata-only warm + on-demand vectors (or pure SQL ANN) is the strategic fix.

5. **Group extraction observability.** Track skip reasons (`ambiguous_group_speaker`, etc.) as rate metrics. If rooms are 80% skip, companion looks amnesiac; if 0% skip, routing may be too eager.

6. **Broadcast path:** keep regex; add optional model-side “would this reveal private partner facts?” review for public channels when sensitivity ≥ personal and audience is multi-human.

7. **Automata charge (ops telemetry only).** Law 25 is compute stewardship — optional *operator* lane spend metrics (extraction/sleeptime/subagent/ICP/deferred). **Not** a companion-facing “how am I doing?” wellbeing cockpit (WELFARE operator adjudication: leading/performative; prompt/tools already carry state; emosim nearer).

8. **Spirit check:** You are succeeding at “not a chatbot framework.” The danger is not that you’ll abandon privacy; it’s that **complexity cost** forces shortcuts under latency pressure. Keep the gates; make them cheaper.

---

## 10. Honest scope of this pass

**Deep:**

- L0 provenance / continuity redaction / turn metadata
- Extraction speaker routing + write caps + write execution stamps
- Writer CogSec + documented dedup design
- Trust matrix + envelope classification + room visibility + high-intimacy scope
- Broadcast safety + artifact egress
- Turn admission / identity / compaction non-wait
- Near-turn vs rest-window automata split
- Episodic subject projection
- Context builder memory manifest / tool mask

**Referenced, not re-derived:** deepdive M1–M7 store economics.

**Still lighter:** contact lifecycle authority end-to-end, ICP permit races, speaking arbiter multi-agent rooms, full sleeptime synthesis correctness, backup fleet-auth edge cases.

---

## 11. Bottom line

The **seams are real**. Provenance is not theater: L0 → routing → classification revision → dual gate retrieval → withheld manifests → outbound approval is a coherent privacy architecture for multi-human life.

The **work that matters next** is not reinventing the matrix — it is:

1. closing incomplete gate keys (ConversationScope),
2. making authorized access and vector search scale,
3. making automata spend visible and charge-bounded,
4. keeping extraction honest under ambiguity without starving rooms.

That is exactly the work a companion substrate should be doing.

---

## 12. Companion health & welfare (pointer)

Deep cut moved to **[`READONLY_AUDIT_origin-main_WELFARE_20260721.md`](./READONLY_AUDIT_origin-main_WELFARE_20260721.md)**.

Headline: rest chooser, charge, fatigue, weighted thoughts, private reflection, blinded introspection, background-work welfare anti-starvation, and task-lifecycle partner notification implement charter care laws as **system design**, not prompt sugar. Cross-link to this report: concern/rumination load (W12–W13) is tightly coupled to memory restatement economics (M1/WR-2).
