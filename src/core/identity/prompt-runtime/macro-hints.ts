import { resolveActiveTimezone } from '../../../shared/time/active-timezone.js';

export const METACOGNITIVE_FLAG_HINT_NAMES = [
  'uncertainty',
  'avoidance',
  'high_engagement',
  'repetition',
  'confabulation_risk',
] as const;

export type MetacognitiveFlagName = typeof METACOGNITIVE_FLAG_HINT_NAMES[number];

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
export const CHARACTER_CARD_PRODUCER = 'character-macro-map:buildCharacterMacroMap';
export const SESSION_BASE_PRODUCER = 'runtime-context:buildPromptTemplateVariables';
export const DYNAMIC_TURN_PRODUCER = 'runtime-context:buildDynamicPromptTemplateVariables';
export const TRUST_STATE_PRODUCER = 'trust-policy:buildTrustPromptState';
export const RESPONSE_STYLE_PRODUCER = 'trust-policy:buildResponseStylePromptState';
export const AFFECT_PRODUCER = 'emotion-persona-adaptation:buildEmotionalAffectPromptVariables';
export const METACOGNITION_PRODUCER = 'self-model-metacognition:buildMetacognitiveFlagPromptVariables';
export const RUNTIME_LAYOUT_OVERLAY_PRODUCER = 'substrate-agent:resolveRuntimePromptGuidanceVariables';
export const PROMPT_ASSEMBLY_PRODUCER = 'turn-execution:assembleTurnPrompt';

export function createPromptRuntimeMacroHint(
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

export function createTurnMacroHintFactory(
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

export const METACOGNITIVE_FLAG_PROMPT_HINT_DETAILS: Record<
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

export const METACOGNITIVE_FLAG_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = METACOGNITIVE_FLAG_HINT_NAMES.flatMap((flagName) => {
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

export const GLOBAL_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
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

export const RUNTIME_STATE_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
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
  runtimeStateTurnHint('{{runtime_participant_relationships_xml}}', 'Compact participant-relationship XML for group turns: live high-confidence edges between currently listed participants, envelope-gated and capped at five. Blank (absent) on DM/internal turns, anonymous/broadcast audiences, or when no edge qualifies.', '<participant_relationships>...</participant_relationships>'),
  runtimeStateTurnHint('{{runtime_participant_relationships_count}}', 'Count of participant-relationship lines rendered for the current group turn.', '1'),
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

export const TRUST_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  trustTurnHint('{{runtime_trust_is_primary}}', 'Whether the current turn is with the primary person.', 'false'),
  trustTurnHint('{{runtime_trust_is_trusted}}', 'Whether the current turn is with a trusted contact.', 'true'),
  trustTurnHint('{{runtime_trust_is_regular}}', 'Whether the current turn is with a regular acquaintance.', 'false'),
  trustTurnHint('{{runtime_trust_is_public}}', 'Whether the current turn is a public interaction.', 'false'),
];

export const RESPONSE_STYLE_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  responseStyleTurnHint('{{runtime_response_style}}', 'Resolved response style identifier for the current turn.', 'expressive'),
  responseStyleTurnHint('{{runtime_response_style_name}}', 'Human-readable response style name for the current turn.', 'Expressive'),
  responseStyleTurnHint('{{runtime_response_style_is_concise}}', 'Whether the current turn should use the concise delivery profile.', 'false'),
  responseStyleTurnHint('{{runtime_response_style_is_expressive}}', 'Whether the current turn should use the expressive delivery profile.', 'true'),
];

export const AFFECT_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
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

export const INTERNAL_STATE_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
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

export const ATTENTION_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
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

export const TOOLING_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
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
