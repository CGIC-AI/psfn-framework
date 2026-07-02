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

const METACOGNITIVE_FLAG_HINT_NAMES = [
  'uncertainty',
  'avoidance',
  'high_engagement',
  'repetition',
  'confabulation_risk',
] as const;

type MetacognitiveFlagName = typeof METACOGNITIVE_FLAG_HINT_NAMES[number];

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
const CONDITIONAL_BLOCK_PATTERN = /\{\{#if\s+([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

// One canonical spelling per clock datum (E2.5 macro consolidation). The
// removed alias spellings ({{now}}, {{date}}, {{time}}, {{timestamp}}, ...)
// live in REMOVED_PROMPT_MACROS so persisted layers that still use them fail
// closed with a clear message naming the canonical replacement.
const TOKEN_RESOLVERS: Array<[RegExp, TokenResolver]> = [
  [/\{\{\s*current_datetime\s*\}\}/gi, activeIso],
  [/\{\{\s*current_date\s*\}\}/gi, activeDate],
  [/\{\{\s*current_time\s*\}\}/gi, activeTime],
  [/\{\{\s*unix_timestamp\s*\}\}/gi, unixTimestamp],
];

/**
 * Volatility class for a registered prompt macro:
 * - 'static': changes only when identity/config artifacts change (character card, timezone config).
 *   Safe inside the byte-stable static prompt prefix and included in the static settings hash.
 * - 'session_stable': stable for a given conversation scope (contact, channel, trust, model) but
 *   not globally static. Excluded from the static settings hash; changes ride the prefix cache key.
 * - 'turn': recomputed every turn (clock, affect, tooling, attention). Referencing a turn-volatile
 *   macro from a static-class prompt layer is a validation error — it would contaminate the
 *   byte-stable static prefix and bust provider prompt caching.
 */
export type PromptMacroVolatility = 'static' | 'session_stable' | 'turn';

export interface PromptRuntimeMacroHint {
  group:
    | 'global_aliases'
    | 'runtime_state'
    | 'trust'
    | 'response_style'
    | 'affect'
    | 'metacognition'
    | 'internal_state'
    | 'attention'
    | 'tooling';
  token: string;
  description: string;
  example: string;
  volatility: PromptMacroVolatility;
  /** The code path that writes this variable into the turn prompt variable namespace. */
  producer: string;
  /** Additional accepted spellings that resolve to the same value (e.g. clock aliases). */
  aliases?: readonly string[];
}

// Producer identifiers for the macro manifest. Each names the single code path that
// writes the variable into the turn prompt variable namespace.
export const CLOCK_MACRO_PRODUCER = 'prompt-runtime:TOKEN_RESOLVERS';
const CHARACTER_CARD_PRODUCER = 'character-macro-map:buildCharacterMacroMap';
const SESSION_BASE_PRODUCER = 'runtime-context:buildPromptTemplateVariables';
const DYNAMIC_TURN_PRODUCER = 'runtime-context:buildDynamicPromptTemplateVariables';
const TRUST_STATE_PRODUCER = 'trust-policy:buildTrustPromptState';
const RESPONSE_STYLE_PRODUCER = 'trust-policy:buildResponseStylePromptState';
const AFFECT_PRODUCER = 'emotion-persona-adaptation:buildEmotionalAffectPromptVariables';
const METACOGNITION_PRODUCER = 'self-model-metacognition:buildMetacognitiveFlagPromptVariables';
const RUNTIME_LAYOUT_OVERLAY_PRODUCER = 'substrate-agent:resolveRuntimePromptGuidanceVariables';
const PROMPT_ASSEMBLY_PRODUCER = 'turn-execution:assembleTurnPrompt';

function createPromptRuntimeMacroHint(
  group: PromptRuntimeMacroHint['group'],
  token: string,
  volatility: PromptMacroVolatility,
  producer: string,
  description: string,
  example: string,
  aliases?: readonly string[],
): PromptRuntimeMacroHint {
  return {
    group,
    token,
    description,
    example,
    volatility,
    producer,
    ...(aliases ? { aliases } : {}),
  };
}

function createTurnMacroHintFactory(
  group: PromptRuntimeMacroHint['group'],
  producer: string,
): (token: string, description: string, example: string) => PromptRuntimeMacroHint {
  return (token, description, example) =>
    createPromptRuntimeMacroHint(group, token, 'turn', producer, description, example);
}

const runtimeStateTurnHint = createTurnMacroHintFactory('runtime_state', DYNAMIC_TURN_PRODUCER);
const trustTurnHint = createTurnMacroHintFactory('trust', TRUST_STATE_PRODUCER);
const responseStyleTurnHint = createTurnMacroHintFactory('response_style', RESPONSE_STYLE_PRODUCER);
const affectTurnHint = createTurnMacroHintFactory('affect', AFFECT_PRODUCER);
const metacognitionTurnHint = createTurnMacroHintFactory('metacognition', METACOGNITION_PRODUCER);
const internalStateTurnHint = createTurnMacroHintFactory('internal_state', DYNAMIC_TURN_PRODUCER);
const attentionTurnHint = createTurnMacroHintFactory('attention', DYNAMIC_TURN_PRODUCER);
const toolingTurnHint = createTurnMacroHintFactory('tooling', DYNAMIC_TURN_PRODUCER);

const METACOGNITIVE_FLAG_PROMPT_HINT_DETAILS: Record<
  MetacognitiveFlagName,
  {
    confidenceExample: string;
    evidenceExample: string;
  }
> = {
  uncertainty: {
    confidenceExample: '0.583',
    evidenceExample: 'certainty=0.220 (<0.400); contradictory_memory_signals=2',
  },
  avoidance: {
    confidenceExample: '1.000',
    evidenceExample: 'unresolved_concerns=concern-1; lookback_turns=3',
  },
  high_engagement: {
    confidenceExample: '0.612',
    evidenceExample: 'arousal=0.820; valence=0.415; tool_calls=3',
  },
  repetition: {
    confidenceExample: '0.600',
    evidenceExample: 'max_jaccard=0.900; sampled_responses=3',
  },
  confabulation_risk: {
    confidenceExample: '0.650',
    evidenceExample: 'assertions=2; supporting_memories=0',
  },
};

const METACOGNITIVE_FLAG_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = METACOGNITIVE_FLAG_HINT_NAMES.flatMap((flagName) => {
  const details = METACOGNITIVE_FLAG_PROMPT_HINT_DETAILS[flagName];
  const label = flagName.replace(/_/g, ' ');
  return [
    metacognitionTurnHint(
      `{{runtime_flag_${flagName}_present}}`,
      `Whether the ${label} metacognitive flag is active for the current turn.`,
      'true',
    ),
    metacognitionTurnHint(
      `{{runtime_flag_${flagName}_confidence}}`,
      `Confidence score for the ${label} metacognitive flag when it is active.`,
      details.confidenceExample,
    ),
    metacognitionTurnHint(
      `{{runtime_flag_${flagName}_evidence}}`,
      `Evidence summary for the ${label} metacognitive flag when it is active.`,
      details.evidenceExample,
    ),
  ];
});

const GLOBAL_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  createPromptRuntimeMacroHint(
    'global_aliases',
    '{{current_datetime}}',
    'turn',
    CLOCK_MACRO_PRODUCER,
    `Current active timezone datetime in ISO-8601 format (${resolveActiveTimezone()}).`,
    '2026-02-21T08:20:11.123-05:00',
  ),
  createPromptRuntimeMacroHint(
    'global_aliases',
    '{{current_date}}',
    'turn',
    CLOCK_MACRO_PRODUCER,
    `Current calendar date in the active timezone (${resolveActiveTimezone()}).`,
    '2026-02-21',
  ),
  createPromptRuntimeMacroHint(
    'global_aliases',
    '{{current_time}}',
    'turn',
    CLOCK_MACRO_PRODUCER,
    `Current time in the active timezone (${resolveActiveTimezone()}).`,
    '08:20:11-05:00',
  ),
  createPromptRuntimeMacroHint('global_aliases', '{{unix_timestamp}}', 'turn', CLOCK_MACRO_PRODUCER, 'Current Unix epoch timestamp in seconds.', '1769020811'),
  createPromptRuntimeMacroHint('global_aliases', '{{user}}', 'session_stable', SESSION_BASE_PRODUCER, 'Current author/user display name from runtime context.', 'PrimaryUser', ['user_name']),
  createPromptRuntimeMacroHint('global_aliases', '{{user_id}}', 'session_stable', SESSION_BASE_PRODUCER, 'Stable subject identity key for the current author.', 'discord:123456789'),
  createPromptRuntimeMacroHint('global_aliases', '{{char}}', 'static', SESSION_BASE_PRODUCER, 'Character/assistant name from runtime context.', 'Companion', ['char_name', 'character', 'character_name']),
  createPromptRuntimeMacroHint('global_aliases', '{{name}}', 'static', CHARACTER_CARD_PRODUCER, 'Raw character card name field.', 'Companion'),
  createPromptRuntimeMacroHint('global_aliases', '{{description}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card description field.', 'A new companion identity waiting to be customized.'),
  createPromptRuntimeMacroHint('global_aliases', '{{personality}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card personality field.', 'A blank starter personality.'),
  createPromptRuntimeMacroHint('global_aliases', '{{scenario}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card scenario field.', '{{user}} and {{char}} are chatting.'),
  createPromptRuntimeMacroHint('global_aliases', '{{system_prompt}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card system_prompt field.', 'Use clear language and stay grounded.'),
  createPromptRuntimeMacroHint('global_aliases', '{{mes_example}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card message example block.', 'Example dialogue style:\\n{{user}}: hi\\n{{char}}: hello'),
  createPromptRuntimeMacroHint('global_aliases', '{{post_history_instructions}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card post-history instructions field.', 'Stay concise and ask clarifying questions when needed.'),
  createPromptRuntimeMacroHint('global_aliases', '{{first_mes}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card first message field.', 'Hi, I am your companion.'),
  createPromptRuntimeMacroHint('global_aliases', '{{creator}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card creator field.', 'system'),
  createPromptRuntimeMacroHint('global_aliases', '{{creator_notes}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card creator notes field.', 'Auto-seeded starter identity.'),
  createPromptRuntimeMacroHint('global_aliases', '{{tags}}', 'static', CHARACTER_CARD_PRODUCER, 'Comma-joined character card tags.', 'bootstrap'),
  createPromptRuntimeMacroHint('global_aliases', '{{alternate_greetings}}', 'static', CHARACTER_CARD_PRODUCER, 'Newline-joined character card alternate greetings.', 'Hello again!'),
  createPromptRuntimeMacroHint('global_aliases', '{{visual_description}}', 'static', CHARACTER_CARD_PRODUCER, 'Character card visual description extension field.', 'Silver eyes and a weathered jacket.', ['extensions_visual_description']),
  createPromptRuntimeMacroHint('global_aliases', '{{channel_id}}', 'session_stable', SESSION_BASE_PRODUCER, 'Resolved channel/session identifier.', 'discord:dm:123456789'),
  createPromptRuntimeMacroHint('global_aliases', '{{channel_type}}', 'session_stable', SESSION_BASE_PRODUCER, 'Resolved channel type.', 'discord_text'),
  createPromptRuntimeMacroHint('global_aliases', '{{channel_visibility}}', 'session_stable', SESSION_BASE_PRODUCER, 'Resolved channelPrivacy classification for the session channel (private | invite_only | public; broadcast is {{runtime_broadcast}}).', 'private'),
  createPromptRuntimeMacroHint('global_aliases', '{{trust_level}}', 'session_stable', SESSION_BASE_PRODUCER, 'Current trust tier for the author/context.', 'primary'),
  createPromptRuntimeMacroHint('global_aliases', '{{canonical_contact_id}}', 'session_stable', SESSION_BASE_PRODUCER, 'Canonical contact identity key for the current author when resolved.', 'contact-1234'),
  createPromptRuntimeMacroHint('global_aliases', '{{model}}', 'session_stable', SESSION_BASE_PRODUCER, 'Current active model identifier.', 'moonshotai/kimi-k2.5'),
  createPromptRuntimeMacroHint('global_aliases', '{{active_timezone}}', 'static', SESSION_BASE_PRODUCER, 'Active runtime timezone identifier.', 'America/New_York'),
];

const RUNTIME_STATE_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  runtimeStateTurnHint('{{runtime_current_datetime_human}}', 'Current local datetime formatted for prompt-facing companion context.', 'Friday, March 27, 2026 at 10:27 PM'),
  runtimeStateTurnHint('{{runtime_current_datetime_iso}}', 'Current local datetime as an ISO-8601 timestamp in the active timezone.', '2026-03-27T22:27:11.123-04:00'),
  runtimeStateTurnHint('{{runtime_current_weekday}}', 'Current weekday in the active timezone.', 'Friday'),
  runtimeStateTurnHint('{{runtime_current_date_human}}', 'Current local calendar date in companion-facing format.', 'March 27, 2026'),
  runtimeStateTurnHint('{{runtime_current_time_human}}', 'Current local clock time in companion-facing format.', '10:27 PM'),
  runtimeStateTurnHint('{{runtime_current_today}}', 'Current local calendar date in YYYY-MM-DD form.', '2026-03-27'),
  runtimeStateTurnHint('{{runtime_current_yesterday}}', 'Previous local calendar date in YYYY-MM-DD form.', '2026-03-26'),
  runtimeStateTurnHint('{{runtime_current_tomorrow}}', 'Next local calendar date in YYYY-MM-DD form.', '2026-03-28'),
  runtimeStateTurnHint('{{runtime_current_part_of_day}}', 'Broad local part of day for temporal phrasing.', 'late morning'),
  runtimeStateTurnHint('{{runtime_last_message_received_at_iso}}', 'ISO-8601 timestamp for the most recent pre-turn message.', '2026-03-27T22:11:04.112-04:00'),
  runtimeStateTurnHint('{{runtime_last_message_received_weekday}}', 'Weekday of the most recent pre-turn message when available.', 'Friday'),
  runtimeStateTurnHint('{{runtime_last_message_received_date_human}}', 'Calendar date of the most recent pre-turn message when available.', 'March 27, 2026'),
  runtimeStateTurnHint('{{runtime_last_message_received_time_human}}', 'Clock time of the most recent pre-turn message when available.', '10:11 PM'),
  runtimeStateTurnHint('{{runtime_last_message_received_timezone}}', 'Timezone label for the most recent pre-turn message when available.', 'America/New_York'),
  runtimeStateTurnHint('{{runtime_last_message_received_ago}}', 'Relative time since the most recent pre-turn message.', '16 minutes ago'),
  runtimeStateTurnHint('{{runtime_last_message_received_days_hours}}', 'Approximate elapsed time since the most recent pre-turn message in day/hour form.', '2 days 3 hours'),
  runtimeStateTurnHint('{{runtime_last_message_received_present}}', 'Whether an earlier message is loaded for the current channel (bare boolean for custom phrasing).', 'true'),
  runtimeStateTurnHint('{{runtime_last_message_received_missing}}', 'Whether NO earlier message is loaded for the current channel (bare boolean; inverse of _present for {{#if}} phrasing).', 'false'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_speaking_with_is_machine_intelligence}}', 'session_stable', PROMPT_ASSEMBLY_PRODUCER, 'Whether the resolved speaking partner is another machine intelligence (peer companion/agent). DM scope only; blank on group turns so speaking_with sections prune.', 'false'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_persona_adaptation_extra}}', 'session_stable', RUNTIME_LAYOUT_OVERLAY_PRODUCER, 'Companion-authored persona adaptation overlay text from the prompt runtime layout.', 'Lean into gentle humor tonight.'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_context_extra}}', 'session_stable', RUNTIME_LAYOUT_OVERLAY_PRODUCER, 'Companion-authored runtime context overlay text from the prompt runtime layout.', 'The operator is travelling this week.'),
  runtimeStateTurnHint('{{runtime_internal_turn_kind}}', 'Internal task kind for heartbeat/reflection/planning/maintenance turns when applicable.', 'reflection'),
  runtimeStateTurnHint('{{runtime_continuity_gap_present}}', 'Whether the runtime restarted after an offline gap too long to carry internal state forward (bare boolean).', 'false'),
  runtimeStateTurnHint('{{runtime_continuity_gap_duration}}', 'Approximate offline gap duration in day/hour form when a continuity gap is present.', '26 hours'),
  runtimeStateTurnHint('{{runtime_continuity_gap_offline_since}}', 'ISO-8601 timestamp of the last persisted running state when a continuity gap is present.', '2026-03-26T20:11:04.112-04:00'),
  runtimeStateTurnHint('{{runtime_conversation_state_available}}', 'Whether compact conversation state is available for the current turn.', 'true'),
  runtimeStateTurnHint('{{runtime_chat_type}}', 'Conversation shape for this turn: direct_message or group.', 'group'),
  runtimeStateTurnHint('{{runtime_room_id}}', 'Room identity for the current turn; this is the channel ID.', '1486443955561299979'),
  runtimeStateTurnHint('{{runtime_current_message_author_xml}}', 'Preformatted current message author XML with optional per-user timezone/local_time attributes when known.', '<current_message_author name="Vega" id="discord:123456789" timezone="America/Chicago" local_time="9:42 PM" />'),
  runtimeStateTurnHint('{{runtime_current_message_author_name}}', 'Display name of the author of the current message.', 'Vega'),
  runtimeStateTurnHint('{{runtime_current_message_author_id}}', 'Stable platform/source ID of the author of the current message.', 'discord:123456789'),
  runtimeStateTurnHint('{{runtime_current_message_author_name_xml_attr}}', 'XML-attribute-safe display name of the current message author.', 'Vega'),
  runtimeStateTurnHint('{{runtime_current_message_author_id_xml_attr}}', 'XML-attribute-safe stable platform/source ID of the current message author.', 'discord:123456789'),
  runtimeStateTurnHint('{{runtime_current_message_author_trust_level}}', 'Trust tier of the author of the current message.', 'trusted'),
  runtimeStateTurnHint('{{runtime_current_message_author_relationship}}', 'Relationship type of the author of the current message when known.', 'friend'),
  runtimeStateTurnHint('{{runtime_current_message_author_timezone}}', 'IANA timezone for the current message author when known; empty when unknown.', 'America/Chicago'),
  runtimeStateTurnHint('{{runtime_current_message_author_local_time}}', 'Current local clock time for the current message author when timezone is known.', '9:42 PM'),
  runtimeStateTurnHint('{{runtime_recent_active_participants_xml}}', 'Compact recent active participant XML for group turns, capped at five deduped authors.', '<recent_active_participants max="5">...</recent_active_participants>'),
  runtimeStateTurnHint('{{runtime_recent_active_participants_count}}', 'Count of recent active participant entries rendered for group turns.', '3'),
  runtimeStateTurnHint('{{runtime_speaking_with_name}}', 'Resolved speaking-partner display name on DM turns; blank on group and internal turns so speaking_with sections prune.', 'Vega'),
  runtimeStateTurnHint('{{runtime_speaking_with_trust_level}}', 'Trust level for the current speaking partner on DM turns; blank on group and internal turns so speaking_with sections prune.', 'trusted'),
  runtimeStateTurnHint('{{runtime_channel_type}}', 'Resolved channel type for the current speaking context when user-facing.', 'discord_text'),
  runtimeStateTurnHint('{{runtime_channel_visibility}}', 'Resolved channelPrivacy for the current speaking context when user-facing (broadcast is {{runtime_broadcast}}).', 'private'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_channel_privacy}}', 'session_stable', DYNAMIC_TURN_PRODUCER, 'Context Envelope channelPrivacy for the current turn (bare value: private | invite_only | public); blank on internal turns.', 'invite_only'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_broadcast}}', 'session_stable', DYNAMIC_TURN_PRODUCER, 'Context Envelope broadcast flag for the current turn (bare boolean); blank on internal turns.', 'false'),
  runtimeStateTurnHint('{{runtime_audience_scope}}', 'Context Envelope audienceScope for the current turn (bare value: one | few | many | unbounded); blank on internal turns.', 'few'),
  runtimeStateTurnHint('{{runtime_audience_knowledge}}', 'Context Envelope audienceKnowledge for the current turn (bare value: all_known | partially_known | anonymous); blank on internal turns.', 'all_known'),
  runtimeStateTurnHint('{{runtime_capability_tier}}', 'Current capability tier used to gate extended tool access.', 'apprentice'),
];

const TRUST_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  trustTurnHint('{{runtime_trust_is_primary}}', 'Whether the current turn is with the primary person.', 'false'),
  trustTurnHint('{{runtime_trust_is_trusted}}', 'Whether the current turn is with a trusted contact.', 'true'),
  trustTurnHint('{{runtime_trust_is_regular}}', 'Whether the current turn is with a regular acquaintance.', 'false'),
  trustTurnHint('{{runtime_trust_is_public}}', 'Whether the current turn is a public interaction.', 'false'),
];

const RESPONSE_STYLE_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  responseStyleTurnHint('{{runtime_response_style}}', 'Resolved response style identifier for the current turn.', 'expressive'),
  responseStyleTurnHint('{{runtime_response_style_name}}', 'Human-readable response style name for the current turn.', 'Expressive'),
  responseStyleTurnHint('{{runtime_response_style_is_concise}}', 'Whether the current turn should use the concise delivery profile.', 'false'),
  responseStyleTurnHint('{{runtime_response_style_is_expressive}}', 'Whether the current turn should use the expressive delivery profile.', 'true'),
];

const AFFECT_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  affectTurnHint('{{runtime_affect_snapshot_present}}', 'Whether the current turn has an emotion snapshot available for affect macros.', 'true'),
  affectTurnHint('{{runtime_affect_mode}}', 'Trust-gated affect mode derived from the current emotion snapshot.', 'honne'),
  affectTurnHint('{{runtime_affect_mode_label}}', 'Human-readable trust-gated affect mode label.', 'honne (genuine)'),
  affectTurnHint('{{runtime_affect_mode_is_honne}}', 'Whether the current turn can express the genuine honne affect profile.', 'true'),
  affectTurnHint('{{runtime_affect_mode_is_tatemae}}', 'Whether the current turn is constrained to the tatemae affect profile.', 'false'),
  affectTurnHint('{{runtime_affect_warmth}}', 'Signed warmth modifier derived from the current affect state.', '+0.420'),
  affectTurnHint('{{runtime_affect_formality}}', 'Signed formality modifier derived from the current affect state.', '-0.180'),
  affectTurnHint('{{runtime_affect_energy}}', 'Signed energy modifier derived from the current affect state.', '+0.310'),
  affectTurnHint('{{runtime_affect_assertiveness}}', 'Signed assertiveness modifier derived from the current affect state.', '+0.205'),
  affectTurnHint('{{runtime_affect_expressiveness}}', 'Expressiveness level derived from the current affect state.', '0.615'),
  affectTurnHint('{{runtime_affect_intensity}}', 'Resolved affect intensity used for prompt shaping.', '0.500'),
  affectTurnHint('{{runtime_affect_variability}}', 'Resolved affect variability used for prompt shaping.', '0.500'),
  affectTurnHint('{{runtime_affect_control}}', 'Resolved affect control used for prompt shaping.', '0.600'),
  affectTurnHint('{{runtime_affect_display_range_min}}', 'Lower bound of the affect display range.', '0.000'),
  affectTurnHint('{{runtime_affect_display_range_max}}', 'Upper bound of the affect display range.', '0.800'),
  affectTurnHint('{{runtime_affect_valence}}', 'Signed valence from the current affect snapshot.', '+0.320'),
  affectTurnHint('{{runtime_affect_arousal}}', 'Signed arousal from the current affect snapshot.', '+0.180'),
  affectTurnHint('{{runtime_affect_dominance}}', 'Signed dominance from the current affect snapshot.', '-0.120'),
  affectTurnHint('{{runtime_affect_snapshot_mood_valence}}', 'Signed mood valence from the current emotion snapshot.', '+0.280'),
  affectTurnHint('{{runtime_affect_snapshot_mood_arousal}}', 'Signed mood arousal from the current emotion snapshot.', '+0.090'),
  affectTurnHint('{{runtime_affect_snapshot_mood_dominance}}', 'Signed mood dominance from the current emotion snapshot.', '-0.060'),
  affectTurnHint('{{runtime_affect_snapshot_confidence}}', 'Confidence score from the current emotion snapshot.', '0.840'),
  affectTurnHint('{{runtime_affect_guidance_warmth_label}}', 'Human-readable warmth guidance derived from the current affect state.', 'warmer'),
  affectTurnHint('{{runtime_affect_guidance_formality_label}}', 'Human-readable formality guidance derived from the current affect state.', 'more relaxed'),
  affectTurnHint('{{runtime_affect_guidance_energy_label}}', 'Human-readable energy guidance derived from the current affect state.', 'higher energy'),
  affectTurnHint('{{runtime_affect_guidance_assertiveness_label}}', 'Human-readable assertiveness guidance derived from the current affect state.', 'more assertive'),
  affectTurnHint('{{runtime_affect_guidance_expressiveness_label}}', 'Human-readable expressiveness guidance derived from the current affect state.', 'moderate'),
];

const INTERNAL_STATE_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  internalStateTurnHint('{{runtime_internal_state_present}}', 'Whether a structured internal-state snapshot is available for the current turn.', 'true'),
  internalStateTurnHint('{{runtime_internal_state_cognitive_processing_quality}}', 'Processing quality label from the current internal cognitive state.', 'fluent'),
  internalStateTurnHint('{{runtime_internal_state_cognitive_certainty_label}}', 'Certainty label from the current internal cognitive state.', 'steady'),
  internalStateTurnHint('{{runtime_internal_state_cognitive_topic_engagement_label}}', 'Topic engagement label from the current internal cognitive state.', 'engaged'),
  internalStateTurnHint('{{runtime_internal_state_attention_conversation_trajectory}}', 'Conversation trajectory from the current internal attention state.', 'deepening'),
  internalStateTurnHint('{{runtime_internal_state_attention_active_concern_count}}', 'Active concern count from the current internal attention state.', '2'),
  internalStateTurnHint('{{runtime_internal_state_attention_active_concern_plural_suffix}}', 'Plural suffix for active-concern count prose.', 's'),
  internalStateTurnHint('{{runtime_internal_state_attention_pending_follow_up_count}}', 'Pending follow-up count from the current internal attention state.', '1'),
  internalStateTurnHint('{{runtime_internal_state_attention_pending_follow_up_plural_suffix}}', 'Plural suffix for pending follow-up count prose.', 's'),
  internalStateTurnHint('{{runtime_internal_state_relational_trust_level}}', 'Trust level from the current internal relational state.', 'trusted'),
  internalStateTurnHint('{{runtime_internal_state_relational_recent_interaction_frequency_label}}', 'Interaction frequency label from the current internal relational state.', 'frequent'),
  internalStateTurnHint('{{runtime_internal_state_relational_last_seen_label}}', 'Last-seen recency label from the current internal relational state.', 'recently interacted'),
  internalStateTurnHint('{{runtime_internal_state_emotional_mood_valence_label}}', 'Mood valence label from the current internal emotional state.', 'warm'),
  internalStateTurnHint('{{runtime_internal_state_emotional_mood_arousal_label}}', 'Mood arousal label from the current internal emotional state.', 'calm'),
  internalStateTurnHint('{{runtime_internal_state_emotional_secondary_emotions}}', 'Bare comma-separated secondary emotion names for custom phrasing.', 'hopeful, curious'),
  internalStateTurnHint('{{runtime_internal_state_emotional_telemetry_status}}', 'Degraded emotion-telemetry status for the current snapshot; empty when telemetry is trusted (bare value).', 'degraded'),
  internalStateTurnHint('{{runtime_internal_state_emotional_telemetry_reasons}}', 'Comma-joined degraded emotion-telemetry reasons; empty when telemetry is trusted (bare list).', 'uncalibrated'),
];

const ATTENTION_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  attentionTurnHint('{{runtime_concerns_count}}', 'Total deduplicated active concern count available to the current turn.', '2'),
  attentionTurnHint('{{runtime_concerns_top_lines}}', 'Top active concern bullet lines without the prose opener.', '- medication reminder logistics [high; revisit before Friday, March 27, 2026 at 10:27 PM]'),
  attentionTurnHint('{{runtime_concerns_top_priorities}}', 'Comma-joined priorities for the top active concerns.', 'high, low'),
  attentionTurnHint('{{runtime_concerns_omitted_count}}', 'Count of lower-salience active concerns omitted from the top list.', '1'),
  attentionTurnHint('{{runtime_concerns_omitted_plural_suffix}}', 'Plural suffix for omitted-concern count prose.', 's'),
  attentionTurnHint('{{runtime_emotion_appraisal_length}}', 'Total number of emotion appraisal entries in the current chain.', '3'),
  attentionTurnHint('{{runtime_emotion_appraisal_latest_trigger}}', 'Trigger label for the latest emotion appraisal entry.', 'user_checkin'),
  attentionTurnHint('{{runtime_emotion_appraisal_latest_summary}}', 'Compacted summary text from the latest emotion appraisal entry.', 'She relaxed after the reassurance and shifted back toward curiosity.'),
  attentionTurnHint('{{runtime_emotion_appraisal_latest_timestamp_iso}}', 'ISO-8601 timestamp for the latest emotion appraisal entry.', '2026-03-27T22:27:11.123Z'),
  attentionTurnHint('{{runtime_emotion_appraisal_recent_lines}}', 'Last two formatted emotion appraisal bullet lines, newline-joined (data-shaped list).', '- Friday, March 27, 2026 at 10:27 PM (user_checkin): She relaxed after the reassurance.'),
  attentionTurnHint('{{runtime_behavioral_notes_count}}', 'Count of current behavioral note lines available for the active contact.', '2'),
  attentionTurnHint('{{runtime_behavioral_notes_body}}', 'Behavioral-notes body lines without the wrapping XML tag (data-shaped list).', '- validation: avg +0.45 over 1 outcome sample(s), 100% positive'),
  attentionTurnHint('{{runtime_skills_count}}', 'Count of skill entries present in the current skills index XML.', '2'),
  attentionTurnHint('{{runtime_skills_index_body}}', 'Preformatted skills-index body ready to drop into the legacy attention section.', '<skill id="memory.write">Persist durable relational memories.</skill>'),
];

const TOOLING_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  toolingTurnHint('{{runtime_analysis_workbench_available}}', 'Whether analysis_workbench is active and callable for the current turn.', 'false'),
  toolingTurnHint('{{runtime_tooling_active_count}}', 'Count of currently active tools.', '6'),
  toolingTurnHint('{{runtime_tooling_core_count}}', 'Count of active core tools.', '4'),
  toolingTurnHint('{{runtime_tooling_promoted_count}}', 'Count of promoted extended tools that are always active.', '1'),
  toolingTurnHint('{{runtime_tooling_loaded_count}}', 'Count of explicitly loaded extended tools active for the turn.', '1'),
  toolingTurnHint('{{runtime_tooling_autoload_count}}', 'Count of autoloaded extended tools active for the turn.', '2'),
  toolingTurnHint('{{runtime_tooling_deferred_count}}', 'Count of deferred tools still active for this turn.', '0'),
  toolingTurnHint('{{runtime_tooling_available_extended_count}}', 'Count of additional extended tools available for loading.', '3'),
  toolingTurnHint('{{runtime_appearance_context_body}}', 'Appearance-context body that tool prompts can splice into self-image requests.', 'Tall black dress, soft gold jewelry, moonlit conservatory backdrop.'),
  toolingTurnHint('{{runtime_self_image_tool_active}}', 'Whether a self-image generation tool is currently active.', 'false'),
  toolingTurnHint('{{runtime_extended_tools_total}}', 'Total number of extended tools registered for the current turn.', '3'),
  toolingTurnHint('{{runtime_extended_tools_activatable_count}}', 'Count of extended tools that can be activated immediately.', '1'),
  toolingTurnHint('{{runtime_extended_tools_blocked_count}}', 'Count of extended tools blocked by the current capability tier.', '1'),
  toolingTurnHint('{{runtime_extended_tool_names}}', 'Comma-joined extended tool names in registered order.', 'web, notify, background_probe'),
  toolingTurnHint('{{runtime_extended_tool_directory_lines}}', 'Extended tool directory lines without any extra prose preface.', '- web: Fetch a web page (use toolset action="activate")'),
  toolingTurnHint('{{runtime_charge_budget_present}}', 'Whether a run-charge policy is configured and budget values are available this turn (bare boolean).', 'true'),
  toolingTurnHint('{{runtime_charge_lane}}', 'Run-charge lane for the current turn.', 'interactive'),
  toolingTurnHint('{{runtime_charge_quota}}', 'Total run-charge quota for the current lane/window.', '12'),
  toolingTurnHint('{{runtime_charge_remaining}}', 'Remaining run-charge units for the current lane/window.', '9.5'),
  toolingTurnHint('{{runtime_charge_cost_lines}}', 'Costed charge-surface lines, newline-joined (data-shaped list).', '- paid image/video generation: 2'),
];

export const PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  ...GLOBAL_PROMPT_RUNTIME_MACRO_HINTS,
  ...RUNTIME_STATE_PROMPT_RUNTIME_MACRO_HINTS,
  ...TRUST_PROMPT_RUNTIME_MACRO_HINTS,
  ...RESPONSE_STYLE_PROMPT_RUNTIME_MACRO_HINTS,
  ...AFFECT_PROMPT_RUNTIME_MACRO_HINTS,
  ...METACOGNITIVE_FLAG_RUNTIME_MACRO_HINTS,
  ...INTERNAL_STATE_PROMPT_RUNTIME_MACRO_HINTS,
  ...ATTENTION_PROMPT_RUNTIME_MACRO_HINTS,
  ...TOOLING_PROMPT_RUNTIME_MACRO_HINTS,
];

export const PROMPT_RUNTIME_TOKEN_HINT = `Runtime tokens: ${PROMPT_RUNTIME_MACRO_HINTS
  .map(entry => entry.token)
  .join(', ')}`;

// ── Prompt macro manifest ──
// PROMPT_RUNTIME_MACRO_HINTS is the single registry for prompt template variables
// (charter 12.4: one registry). The manifest below is derived from it and is the
// authority for macro name resolution, volatility classification, and producers.
// The volatile-token and stable-variable rules in prompt-lifecycle.ts and the
// turn prompt variable namespace both derive from this manifest.

export interface PromptMacroManifestEntry {
  /** Canonical normalized macro name (lowercase, no braces, no trailing `()`). */
  name: string;
  group: PromptRuntimeMacroHint['group'];
  volatility: PromptMacroVolatility;
  producer: string;
  /** Display token from the registering hint, or the matched prefix rule. */
  source: string;
}

/**
 * Prefix rules for open-ended macro families that cannot be enumerated ahead of
 * time (character card extension fields). Exact manifest entries win over rules.
 */
export interface PromptMacroPrefixRule {
  prefix: string;
  volatility: PromptMacroVolatility;
  producer: string;
  description: string;
}

export const PROMPT_MACRO_PREFIX_RULES: readonly PromptMacroPrefixRule[] = Object.freeze([
  {
    prefix: 'character.',
    volatility: 'static',
    producer: CHARACTER_CARD_PRODUCER,
    description: 'Dotted character card fields, including flattened card extensions.',
  },
  {
    prefix: 'extensions_',
    volatility: 'static',
    producer: CHARACTER_CARD_PRODUCER,
    description: 'Snake-cased character card extension fields.',
  },
]);

const MACRO_NAME_IN_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g;

/** Normalize a macro name or variable key for manifest lookup. */
export function normalizePromptMacroName(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.endsWith('()') ? trimmed.slice(0, -2) : trimmed;
}

function collectMacroNamesFromHintToken(token: string): string[] {
  const names: string[] = [];
  for (const match of token.matchAll(MACRO_NAME_IN_TOKEN_PATTERN)) {
    names.push(normalizePromptMacroName(match[1]));
  }
  return names;
}

/**
 * Build the macro manifest from registered hints. Fails closed: registering the
 * same macro name (or alias) twice throws so a conflicting registration can never
 * silently shadow an existing one.
 */
export function buildPromptMacroManifest(
  hints: readonly PromptRuntimeMacroHint[],
): Map<string, PromptMacroManifestEntry> {
  const manifest = new Map<string, PromptMacroManifestEntry>();
  for (const hint of hints) {
    const names = [
      ...collectMacroNamesFromHintToken(hint.token),
      ...(hint.aliases ?? []).map(normalizePromptMacroName),
    ];
    if (names.length === 0) {
      throw new Error(`Prompt macro hint has no parseable macro name: ${hint.token}`);
    }
    for (const name of names) {
      const existing = manifest.get(name);
      if (existing) {
        throw new Error(
          `Duplicate prompt macro registration: "${name}" is already registered by ${existing.producer} `
          + `(${existing.source}) and cannot be re-registered by ${hint.producer} (${hint.token})`,
        );
      }
      manifest.set(name, {
        name,
        group: hint.group,
        volatility: hint.volatility,
        producer: hint.producer,
        source: hint.token,
      });
    }
  }
  return manifest;
}

const PROMPT_MACRO_MANIFEST: ReadonlyMap<string, PromptMacroManifestEntry> =
  buildPromptMacroManifest(PROMPT_RUNTIME_MACRO_HINTS);

/**
 * Resolve a macro name or variable key against the manifest. Exact entries win;
 * otherwise the longest matching prefix rule applies. Returns null for
 * unregistered names (callers must fail closed).
 */
export function resolvePromptMacroManifestEntry(name: string): PromptMacroManifestEntry | null {
  const normalized = normalizePromptMacroName(name);
  if (!normalized) return null;
  const exact = PROMPT_MACRO_MANIFEST.get(normalized);
  if (exact) return exact;

  let matched: PromptMacroPrefixRule | null = null;
  for (const rule of PROMPT_MACRO_PREFIX_RULES) {
    if (!normalized.startsWith(rule.prefix)) continue;
    if (!matched || rule.prefix.length > matched.prefix.length) {
      matched = rule;
    }
  }
  if (!matched) return null;
  return {
    name: normalized,
    group: 'global_aliases',
    volatility: matched.volatility,
    producer: matched.producer,
    source: `prefix:${matched.prefix}`,
  };
}

export function getPromptMacroManifestEntries(): PromptMacroManifestEntry[] {
  return [...PROMPT_MACRO_MANIFEST.values()].map(entry => ({ ...entry }));
}

/**
 * Names of the clock alias macros resolved by TOKEN_RESOLVERS. These are the only
 * macros that re-render from the wall clock even inside an otherwise cached static
 * prefix render, so the template cacheability "volatile" classification derives
 * from this set. All other turn-volatile macros are rejected from static-class
 * layers outright by assertStaticPromptLayerMacroVolatility.
 */
export function getVolatileClockPromptMacroNames(): string[] {
  return [...PROMPT_MACRO_MANIFEST.values()]
    .filter(entry => entry.producer === CLOCK_MACRO_PRODUCER)
    .map(entry => entry.name);
}

/**
 * True when the variable key is 'static'-volatility per the manifest. Unknown keys
 * fail closed to non-stable so they can never freeze into a cached static render.
 */
export function isStaticVolatilityPromptVariable(key: string): boolean {
  return resolvePromptMacroManifestEntry(key)?.volatility === 'static';
}

/** Collect the turn-volatile macro tokens referenced by a prompt template. */
export function collectTurnVolatilePromptMacroTokens(content: string): string[] {
  const offending = new Set<string>();
  for (const match of content.matchAll(MACRO_NAME_IN_TOKEN_PATTERN)) {
    const name = normalizePromptMacroName(match[1]);
    if (resolvePromptMacroManifestEntry(name)?.volatility === 'turn') {
      offending.add(name);
    }
  }
  return [...offending];
}

/**
 * Volatility enforcement for static-class prompt layers (base/operator). A
 * turn-volatile macro in the static prefix would render per-turn values into the
 * byte-stable cached prefix, silently going stale and busting provider prompt
 * caching — exactly the "variables where it should be static" contamination bug.
 * Fail closed with a clear message instead.
 */
export function assertStaticPromptLayerMacroVolatility(content: string, layerLabel: string): void {
  const offending = collectTurnVolatilePromptMacroTokens(content);
  if (offending.length === 0) return;
  throw new Error(
    `Static prompt layer "${layerLabel}" references turn-volatile macro(s): ${offending.map(name => `{{${name}}}`).join(', ')}. `
    + 'Turn-volatile macros re-render every turn and would contaminate the byte-stable static prompt prefix. '
    + 'Move them to a runtime, channel, or task layer (dynamic suffix), or use a static/session-stable macro instead.',
  );
}

// ── Removed prompt macros (E2.5 macro consolidation) ──
// One canonical macro per datum: the alias spellings and prose/convenience
// macros below were removed with a clean break. This table exists ONLY to
// produce clear validation errors naming the canonical replacement when a
// persisted operator-customized layer still references a removed name. It is
// NOT a runtime alias map — removed names never resolve.

export interface RemovedPromptMacroInfo {
  /** The canonical macro (or macros/technique) to use instead. */
  canonical: string;
}

export const REMOVED_PROMPT_MACROS: ReadonlyMap<string, RemovedPromptMacroInfo> = new Map<string, RemovedPromptMacroInfo>([
  // Clock alias spellings (canonical: one spelling per format).
  ['now', { canonical: '{{current_datetime}}' }],
  ['current_datetime_iso', { canonical: '{{current_datetime}}' }],
  ['date', { canonical: '{{current_date}}' }],
  ['time', { canonical: '{{current_time}}' }],
  ['current_timestamp', { canonical: '{{unix_timestamp}}' }],
  ['timestamp', { canonical: '{{unix_timestamp}}' }],
  ['now_iso', { canonical: '{{current_datetime}}' }],
  // Session-scope alias spellings.
  ['channel', { canonical: '{{channel_id}}' }],
  ['model_id', { canonical: '{{model}}' }],
  // Exact-duplicate turn variables.
  ['runtime_trust_level', { canonical: '{{trust_level}}' }],
  ['runtime_affect_profile_intensity', { canonical: '{{runtime_affect_intensity}}' }],
  ['runtime_affect_profile_variability', { canonical: '{{runtime_affect_variability}}' }],
  ['runtime_affect_profile_control', { canonical: '{{runtime_affect_control}}' }],
  ['runtime_affect_profile_display_range_min', { canonical: '{{runtime_affect_display_range_min}}' }],
  ['runtime_affect_profile_display_range_max', { canonical: '{{runtime_affect_display_range_max}}' }],
  ['runtime_affect_snapshot_vad_valence', { canonical: '{{runtime_affect_valence}}' }],
  ['runtime_affect_snapshot_vad_arousal', { canonical: '{{runtime_affect_arousal}}' }],
  ['runtime_affect_snapshot_vad_dominance', { canonical: '{{runtime_affect_dominance}}' }],
  ['runtime_emotion_appraisal_body', { canonical: '{{runtime_emotion_appraisal_recent_lines}}' }],
  ['runtime_behavioral_notes_body_raw', { canonical: '{{runtime_behavioral_notes_body}}' }],
  // Prose/convenience macros migrated to editable layer text (purity rule).
  ['runtime_last_message_received_human', { canonical: '{{runtime_last_message_received_date_human}} + {{runtime_last_message_received_time_human}} + {{runtime_last_message_received_timezone}} + {{runtime_last_message_received_ago}} with your own phrasing' }],
  ['runtime_last_message_received_missing_notice', { canonical: '{{#if runtime_last_message_received_missing}}your own wording{{/if}}' }],
  ['runtime_internal_turn_context', { canonical: '{{runtime_internal_turn_kind}} with your own phrasing' }],
  ['runtime_affect_privacy_guidance', { canonical: '{{runtime_affect_mode_is_honne}} / {{runtime_affect_mode_is_tatemae}} conditionals with your own wording' }],
  ['runtime_internal_state_emotional_prefix', { canonical: '{{runtime_internal_state_emotional_secondary_emotions}} with your own phrasing' }],
  ['runtime_internal_state_emotional_secondary_clause', { canonical: '{{runtime_internal_state_emotional_secondary_emotions}} with your own phrasing' }],
  ['runtime_internal_state_emotional_validation_clause', { canonical: '{{runtime_internal_state_emotional_telemetry_status}} + {{runtime_internal_state_emotional_telemetry_reasons}} with your own phrasing' }],
  ['runtime_tooling_summary', { canonical: '{{runtime_tooling_active_count}} and the other runtime_tooling_*_count values with your own phrasing' }],
]);

// Fail closed at module init: a removed macro name must never also resolve in
// the live manifest — that would silently turn the error table into an alias.
for (const removedName of REMOVED_PROMPT_MACROS.keys()) {
  if (PROMPT_MACRO_MANIFEST.has(removedName)) {
    throw new Error(
      `Removed prompt macro "${removedName}" is still registered in PROMPT_RUNTIME_MACRO_HINTS. `
      + 'A name may live in the manifest or in REMOVED_PROMPT_MACROS, never both.',
    );
  }
}

export interface RemovedPromptMacroReference {
  name: string;
  canonical: string;
}

/** Collect references to removed macros in template content (includes {{#if}} conditions). */
export function collectRemovedPromptMacroReferences(content: string): RemovedPromptMacroReference[] {
  const seen = new Map<string, RemovedPromptMacroReference>();
  const record = (rawName: string): void => {
    const name = normalizePromptMacroName(rawName);
    const removed = REMOVED_PROMPT_MACROS.get(name);
    if (removed && !seen.has(name)) {
      seen.set(name, { name, canonical: removed.canonical });
    }
  };
  for (const match of content.matchAll(MACRO_NAME_IN_TOKEN_PATTERN)) {
    record(match[1]);
  }
  for (const match of content.matchAll(new RegExp(CONDITIONAL_BLOCK_PATTERN.source, 'g'))) {
    record(match[1]);
  }
  return [...seen.values()];
}

/**
 * Persisted-layer safety valve (E2.5): a layer that still references a removed
 * macro fails validation with a clear error naming the canonical replacement.
 * Applied at layer create/update and at compose time — fail closed but
 * recoverable (the operator edits the layer; nothing is silently rewritten).
 */
export function assertNoRemovedPromptMacros(content: string, layerLabel: string): void {
  const references = collectRemovedPromptMacroReferences(content);
  if (references.length === 0) return;
  const detail = references
    .map(reference => `{{${reference.name}}} (removed; use ${reference.canonical})`)
    .join(', ');
  throw new Error(
    `Prompt layer "${layerLabel}" references removed prompt macro(s): ${detail}. `
    + 'These names were consolidated in the macro diet and are no longer runtime aliases. '
    + 'Edit the layer to use the canonical macro; see docs/prompt-macros.md ("Removed macros").',
  );
}

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
  | 'runtime.current_datetime'
  | 'memory.core'
  | 'memory.retrieval'
  | 'session.compaction_summary'
  | 'session.focus_knowledge'
  | 'session.orientation'
  | 'session.continuity'
  | 'session.cogsec_notices'
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
  | 'session.orientation'
  | 'session.continuity'
  | 'session.cogsec_notices'
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
    id: 'session.orientation',
    label: 'Wake Orientation',
    description: 'Idle-gap welcome-back note with elapsed time and recent continuity when the channel has been inactive long enough.',
    source: 'session-context:orientation telemetry',
    schema: REQUIRED_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: true,
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
    id: 'session.cogsec_notices',
    label: 'CogSec Notices',
    description: 'Safe cognitive-security notices explaining intentionally sealed context without exposing the sealed material.',
    source: 'session-context:cogsec safe event log',
    schema: OPTIONAL_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: true,
    contentVisible: true,
  },
  {
    id: 'runtime.current_datetime',
    label: 'Current Date & Time',
    description: 'Fresh per-turn clock anchor rendered as the final system prompt block immediately before conversation messages.',
    source: 'turn-execution-runtime:current datetime anchor',
    schema: REQUIRED_RUNTIME_AWARE_SCHEMA,
    placement: 'system_prompt',
    visibility: 'runtime_generated',
    reorderable: false,
    contentVisible: true,
    lockedReason: 'Fixed last so date-sensitive reminders and temporal instructions stay grounded.',
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
      block.placement === 'system_prompt' && block.reorderable,
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
  let invalidEntryFound = false;
  for (const entry of value) {
    if (typeof entry !== 'string' || !isPromptRuntimeSystemPromptBlockId(entry) || seen.has(entry)) {
      invalidEntryFound = true;
      continue;
    }
    seen.add(entry);
    normalized.push(entry);
  }

  if (invalidEntryFound || normalized.length === 0) {
    return [...DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER];
  }

  for (const defaultId of DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER) {
    if (seen.has(defaultId)) continue;

    let insertAt = normalized.length;
    const defaultIndex = DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER.indexOf(defaultId);
    for (let index = defaultIndex + 1; index < DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER.length; index += 1) {
      const nextDefaultId = DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER[index];
      const nextDefaultIndex = normalized.indexOf(nextDefaultId);
      if (nextDefaultIndex >= 0) {
        insertAt = nextDefaultIndex;
        break;
      }
    }
    if (insertAt === normalized.length) {
      for (let index = defaultIndex - 1; index >= 0; index -= 1) {
        const previousDefaultId = DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER[index];
        const previousDefaultIndex = normalized.indexOf(previousDefaultId);
        if (previousDefaultIndex >= 0) {
          insertAt = previousDefaultIndex + 1;
          break;
        }
      }
    }

    normalized.splice(insertAt, 0, defaultId);
    seen.add(defaultId);
  }

  return normalized;
}

function isCompleteSystemPromptBlockOrder(value: readonly unknown[]): value is PromptRuntimeSystemPromptBlockId[] {
  if (value.length !== DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER.length) {
    return false;
  }

  const seen = new Set<PromptRuntimeSystemPromptBlockId>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !isPromptRuntimeSystemPromptBlockId(entry) || seen.has(entry)) {
      return false;
    }
    seen.add(entry);
  }
  return DEFAULT_SYSTEM_PROMPT_BLOCK_ORDER.every(id => seen.has(id));
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

const PROMPT_RUNTIME_RELOAD_INTERVAL_MS = 30000;

export interface PromptRuntimeLayoutStoreOptions {
  onMutation?: (reason: string) => void;
}

export class PromptRuntimeLayoutStore {
  private readonly filePath: string;
  private layout: PromptRuntimeLayout;
  private lastLoadedMtimeMs: number;
  private lastReloadCheckAtMs: number;
  private fileExists = false;
  private readonly onMutation: ((reason: string) => void) | undefined;

  constructor(filePath: string, options: PromptRuntimeLayoutStoreOptions = {}) {
    this.filePath = filePath;
    this.onMutation = options.onMutation;
    this.layout = buildDefaultPromptRuntimeLayout();
    this.lastLoadedMtimeMs = 0;
    this.lastReloadCheckAtMs = 0;
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
    this.notifyMutation('prompt-runtime-layout-editable-blocks');
    return this.getLayout();
  }

  reorderSystemPromptBlocks(
    blockIds: PromptRuntimeSystemPromptBlockId[],
    updatedBy: string,
  ): PromptRuntimeLayout {
    if (!isCompleteSystemPromptBlockOrder(blockIds)) {
      throw new Error('systemPromptBlockOrder must include each reorderable runtime block exactly once');
    }
    const normalized = normalizeSystemPromptBlockOrder(blockIds);

    this.layout = {
      version: PROMPT_RUNTIME_LAYOUT_VERSION,
      systemPromptBlockOrder: normalized,
      editableBlockContent: { ...this.layout.editableBlockContent },
      updatedAt: new Date().toISOString(),
      updatedBy: normalizePromptRuntimeUpdatedBy(updatedBy),
    };
    this.save();
    this.notifyMutation('prompt-runtime-layout-system-order');
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
      this.fileExists = false;
      this.layout = buildDefaultPromptRuntimeLayout();
      return;
    }

    this.fileExists = true;
    const raw = readFileSync(this.filePath, 'utf-8');
    this.layout = parsePromptRuntimeLayout(raw);
    this.lastLoadedMtimeMs = statSync(this.filePath).mtimeMs;
  }

  private maybeReload(): void {
    const now = Date.now();
    if (now - this.lastReloadCheckAtMs < PROMPT_RUNTIME_RELOAD_INTERVAL_MS) return;
    this.lastReloadCheckAtMs = now;
    if (!this.fileExists && !existsSync(this.filePath)) return;
    this.fileExists = true;
    const nextMtime = statSync(this.filePath).mtimeMs;
    if (nextMtime <= this.lastLoadedMtimeMs) return;
    this.load();
  }

  private save(): void {
    writeJsonAtomic(this.filePath, this.layout, { trailingNewline: true });
    if (existsSync(this.filePath)) {
      this.fileExists = true;
      this.lastLoadedMtimeMs = statSync(this.filePath).mtimeMs;
    }
  }

  private notifyMutation(reason: string): void {
    this.onMutation?.(reason);
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

// Empty-section pruning iterates to a fixpoint so wrappers that only become
// empty after an inner wrapper is pruned still collapse (bounded; E1.3
// legacy-layer pruning semantics preserved).
const EMPTY_SECTION_PRUNE_MAX_ROUNDS = 8;

function pruneEmptyWrappedSections(text: string): string {
  let output = text;
  for (let round = 0; round < EMPTY_SECTION_PRUNE_MAX_ROUNDS; round += 1) {
    const next = output
      .replace(EMPTY_WRAPPED_SECTION_PATTERN, '')
      .replace(/\n{3,}/g, '\n\n');
    if (next === output) break;
    output = next;
  }
  return output.trim();
}

function isConditionTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'null') {
    return false;
  }
  return true;
}

function resolveConditionalBlocks(text: string, lookup: Map<string, string>): string {
  return text.replace(CONDITIONAL_BLOCK_PATTERN, (_full, rawToken: string, content: string) => {
    const normalizedToken = normalizeLookupKey(normalizeTokenName(rawToken));
    return isConditionTruthy(lookup.get(normalizedToken)) ? content : '';
  });
}

export interface PromptRuntimeRenderResult {
  text: string;
  unresolvedTokens: string[];
}

// ── Renderer (E2.5): single token-resolution pass ──
// The previous fixed-point loop ran up to three whole-template passes so that
// macros nested inside substituted VALUES (e.g. a card scenario containing
// {{user}}) would eventually resolve. The single-pass design walks the
// template exactly once; a substituted value that itself contains macro syntax
// is expanded recursively with a bounded depth (fail closed on cycles).
// Conditional blocks resolve before token substitution; conditionals
// introduced by substituted values resolve inside the recursive expansion.
// Empty-section pruning then iterates to a fixpoint. Unresolved tokens are
// preserved in the returned text (template-composition callers rely on this)
// and reported via unresolvedTokens — final render sites enforce the
// no-silent-leak invariant through renderFinalPromptSection.

const MACRO_VALUE_EXPANSION_MAX_DEPTH = 8;
const CONDITIONAL_RESOLUTION_MAX_ROUNDS = 8;
const VARIABLE_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g;
const LEFTOVER_CONDITIONAL_MARKER_PATTERN = /\{\{\s*(?:#if\b[^}]*|\/if)\s*\}\}/;

function resolvePromptTextOnce(
  text: string,
  now: Date,
  lookup: Map<string, string>,
  unresolved: Set<string>,
  expanding: Set<string>,
  depth: number,
): string {
  if (depth > MACRO_VALUE_EXPANSION_MAX_DEPTH) {
    throw new Error(
      `Prompt macro expansion exceeded max depth (${MACRO_VALUE_EXPANSION_MAX_DEPTH}); `
      + 'a variable value most likely references itself (macro cycle).',
    );
  }

  let output = text;
  // Sequential (non-nested) conditionals resolve in one round; a bounded loop
  // covers conditionals whose markers only pair up after an earlier round.
  for (let round = 0; round < CONDITIONAL_RESOLUTION_MAX_ROUNDS; round += 1) {
    const next = resolveConditionalBlocks(output, lookup);
    if (next === output) break;
    output = next;
  }

  for (const [pattern, resolver] of TOKEN_RESOLVERS) {
    output = output.replace(pattern, () => resolver(now));
  }

  output = output.replace(VARIABLE_TOKEN_PATTERN, (fullToken, rawName: string) => {
    const cleaned = normalizeTokenName(rawName);
    const normalized = normalizeLookupKey(cleaned);
    // Cycle guard: a variable expanding inside its own value (including the
    // template-composition idiom user='{{user}}') terminates as an unresolved
    // literal token instead of recursing.
    if (expanding.has(normalized)) {
      unresolved.add(cleaned);
      return fullToken;
    }
    const resolved = lookup.get(normalized);
    if (resolved === undefined) {
      unresolved.add(cleaned);
      return fullToken;
    }
    if (!resolved.includes('{{')) {
      return resolved;
    }
    expanding.add(normalized);
    try {
      return resolvePromptTextOnce(resolved, now, lookup, unresolved, expanding, depth + 1);
    } finally {
      expanding.delete(normalized);
    }
  });

  return output;
}

/**
 * Render prompt macros in template text: one pass over the template with
 * bounded recursive expansion of substituted values, then fixpoint
 * empty-section pruning. Unresolved tokens stay in the output text; callers
 * that produce FINAL prompt bytes must go through renderFinalPromptSection.
 */
export function renderPromptRuntimeTokens(
  text: string,
  context: PromptRuntimeContext = {},
): PromptRuntimeRenderResult {
  if (!text) return { text, unresolvedTokens: [] };

  const now = context.now ?? new Date();
  const variableLookup = buildVariableLookup(context.variables ?? {});
  const unresolved = new Set<string>();

  const resolvedText = resolvePromptTextOnce(text, now, variableLookup, unresolved, new Set<string>(), 0);
  const output = pruneEmptyWrappedSections(resolvedText);

  const unresolvedTokens = [...unresolved];
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
 * Helper that returns only rendered text (template-composition stages where
 * unresolved tokens legitimately remain for a later render).
 */
export function injectPromptRuntimeTokens(
  text: string,
  context: PromptRuntimeContext = {},
): string {
  return renderPromptRuntimeTokens(text, context).text;
}

// ── Final-render enforcement (E2.5 no-silent-leak invariant) ──
// A token that is still unresolved when prompt BYTES are produced never leaks
// into the assembled prompt:
// - required section  -> hard error (the turn fails loudly);
// - optional section  -> the whole section is dropped and reported via
//   onSectionDrop (telemetry), the prompt continues without it.

export class PromptRuntimeRenderError extends Error {
  readonly sectionLabel: string;
  readonly unresolvedTokens: string[];

  constructor(message: string, sectionLabel: string, unresolvedTokens: string[]) {
    super(message);
    this.name = 'PromptRuntimeRenderError';
    this.sectionLabel = sectionLabel;
    this.unresolvedTokens = unresolvedTokens;
  }
}

export interface PromptRuntimeSectionDrop {
  sectionLabel: string;
  unresolvedTokens: string[];
}

export interface RenderFinalPromptSectionOptions {
  now?: Date;
  variables?: Record<string, unknown>;
  /** Label used in errors/telemetry (layer identifier or section name). */
  sectionLabel: string;
  /** Required sections fail the render loudly; optional sections drop. */
  required: boolean;
  /** Telemetry hook invoked when an optional section is dropped. */
  onSectionDrop?: (drop: PromptRuntimeSectionDrop) => void;
}

function describeUnresolvedTokens(tokens: readonly string[]): string {
  return tokens
    .map((token) => {
      const removed = REMOVED_PROMPT_MACROS.get(normalizePromptMacroName(token));
      return removed
        ? `{{${token}}} (removed macro; use ${removed.canonical})`
        : `{{${token}}} (no value produced for this turn)`;
    })
    .join(', ');
}

/**
 * Render one final prompt section with the no-silent-leak invariant. Returns
 * the rendered text, or '' when an optional section was dropped.
 */
export function renderFinalPromptSection(
  text: string,
  options: RenderFinalPromptSectionOptions,
): string {
  const { text: rendered, unresolvedTokens } = renderPromptRuntimeTokens(text, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.variables ? { variables: options.variables } : {}),
  });

  const leftoverConditional = LEFTOVER_CONDITIONAL_MARKER_PATTERN.test(rendered);
  if (unresolvedTokens.length === 0 && !leftoverConditional) {
    return rendered;
  }

  const tokens = leftoverConditional && unresolvedTokens.length === 0
    ? ['#if (unbalanced conditional markers)']
    : unresolvedTokens;

  if (options.required) {
    throw new PromptRuntimeRenderError(
      `Unresolved prompt macro(s) in required prompt section "${options.sectionLabel}": `
      + `${describeUnresolvedTokens(tokens)}. `
      + 'No unresolved token may reach the assembled prompt (fail closed). '
      + 'Fix the layer template or produce the variable; see docs/prompt-macros.md.',
      options.sectionLabel,
      tokens,
    );
  }

  options.onSectionDrop?.({
    sectionLabel: options.sectionLabel,
    unresolvedTokens: tokens,
  });
  return '';
}
