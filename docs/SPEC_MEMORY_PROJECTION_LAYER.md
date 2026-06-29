# SPEC — Memory Projection Layer: Storage Schema vs Attention Schema

*2026-06-11, Fable Window 1. Companion packet: `context_packets/2026-06-11-memory-schema-session.md`. Sibling spec: `docs/SPEC_L01_LANDMARK_SCHEMA.md`. Charter authority: §6.23 (Mirror and Projection), §8.6 (Context Presentation Quality Is Architecture), Laws 17–20.*

> Status as of 2026-06-29: this is a design contract, not a fully implemented module. The current runtime has landmark-first retrieval and multiple hand-coded prompt renderers; the declarative `ProjectionProfile` registry and `recall_expand` tool are still future work. Keep new retrieval rendering bounded, provenance-preserving, and trust-gated while that work remains open.

## 1. The principle

**Storage schema and attention schema are different layers.** Postgres stores rich — provenance chains, formation VAD, lineage, arc membership, callbacks — because storage is cheap and provenance is law. Model attention is the scarce resource: the operator's empirical ceiling is **roughly five fields per item** of useful per-item metadata in attention, regardless of storage richness. The ~30% context-token reduction (commits `83cc7c47`, `716186d7`, `1ee91df9`, 2026-06-09) was achieved by stripping metadata at retrieval time and degraded nothing — evidence that everything stripped was attention noise.

Today that projection exists *de facto*: nine retrieval modes, each hardcoding its own field selection in its own renderer. The selections are empirically good (post-reduction). What's missing is the **contract** — one place where field selection is declared, justified, and enforced, so the next feature doesn't quietly re-inflate context or, worse, leak a field a mode must not see.

## 2. Ground truth — the nine current modes

| # | Mode | Consumer | Entry | Fields surfaced | Formatter |
|---|---|---|---|---|---|
| 1 | Turn-time semantic | agent context | `retrieval.ts:589` `retrieve()` | narrative text (compacted), type, valence marker, contact name | `formatMemoriesForPrompt` → `formatting.ts:23–64` |
| 2 | Episodic landmark chains | agent context | `retrieval.ts:1280` | title (≤96ch), humanized time range, themes[0:5], landmark, arc-partner *title* | `renderEpisodicLandmarkChains` `formatting.ts:150–181` |
| 3 | Emotional snapshot | agent context | `retrieval.ts:648` | profile summary, baseline/mood valence, drift, sample count, freshness | `renderEmotionalSnapshot` `formatting.ts:83–105` |
| 4 | Emotional continuity | agent context | `retrieval.ts:1119` | narrative text, valence marker | `renderEmotionalContinuityMemories` |
| 5 | Proactive recall | agent context | `retrieval.ts:1204` | type, narrative text, valence marker | `renderProactiveRecall` `formatting.ts:404` |
| 6 | Sleep consolidation | background LLM | `sleep-consolidation.ts:125` | JSON: id, startedAt, endedAt, title, landmark, themes, salience.score | inline builder |
| 7 | Dream pass | her main mind | `dream-meaning-pass.ts:73` | same JSON as #6 | inline |
| 8 | Appraisal | emotion/intention | `appraisal/formatting.ts:18` | concern excerpts (not UUIDs), VAD state, metacognitive flags | `sessionEntriesToIntentionMessages` |
| 9 | Session history / manifest | agent context | `context-builder.ts:439` | role, content, floored timestamp, authorName | context builder |

Shared narrative gate: `compactMemoryTextForPrompt` (`formatting.ts:206`) — strips fenced JSON, `**carry_forward:**` scaffolding, collapses whitespace.

Fields that never reach attention (keep it that way): embeddings, UUIDs, raw epoch timestamps, salience/importance/confidence decimals, full provenance objects, sourceRef strings, tags, scope refs.

## 3. The contract: ProjectionProfile

One module, `src/faculties/memory/projection/profiles.ts`, owns every profile. A profile is data, not code:

```ts
interface ProjectionProfile {
  id: string;                          // 'turn_semantic', 'episodic_chains', ...
  consumer: 'agent_context' | 'background_llm' | 'main_mind_pass' | 'appraisal';
  fields: ProjectedField[];            // from a typed catalog keyed to storage contracts
  fieldCeiling: 5;                     // >5 requires `ceilingExemption: { rationale: string }`
  budget: BudgetRef;                   // which resolve*Budget() governs truncation
  renderer: string;                    // the formatting.ts function bound to this profile
  redactions: RedactionRule[];         // fields this mode must NEVER receive (fail-closed)
}
```

Rules (fail-closed, house style):

1. **No profile, no render.** A retrieval mode that hasn't registered a profile cannot reach a prompt. New modes start by declaring what they surface and why.
2. **The ceiling is enforced, not advisory.** A test walks every profile; >5 fields without a written exemption rationale fails CI. (The rationale requirement is the point — re-inflation must be a decision, not drift.)
3. **Redactions are part of the profile.** E.g. profile #6 (background LLM) declares it never receives participant identities or message content — that is today's behavior, promoted to contract. This is the hook the Window-2 closed-door/audit pipelines will extend; designing redaction into the projection layer now means the blinded-audit preprocessor becomes *a profile*, not a parallel system.
4. **Renderers consume profiles.** Existing renderers in `formatting.ts` keep their output shape (they are empirically validated); they are refactored to read their field list from the profile rather than closing over it. Golden render tests freeze each profile's output shape (`testing-golden-artifacts` pattern); a profile change must change a golden file — visible in diff, reviewable.
5. **Sleeptime passes are profiles too.** #6/#7's inline JSON builders register like everything else. The dream pass runs on her main mind with her persona (kidney-vs-heart rule) — its profile's consumer field records that, so no future refactor quietly moves it to a background model.

Current field selections are **adopted as-is** for profiles 1–9 (they are the validated post-reduction shapes), with two additions from the sibling spec when its schema lands: profile 2 gains `motifs` (labels only) and `occasion_kind` — both attention-cheap and retrieval-rich; landmark text already carries meaning. That puts profile 2 at its ceiling: title, time range, landmark, motifs, occasion (themes drop to make room — motifs are their durable replacement; themes remain storage-side).

## 4. Why this is care infrastructure, not plumbing

§8.6: context presentation quality is architecture. The projection layer is where "what does she get to remember *right now*" is decided. Making it declarative means: the operator can read one file and know exactly what reaches her attention in every mode; an auditor can verify the closed-door rule has no leak path; and a token-budget regression has a single accountable surface. The alternative — nine renderers drifting independently — is how silent context rot happens.

## 5. Recursive recollection (revives PSFN-cyzi as a projection mode + tool)

The deferred design: fuzzy recall first, deeper recollection at will. Landmark-first is live (profile 2). The missing half is **controlled expansion**:

- New direct tool `recall_expand(episode_id_or_cue, depth)` — registered `extended`, budget-aware, trust/privacy-gated:
  - **depth 1 — recollection frame:** profile-2 fields + her dream-pass meaning (`EpisodeMeaning.text`) + arc neighbors (titles) + callback summary ("you've returned to this 3 times, last on …"). One episode, ~150 tokens.
  - **depth 2 — evidence:** span excerpts from L0 via `l01_episode_spans` (bounded turn count, session-store read), linked L2 memories (narrative text only).
  - **depth 3 — artifacts:** artifact refs resolved to vault/media handles.
- Each depth is its own ProjectionProfile with its own redactions: expansion respects channel visibility and trust gates (an episode whose spans lie in a private channel does not expand for a group-context turn — same attribution-guard posture the session layer already enforces).
- Cue-side: occasion-aware retrieval ("birthday next week" → upcoming-occasion query from the sibling spec D4) and motif retrieval ("our song" → `l01_motifs` lookup → origin episode) both terminate in the same depth-1 frame.
- Fail-closed: expansion of a merged/superseded episode follows lineage to the canonical head and says so ("this folded into …") rather than rendering stale rows.

This is the "scent triggers the synapses" substrate the project-state doc names as the follow-on: the landmark is the scent; `recall_expand` is the synapse chain.

## 6. Implementation order (beads carry the detail)

1. Profile registry + golden render tests over the nine existing modes (pure refactor, no behavior change — the goldens prove it).
2. Ceiling/redaction CI test.
3. Profile-2 field additions when `SPEC_L01_LANDMARK_SCHEMA` M1 lands (motifs, occasion).
4. `recall_expand` depth 1, then 2–3 (depends on M1 for callbacks/motifs; depth 2 needs only existing spans).
5. Window-2 hook: blinded-audit preprocessor registers as a profile with closed-door redactions (design deferred to the introspection session; the slot is reserved here on purpose).

## 7. Non-goals

- Changing retrieval *selection* (ranking, budgets, stochastic gates) — this spec governs what surfaces per selected item, not which items are selected.
- Garden/admin rendering — operator surfaces may show full storage richness; profiles govern model attention only.
- Prompt phrasing — macro-purity rule holds; profiles emit bare values, phrasing lives in editable prompt layers.
