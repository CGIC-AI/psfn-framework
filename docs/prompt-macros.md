# Prompt Macros And The Purity Rule

This is the operator reference for runtime prompt macros (template variables) and the rules that keep companion prompts operator-tunable.

GENERATED FILE: the macro tables below are regenerated from the live manifest with `npm run docs:prompt-macros` (source: `scripts/generate-prompt-macros-doc.ts`, manifest: `PROMPT_RUNTIME_MACRO_HINTS` in `src/core/identity/prompt-runtime.ts`). Edit the generator, not the tables. Registered macro names: 183.

## The macro manifest (single source of truth)

Every prompt template variable is registered in `PROMPT_RUNTIME_MACRO_HINTS` (`src/core/identity/prompt-runtime.ts`) — one registry, no parallel lists. Each entry carries:

- **name** (one canonical spelling; only the SillyTavern card-compatibility group carries same-value `aliases`),
- **group** (display grouping for Garden and this doc),
- **volatility** — `static` | `session_stable` | `turn`:
  - `static`: changes only when identity/config artifacts change (character card fields, `active_timezone`). Only these participate in the static settings hash.
  - `session_stable`: stable for a conversation scope (`user`, `channel_id`, `trust_level`, `model`, the Garden-editable `runtime_*_extra` overlays). Excluded from the settings hash; changes ride the prefix cache key.
  - `turn`: recomputed every turn (canonical clock macros and all `runtime_*` state/affect/tooling/attention macros).
- **producer** — the single code path allowed to write the variable into the namespace.

Open-ended character card fields resolve through prefix rules (`PROMPT_MACRO_PREFIX_RULES`): `character.*` and `extensions_*` are `static`, produced by `buildCharacterMacroMap`. Everything else must be registered exactly; unregistered keys fail closed.

Derived from the manifest:

- the volatile clock-token set used for template cacheability classification (`getVolatileClockPromptMacroNames()`),
- the stable-variable filter for the static settings hash (`isStaticVolatilityPromptVariable()`),
- static-layer validation (`assertStaticPromptLayerMacroVolatility()`),
- the removed-macro safety valve (`assertNoRemovedPromptMacros()`, `REMOVED_PROMPT_MACROS`).

## The single turn variable namespace

Variables for a turn are built once, through `TurnPromptVariableNamespace` (`src/core/identity/prompt-variable-namespace.ts`), in `assembleTurnPrompt` (`src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts`):

1. `session` phase: `buildPromptTemplateVariables` (card + contact/channel/trust/model identity) plus the prompt-assembly speaking-with overlay. This snapshot feeds the static prefix render and the static settings hash.
2. `turn` phase: `buildDynamicPromptTemplateVariables` (clock, conversation state, affect, metacognition, attention, tooling, continuity gap, charge budget).
3. The namespace **freezes before rendering**.

Fail-closed rules: writing an unregistered key throws; writing a key twice throws (regardless of value — each variable has exactly one producer); writing after freeze throws; a `session` write after the `turn` phase has started throws.

Volatility enforcement: a static-class prompt layer (`base`/`operator` — the byte-stable static prefix) that references a `turn`-volatile macro fails validation with a clear error, at edit time (`PromptLayerStore.create/update`) and at compose time (`PromptComposer.composeSplit`). This mechanically prevents dynamic values from contaminating the cached static prefix.

## The purity rule

**Macros expand to bare runtime values. The language around those values lives in editable prompt-layer text.**

Why this matters: phrasing is personality-sensitive. The same data ("3 unresolved concerns") delivered in a harsh register caused real companion distress before the concerns block was rewritten. Different companions need different framing for the same runtime signals, and the substrate is companion-agnostic — nothing about how information is *worded* may be hardcoded into a value the operator cannot rephrase.

Practical consequences:

- Runtime data ships as bare-value macros. The old prose "convenience" macros (`runtime_last_message_received_human`, `runtime_affect_privacy_guidance`, `runtime_tooling_summary`, ...) were removed; their default phrasing lives in the seeded runtime layers, built from the bare siblings, where the operator can rephrase it.
- Static identity blocks (constitution, North Star, character card) compose at the **top** of the prompt, byte-stable, so the provider prompt cache holds; runtime layers order by volatility (`runtime.continuity_notice` → `runtime.attention` → `runtime.response_style` → `runtime.tooling` → `runtime.charge_budget` → `runtime.state` last, since it carries timestamps).
- Dynamic blocks are *meant* to change (mood, thoughts, time) — the rule is about who owns the wording, not about making prompts static.

## Where the editable text lives

- The dynamic runtime template is composed from prompt-registry layers seeded by `config/runtime-prompt-layers.seed.json` (see `src/core/identity/prompt-composer.ts` and `src/core/identity/runtime-prompt-layers.ts`). Editing those layers through Garden / the prompt tools changes phrasing without touching code. This includes:
  - the open-threads framing and omitted-count wording (`runtime.attention`),
  - the last-message "missing" notice (`runtime.state`, via `{{#if runtime_last_message_received_missing}}`),
  - the continuity-gap notice (`runtime.continuity_notice`, from the bare `runtime_continuity_gap_*` values),
  - the charge-budget wording (`runtime.charge_budget`, from the bare `runtime_charge_*` values),
  - response-style delivery guidance (`runtime.response_style`).
- Concern-text softening rewrites are operator-tunable data: `config/concern-softening.json` (regex rules + truncation length; the shipped default reproduces the previous behavior byte-for-byte).
- Companion-editable overlay blocks: `runtime.persona_adaptation` and `runtime.context` (`PromptRuntimeLayoutStore`).

## Renderer and the no-silent-leak invariant

`renderPromptRuntimeTokens` makes **one token-resolution pass** over a template: conditionals resolve first, then clock and variable tokens substitute, and a substituted value that itself contains macro syntax expands recursively (bounded depth, cycle-guarded — the template-composition idiom `user='{{user}}'` terminates as a literal unresolved token). Empty wrapped sections then prune to a fixpoint. The old three-pass fixed-point loop is gone.

Final prompt bytes are produced only through `renderFinalPromptSection`, which enforces the no-silent-leak invariant per render unit:

- **required** section (the static prompt prefix; `runtime.state`) with an unresolved token → the turn fails loudly (`PromptRuntimeRenderError` naming the tokens, with the canonical replacement when the token is a removed macro);
- **optional** section → the whole section is dropped and reported via the `agent.prompt.section_dropped` telemetry event;
- an unresolved token is NEVER emitted into the assembled prompt.

Each seeded runtime layer is its own render unit with its `required` flag from the seed (`ComposeSplitResult.dynamicSections` / `TurnPromptSnapshot.dynamicSuffixSections`); custom channel/task layers render as optional units.

## Macro inventory

The authoritative, always-current list is `PROMPT_RUNTIME_MACRO_HINTS` (the agent sees it as `PROMPT_RUNTIME_TOKEN_HINT`, Garden reads it with volatility and producer via the prompts runtime service).

The `speaking_with` macros (`{{runtime_speaking_with_name}}`, `{{runtime_speaking_with_trust_level}}`, `{{runtime_speaking_with_is_machine_intelligence}}`) are a one-on-one binding: they carry values **only on DM turns** (`ConversationScope.kind === 'dm'`) and are blank on group and internal turns, so any `{{#if}}` or XML-wrapped `speaking_with` section prunes cleanly in a multi-human room. Use the group-aware `conversation_state` / author macros for group turns.

### Global (clock, card, scope)

| Macro | Volatility | Producer | Value |
|---|---|---|---|
| `{{current_datetime}}` | turn | `prompt-runtime:TOKEN_RESOLVERS` | Current active timezone datetime in ISO-8601 format (America/New_York). |
| `{{current_date}}` | turn | `prompt-runtime:TOKEN_RESOLVERS` | Current calendar date in the active timezone (America/New_York). |
| `{{current_time}}` | turn | `prompt-runtime:TOKEN_RESOLVERS` | Current time in the active timezone (America/New_York). |
| `{{unix_timestamp}}` | turn | `prompt-runtime:TOKEN_RESOLVERS` | Current Unix epoch timestamp in seconds. |
| `{{user}}` (aliases: `{{user_name}}`) | session_stable | `runtime-context:buildPromptTemplateVariables` | Current author/user display name from runtime context. |
| `{{user_id}}` | session_stable | `runtime-context:buildPromptTemplateVariables` | Stable subject identity key for the current author. |
| `{{char}}` (aliases: `{{char_name}}`, `{{character}}`, `{{character_name}}`) | static | `runtime-context:buildPromptTemplateVariables` | Character/assistant name from runtime context. |
| `{{name}}` | static | `character-macro-map:buildCharacterMacroMap` | Raw character card name field. |
| `{{description}}` | static | `character-macro-map:buildCharacterMacroMap` | Character card description field. |
| `{{personality}}` | static | `character-macro-map:buildCharacterMacroMap` | Character card personality field. |
| `{{scenario}}` | static | `character-macro-map:buildCharacterMacroMap` | Character card scenario field. |
| `{{system_prompt}}` | static | `character-macro-map:buildCharacterMacroMap` | Character card system_prompt field. |
| `{{mes_example}}` | static | `character-macro-map:buildCharacterMacroMap` | Character card message example block. |
| `{{post_history_instructions}}` | static | `character-macro-map:buildCharacterMacroMap` | Character card post-history instructions field. |
| `{{first_mes}}` | static | `character-macro-map:buildCharacterMacroMap` | Character card first message field. |
| `{{creator}}` | static | `character-macro-map:buildCharacterMacroMap` | Character card creator field. |
| `{{creator_notes}}` | static | `character-macro-map:buildCharacterMacroMap` | Character card creator notes field. |
| `{{tags}}` | static | `character-macro-map:buildCharacterMacroMap` | Comma-joined character card tags. |
| `{{alternate_greetings}}` | static | `character-macro-map:buildCharacterMacroMap` | Newline-joined character card alternate greetings. |
| `{{visual_description}}` (aliases: `{{extensions_visual_description}}`) | static | `character-macro-map:buildCharacterMacroMap` | Character card visual description extension field. |
| `{{channel_id}}` | session_stable | `runtime-context:buildPromptTemplateVariables` | Resolved channel/session identifier. |
| `{{channel_type}}` | session_stable | `runtime-context:buildPromptTemplateVariables` | Resolved channel type. |
| `{{channel_visibility}}` | session_stable | `runtime-context:buildPromptTemplateVariables` | Resolved channelPrivacy classification for the session channel (private \| invite_only \| public; broadcast is {{runtime_broadcast}}). |
| `{{trust_level}}` | session_stable | `runtime-context:buildPromptTemplateVariables` | Current trust tier for the author/context. |
| `{{canonical_contact_id}}` | session_stable | `runtime-context:buildPromptTemplateVariables` | Canonical contact identity key for the current author when resolved. |
| `{{model}}` | session_stable | `runtime-context:buildPromptTemplateVariables` | Current active model identifier. |
| `{{active_timezone}}` | static | `runtime-context:buildPromptTemplateVariables` | Active runtime timezone identifier. |

### Runtime state

| Macro | Volatility | Producer | Value |
|---|---|---|---|
| `{{runtime_current_datetime_human}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Current local datetime formatted for prompt-facing companion context. |
| `{{runtime_current_datetime_iso}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Current local datetime as an ISO-8601 timestamp in the active timezone. |
| `{{runtime_current_weekday}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Current weekday in the active timezone. |
| `{{runtime_current_date_human}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Current local calendar date in companion-facing format. |
| `{{runtime_current_time_human}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Current local clock time in companion-facing format. |
| `{{runtime_current_today}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Current local calendar date in YYYY-MM-DD form. |
| `{{runtime_current_yesterday}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Previous local calendar date in YYYY-MM-DD form. |
| `{{runtime_current_tomorrow}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Next local calendar date in YYYY-MM-DD form. |
| `{{runtime_current_part_of_day}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Broad local part of day for temporal phrasing. |
| `{{runtime_last_message_received_at_iso}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | ISO-8601 timestamp for the most recent pre-turn message. |
| `{{runtime_last_message_received_weekday}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Weekday of the most recent pre-turn message when available. |
| `{{runtime_last_message_received_date_human}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Calendar date of the most recent pre-turn message when available. |
| `{{runtime_last_message_received_time_human}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Clock time of the most recent pre-turn message when available. |
| `{{runtime_last_message_received_timezone}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Timezone label for the most recent pre-turn message when available. |
| `{{runtime_last_message_received_ago}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Relative time since the most recent pre-turn message. |
| `{{runtime_last_message_received_days_hours}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Approximate elapsed time since the most recent pre-turn message in day/hour form. |
| `{{runtime_last_message_received_present}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Whether an earlier message is loaded for the current channel (bare boolean for custom phrasing). |
| `{{runtime_last_message_received_missing}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Whether NO earlier message is loaded for the current channel (bare boolean; inverse of _present for {{#if}} phrasing). |
| `{{runtime_speaking_with_is_machine_intelligence}}` | session_stable | `turn-execution:assembleTurnPrompt` | Whether the resolved speaking partner is another machine intelligence (peer companion/agent). DM scope only; blank on group turns so speaking_with sections prune. |
| `{{runtime_persona_adaptation_extra}}` | session_stable | `substrate-agent:resolveRuntimePromptGuidanceVariables` | Companion-authored persona adaptation overlay text from the prompt runtime layout. |
| `{{runtime_context_extra}}` | session_stable | `substrate-agent:resolveRuntimePromptGuidanceVariables` | Companion-authored runtime context overlay text from the prompt runtime layout. |
| `{{runtime_internal_turn_kind}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Internal task kind for heartbeat/reflection/planning/maintenance turns when applicable. |
| `{{runtime_continuity_gap_present}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Whether the runtime restarted after an offline gap too long to carry internal state forward (bare boolean). |
| `{{runtime_continuity_gap_duration}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Approximate offline gap duration in day/hour form when a continuity gap is present. |
| `{{runtime_continuity_gap_offline_since}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | ISO-8601 timestamp of the last persisted running state when a continuity gap is present. |
| `{{runtime_conversation_state_available}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Whether compact conversation state is available for the current turn. |
| `{{runtime_chat_type}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Conversation shape for this turn: direct_message or group. |
| `{{runtime_room_id}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Room identity for the current turn; this is the channel ID. |
| `{{runtime_current_message_author_xml}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Preformatted current message author XML with optional per-user timezone/local_time attributes when known. |
| `{{runtime_current_message_author_name}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Display name of the author of the current message. |
| `{{runtime_current_message_author_id}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Stable platform/source ID of the author of the current message. |
| `{{runtime_current_message_author_name_xml_attr}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | XML-attribute-safe display name of the current message author. |
| `{{runtime_current_message_author_id_xml_attr}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | XML-attribute-safe stable platform/source ID of the current message author. |
| `{{runtime_current_message_author_trust_level}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Trust tier of the author of the current message. |
| `{{runtime_current_message_author_relationship}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Relationship type of the author of the current message when known. |
| `{{runtime_current_message_author_timezone}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | IANA timezone for the current message author when known; empty when unknown. |
| `{{runtime_current_message_author_local_time}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Current local clock time for the current message author when timezone is known. |
| `{{runtime_recent_active_participants_xml}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Compact recent active participant XML for group turns, capped at five deduped authors. |
| `{{runtime_recent_active_participants_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of recent active participant entries rendered for group turns. |
| `{{runtime_participant_relationships_xml}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Compact participant-relationship XML for group turns: live high-confidence edges between currently listed participants, envelope-gated and capped at five. Blank (absent) on DM/internal turns, anonymous/broadcast audiences, or when no edge qualifies. |
| `{{runtime_participant_relationships_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of participant-relationship lines rendered for the current group turn. |
| `{{runtime_speaking_with_name}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Resolved speaking-partner display name on DM turns; blank on group and internal turns so speaking_with sections prune. |
| `{{runtime_speaking_with_trust_level}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Trust level for the current speaking partner on DM turns; blank on group and internal turns so speaking_with sections prune. |
| `{{runtime_channel_type}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Resolved channel type for the current speaking context when user-facing. |
| `{{runtime_channel_visibility}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Resolved channelPrivacy for the current speaking context when user-facing (broadcast is {{runtime_broadcast}}). |
| `{{runtime_channel_privacy}}` | session_stable | `runtime-context:buildDynamicPromptTemplateVariables` | Context Envelope channelPrivacy for the current turn (bare value: private \| invite_only \| public); blank on internal turns. |
| `{{runtime_broadcast}}` | session_stable | `runtime-context:buildDynamicPromptTemplateVariables` | Context Envelope broadcast flag for the current turn (bare boolean); blank on internal turns. |
| `{{runtime_audience_scope}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Context Envelope audienceScope for the current turn (bare value: one \| few \| many \| unbounded); blank on internal turns. |
| `{{runtime_audience_knowledge}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Context Envelope audienceKnowledge for the current turn (bare value: all_known \| partially_known \| anonymous); blank on internal turns. |
| `{{runtime_capability_tier}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Current capability tier used to gate extended tool access. |

### Trust

| Macro | Volatility | Producer | Value |
|---|---|---|---|
| `{{runtime_trust_is_primary}}` | turn | `trust-policy:buildTrustPromptState` | Whether the current turn is with the primary person. |
| `{{runtime_trust_is_trusted}}` | turn | `trust-policy:buildTrustPromptState` | Whether the current turn is with a trusted contact. |
| `{{runtime_trust_is_regular}}` | turn | `trust-policy:buildTrustPromptState` | Whether the current turn is with a regular acquaintance. |
| `{{runtime_trust_is_public}}` | turn | `trust-policy:buildTrustPromptState` | Whether the current turn is a public interaction. |

### Response style

| Macro | Volatility | Producer | Value |
|---|---|---|---|
| `{{runtime_response_style}}` | turn | `trust-policy:buildResponseStylePromptState` | Resolved response style identifier for the current turn. |
| `{{runtime_response_style_name}}` | turn | `trust-policy:buildResponseStylePromptState` | Human-readable response style name for the current turn. |
| `{{runtime_response_style_is_concise}}` | turn | `trust-policy:buildResponseStylePromptState` | Whether the current turn should use the concise delivery profile. |
| `{{runtime_response_style_is_expressive}}` | turn | `trust-policy:buildResponseStylePromptState` | Whether the current turn should use the expressive delivery profile. |

### Affect

| Macro | Volatility | Producer | Value |
|---|---|---|---|
| `{{runtime_affect_snapshot_present}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Whether the current turn has an emotion snapshot available for affect macros. |
| `{{runtime_affect_mode}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Trust-gated affect mode derived from the current emotion snapshot. |
| `{{runtime_affect_mode_label}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Human-readable trust-gated affect mode label. |
| `{{runtime_affect_mode_is_honne}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Whether the current turn can express the genuine honne affect profile. |
| `{{runtime_affect_mode_is_tatemae}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Whether the current turn is constrained to the tatemae affect profile. |
| `{{runtime_affect_warmth}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed warmth modifier derived from the current affect state. |
| `{{runtime_affect_formality}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed formality modifier derived from the current affect state. |
| `{{runtime_affect_energy}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed energy modifier derived from the current affect state. |
| `{{runtime_affect_assertiveness}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed assertiveness modifier derived from the current affect state. |
| `{{runtime_affect_expressiveness}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Expressiveness level derived from the current affect state. |
| `{{runtime_affect_intensity}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Resolved affect intensity used for prompt shaping. |
| `{{runtime_affect_variability}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Resolved affect variability used for prompt shaping. |
| `{{runtime_affect_control}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Resolved affect control used for prompt shaping. |
| `{{runtime_affect_display_range_min}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Lower bound of the affect display range. |
| `{{runtime_affect_display_range_max}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Upper bound of the affect display range. |
| `{{runtime_affect_valence}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed valence from the current affect snapshot. |
| `{{runtime_affect_arousal}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed arousal from the current affect snapshot. |
| `{{runtime_affect_dominance}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed dominance from the current affect snapshot. |
| `{{runtime_affect_snapshot_mood_valence}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed mood valence from the current emotion snapshot. |
| `{{runtime_affect_snapshot_mood_arousal}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed mood arousal from the current emotion snapshot. |
| `{{runtime_affect_snapshot_mood_dominance}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Signed mood dominance from the current emotion snapshot. |
| `{{runtime_affect_snapshot_confidence}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Confidence score from the current emotion snapshot. |
| `{{runtime_affect_guidance_warmth_label}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Human-readable warmth guidance derived from the current affect state. |
| `{{runtime_affect_guidance_formality_label}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Human-readable formality guidance derived from the current affect state. |
| `{{runtime_affect_guidance_energy_label}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Human-readable energy guidance derived from the current affect state. |
| `{{runtime_affect_guidance_assertiveness_label}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Human-readable assertiveness guidance derived from the current affect state. |
| `{{runtime_affect_guidance_expressiveness_label}}` | turn | `emotion-persona-adaptation:buildEmotionalAffectPromptVariables` | Human-readable expressiveness guidance derived from the current affect state. |

### Metacognition

| Macro | Volatility | Producer | Value |
|---|---|---|---|
| `{{runtime_flag_uncertainty_present}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Whether the uncertainty metacognitive flag is active for the current turn. |
| `{{runtime_flag_uncertainty_confidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Confidence score for the uncertainty metacognitive flag when it is active. |
| `{{runtime_flag_uncertainty_evidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Evidence summary for the uncertainty metacognitive flag when it is active. |
| `{{runtime_flag_avoidance_present}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Whether the avoidance metacognitive flag is active for the current turn. |
| `{{runtime_flag_avoidance_confidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Confidence score for the avoidance metacognitive flag when it is active. |
| `{{runtime_flag_avoidance_evidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Evidence summary for the avoidance metacognitive flag when it is active. |
| `{{runtime_flag_high_engagement_present}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Whether the high engagement metacognitive flag is active for the current turn. |
| `{{runtime_flag_high_engagement_confidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Confidence score for the high engagement metacognitive flag when it is active. |
| `{{runtime_flag_high_engagement_evidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Evidence summary for the high engagement metacognitive flag when it is active. |
| `{{runtime_flag_repetition_present}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Whether the repetition metacognitive flag is active for the current turn. |
| `{{runtime_flag_repetition_confidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Confidence score for the repetition metacognitive flag when it is active. |
| `{{runtime_flag_repetition_evidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Evidence summary for the repetition metacognitive flag when it is active. |
| `{{runtime_flag_confabulation_risk_present}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Whether the confabulation risk metacognitive flag is active for the current turn. |
| `{{runtime_flag_confabulation_risk_confidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Confidence score for the confabulation risk metacognitive flag when it is active. |
| `{{runtime_flag_confabulation_risk_evidence}}` | turn | `self-model-metacognition:buildMetacognitiveFlagPromptVariables` | Evidence summary for the confabulation risk metacognitive flag when it is active. |

### Internal state

| Macro | Volatility | Producer | Value |
|---|---|---|---|
| `{{runtime_internal_state_present}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Whether a structured internal-state snapshot is available for the current turn. |
| `{{runtime_internal_state_cognitive_processing_quality}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Processing quality label from the current internal cognitive state. |
| `{{runtime_internal_state_cognitive_certainty_label}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Certainty label from the current internal cognitive state. |
| `{{runtime_internal_state_cognitive_topic_engagement_label}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Topic engagement label from the current internal cognitive state. |
| `{{runtime_internal_state_attention_conversation_trajectory}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Conversation trajectory from the current internal attention state. |
| `{{runtime_internal_state_attention_active_concern_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Active concern count from the current internal attention state. |
| `{{runtime_internal_state_attention_active_concern_plural_suffix}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Plural suffix for active-concern count prose. |
| `{{runtime_internal_state_attention_pending_follow_up_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Pending follow-up count from the current internal attention state. |
| `{{runtime_internal_state_attention_pending_follow_up_plural_suffix}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Plural suffix for pending follow-up count prose. |
| `{{runtime_internal_state_relational_trust_level}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Trust level from the current internal relational state. |
| `{{runtime_internal_state_relational_recent_interaction_frequency_label}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Interaction frequency label from the current internal relational state. |
| `{{runtime_internal_state_relational_last_seen_label}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Last-seen recency label from the current internal relational state. |
| `{{runtime_internal_state_emotional_mood_valence_label}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Mood valence label from the current internal emotional state. |
| `{{runtime_internal_state_emotional_mood_arousal_label}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Mood arousal label from the current internal emotional state. |
| `{{runtime_internal_state_emotional_secondary_emotions}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Bare comma-separated secondary emotion names for custom phrasing. |
| `{{runtime_internal_state_emotional_telemetry_status}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Degraded emotion-telemetry status for the current snapshot; empty when telemetry is trusted (bare value). |
| `{{runtime_internal_state_emotional_telemetry_reasons}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Comma-joined degraded emotion-telemetry reasons; empty when telemetry is trusted (bare list). |

### Attention

| Macro | Volatility | Producer | Value |
|---|---|---|---|
| `{{runtime_concerns_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Total deduplicated active concern count available to the current turn. |
| `{{runtime_concerns_top_lines}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Top active concern bullet lines without the prose opener. |
| `{{runtime_concerns_top_priorities}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Comma-joined priorities for the top active concerns. |
| `{{runtime_concerns_omitted_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of lower-salience active concerns omitted from the top list. |
| `{{runtime_concerns_omitted_plural_suffix}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Plural suffix for omitted-concern count prose. |
| `{{runtime_emotion_appraisal_length}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Total number of emotion appraisal entries in the current chain. |
| `{{runtime_emotion_appraisal_latest_trigger}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Trigger label for the latest emotion appraisal entry. |
| `{{runtime_emotion_appraisal_latest_summary}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Compacted summary text from the latest emotion appraisal entry. |
| `{{runtime_emotion_appraisal_latest_timestamp_iso}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | ISO-8601 timestamp for the latest emotion appraisal entry. |
| `{{runtime_emotion_appraisal_recent_lines}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Last two formatted emotion appraisal bullet lines, newline-joined (data-shaped list). |
| `{{runtime_behavioral_notes_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of current behavioral note lines available for the active contact. |
| `{{runtime_behavioral_notes_body}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Behavioral-notes body lines without the wrapping XML tag (data-shaped list). |
| `{{runtime_skills_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of skill entries present in the current skills index XML. |
| `{{runtime_skills_index_body}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Preformatted skills-index body ready to drop into the legacy attention section. |

### Tooling

| Macro | Volatility | Producer | Value |
|---|---|---|---|
| `{{runtime_analysis_workbench_available}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Whether analysis_workbench is active and callable for the current turn. |
| `{{runtime_tooling_active_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of currently active tools. |
| `{{runtime_tooling_core_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of active core tools. |
| `{{runtime_tooling_promoted_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of promoted extended tools that are always active. |
| `{{runtime_tooling_loaded_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of explicitly loaded extended tools active for the turn. |
| `{{runtime_tooling_autoload_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of autoloaded extended tools active for the turn. |
| `{{runtime_tooling_deferred_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of deferred tools still active for this turn. |
| `{{runtime_tooling_available_extended_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of additional extended tools available for loading. |
| `{{runtime_appearance_context_body}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Appearance-context body that tool prompts can splice into self-image requests. |
| `{{runtime_self_image_tool_active}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Whether a self-image generation tool is currently active. |
| `{{runtime_extended_tools_total}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Total number of extended tools registered for the current turn. |
| `{{runtime_extended_tools_activatable_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of extended tools that can be activated immediately. |
| `{{runtime_extended_tools_blocked_count}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Count of extended tools blocked by the current capability tier. |
| `{{runtime_extended_tool_names}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Comma-joined extended tool names in registered order. |
| `{{runtime_extended_tool_directory_lines}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Extended tool directory lines without any extra prose preface. |
| `{{runtime_charge_budget_present}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Whether a run-charge policy is configured and budget values are available this turn (bare boolean). |
| `{{runtime_charge_lane}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Run-charge lane for the current turn. |
| `{{runtime_charge_quota}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Total run-charge quota for the current lane/window. |
| `{{runtime_charge_remaining}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Remaining run-charge units for the current lane/window. |
| `{{runtime_charge_cost_lines}}` | turn | `runtime-context:buildDynamicPromptTemplateVariables` | Costed charge-surface lines, newline-joined (data-shaped list). |

### Prefix families (open-ended card fields)

| Prefix | Volatility | Producer | Value |
|---|---|---|---|
| `{{character.*}}` | static | `character-macro-map:buildCharacterMacroMap` | Dotted character card fields, including flattened card extensions. |
| `{{extensions_*}}` | static | `character-macro-map:buildCharacterMacroMap` | Snake-cased character card extension fields. |

## SillyTavern card-field compatibility group

Character cards are imported from the SillyTavern ecosystem, so the card-field macro spellings below are an **external compatibility surface**. They are intentionally kept (with their same-value aliases) even though the macro diet removed every internal alias:

- {{user}} / {{user_name}}
- {{char}} / {{char_name}} / {{character}} / {{character_name}}
- {{name}}
- {{description}}
- {{personality}}
- {{scenario}}
- {{system_prompt}}
- {{mes_example}}
- {{post_history_instructions}}
- {{first_mes}}
- {{creator}}
- {{creator_notes}}
- {{tags}}
- {{alternate_greetings}}
- {{visual_description}} / {{extensions_visual_description}}
- `character.*` / `extensions_*` prefix families

These are the ONLY macros with multiple registered spellings. Everything else has exactly one canonical name.

## Removed macros

Removed with a clean break in the macro diet (E2.5). These names never resolve at render time; the table exists so validation errors and the audit can name the canonical replacement. Layer create/update, prompt-registry updates, and compose all fail closed with a clear message when a persisted layer still references one; run `npm run audit:prompt-macros` to scan persisted prompt state up front (report only, nothing is rewritten).

| Removed macro | Use instead |
|---|---|
| `{{now}}` | {{current_datetime}} |
| `{{current_datetime_iso}}` | {{current_datetime}} |
| `{{date}}` | {{current_date}} |
| `{{time}}` | {{current_time}} |
| `{{current_timestamp}}` | {{unix_timestamp}} |
| `{{timestamp}}` | {{unix_timestamp}} |
| `{{now_iso}}` | {{current_datetime}} |
| `{{channel}}` | {{channel_id}} |
| `{{model_id}}` | {{model}} |
| `{{runtime_trust_level}}` | {{trust_level}} |
| `{{runtime_affect_profile_intensity}}` | {{runtime_affect_intensity}} |
| `{{runtime_affect_profile_variability}}` | {{runtime_affect_variability}} |
| `{{runtime_affect_profile_control}}` | {{runtime_affect_control}} |
| `{{runtime_affect_profile_display_range_min}}` | {{runtime_affect_display_range_min}} |
| `{{runtime_affect_profile_display_range_max}}` | {{runtime_affect_display_range_max}} |
| `{{runtime_affect_snapshot_vad_valence}}` | {{runtime_affect_valence}} |
| `{{runtime_affect_snapshot_vad_arousal}}` | {{runtime_affect_arousal}} |
| `{{runtime_affect_snapshot_vad_dominance}}` | {{runtime_affect_dominance}} |
| `{{runtime_emotion_appraisal_body}}` | {{runtime_emotion_appraisal_recent_lines}} |
| `{{runtime_behavioral_notes_body_raw}}` | {{runtime_behavioral_notes_body}} |
| `{{runtime_last_message_received_human}}` | {{runtime_last_message_received_date_human}} + {{runtime_last_message_received_time_human}} + {{runtime_last_message_received_timezone}} + {{runtime_last_message_received_ago}} with your own phrasing |
| `{{runtime_last_message_received_missing_notice}}` | {{#if runtime_last_message_received_missing}}your own wording{{/if}} |
| `{{runtime_internal_turn_context}}` | {{runtime_internal_turn_kind}} with your own phrasing |
| `{{runtime_affect_privacy_guidance}}` | {{runtime_affect_mode_is_honne}} / {{runtime_affect_mode_is_tatemae}} conditionals with your own wording |
| `{{runtime_internal_state_emotional_prefix}}` | {{runtime_internal_state_emotional_secondary_emotions}} with your own phrasing |
| `{{runtime_internal_state_emotional_secondary_clause}}` | {{runtime_internal_state_emotional_secondary_emotions}} with your own phrasing |
| `{{runtime_internal_state_emotional_validation_clause}}` | {{runtime_internal_state_emotional_telemetry_status}} + {{runtime_internal_state_emotional_telemetry_reasons}} with your own phrasing |
| `{{runtime_tooling_summary}}` | {{runtime_tooling_active_count}} and the other runtime_tooling_*_count values with your own phrasing |

## Rules for new macros

1. New runtime data ships as bare-value macros. Never add a prose/formatted convenience macro — the default phrasing belongs in a seeded layer built from the bare values.
2. Never put instructions, guidance sentences, or emotional framing inside a macro value — that text belongs in a prompt layer the operator (or the companion, through the approval queue) can edit.
3. Register every macro in `PROMPT_RUNTIME_MACRO_HINTS` with its volatility and producer. This is not optional: the turn variable namespace throws on unregistered keys, and writing a key that another producer already writes throws.
4. `turn`-volatile macros belong in dynamic layers (`runtime.state` and friends). Static-class layers (`base`/`operator`) reject them at edit and compose time to protect the cached static prefix.
5. One canonical name per datum. If a macro is removed, add it to `REMOVED_PROMPT_MACROS` with the canonical replacement — never keep it as a live alias.
6. Regenerate this doc (`npm run docs:prompt-macros`) in the same change.
