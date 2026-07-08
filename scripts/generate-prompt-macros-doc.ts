// Regenerates docs/prompt-macros.md from the live macro manifest
// (PROMPT_RUNTIME_MACRO_HINTS / PROMPT_MACRO_PREFIX_RULES / REMOVED_PROMPT_MACROS).
// Run: npm run docs:prompt-macros
//
// The prose sections below are the operator-facing explanation of the purity
// rule and renderer invariants; the tables are derived from the manifest so
// the doc can never drift from the registered macro surface.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROMPT_MACRO_PREFIX_RULES,
  PROMPT_RUNTIME_MACRO_HINTS,
  REMOVED_PROMPT_MACROS,
  type PromptRuntimeMacroHint,
} from '../src/core/identity/prompt-runtime.js';

const GROUP_ORDER: Array<{ group: PromptRuntimeMacroHint['group']; title: string }> = [
  { group: 'global_aliases', title: 'Global (clock, card, scope)' },
  { group: 'runtime_state', title: 'Runtime state' },
  { group: 'trust', title: 'Trust' },
  { group: 'response_style', title: 'Response style' },
  { group: 'affect', title: 'Affect' },
  { group: 'metacognition', title: 'Metacognition' },
  { group: 'internal_state', title: 'Internal state' },
  { group: 'attention', title: 'Attention' },
  { group: 'tooling', title: 'Tooling' },
];

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatMacroRow(hint: PromptRuntimeMacroHint): string {
  const aliasSuffix = hint.aliases && hint.aliases.length > 0
    ? ` (aliases: ${hint.aliases.map(alias => `\`{{${alias}}}\``).join(', ')})`
    : '';
  return `| \`${escapeTableCell(hint.token)}\`${aliasSuffix} | ${hint.volatility} | \`${escapeTableCell(hint.producer)}\` | ${escapeTableCell(hint.description)} |`;
}

function buildInventorySection(): string {
  const lines: string[] = [];
  for (const { group, title } of GROUP_ORDER) {
    const hints = PROMPT_RUNTIME_MACRO_HINTS.filter(hint => hint.group === group);
    if (hints.length === 0) continue;
    lines.push(`### ${title}`);
    lines.push('');
    lines.push('| Macro | Volatility | Producer | Value |');
    lines.push('|---|---|---|---|');
    for (const hint of hints) {
      lines.push(formatMacroRow(hint));
    }
    lines.push('');
  }
  lines.push('### Prefix families (open-ended card fields)');
  lines.push('');
  lines.push('| Prefix | Volatility | Producer | Value |');
  lines.push('|---|---|---|---|');
  for (const rule of PROMPT_MACRO_PREFIX_RULES) {
    lines.push(`| \`{{${rule.prefix}*}}\` | ${rule.volatility} | \`${escapeTableCell(rule.producer)}\` | ${escapeTableCell(rule.description)} |`);
  }
  return lines.join('\n');
}

const CARD_COMPATIBILITY_TOKENS = [
  '{{user}} / {{user_name}}',
  '{{char}} / {{char_name}} / {{character}} / {{character_name}}',
  '{{name}}',
  '{{description}}',
  '{{personality}}',
  '{{scenario}}',
  '{{system_prompt}}',
  '{{mes_example}}',
  '{{post_history_instructions}}',
  '{{first_mes}}',
  '{{creator}}',
  '{{creator_notes}}',
  '{{tags}}',
  '{{alternate_greetings}}',
  '{{visual_description}} / {{extensions_visual_description}}',
  '`character.*` / `extensions_*` prefix families',
];

function buildCompatibilitySection(): string {
  return [
    'Character cards are imported from the SillyTavern ecosystem, so the card-field macro spellings below are an **external compatibility surface**. They are intentionally kept (with their same-value aliases) even though the macro diet removed every internal alias:',
    '',
    ...CARD_COMPATIBILITY_TOKENS.map(token => `- ${token}`),
    '',
    'These are the ONLY macros with multiple registered spellings. Everything else has exactly one canonical name.',
  ].join('\n');
}

function buildRemovedSection(): string {
  const lines = [
    'Removed with a clean break in the macro diet (E2.5). These names never resolve at render time; the table exists so validation errors and the audit can name the canonical replacement. Layer create/update, prompt-registry updates, and compose all fail closed with a clear message when a persisted layer still references one; run `npm run audit:prompt-macros` to scan persisted prompt state up front (report only, nothing is rewritten).',
    '',
    '| Removed macro | Use instead |',
    '|---|---|',
  ];
  for (const [name, info] of REMOVED_PROMPT_MACROS.entries()) {
    lines.push(`| \`{{${name}}}\` | ${escapeTableCell(info.canonical)} |`);
  }
  return lines.join('\n');
}

function countRegisteredNames(): number {
  let count = 0;
  for (const hint of PROMPT_RUNTIME_MACRO_HINTS) {
    const tokenNames = [...hint.token.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g)].length;
    count += tokenNames + (hint.aliases?.length ?? 0);
  }
  return count;
}

const doc = `# Prompt Macros And The Purity Rule

This is the operator reference for runtime prompt macros (template variables) and the rules that keep companion prompts operator-tunable.

GENERATED FILE: the macro tables below are regenerated from the live manifest with \`npm run docs:prompt-macros\` (source: \`scripts/generate-prompt-macros-doc.ts\`, manifest: \`PROMPT_RUNTIME_MACRO_HINTS\` in \`src/core/identity/prompt-runtime.ts\`). Edit the generator, not the tables. Registered macro names: ${String(countRegisteredNames())}.

## The macro manifest (single source of truth)

Every prompt template variable is registered in \`PROMPT_RUNTIME_MACRO_HINTS\` (\`src/core/identity/prompt-runtime.ts\`) — one registry, no parallel lists. Each entry carries:

- **name** (one canonical spelling; only the SillyTavern card-compatibility group carries same-value \`aliases\`),
- **group** (display grouping for Garden and this doc),
- **volatility** — \`static\` | \`session_stable\` | \`turn\`:
  - \`static\`: changes only when identity/config artifacts change (character card fields, \`active_timezone\`). Only these participate in the static settings hash.
  - \`session_stable\`: stable for a conversation scope (\`user\`, \`channel_id\`, \`trust_level\`, \`model\`, the Garden-editable \`runtime_*_extra\` overlays). Excluded from the settings hash; changes ride the prefix cache key.
  - \`turn\`: recomputed every turn (canonical clock macros and all \`runtime_*\` state/affect/tooling/attention macros).
- **producer** — the single code path allowed to write the variable into the namespace.

Open-ended character card fields resolve through prefix rules (\`PROMPT_MACRO_PREFIX_RULES\`): \`character.*\` and \`extensions_*\` are \`static\`, produced by \`buildCharacterMacroMap\`. Everything else must be registered exactly; unregistered keys fail closed.

Derived from the manifest:

- the volatile clock-token set used for template cacheability classification (\`getVolatileClockPromptMacroNames()\`),
- the stable-variable filter for the static settings hash (\`isStaticVolatilityPromptVariable()\`),
- static-layer validation (\`assertStaticPromptLayerMacroVolatility()\`),
- the removed-macro safety valve (\`assertNoRemovedPromptMacros()\`, \`REMOVED_PROMPT_MACROS\`).

## The single turn variable namespace

Variables for a turn are built once, through \`TurnPromptVariableNamespace\` (\`src/core/identity/prompt-variable-namespace.ts\`), in \`assembleTurnPrompt\` (\`src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts\`):

1. \`session\` phase: \`buildPromptTemplateVariables\` (card + contact/channel/trust/model identity) plus the prompt-assembly speaking-with overlay. This snapshot feeds the static prefix render and the static settings hash.
2. \`turn\` phase: \`buildDynamicPromptTemplateVariables\` (clock, conversation state, affect, metacognition, attention, tooling, continuity gap, charge budget).
3. The namespace **freezes before rendering**.

Fail-closed rules: writing an unregistered key throws; writing a key twice throws (regardless of value — each variable has exactly one producer); writing after freeze throws; a \`session\` write after the \`turn\` phase has started throws.

Volatility enforcement: a static-class prompt layer (\`base\`/\`operator\` — the byte-stable static prefix) that references a \`turn\`-volatile macro fails validation with a clear error, at edit time (\`PromptLayerStore.create/update\`) and at compose time (\`PromptComposer.composeSplit\`). This mechanically prevents dynamic values from contaminating the cached static prefix.

## The purity rule

**Macros expand to bare runtime values. The language around those values lives in editable prompt-layer text.**

Why this matters: phrasing is personality-sensitive. The same data ("3 unresolved concerns") delivered in a harsh register caused real companion distress before the concerns block was rewritten. Different companions need different framing for the same runtime signals, and the substrate is companion-agnostic — nothing about how information is *worded* may be hardcoded into a value the operator cannot rephrase.

Practical consequences:

- Runtime data ships as bare-value macros. The old prose "convenience" macros (\`runtime_last_message_received_human\`, \`runtime_affect_privacy_guidance\`, \`runtime_tooling_summary\`, ...) were removed; their default phrasing lives in the seeded runtime layers, built from the bare siblings, where the operator can rephrase it.
- Static identity blocks (constitution, North Star, character card) compose at the **top** of the prompt, byte-stable, so the provider prompt cache holds; runtime layers order by volatility (\`runtime.continuity_notice\` → \`runtime.attention\` → \`runtime.response_style\` → \`runtime.tooling\` → \`runtime.charge_budget\` → \`runtime.state\` last, since it carries timestamps).
- Dynamic blocks are *meant* to change (mood, thoughts, time) — the rule is about who owns the wording, not about making prompts static.

## Where the editable text lives

- The dynamic runtime template is composed from prompt-registry layers seeded by \`config/runtime-prompt-layers.seed.json\` (see \`src/core/identity/prompt-composer.ts\` and \`src/core/identity/runtime-prompt-layers.ts\`). Editing those layers through Garden / the prompt tools changes phrasing without touching code. This includes:
  - the open-threads framing and omitted-count wording (\`runtime.attention\`),
  - the last-message "missing" notice (\`runtime.state\`, via \`{{#if runtime_last_message_received_missing}}\`),
  - the continuity-gap notice (\`runtime.continuity_notice\`, from the bare \`runtime_continuity_gap_*\` values),
  - the charge-budget wording (\`runtime.charge_budget\`, from the bare \`runtime_charge_*\` values),
  - response-style delivery guidance (\`runtime.response_style\`).
- Concern-text softening rewrites are operator-tunable data: \`config/concern-softening.json\` (regex rules + truncation length; the shipped default reproduces the previous behavior byte-for-byte).
- Companion-editable overlay blocks: \`runtime.persona_adaptation\` and \`runtime.context\` (\`PromptRuntimeLayoutStore\`).

## Renderer and the no-silent-leak invariant

\`renderPromptRuntimeTokens\` makes **one token-resolution pass** over a template: conditionals resolve first, then clock and variable tokens substitute, and a substituted value that itself contains macro syntax expands recursively (bounded depth, cycle-guarded — the template-composition idiom \`user='{{user}}'\` terminates as a literal unresolved token). Empty wrapped sections then prune to a fixpoint. The old three-pass fixed-point loop is gone.

Final prompt bytes are produced only through \`renderFinalPromptSection\`, which enforces the no-silent-leak invariant per render unit:

- **required** section (the static prompt prefix; \`runtime.state\`) with an unresolved token → the turn fails loudly (\`PromptRuntimeRenderError\` naming the tokens, with the canonical replacement when the token is a removed macro);
- **optional** section → the whole section is dropped and reported via the \`agent.prompt.section_dropped\` telemetry event;
- an unresolved token is NEVER emitted into the assembled prompt.

Each seeded runtime layer is its own render unit with its \`required\` flag from the seed (\`ComposeSplitResult.dynamicSections\` / \`TurnPromptSnapshot.dynamicSuffixSections\`); custom channel/task layers render as optional units.

## Macro inventory

The authoritative, always-current list is \`PROMPT_RUNTIME_MACRO_HINTS\` (the agent sees it as \`PROMPT_RUNTIME_TOKEN_HINT\`, Garden reads it with volatility and producer via the prompts runtime service).

The \`speaking_with\` macros (\`{{runtime_speaking_with_name}}\`, \`{{runtime_speaking_with_trust_level}}\`, \`{{runtime_speaking_with_is_machine_intelligence}}\`) are a one-on-one binding: they carry values **only on DM turns** (\`ConversationScope.kind === 'dm'\`) and are blank on group and internal turns, so any \`{{#if}}\` or XML-wrapped \`speaking_with\` section prunes cleanly in a multi-human room. Use the group-aware \`conversation_state\` / author macros for group turns.

${buildInventorySection()}

## SillyTavern card-field compatibility group

${buildCompatibilitySection()}

## Removed macros

${buildRemovedSection()}

## Rules for new macros

1. New runtime data ships as bare-value macros. Never add a prose/formatted convenience macro — the default phrasing belongs in a seeded layer built from the bare values.
2. Never put instructions, guidance sentences, or emotional framing inside a macro value — that text belongs in a prompt layer the operator (or the companion, through the approval queue) can edit.
3. Register every macro in \`PROMPT_RUNTIME_MACRO_HINTS\` with its volatility and producer. This is not optional: the turn variable namespace throws on unregistered keys, and writing a key that another producer already writes throws.
4. \`turn\`-volatile macros belong in dynamic layers (\`runtime.state\` and friends). Static-class layers (\`base\`/\`operator\`) reject them at edit and compose time to protect the cached static prefix.
5. One canonical name per datum. If a macro is removed, add it to \`REMOVED_PROMPT_MACROS\` with the canonical replacement — never keep it as a live alias.
6. Regenerate this doc (\`npm run docs:prompt-macros\`) in the same change.
`;

const outputPath = join(process.cwd(), 'docs', 'prompt-macros.md');
writeFileSync(outputPath, doc);
console.log(`Wrote ${outputPath}`);
