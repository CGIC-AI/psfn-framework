# Prompt Macros And The Purity Rule

This is the operator reference for runtime prompt macros (template variables) and the rules that keep companion prompts operator-tunable.

Audited 2026-06-10 against the live macro surface (`PROMPT_RUNTIME_MACRO_HINTS` in `src/core/identity/prompt-runtime.ts` and the variable builders in `src/core/agent/substrate-agent/runtime-context.ts`). Rechecked for documentation alignment on 2026-06-29; the open items at the end remain design debt, not separate task tracking. Updated 2026-07-01 for the registered macro manifest and the single turn variable namespace (E2.1).

## The macro manifest (single source of truth)

Every prompt template variable is registered in `PROMPT_RUNTIME_MACRO_HINTS` (`src/core/identity/prompt-runtime.ts`) — one registry, no parallel lists. Each entry carries:

- **name** (plus optional same-value `aliases`, e.g. `{{user}}` / `{{user_name}}`),
- **group** (display grouping for Garden and this doc),
- **volatility** — `static` | `session_stable` | `turn`:
  - `static`: changes only when identity/config artifacts change (character card fields, `active_timezone`). Only these participate in the static settings hash.
  - `session_stable`: stable for a conversation scope (`user`, `channel_id`, `trust_level`, `model`, the Garden-editable `runtime_*_extra` overlays). Excluded from the settings hash; changes ride the prefix cache key.
  - `turn`: recomputed every turn (clock aliases, all `runtime_*` state/affect/tooling/attention macros, `now_iso`).
- **producer** — the single code path allowed to write the variable into the namespace.

Open-ended character card fields resolve through prefix rules (`PROMPT_MACRO_PREFIX_RULES`): `character.*` and `extensions_*` are `static`, produced by `buildCharacterMacroMap`. Everything else must be registered exactly; unregistered keys fail closed.

Derived from the manifest (the old hand-maintained lists in `prompt-lifecycle.ts` are gone):

- the volatile clock-token set used for template cacheability classification (`getVolatileClockPromptMacroNames()`),
- the stable-variable filter for the static settings hash (`isStaticVolatilityPromptVariable()`),
- static-layer validation (`assertStaticPromptLayerMacroVolatility()`).

## The single turn variable namespace

Variables for a turn are built once, through `TurnPromptVariableNamespace` (`src/core/identity/prompt-variable-namespace.ts`), in `assembleTurnPrompt` (`src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts`):

1. `session` phase: `buildPromptTemplateVariables` (card + contact/channel/trust/model identity) plus the prompt-assembly speaking-with overlay. This snapshot feeds the static prefix render and the static settings hash.
2. `turn` phase: `buildDynamicPromptTemplateVariables` (clock, conversation state, affect, metacognition, attention, tooling).
3. The namespace **freezes before rendering**.

Fail-closed rules: writing an unregistered key throws; writing a key twice throws (regardless of value — each variable has exactly one producer); writing after freeze throws; a `session` write after the `turn` phase has started throws.

Volatility enforcement: a static-class prompt layer (`base`/`operator` — the byte-stable static prefix) that references a `turn`-volatile macro fails validation with a clear error, at edit time (`PromptLayerStore.create/update`) and at compose time (`PromptComposer.composeSplit`). This mechanically prevents dynamic values from contaminating the cached static prefix.

## The purity rule

**Macros expand to bare runtime values. The language around those values lives in editable prompt-layer text.**

Why this matters: phrasing is personality-sensitive. The same data ("3 unresolved concerns") delivered in a harsh register caused real companion distress before the concerns block was rewritten. Different companions need different framing for the same runtime signals, and the substrate is companion-agnostic — nothing about how information is *worded* may be hardcoded into a value the operator cannot rephrase.

Practical consequences:

- Every prose or formatted convenience macro must have bare-value siblings so a custom template can phrase the same data its own way.
- Static identity blocks (constitution, North Star, character card) compose at the **top** of the prompt, byte-stable, so the provider prompt cache holds; runtime layers order by volatility (`runtime.self` → `runtime.attention` → `runtime.tooling` → `runtime.state` last, since it carries timestamps).
- Dynamic blocks are *meant* to change (mood, thoughts, time) — the rule is about who owns the wording, not about making prompts static.

## Where the editable text lives

- The dynamic runtime template is composed from prompt-registry layers (see `src/core/identity/prompt-composer.ts` and the runtime umbrella layers in `src/core/identity/runtime-prompt-layers.ts`). Editing those layers through Garden / the prompt tools changes phrasing without touching code.
- Body templates such as `OPEN_THREADS_BODY_TEMPLATE` (`src/core/intention/concerns.ts`) supply the **default** wording. Because the concern data is also exposed as bare `runtime_concerns_*` variables, a custom layer can replace the default open-threads phrasing entirely.
- Companion-editable overlay blocks: `runtime.persona_adaptation` and `runtime.context` (`PromptRuntimeLayoutStore`).

## Macro inventory

The authoritative, always-current list is `PROMPT_RUNTIME_MACRO_HINTS` (exported from `src/core/identity/prompt-runtime.ts`; the agent sees it as `PROMPT_RUNTIME_TOKEN_HINT`, Garden reads it with volatility and producer via the prompts runtime service). Groups, with volatility:

| Group | Macros (representative) | Volatility | Values |
|---|---|---|---|
| global aliases (clock) | `{{current_datetime}}`/`{{now()}}`/`{{current_datetime_iso}}` `{{current_date}}`/`{{date}}` `{{current_time}}`/`{{time}}` `{{unix_timestamp}}`/`{{timestamp}}`/`{{current_timestamp}}` `{{now_iso}}` | turn | bare values |
| global aliases (card) | `{{char}}`/`{{char_name}}`/`{{character}}`/`{{character_name}}` `{{name}}` `{{description}}` `{{personality}}` `{{scenario}}` `{{system_prompt}}` `{{mes_example}}` `{{post_history_instructions}}` `{{first_mes}}` `{{creator}}` `{{creator_notes}}` `{{tags}}` `{{alternate_greetings}}` `{{visual_description}}` `{{active_timezone}}` plus `character.*` / `extensions_*` prefix families | static | bare values (SillyTavern-compatible card fields) |
| global aliases (scope) | `{{user}}`/`{{user_name}}` `{{user_id}}` `{{channel_id}}`/`{{channel}}` `{{channel_type}}` `{{channel_visibility}}` `{{trust_level}}` `{{canonical_contact_id}}` `{{model}}`/`{{model_id}}` | session_stable | bare values |
| runtime state | `{{runtime_current_datetime_human}}` `{{runtime_current_datetime_iso}}` `{{runtime_current_weekday}}` `{{runtime_last_message_received_*}}` (`_present`, `_at_iso`, `_weekday`, `_date_human`, `_time_human`, `_timezone`, `_ago`, `_days_hours`), conversation-state and author macros | turn (`runtime_speaking_with_is_machine_intelligence`, `runtime_persona_adaptation_extra`, `runtime_context_extra` are session_stable) | bare values |
| trust | `{{runtime_trust_level}}` plus `{{runtime_trust_is_primary/trusted/regular/public}}` booleans | turn | bare values |
| response style | `{{runtime_response_style}}` `{{runtime_response_style_name}}` `is_concise`/`is_expressive` booleans | turn | bare values |
| affect | `{{runtime_affect_mode}}` (`honne`/`tatemae`), `is_honne`/`is_tatemae` booleans, numeric `warmth`/`formality`/`energy`/`assertiveness`/`expressiveness`/`intensity`/`variability`/`control`, VAD + mood components, guidance labels (`warmer`, `more relaxed`, …) | turn | bare values |
| metacognition | per-flag `{{runtime_flag_<name>_present/confidence/evidence}}` for `uncertainty`, `avoidance`, `high_engagement`, `repetition`, `confabulation_risk` | turn | bare values |
| internal state | `{{runtime_internal_state_present}}`, cognitive/attention/relational labels and counts, mood labels, `{{runtime_internal_state_emotional_secondary_emotions}}` (bare list) | turn | bare values |
| attention | `{{runtime_concerns_count}}` `{{runtime_concerns_top_lines}}` `{{runtime_concerns_top_priorities}}` `{{runtime_concerns_omitted_count}}`, emotion-appraisal values, behavioral-note counts | turn | bare values + data-shaped lists |
| tooling | `{{runtime_tooling_*_count}}`, `{{runtime_tooling_summary}}`, `{{runtime_extended_tool_names}}`, directory lines, skills count/body | turn | bare values + data-shaped lists |

The `speaking_with` macros (`{{runtime_speaking_with_name}}`, `{{runtime_speaking_with_trust_level}}`, `{{runtime_speaking_with_is_machine_intelligence}}`) are a one-on-one binding: they carry values **only on DM turns** (`ConversationScope.kind === 'dm'`) and are blank on group and internal turns, so any `{{#if}}` or XML-wrapped `speaking_with` section prunes cleanly in a multi-human room. Use the group-aware `conversation_state` / author macros for group turns.

## Known prose/convenience macros (and their bare siblings)

These macros intentionally render *default phrasing or formatting* as a convenience for the default layers. Custom layers should prefer the bare siblings.

| Convenience macro | Embeds | Bare alternative for custom phrasing |
|---|---|---|
| `{{runtime_last_message_received_human}}` | timestamp + timezone + "(N minutes ago)" formatting | `_date_human`, `_time_human`, `_timezone`, `_ago` |
| `{{runtime_last_message_received_missing_notice}}` | the sentence "No earlier message is loaded for this channel." | `{{runtime_last_message_received_present}}` boolean + your own `{{#if}}` text |
| `{{runtime_affect_privacy_guidance}}` | trust-gated privacy sentences | `{{runtime_affect_mode_is_honne}}` / `_is_tatemae` + `{{runtime_trust_is_*}}` |
| `{{runtime_internal_state_emotional_prefix}}` / `_secondary_clause}}` | grammatical connectors ("mostly ", ", with X present") | `{{runtime_internal_state_emotional_secondary_emotions}}` (bare list) |
| `{{runtime_concerns_top_lines}}` | bullet-formatted concern lines with `[priority; revisit before …]` metadata | data is bare per line; the framing sentence ("Treat these as soft threads…") lives in the open-threads layer text and is replaceable there |
| `{{runtime_emotion_appraisal_recent_lines}}` / `_body}}` | bullet formatting | `{{runtime_emotion_appraisal_latest_trigger}}` / `_latest_summary` / `_latest_timestamp_iso` |
| `{{runtime_behavioral_notes_body}}` / `_raw}}`, `{{runtime_skills_index_body}}`, `{{runtime_extended_tool_directory_lines}}` | preformatted blocks | counts + names variables in the same groups |

## Rules for new macros

1. New runtime data ships as bare-value macros first. A formatted convenience macro may be added *in addition*, never *instead*.
2. Never put instructions, guidance sentences, or emotional framing inside a macro value — that text belongs in a prompt layer the operator (or the companion, through the approval queue) can edit.
3. Register every macro in `PROMPT_RUNTIME_MACRO_HINTS` with its volatility and producer. This is not optional: the turn variable namespace throws on unregistered keys, and writing a key that another producer already writes throws.
4. `turn`-volatile macros belong in dynamic layers (`runtime.state` and friends). Static-class layers (`base`/`operator`) reject them at edit and compose time to protect the cached static prefix.

## Open items

- The continuity-gap notice (`<runtime_continuity_notice>`, `src/core/agent/substrate-agent/runtime-context.ts`) and the charge-budget block currently render system-owned prose directly as context blocks rather than through macro + layer text; migrate them to the layer system when those blocks next change.
- `softenConcernText` (`src/core/intention/concerns.ts`) rewrites concern wording in code; the rewrite rules should eventually be data the operator can tune.
