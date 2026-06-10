# Prompt Macros And The Purity Rule

This is the operator reference for runtime prompt macros (template variables) and the rules that keep companion prompts operator-tunable.

Audited 2026-06-10 against the live macro surface (`PROMPT_RUNTIME_MACRO_HINTS` in `src/core/identity/prompt-runtime.ts` and the variable builders in `src/core/agent/substrate-agent/runtime-context.ts`).

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

The authoritative, always-current list is `PROMPT_RUNTIME_MACRO_HINTS` (exported from `src/core/identity/prompt-runtime.ts`; the agent sees it as `PROMPT_RUNTIME_TOKEN_HINT`). Groups:

| Group | Macros (representative) | Values |
|---|---|---|
| global aliases | `{{current_datetime}}` `{{current_date}}` `{{current_time}}` `{{unix_timestamp}}` `{{user}}` `{{char}}` `{{description}}` `{{personality}}` `{{scenario}}` `{{system_prompt}}` `{{mes_example}}` `{{post_history_instructions}}` `{{channel_id}}` `{{channel_type}}` `{{trust_level}}` `{{model}}` `{{active_timezone}}` | bare values (SillyTavern-compatible card fields + runtime identifiers) |
| runtime state | `{{runtime_current_datetime_human}}` `{{runtime_current_datetime_iso}}` `{{runtime_current_weekday}}` `{{runtime_last_message_received_*}}` (`_present`, `_at_iso`, `_weekday`, `_date_human`, `_time_human`, `_timezone`, `_ago`, `_days_hours`) | bare values |
| trust | `{{runtime_trust_level}}` plus `{{runtime_trust_is_primary/trusted/regular/public}}` booleans | bare values |
| response style | `{{runtime_response_style}}` `{{runtime_response_style_name}}` `is_concise`/`is_expressive` booleans | bare values |
| affect | `{{runtime_affect_mode}}` (`honne`/`tatemae`), `is_honne`/`is_tatemae` booleans, numeric `warmth`/`formality`/`energy`/`assertiveness`/`expressiveness`/`intensity`/`variability`/`control`, VAD + mood components, guidance labels (`warmer`, `more relaxed`, …) | bare values |
| metacognition | per-flag `{{runtime_flag_<name>_present/confidence/evidence}}` for `uncertainty`, `avoidance`, `high_engagement`, `repetition`, `confabulation_risk` | bare values |
| internal state | `{{runtime_internal_state_present}}`, cognitive/attention/relational labels and counts, mood labels, `{{runtime_internal_state_emotional_secondary_emotions}}` (bare list) | bare values |
| attention | `{{runtime_concerns_count}}` `{{runtime_concerns_top_lines}}` `{{runtime_concerns_top_priorities}}` `{{runtime_concerns_omitted_count}}`, emotion-appraisal values, behavioral-note counts | bare values + data-shaped lists |
| tooling | `{{runtime_tooling_*_count}}`, `{{runtime_extended_tool_names}}`, directory lines, skills count/body | bare values + data-shaped lists |

## Known prose/convenience macros (and their bare siblings)

These macros intentionally render *default phrasing or formatting* as a convenience for the default layers. Custom layers should prefer the bare siblings.

| Convenience macro | Embeds | Bare alternative for custom phrasing |
|---|---|---|
| `{{runtime_last_message_received_human}}` | timestamp + timezone + "(N minutes ago)" formatting | `_date_human`, `_time_human`, `_timezone`, `_ago` |
| `{{runtime_last_message_received_missing_notice}}` | the sentence "No earlier message is loaded for this channel." | `{{runtime_last_message_received_present}}` boolean + your own `{{#if}}` text |
| `{{runtime_response_style_delivery_guidance}}` / `_expansion_guidance` / `_guidance_body}}` | instruction sentences ("Keep your voice warm and vivid.") | `{{runtime_response_style}}` + `is_concise`/`is_expressive` booleans |
| `{{runtime_affect_privacy_guidance}}` | trust-gated privacy sentences | `{{runtime_affect_mode_is_honne}}` / `_is_tatemae` + `{{runtime_trust_is_*}}` |
| `{{runtime_internal_state_emotional_prefix}}` / `_secondary_clause}}` | grammatical connectors ("mostly ", ", with X present") | `{{runtime_internal_state_emotional_secondary_emotions}}` (bare list) |
| `{{runtime_concerns_top_lines}}` | bullet-formatted concern lines with `[priority; revisit before …]` metadata | data is bare per line; the framing sentence ("Treat these as soft threads…") lives in the open-threads layer text and is replaceable there |
| `{{runtime_emotion_appraisal_recent_lines}}` / `_body}}` | bullet formatting | `{{runtime_emotion_appraisal_latest_trigger}}` / `_latest_summary` / `_latest_timestamp_iso` |
| `{{runtime_behavioral_notes_body}}` / `_raw}}`, `{{runtime_skills_index_body}}`, `{{runtime_extended_tool_directory_lines}}` | preformatted blocks | counts + names variables in the same groups |

## Rules for new macros

1. New runtime data ships as bare-value macros first. A formatted convenience macro may be added *in addition*, never *instead*.
2. Never put instructions, guidance sentences, or emotional framing inside a macro value — that text belongs in a prompt layer the operator (or the companion, through the approval queue) can edit.
3. Register every macro in `PROMPT_RUNTIME_MACRO_HINTS` so it is discoverable here and by the agent.
4. Volatile macros (timestamps, elapsed time) belong in late layers (`runtime.state`) to protect the cached static prefix.

## Open items

- The continuity-gap notice (`<runtime_continuity_notice>`, `src/core/agent/substrate-agent/runtime-context.ts`) and the charge-budget block currently render system-owned prose directly as context blocks rather than through macro + layer text; migrate them to the layer system when those blocks next change.
- `softenConcernText` (`src/core/intention/concerns.ts`) rewrites concern wording in code; the rewrite rules should eventually be data the operator can tune.
