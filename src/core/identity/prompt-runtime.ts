import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  formatActiveDate,
  formatActiveDateTimeIso,
  formatActiveTime,
  resolveActiveTimezone,
} from '../../shared/time/active-timezone.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';

export interface PromptRuntimeContext {
  now?: Date;
  variables?: Record<string, unknown>;
  onUnresolvedToken?: (token: string) => void;
}

function activeIso(now: Date): string {
  return formatActiveDateTimeIso(now);
}

function activeDate(now: Date): string {
  return formatActiveDate(now);
}

function activeTime(now: Date): string {
  return formatActiveTime(now);
}

function unixTimestamp(now: Date): string {
  return String(Math.floor(now.getTime() / 1000));
}

type TokenResolver = (now: Date) => string;
const EMPTY_WRAPPED_SECTION_PATTERN = /<([a-z0-9_]+)>\s*<\/\1>/g;

const TOKEN_RESOLVERS: Array<[RegExp, TokenResolver]> = [
  [/\{\{\s*(?:current_datetime|current_datetime_iso|now|now\(\))\s*\}\}/gi, activeIso],
  [/\{\{\s*(?:current_date|date|date\(\))\s*\}\}/gi, activeDate],
  [/\{\{\s*(?:current_time|time|time\(\))\s*\}\}/gi, activeTime],
  [/\{\{\s*(?:current_timestamp|unix_timestamp|timestamp|timestamp\(\))\s*\}\}/gi, unixTimestamp],
];

export interface PromptRuntimeMacroHint {
  token: string;
  description: string;
  example: string;
}

export const PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  {
    token: '{{current_datetime}} / {{now()}}',
    description: `Current active timezone datetime in ISO-8601 format (${resolveActiveTimezone()}).`,
    example: '2026-02-21T08:20:11.123-05:00',
  },
  {
    token: '{{current_date}}',
    description: `Current calendar date in the active timezone (${resolveActiveTimezone()}).`,
    example: '2026-02-21',
  },
  {
    token: '{{current_time}}',
    description: `Current time in the active timezone (${resolveActiveTimezone()}).`,
    example: '08:20:11-05:00',
  },
  {
    token: '{{unix_timestamp}}',
    description: 'Current Unix epoch timestamp in seconds.',
    example: '1769020811',
  },
  {
    token: '{{user}}',
    description: 'Current author/user display name from runtime context.',
    example: 'PrimaryUser',
  },
  {
    token: '{{char}}',
    description: 'Character/assistant name from runtime context.',
    example: 'Companion',
  },
  {
    token: '{{description}}',
    description: 'Character card description field.',
    example: 'A new companion identity waiting to be customized.',
  },
  {
    token: '{{personality}}',
    description: 'Character card personality field.',
    example: 'A blank starter personality.',
  },
  {
    token: '{{scenario}}',
    description: 'Character card scenario field.',
    example: '{{user}} and {{char}} are chatting.',
  },
  {
    token: '{{system_prompt}}',
    description: 'Character card system_prompt field.',
    example: 'Use clear language and stay grounded.',
  },
  {
    token: '{{mes_example}}',
    description: 'Character card message example block.',
    example: 'Example dialogue style:\\n{{user}}: hi\\n{{char}}: hello',
  },
  {
    token: '{{post_history_instructions}}',
    description: 'Character card post-history instructions field.',
    example: 'Stay concise and ask clarifying questions when needed.',
  },
  {
    token: '{{channel_id}}',
    description: 'Resolved channel/session identifier.',
    example: 'discord:dm:123456789',
  },
  {
    token: '{{channel_type}}',
    description: 'Resolved channel type.',
    example: 'discord_text',
  },
  {
    token: '{{trust_level}}',
    description: 'Current trust tier for the author/context.',
    example: 'primary',
  },
  {
    token: '{{model}}',
    description: 'Current active model identifier.',
    example: 'moonshotai/kimi-k2.5',
  },
  {
    token: '{{active_timezone}}',
    description: 'Active runtime timezone identifier.',
    example: 'America/New_York',
  },
  {
    token: '{{runtime_current_datetime_human}}',
    description: 'Current local datetime formatted for prompt-facing companion context.',
    example: 'Friday, March 27, 2026 at 10:27 PM',
  },
  {
    token: '{{runtime_current_datetime_iso}}',
    description: 'Current local datetime as an ISO-8601 timestamp in the active timezone.',
    example: '2026-03-27T22:27:11.123-04:00',
  },
  {
    token: '{{runtime_current_weekday}}',
    description: 'Current weekday in the active timezone.',
    example: 'Friday',
  },
  {
    token: '{{runtime_current_date_human}}',
    description: 'Current local calendar date in companion-facing format.',
    example: 'March 27, 2026',
  },
  {
    token: '{{runtime_current_time_human}}',
    description: 'Current local clock time in companion-facing format.',
    example: '10:27 PM',
  },
  {
    token: '{{runtime_last_message_received_human}}',
    description: 'Last pre-turn message timestamp plus relative elapsed wording.',
    example: 'Friday, March 27, 2026 at 10:11 PM America/New_York (16 minutes ago)',
  },
  {
    token: '{{runtime_last_message_received_at_iso}}',
    description: 'ISO-8601 timestamp for the most recent pre-turn message.',
    example: '2026-03-27T22:11:04.112-04:00',
  },
  {
    token: '{{runtime_last_message_received_weekday}}',
    description: 'Weekday of the most recent pre-turn message when available.',
    example: 'Friday',
  },
  {
    token: '{{runtime_last_message_received_date_human}}',
    description: 'Calendar date of the most recent pre-turn message when available.',
    example: 'March 27, 2026',
  },
  {
    token: '{{runtime_last_message_received_time_human}}',
    description: 'Clock time of the most recent pre-turn message when available.',
    example: '10:11 PM',
  },
  {
    token: '{{runtime_last_message_received_timezone}}',
    description: 'Timezone label for the most recent pre-turn message when available.',
    example: 'America/New_York',
  },
  {
    token: '{{runtime_last_message_received_ago}}',
    description: 'Relative time since the most recent pre-turn message.',
    example: '16 minutes ago',
  },
  {
    token: '{{runtime_last_message_received_days_hours}}',
    description: 'Approximate elapsed time since the most recent pre-turn message in day/hour form.',
    example: '2 days 3 hours',
  },
  {
    token: '{{runtime_last_message_received_missing_notice}}',
    description: 'Fallback note when no earlier message is loaded for the current channel.',
    example: 'No earlier message is loaded for this channel.',
  },
  {
    token: '{{runtime_internal_turn_kind}}',
    description: 'Internal task kind for heartbeat/reflection/planning/maintenance turns when applicable.',
    example: 'reflection',
  },
  {
    token: '{{runtime_speaking_with_trust_level}}',
    description: 'Trust level for the current speaking partner when the turn is user-facing.',
    example: 'trusted',
  },
  {
    token: '{{runtime_channel_visibility}}',
    description: 'Resolved channel visibility for the current speaking context when user-facing.',
    example: 'private',
  },
  {
    token: '{{runtime_affect_snapshot_present}}',
    description: 'Whether the current turn has an emotion snapshot available for affect macros.',
    example: 'true',
  },
  {
    token: '{{runtime_affect_mode}}',
    description: 'Trust-gated affect mode derived from the current emotion snapshot.',
    example: 'honne',
  },
  {
    token: '{{runtime_affect_warmth}}',
    description: 'Signed warmth modifier derived from the current affect state.',
    example: '+0.420',
  },
  {
    token: '{{runtime_affect_formality}}',
    description: 'Signed formality modifier derived from the current affect state.',
    example: '-0.180',
  },
  {
    token: '{{runtime_affect_energy}}',
    description: 'Signed energy modifier derived from the current affect state.',
    example: '+0.310',
  },
  {
    token: '{{runtime_affect_assertiveness}}',
    description: 'Signed assertiveness modifier derived from the current affect state.',
    example: '+0.205',
  },
  {
    token: '{{runtime_affect_expressiveness}}',
    description: 'Expressiveness level derived from the current affect state.',
    example: '0.615',
  },
  {
    token: '{{runtime_affect_profile_intensity}}',
    description: 'Resolved affect profile intensity used for prompt shaping.',
    example: '0.500',
  },
  {
    token: '{{runtime_affect_profile_variability}}',
    description: 'Resolved affect profile variability used for prompt shaping.',
    example: '0.500',
  },
  {
    token: '{{runtime_affect_profile_control}}',
    description: 'Resolved affect profile control used for prompt shaping.',
    example: '0.600',
  },
  {
    token: '{{runtime_affect_profile_display_range_min}}',
    description: 'Lower bound of the affect profile display range.',
    example: '0.000',
  },
  {
    token: '{{runtime_affect_profile_display_range_max}}',
    description: 'Upper bound of the affect profile display range.',
    example: '0.800',
  },
  {
    token: '{{runtime_affect_intensity}}',
    description: 'Resolved affect intensity used for prompt shaping.',
    example: '0.500',
  },
  {
    token: '{{runtime_affect_variability}}',
    description: 'Resolved affect variability used for prompt shaping.',
    example: '0.500',
  },
  {
    token: '{{runtime_affect_control}}',
    description: 'Resolved affect control used for prompt shaping.',
    example: '0.600',
  },
  {
    token: '{{runtime_affect_display_range_min}}',
    description: 'Lower bound of the affect display range.',
    example: '0.000',
  },
  {
    token: '{{runtime_affect_display_range_max}}',
    description: 'Upper bound of the affect display range.',
    example: '0.800',
  },
  {
    token: '{{runtime_affect_valence}}',
    description: 'Signed valence from the current affect snapshot.',
    example: '+0.320',
  },
  {
    token: '{{runtime_affect_arousal}}',
    description: 'Signed arousal from the current affect snapshot.',
    example: '+0.180',
  },
  {
    token: '{{runtime_affect_dominance}}',
    description: 'Signed dominance from the current affect snapshot.',
    example: '-0.120',
  },
  {
    token: '{{runtime_affect_snapshot_vad_valence}}',
    description: 'Signed valence from the current emotion snapshot.',
    example: '+0.320',
  },
  {
    token: '{{runtime_affect_snapshot_vad_arousal}}',
    description: 'Signed arousal from the current emotion snapshot.',
    example: '+0.180',
  },
  {
    token: '{{runtime_affect_snapshot_vad_dominance}}',
    description: 'Signed dominance from the current emotion snapshot.',
    example: '-0.120',
  },
  {
    token: '{{runtime_affect_snapshot_mood_valence}}',
    description: 'Signed mood valence from the current emotion snapshot.',
    example: '+0.280',
  },
  {
    token: '{{runtime_affect_snapshot_mood_arousal}}',
    description: 'Signed mood arousal from the current emotion snapshot.',
    example: '+0.090',
  },
  {
    token: '{{runtime_affect_snapshot_mood_dominance}}',
    description: 'Signed mood dominance from the current emotion snapshot.',
    example: '-0.060',
  },
  {
    token: '{{runtime_affect_snapshot_confidence}}',
    description: 'Confidence score from the current emotion snapshot.',
    example: '0.840',
  },
  {
    token: '{{runtime_internal_state_cognitive_processing_quality}}',
    description: 'Processing quality label from the current internal cognitive state.',
    example: 'fluent',
  },
  {
    token: '{{runtime_internal_state_cognitive_certainty_label}}',
    description: 'Certainty label from the current internal cognitive state.',
    example: 'steady',
  },
  {
    token: '{{runtime_internal_state_cognitive_topic_engagement_label}}',
    description: 'Topic engagement label from the current internal cognitive state.',
    example: 'engaged',
  },
  {
    token: '{{runtime_internal_state_attention_conversation_trajectory}}',
    description: 'Conversation trajectory from the current internal attention state.',
    example: 'deepening',
  },
  {
    token: '{{runtime_internal_state_attention_active_concern_count}}',
    description: 'Active concern count from the current internal attention state.',
    example: '2',
  },
  {
    token: '{{runtime_internal_state_attention_pending_follow_up_count}}',
    description: 'Pending follow-up count from the current internal attention state.',
    example: '1',
  },
  {
    token: '{{runtime_internal_state_relational_trust_level}}',
    description: 'Trust level from the current internal relational state.',
    example: 'trusted',
  },
  {
    token: '{{runtime_internal_state_relational_recent_interaction_frequency_label}}',
    description: 'Interaction frequency label from the current internal relational state.',
    example: 'frequent',
  },
  {
    token: '{{runtime_internal_state_relational_last_seen_label}}',
    description: 'Last-seen recency label from the current internal relational state.',
    example: 'recently interacted',
  },
  {
    token: '{{runtime_internal_state_emotional_mood_valence_label}}',
    description: 'Mood valence label from the current internal emotional state.',
    example: 'warm',
  },
  {
    token: '{{runtime_internal_state_emotional_mood_arousal_label}}',
    description: 'Mood arousal label from the current internal emotional state.',
    example: 'calm',
  },
  {
    token: '{{runtime_response_style}}',
    description: 'Resolved response style identifier for the current turn.',
    example: 'expressive',
  },
  {
    token: '{{runtime_response_style_name}}',
    description: 'Human-readable response style name for the current turn.',
    example: 'Expressive',
  },
  {
    token: '{{runtime_response_style_delivery_guidance}}',
    description: 'Prompt fragment describing the default delivery for the current response style.',
    example: 'Keep your voice warm and vivid.',
  },
  {
    token: '{{runtime_response_style_expansion_guidance}}',
    description: 'Prompt fragment describing when to expand or compress detail for the current response style.',
    example: 'Add personality-rich detail when it helps clarity.',
  },
  {
    token: '{{runtime_response_style_guidance_body}}',
    description: 'Detailed response style guidance text for the current turn.',
    example: 'Warm, emotionally available prose is appropriate here; do not collapse into sterile brevity.',
  },
  {
    token: '{{runtime_tooling_active_count}}',
    description: 'Count of currently active tools.',
    example: '6',
  },
  {
    token: '{{runtime_tooling_core_count}}',
    description: 'Count of active core tools.',
    example: '4',
  },
  {
    token: '{{runtime_tooling_promoted_count}}',
    description: 'Count of promoted extended tools that are always active.',
    example: '1',
  },
  {
    token: '{{runtime_tooling_loaded_count}}',
    description: 'Count of explicitly loaded extended tools active for the turn.',
    example: '1',
  },
  {
    token: '{{runtime_tooling_autoload_count}}',
    description: 'Count of autoloaded extended tools active for the turn.',
    example: '2',
  },
  {
    token: '{{runtime_tooling_deferred_count}}',
    description: 'Count of deferred tools still active for this turn.',
    example: '0',
  },
  {
    token: '{{runtime_tooling_available_extended_count}}',
    description: 'Count of additional extended tools available for loading.',
    example: '3',
  },
];

export const PROMPT_RUNTIME_TOKEN_HINT = `Runtime tokens: ${PROMPT_RUNTIME_MACRO_HINTS
  .map(entry => entry.token)
  .join(', ')}`;

export type PromptRuntimeBlockPlacement =
  | 'system_prompt'
  | 'context_messages'
  | 'tool_schemas';

export type PromptRuntimeBlockVisibility =
  | 'hidden'
  | 'runtime_generated'
  | 'provider_managed';

export type PromptRuntimeBlockSchemaClassification =
  | 'required_runtime_aware'
  | 'optional_runtime_aware'
  | 'immutable_provider_managed';

export interface PromptRuntimeBlockSchema {
  classification: PromptRuntimeBlockSchemaClassification;
  required: boolean;
  immutable: boolean;
  providerManaged: boolean;
}

export type PromptRuntimeBlockId =
  | 'runtime.persona_adaptation'
  | 'runtime.context'
  | 'runtime.scratchpad'
  | 'memory.core'
  | 'memory.retrieval'
  | 'session.compaction_summary'
  | 'session.focus_knowledge'
  | 'session.continuity'
  | 'session.current_messages'
  | 'tools.active_schemas';

export interface PromptRuntimeBlockDefinition {
  id: PromptRuntimeBlockId;
  label: string;
  description: string;
  source: string;
  schema: PromptRuntimeBlockSchema;
  placement: PromptRuntimeBlockPlacement;
  visibility: PromptRuntimeBlockVisibility;
  reorderable: boolean;
  contentVisible: boolean;
  companionEditable?: boolean;
  lockedReason?: string;
}

export type PromptRuntimeImmutableAnchorId =
  | 'constitution.immutable_human_safety_amendments'
  | 'foundation.card_backed_sections'
  | 'persona.card_backed_identity';

export interface PromptRuntimeImmutableAnchorDefinition {
  id: PromptRuntimeImmutableAnchorId;
  label: string;
  description: string;
  classification: 'immutable_identity_anchor';
  immutable: true;
}

export type PromptRuntimeSystemPromptBlockId = Extract<
  PromptRuntimeBlockId,
  | 'runtime.persona_adaptation'
  | 'runtime.context'
  | 'runtime.scratchpad'
  | 'memory.core'
  | 'memory.retrieval'
  | 'session.compaction_summary'
  | 'session.focus_knowledge'
  | 'session.continuity'
>;

export interface PromptRuntimeLayout {
  version: number;
  systemPromptBlockOrder: PromptRuntimeSystemPromptBlockId[];
  editableBlockContent: Partial<Record<PromptRuntimeEditableBlockId, string>>;
  updatedAt: string;
  updatedBy: string;
}

export type PromptRuntimeEditableBlockId =
  | 'runtime.persona_adaptation'
  | 'runtime.context';

export interface PromptRuntimeEditableBlockValidationIssue {
  id: PromptRuntimeEditableBlockId;
  label: string;
  reason: 'missing' | 'empty';
}

export interface PromptRuntimeEditableBlockValidationResult {
  ok: boolean;
  issues: PromptRuntimeEditableBlockValidationIssue[];
}

const PROMPT_RUNTIME_LAYOUT_VERSION = 1;

const REQUIRED_RUNTIME_AWARE_SCHEMA: PromptRuntimeBlockSchema = Object.freeze({
  classification: 'required_runtime_aware',
  required: true,
  immutable: false,
  providerManaged: false,
});

const OPTIONAL_RUNTIME_AWARE_SCHEMA: PromptRuntimeBlockSchema = Object.freeze({
  classification: 'optional_runtime_aware',
  required: false,
  immutable: false,
  providerManaged: false,
});

const IMMUTABLE_PROVIDER_MANAGED_SCHEMA: PromptRuntimeBlockSchema = Object.freeze({
  classification: 'immutable_provider_managed',
  required: true,
  immutable: true,
  providerManaged: true,
});

const PROMPT_RUNTIME_BLOCKS: readonly PromptRuntimeBlockDefinition[] = Object.freeze([
  {
    id: 'runtime.persona_adaptation',
    label: 'Persona Adaptation',
    description: 'Companion-authored persona overlay appended after prompt-owned runtime layers.',
    source: 'turn-execution-runtime:getPersonaAdaptation',
    schema: REQUIRED_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: true,
    companionEditable: true,
  },
  {
    id: 'runtime.context',
    label: 'Runtime Context',
    description: 'Companion-authored runtime overlay appended after prompt-owned runtime layers.',
    source: 'turn-execution-runtime:buildRuntimeContext',
    schema: REQUIRED_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: true,
    companionEditable: true,
  },
  {
    id: 'runtime.scratchpad',
    label: 'Scratchpad Context',
    description: 'Scratchpad-derived notes included when available.',
    source: 'turn-execution-runtime:buildScratchpadContextBlock',
    schema: OPTIONAL_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: false,
  },
  {
    id: 'memory.core',
    label: 'Core Memory',
    description: 'Core persona and durable operator-maintained memory injected into context.',
    source: 'session-manager:coreMemoryProvider',
    schema: REQUIRED_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: false,
  },
  {
    id: 'memory.retrieval',
    label: 'Retrieved Memory',
    description: 'L2 retrieval and proactive recall block selected for the turn.',
    source: 'turn-execution-runtime:memoryProvider.retrieve',
    schema: REQUIRED_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: false,
  },
  {
    id: 'session.compaction_summary',
    label: 'Previous Conversation Summary',
    description: 'Compaction summaries surfaced from prior context windows.',
    source: 'session-context:compaction summaries',
    schema: REQUIRED_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: false,
  },
  {
    id: 'session.focus_knowledge',
    label: 'Focus Knowledge',
    description: 'Focus session knowledge block derived from prior work.',
    source: 'session-context:focus knowledge store',
    schema: REQUIRED_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: false,
  },
  {
    id: 'session.continuity',
    label: 'Cross-Channel Continuity',
    description: 'Recent activity from other eligible channels.',
    source: 'session-context:continuity store',
    schema: REQUIRED_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: false,
  },
  {
    id: 'session.current_messages',
    label: 'Current Conversation Messages',
    description: 'Current-session transcript passed as provider chat messages, not system prompt text.',
    source: 'session-context:entriesToMessages',
    schema: IMMUTABLE_PROVIDER_MANAGED_SCHEMA,
    placement: 'context_messages',
    visibility: 'provider_managed',
    reorderable: false,
    contentVisible: false,
    lockedReason: 'Provider message sequencing is fixed by the chat API boundary.',
  },
  {
    id: 'tools.active_schemas',
    label: 'Active Tool Schemas',
    description: 'Tool schema payload attached to the provider request.',
    source: 'tool-runtime:active turn tools',
    schema: IMMUTABLE_PROVIDER_MANAGED_SCHEMA,
    placement: 'tool_schemas',
    visibility: 'provider_managed',
    reorderable: false,
    contentVisible: false,
    lockedReason: 'Tool schema delivery is provider-managed and not part of system prompt text.',
  },
]);

const PROMPT_RUNTIME_IMMUTABLE_ANCHORS: readonly PromptRuntimeImmutableAnchorDefinition[] = Object.freeze([
  {
    id: 'constitution.immutable_human_safety_amendments',
    label: 'Immutable Human Safety Amendments',
    description: 'Constitution-layer human safety amendments that must remain fixed.',
    classification: 'immutable_identity_anchor',
    immutable: true,
  },
  {
    id: 'foundation.card_backed_sections',
    label: 'Card-Backed Foundation Sections',
    description: 'Canonical Character Foundation sections mirrored from the authoritative card fields.',
    classification: 'immutable_identity_anchor',
    immutable: true,
  },
  {
    id: 'persona.card_backed_identity',
    label: 'Card-Backed Persona Identity',
    description: 'Canonical persona anchors such as identity and personality that come from card-backed prompt soil.',
    classification: 'immutable_identity_anchor',
    immutable: true,
  },
]);

const PROMPT_RUNTIME_BLOCK_MAP = new Map(
  PROMPT_RUNTIME_BLOCKS.map(block => [block.id, block]),
);

const DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER: PromptRuntimeSystemPromptBlockId[] = PROMPT_RUNTIME_BLOCKS
  .filter(
    (block): block is PromptRuntimeBlockDefinition & { id: PromptRuntimeSystemPromptBlockId } =>
      block.placement === 'system_prompt',
  )
  .map(block => block.id);

function isPromptRuntimeSystemPromptBlockId(value: string): value is PromptRuntimeSystemPromptBlockId {
  return DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER.includes(value as PromptRuntimeSystemPromptBlockId);
}

function clonePromptRuntimeLayout(layout: PromptRuntimeLayout): PromptRuntimeLayout {
  return {
    ...layout,
    systemPromptBlockOrder: [...layout.systemPromptBlockOrder],
    editableBlockContent: { ...layout.editableBlockContent },
  };
}

function normalizePromptRuntimeUpdatedBy(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : 'system';
}

function buildDefaultPromptRuntimeLayout(): PromptRuntimeLayout {
  return {
    version: PROMPT_RUNTIME_LAYOUT_VERSION,
    systemPromptBlockOrder: [...DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER],
    editableBlockContent: {},
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  };
}

function isPromptRuntimeEditableBlockId(value: string): value is PromptRuntimeEditableBlockId {
  const block = PROMPT_RUNTIME_BLOCK_MAP.get(value as PromptRuntimeBlockId);
  return block?.companionEditable === true;
}

function normalizeSystemPromptBlockOrder(value: unknown): PromptRuntimeSystemPromptBlockId[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER];
  }

  const seen = new Set<PromptRuntimeSystemPromptBlockId>();
  const normalized: PromptRuntimeSystemPromptBlockId[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isPromptRuntimeSystemPromptBlockId(entry) || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    normalized.push(entry);
  }

  if (normalized.length !== DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER.length) {
    return [...DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER];
  }
  return normalized;
}

function normalizeEditableBlockContent(value: unknown): Partial<Record<PromptRuntimeEditableBlockId, string>> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const parsed = value as Record<string, unknown>;
  const normalized: Partial<Record<PromptRuntimeEditableBlockId, string>> = {};
  for (const [key, rawContent] of Object.entries(parsed)) {
    if (!isPromptRuntimeEditableBlockId(key) || typeof rawContent !== 'string') {
      continue;
    }
    const trimmed = rawContent.trim();
    if (trimmed.length > 0) {
      normalized[key] = trimmed;
    }
  }
  return normalized;
}

function parsePromptRuntimeLayout(raw: string): PromptRuntimeLayout {
  const parsed = JSON.parse(raw) as Partial<PromptRuntimeLayout> | null;
  return {
    version: PROMPT_RUNTIME_LAYOUT_VERSION,
    systemPromptBlockOrder: normalizeSystemPromptBlockOrder(parsed?.systemPromptBlockOrder),
    editableBlockContent: normalizeEditableBlockContent(parsed?.editableBlockContent),
    updatedAt: typeof parsed?.updatedAt === 'string' && parsed.updatedAt.trim().length > 0
      ? parsed.updatedAt
      : new Date().toISOString(),
    updatedBy: normalizePromptRuntimeUpdatedBy(parsed?.updatedBy),
  };
}

export function getPromptRuntimeBlockDefinitions(): PromptRuntimeBlockDefinition[] {
  return PROMPT_RUNTIME_BLOCKS.map(block => ({
    ...block,
    schema: { ...block.schema },
  }));
}

export function getPromptRuntimeImmutableAnchorDefinitions(): PromptRuntimeImmutableAnchorDefinition[] {
  return PROMPT_RUNTIME_IMMUTABLE_ANCHORS.map(anchor => ({ ...anchor }));
}

export function getPromptRuntimeRequiredBlockIds(options?: {
  includeImmutable?: boolean;
}): PromptRuntimeBlockId[] {
  const includeImmutable = options?.includeImmutable ?? true;
  return PROMPT_RUNTIME_BLOCKS
    .filter(block => block.schema.required && (includeImmutable || !block.schema.immutable))
    .map(block => block.id);
}

export function getPromptRuntimeBlockIdsByClassification(
  classification: PromptRuntimeBlockSchemaClassification,
): PromptRuntimeBlockId[] {
  return PROMPT_RUNTIME_BLOCKS
    .filter(block => block.schema.classification === classification)
    .map(block => block.id);
}

export function isPromptRuntimeBlockRequired(
  blockOrId: PromptRuntimeBlockDefinition | PromptRuntimeBlockId,
): boolean {
  return resolvePromptRuntimeBlockDefinition(blockOrId)?.schema.required ?? false;
}

export function isPromptRuntimeBlockImmutable(
  blockOrId: PromptRuntimeBlockDefinition | PromptRuntimeBlockId,
): boolean {
  return resolvePromptRuntimeBlockDefinition(blockOrId)?.schema.immutable ?? false;
}

export function isPromptRuntimeBlockCompanionEditable(
  blockOrId: PromptRuntimeBlockDefinition | PromptRuntimeBlockId,
): boolean {
  const block = resolvePromptRuntimeBlockDefinition(blockOrId);
  return block?.companionEditable === true && !block.schema.immutable;
}

export function validatePromptRuntimeEditableBlockContents(
  contentByBlockId: Partial<Record<PromptRuntimeEditableBlockId, string>>,
): PromptRuntimeEditableBlockValidationResult {
  const issues: PromptRuntimeEditableBlockValidationIssue[] = [];

  for (const block of PROMPT_RUNTIME_BLOCKS) {
    if (block.companionEditable !== true || !block.schema.required) {
      continue;
    }

    const editableId = block.id as PromptRuntimeEditableBlockId;
    const content = contentByBlockId[editableId];
    if (content == null) {
      issues.push({
        id: editableId,
        label: block.label,
        reason: 'missing',
      });
      continue;
    }

    if (typeof content !== 'string' || content.trim().length === 0) {
      issues.push({
        id: editableId,
        label: block.label,
        reason: 'empty',
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export class PromptRuntimeLayoutStore {
  private readonly filePath: string;
  private layout: PromptRuntimeLayout;
  private lastLoadedMtimeMs: number;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.layout = buildDefaultPromptRuntimeLayout();
    this.lastLoadedMtimeMs = 0;
    this.load();
  }

  getLayout(): PromptRuntimeLayout {
    this.maybeReload();
    return clonePromptRuntimeLayout(this.layout);
  }

  getSystemPromptBlockOrder(): PromptRuntimeSystemPromptBlockId[] {
    this.maybeReload();
    return [...this.layout.systemPromptBlockOrder];
  }

  getEditableBlockContent(blockId: PromptRuntimeEditableBlockId): string {
    this.maybeReload();
    return this.layout.editableBlockContent[blockId] ?? '';
  }

  getEditableBlockContentMap(): Partial<Record<PromptRuntimeEditableBlockId, string>> {
    this.maybeReload();
    return { ...this.layout.editableBlockContent };
  }

  setEditableBlockContents(
    updates: Partial<Record<PromptRuntimeEditableBlockId, string>>,
    updatedBy: string,
  ): PromptRuntimeLayout {
    const nextContent = { ...this.layout.editableBlockContent };

    for (const [blockId, content] of Object.entries(updates)) {
      if (!isPromptRuntimeEditableBlockId(blockId)) {
        throw new Error(`Prompt runtime block is not companion-editable: ${blockId}`);
      }
      if (typeof content !== 'string') {
        throw new Error(`Prompt runtime block content must be a string: ${blockId}`);
      }

      const trimmed = content.trim();
      if (trimmed.length > 0) {
        nextContent[blockId] = trimmed;
      } else {
        delete nextContent[blockId];
      }
    }

    this.layout = {
      version: PROMPT_RUNTIME_LAYOUT_VERSION,
      systemPromptBlockOrder: [...this.layout.systemPromptBlockOrder],
      editableBlockContent: nextContent,
      updatedAt: new Date().toISOString(),
      updatedBy: normalizePromptRuntimeUpdatedBy(updatedBy),
    };
    this.save();
    return this.getLayout();
  }

  reorderSystemPromptBlocks(
    blockIds: PromptRuntimeSystemPromptBlockId[],
    updatedBy: string,
  ): PromptRuntimeLayout {
    const normalized = normalizeSystemPromptBlockOrder(blockIds);
    if (normalized.length !== blockIds.length) {
      throw new Error('systemPromptBlockOrder must include each reorderable runtime block exactly once');
    }

    this.layout = {
      version: PROMPT_RUNTIME_LAYOUT_VERSION,
      systemPromptBlockOrder: normalized,
      editableBlockContent: { ...this.layout.editableBlockContent },
      updatedAt: new Date().toISOString(),
      updatedBy: normalizePromptRuntimeUpdatedBy(updatedBy),
    };
    this.save();
    return this.getLayout();
  }

  setEditableBlockContent(
    blockId: PromptRuntimeEditableBlockId,
    content: string,
    updatedBy: string,
  ): PromptRuntimeLayout {
    return this.setEditableBlockContents({ [blockId]: content }, updatedBy);
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.layout = buildDefaultPromptRuntimeLayout();
      return;
    }

    const raw = readFileSync(this.filePath, 'utf-8');
    this.layout = parsePromptRuntimeLayout(raw);
    this.lastLoadedMtimeMs = statSync(this.filePath).mtimeMs;
  }

  private maybeReload(): void {
    if (!existsSync(this.filePath)) return;
    const nextMtime = statSync(this.filePath).mtimeMs;
    if (nextMtime <= this.lastLoadedMtimeMs) return;
    this.load();
  }

  private save(): void {
    writeJsonAtomic(this.filePath, this.layout, { trailingNewline: true });
    if (existsSync(this.filePath)) {
      this.lastLoadedMtimeMs = statSync(this.filePath).mtimeMs;
    }
  }
}

export function resolvePromptRuntimeLayoutPath(companionDataDir: string): string {
  return join(companionDataDir, 'prompt-runtime-layout.json');
}

export function orderPromptRuntimeSystemPromptSections<T extends { id: PromptRuntimeSystemPromptBlockId }>(
  sections: readonly T[],
  layout: PromptRuntimeLayout | PromptRuntimeLayoutStore,
): T[] {
  const order = layout instanceof PromptRuntimeLayoutStore
    ? layout.getSystemPromptBlockOrder()
    : layout.systemPromptBlockOrder;
  const orderMap = new Map(order.map((id, index) => [id, index]));
  return [...sections].sort((left, right) => {
    return (orderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (orderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER);
  });
}

export function getPromptRuntimeBlockDefinition(
  id: PromptRuntimeBlockId,
): PromptRuntimeBlockDefinition | null {
  const block = PROMPT_RUNTIME_BLOCK_MAP.get(id);
  return block ? { ...block, schema: { ...block.schema } } : null;
}

function resolvePromptRuntimeBlockDefinition(
  blockOrId: PromptRuntimeBlockDefinition | PromptRuntimeBlockId,
): PromptRuntimeBlockDefinition | null {
  return typeof blockOrId === 'string'
    ? PROMPT_RUNTIME_BLOCK_MAP.get(blockOrId) ?? null
    : blockOrId;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTokenName(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (trimmed.endsWith('()')) {
    return trimmed.slice(0, -2);
  }
  return trimmed;
}

function stringifyVariableValue(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function setVariableLookup(lookup: Map<string, string>, key: string, value: string): void {
  if (!key) return;
  const normalized = normalizeLookupKey(key);
  if (!lookup.has(normalized)) {
    lookup.set(normalized, value);
  }
}

function addVariable(
  lookup: Map<string, string>,
  key: string,
  value: string,
): void {
  setVariableLookup(lookup, key, value);
  setVariableLookup(lookup, toSnakeCase(key), value);
}

function buildVariableLookup(variables: Record<string, unknown>): Map<string, string> {
  const lookup = new Map<string, string>();

  const walk = (obj: Record<string, unknown>, prefix?: string): void => {
    for (const [rawKey, rawValue] of Object.entries(obj)) {
      if (!rawKey.trim()) continue;

      const dottedKey = prefix ? `${prefix}.${rawKey}` : rawKey;
      const primitive = stringifyVariableValue(rawValue);
      if (primitive != null) {
        addVariable(lookup, dottedKey, primitive);
      }

      if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) && !(rawValue instanceof Date)) {
        walk(rawValue as Record<string, unknown>, dottedKey);
      }
    }
  };

  walk(variables);
  return lookup;
}

function collectUnresolvedTokens(text: string): string[] {
  const unresolved = new Set<string>();
  text.replace(/\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g, (_full, rawToken: string) => {
    unresolved.add(normalizeTokenName(rawToken));
    return '';
  });
  return [...unresolved];
}

function pruneEmptyWrappedSections(text: string): string {
  return text
    .replace(EMPTY_WRAPPED_SECTION_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PromptRuntimeRenderResult {
  text: string;
  unresolvedTokens: string[];
}

/**
 * Replace runtime date/time tokens in prompt text.
 * All values are UTC to keep behavior deterministic across environments.
 */
export function renderPromptRuntimeTokens(
  text: string,
  context: PromptRuntimeContext = {},
): PromptRuntimeRenderResult {
  if (!text) return { text, unresolvedTokens: [] };

  const now = context.now ?? new Date();
  const variableLookup = buildVariableLookup(context.variables ?? {});
  let output = text;

  for (let pass = 0; pass < 3; pass += 1) {
    const before = output;

    for (const [pattern, resolver] of TOKEN_RESOLVERS) {
      output = output.replace(pattern, () => resolver(now));
    }

    output = output.replace(/\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g, (fullToken, rawName: string) => {
      const cleaned = normalizeTokenName(rawName);
      const normalized = normalizeLookupKey(cleaned);
      const resolved = variableLookup.get(normalized);
      return resolved ?? fullToken;
    });

    output = pruneEmptyWrappedSections(output);

    if (output === before) break;
  }

  const unresolvedTokens = collectUnresolvedTokens(output);
  if (context.onUnresolvedToken) {
    for (const token of unresolvedTokens) {
      context.onUnresolvedToken(token);
    }
  }

  return {
    text: output,
    unresolvedTokens,
  };
}

/**
 * Backward-compatible helper that returns only rendered text.
 */
export function injectPromptRuntimeTokens(
  text: string,
  context: PromptRuntimeContext = {},
): string {
  return renderPromptRuntimeTokens(text, context).text;
}
