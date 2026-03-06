# Identity Macro Contract

This contract defines how character-card fields are converted into runtime prompt
macros and how unresolved macros are handled.

## Canonical Source

All card-backed prompt macros are generated from one source:

- `src/identity/character-macro-map.ts` via `buildCharacterMacroMap(card)`

Prompt sync and runtime expansion must consume this map instead of per-file
substitutions.

## Supported Macro Families

Core aliases (same value from `card.data.name`):

- `{{char}}`
- `{{char_name}}`
- `{{character}}`
- `{{character_name}}`
- `{{name}}`

Primary card fields:

- `{{description}}`
- `{{personality}}`
- `{{scenario}}`
- `{{system_prompt}}`
- `{{post_history_instructions}}`
- `{{mes_example}}`
- `{{first_mes}}`
- `{{creator}}`
- `{{creator_notes}}`
- `{{tags}}`
- `{{alternate_greetings}}`
- `{{visual_description}}`

Canonical dotted aliases:

- `{{character.name}}`
- `{{character.description}}`
- `{{character.personality}}`
- `{{character.scenario}}`
- `{{character.system_prompt}}`
- `{{character.post_history_instructions}}`
- `{{character.mes_example}}`
- `{{character.first_mes}}`
- `{{character.creator}}`
- `{{character.creator_notes}}`
- `{{character.tags}}`
- `{{character.alternate_greetings}}`
- `{{character.visual_description}}`

Extension fields:

- Flattened extension entries are exposed as:
  - `{{extensions_<snake_case_key>}}`
  - `{{character.extensions.<dotted_key>}}`

## Fallback/Resolution Rules

1. Placeholder-like values (`"system prompt"`, `"post history instructions"`,
   empty strings) are normalized to empty values.
2. Missing card fields resolve to empty strings, not hardcoded legacy text.
3. During Character Foundation sync, unresolved macros are fail-closed:
   unsupported unresolved tokens abort sync.
4. Runtime-only unresolved tokens (user/channel/time/model/contact context) are
   explicitly allowlisted in `src/identity/prompt-sync.ts`.

## Admin Update Integration

Identity import, field update, and rollback paths must call
`syncCharacterFoundationPromptFromCard(...)` so prompt layers stay aligned with
the canonical macro map.
