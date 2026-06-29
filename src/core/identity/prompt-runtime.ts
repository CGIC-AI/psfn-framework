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

const TOKEN_RESOLVERS: Array<[RegExp, TokenResolver]> = [
  [/\{\{\s*(?:current_datetime|current_datetime_iso|now|now\(\))\s*\}\}/gi, activeIso],
  [/\{\{\s*(?:current_date|date|date\(\))\s*\}\}/gi, activeDate],
  [/\{\{\s*(?:current_time|time|time\(\))\s*\}\}/gi, activeTime],
  [/\{\{\s*(?:current_timestamp|unix_timestamp|timestamp|timestamp\(\))\s*\}\}/gi, unixTimestamp],
];

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
}

function createPromptRuntimeMacroHint(
  group: PromptRuntimeMacroHint['group'],
  token: string,
  description: string,
  example: string,
): PromptRuntimeMacroHint {
  return {
    group,
    token,
    description,
    example,
  };
}

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
    createPromptRuntimeMacroHint(
      'metacognition',
      `{{runtime_flag_${flagName}_present}}`,
      `Whether the ${label} metacognitive flag is active for the current turn.`,
      'true',
    ),
    createPromptRuntimeMacroHint(
      'metacognition',
      `{{runtime_flag_${flagName}_confidence}}`,
      `Confidence score for the ${label} metacognitive flag when it is active.`,
      details.confidenceExample,
    ),
    createPromptRuntimeMacroHint(
      'metacognition',
      `{{runtime_flag_${flagName}_evidence}}`,
      `Evidence summary for the ${label} metacognitive flag when it is active.`,
      details.evidenceExample,
    ),
  ];
});

const GLOBAL_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  createPromptRuntimeMacroHint(
    'global_aliases',
    '{{current_datetime}} / {{now()}}',
    `Current active timezone datetime in ISO-8601 format (${resolveActiveTimezone()}).`,
    '2026-02-21T08:20:11.123-05:00',
  ),
  createPromptRuntimeMacroHint(
    'global_aliases',
    '{{current_date}}',
    `Current calendar date in the active timezone (${resolveActiveTimezone()}).`,
    '2026-02-21',
  ),
  createPromptRuntimeMacroHint(
    'global_aliases',
    '{{current_time}}',
    `Current time in the active timezone (${resolveActiveTimezone()}).`,
    '08:20:11-05:00',
  ),
  createPromptRuntimeMacroHint('global_aliases', '{{unix_timestamp}}', 'Current Unix epoch timestamp in seconds.', '1769020811'),
  createPromptRuntimeMacroHint('global_aliases', '{{user}}', 'Current author/user display name from runtime context.', 'PrimaryUser'),
  createPromptRuntimeMacroHint('global_aliases', '{{char}}', 'Character/assistant name from runtime context.', 'Companion'),
  createPromptRuntimeMacroHint('global_aliases', '{{description}}', 'Character card description field.', 'A new companion identity waiting to be customized.'),
  createPromptRuntimeMacroHint('global_aliases', '{{personality}}', 'Character card personality field.', 'A blank starter personality.'),
  createPromptRuntimeMacroHint('global_aliases', '{{scenario}}', 'Character card scenario field.', '{{user}} and {{char}} are chatting.'),
  createPromptRuntimeMacroHint('global_aliases', '{{system_prompt}}', 'Character card system_prompt field.', 'Use clear language and stay grounded.'),
  createPromptRuntimeMacroHint('global_aliases', '{{mes_example}}', 'Character card message example block.', 'Example dialogue style:\\n{{user}}: hi\\n{{char}}: hello'),
  createPromptRuntimeMacroHint('global_aliases', '{{post_history_instructions}}', 'Character card post-history instructions field.', 'Stay concise and ask clarifying questions when needed.'),
  createPromptRuntimeMacroHint('global_aliases', '{{channel_id}}', 'Resolved channel/session identifier.', 'discord:dm:123456789'),
  createPromptRuntimeMacroHint('global_aliases', '{{channel_type}}', 'Resolved channel type.', 'discord_text'),
  createPromptRuntimeMacroHint('global_aliases', '{{trust_level}}', 'Current trust tier for the author/context.', 'primary'),
  createPromptRuntimeMacroHint('global_aliases', '{{model}}', 'Current active model identifier.', 'moonshotai/kimi-k2.5'),
  createPromptRuntimeMacroHint('global_aliases', '{{active_timezone}}', 'Active runtime timezone identifier.', 'America/New_York'),
];

const RUNTIME_STATE_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_datetime_human}}', 'Current local datetime formatted for prompt-facing companion context.', 'Friday, March 27, 2026 at 10:27 PM'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_datetime_iso}}', 'Current local datetime as an ISO-8601 timestamp in the active timezone.', '2026-03-27T22:27:11.123-04:00'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_weekday}}', 'Current weekday in the active timezone.', 'Friday'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_date_human}}', 'Current local calendar date in companion-facing format.', 'March 27, 2026'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_time_human}}', 'Current local clock time in companion-facing format.', '10:27 PM'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_today}}', 'Current local calendar date in YYYY-MM-DD form.', '2026-03-27'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_yesterday}}', 'Previous local calendar date in YYYY-MM-DD form.', '2026-03-26'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_tomorrow}}', 'Next local calendar date in YYYY-MM-DD form.', '2026-03-28'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_part_of_day}}', 'Broad local part of day for temporal phrasing.', 'late morning'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_human}}', 'Last pre-turn message timestamp plus relative elapsed wording.', 'Friday, March 27, 2026 at 10:11 PM America/New_York (16 minutes ago)'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_at_iso}}', 'ISO-8601 timestamp for the most recent pre-turn message.', '2026-03-27T22:11:04.112-04:00'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_weekday}}', 'Weekday of the most recent pre-turn message when available.', 'Friday'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_date_human}}', 'Calendar date of the most recent pre-turn message when available.', 'March 27, 2026'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_time_human}}', 'Clock time of the most recent pre-turn message when available.', '10:11 PM'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_timezone}}', 'Timezone label for the most recent pre-turn message when available.', 'America/New_York'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_ago}}', 'Relative time since the most recent pre-turn message.', '16 minutes ago'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_days_hours}}', 'Approximate elapsed time since the most recent pre-turn message in day/hour form.', '2 days 3 hours'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_missing_notice}}', 'Fallback note when no earlier message is loaded for the current channel.', 'No earlier message is loaded for this channel.'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_last_message_received_present}}', 'Whether an earlier message is loaded for the current channel (bare boolean for custom phrasing).', 'true'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_speaking_with_is_machine_intelligence}}', 'Whether the resolved speaking partner is another machine intelligence (peer companion/agent).', 'false'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_internal_turn_kind}}', 'Internal task kind for heartbeat/reflection/planning/maintenance turns when applicable.', 'reflection'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_conversation_state_available}}', 'Whether compact conversation state is available for the current turn.', 'true'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_chat_type}}', 'Conversation shape for this turn: direct_message or group.', 'group'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_room_id}}', 'Room identity for the current turn; this is the channel ID.', '1486443955561299979'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_message_author_name}}', 'Display name of the author of the current message.', 'Vega'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_message_author_id}}', 'Stable platform/source ID of the author of the current message.', 'discord:123456789'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_message_author_name_xml_attr}}', 'XML-attribute-safe display name of the current message author.', 'Vega'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_current_message_author_id_xml_attr}}', 'XML-attribute-safe stable platform/source ID of the current message author.', 'discord:123456789'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_recent_active_participants_xml}}', 'Compact recent active participant XML for group turns, capped at five deduped authors.', '<recent_active_participants max="5">...</recent_active_participants>'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_recent_active_participants_count}}', 'Count of recent active participant entries rendered for group turns.', '3'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_speaking_with_name}}', 'Resolved speaking-partner display name for user-facing turns.', 'Vega'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_speaking_with_trust_level}}', 'Trust level for the current speaking partner when the turn is user-facing.', 'trusted'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_channel_type}}', 'Resolved channel type for the current speaking context when user-facing.', 'discord_text'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_channel_visibility}}', 'Resolved channel visibility for the current speaking context when user-facing.', 'private'),
  createPromptRuntimeMacroHint('runtime_state', '{{runtime_capability_tier}}', 'Current capability tier used to gate extended tool access.', 'apprentice'),
];

const TRUST_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  createPromptRuntimeMacroHint('trust', '{{runtime_trust_level}}', 'Resolved trust tier for the current turn.', 'trusted'),
  createPromptRuntimeMacroHint('trust', '{{runtime_trust_is_primary}}', 'Whether the current turn is with the primary person.', 'false'),
  createPromptRuntimeMacroHint('trust', '{{runtime_trust_is_trusted}}', 'Whether the current turn is with a trusted contact.', 'true'),
  createPromptRuntimeMacroHint('trust', '{{runtime_trust_is_regular}}', 'Whether the current turn is with a regular acquaintance.', 'false'),
  createPromptRuntimeMacroHint('trust', '{{runtime_trust_is_public}}', 'Whether the current turn is a public interaction.', 'false'),
];

const RESPONSE_STYLE_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  createPromptRuntimeMacroHint('response_style', '{{runtime_response_style}}', 'Resolved response style identifier for the current turn.', 'expressive'),
  createPromptRuntimeMacroHint('response_style', '{{runtime_response_style_name}}', 'Human-readable response style name for the current turn.', 'Expressive'),
  createPromptRuntimeMacroHint('response_style', '{{runtime_response_style_is_concise}}', 'Whether the current turn should use the concise delivery profile.', 'false'),
  createPromptRuntimeMacroHint('response_style', '{{runtime_response_style_is_expressive}}', 'Whether the current turn should use the expressive delivery profile.', 'true'),
  createPromptRuntimeMacroHint('response_style', '{{runtime_response_style_delivery_guidance}}', 'Prompt fragment describing the default delivery for the current response style.', 'Keep your voice warm and vivid.'),
  createPromptRuntimeMacroHint('response_style', '{{runtime_response_style_expansion_guidance}}', 'Prompt fragment describing when to expand or compress detail for the current response style.', 'Add personality-rich detail when it helps clarity.'),
  createPromptRuntimeMacroHint('response_style', '{{runtime_response_style_guidance_body}}', 'Detailed response-style guidance text for the current turn.', 'Prefer expressive responses: keep your voice warm and vivid, and add personality-rich detail when it helps clarity.'),
];

const AFFECT_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_snapshot_present}}', 'Whether the current turn has an emotion snapshot available for affect macros.', 'true'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_mode}}', 'Trust-gated affect mode derived from the current emotion snapshot.', 'honne'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_mode_label}}', 'Human-readable trust-gated affect mode label.', 'honne (genuine)'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_mode_is_honne}}', 'Whether the current turn can express the genuine honne affect profile.', 'true'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_mode_is_tatemae}}', 'Whether the current turn is constrained to the tatemae affect profile.', 'false'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_warmth}}', 'Signed warmth modifier derived from the current affect state.', '+0.420'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_formality}}', 'Signed formality modifier derived from the current affect state.', '-0.180'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_energy}}', 'Signed energy modifier derived from the current affect state.', '+0.310'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_assertiveness}}', 'Signed assertiveness modifier derived from the current affect state.', '+0.205'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_expressiveness}}', 'Expressiveness level derived from the current affect state.', '0.615'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_profile_intensity}}', 'Resolved affect profile intensity used for prompt shaping.', '0.500'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_profile_variability}}', 'Resolved affect profile variability used for prompt shaping.', '0.500'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_profile_control}}', 'Resolved affect profile control used for prompt shaping.', '0.600'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_profile_display_range_min}}', 'Lower bound of the affect profile display range.', '0.000'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_profile_display_range_max}}', 'Upper bound of the affect profile display range.', '0.800'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_intensity}}', 'Resolved affect intensity used for prompt shaping.', '0.500'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_variability}}', 'Resolved affect variability used for prompt shaping.', '0.500'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_control}}', 'Resolved affect control used for prompt shaping.', '0.600'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_display_range_min}}', 'Lower bound of the affect display range.', '0.000'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_display_range_max}}', 'Upper bound of the affect display range.', '0.800'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_valence}}', 'Signed valence from the current affect snapshot.', '+0.320'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_arousal}}', 'Signed arousal from the current affect snapshot.', '+0.180'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_dominance}}', 'Signed dominance from the current affect snapshot.', '-0.120'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_snapshot_vad_valence}}', 'Signed valence from the current emotion snapshot.', '+0.320'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_snapshot_vad_arousal}}', 'Signed arousal from the current emotion snapshot.', '+0.180'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_snapshot_vad_dominance}}', 'Signed dominance from the current emotion snapshot.', '-0.120'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_snapshot_mood_valence}}', 'Signed mood valence from the current emotion snapshot.', '+0.280'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_snapshot_mood_arousal}}', 'Signed mood arousal from the current emotion snapshot.', '+0.090'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_snapshot_mood_dominance}}', 'Signed mood dominance from the current emotion snapshot.', '-0.060'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_snapshot_confidence}}', 'Confidence score from the current emotion snapshot.', '0.840'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_guidance_warmth_label}}', 'Human-readable warmth guidance derived from the current affect state.', 'warmer'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_guidance_formality_label}}', 'Human-readable formality guidance derived from the current affect state.', 'more relaxed'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_guidance_energy_label}}', 'Human-readable energy guidance derived from the current affect state.', 'higher energy'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_guidance_assertiveness_label}}', 'Human-readable assertiveness guidance derived from the current affect state.', 'more assertive'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_guidance_expressiveness_label}}', 'Human-readable expressiveness guidance derived from the current affect state.', 'moderate'),
  createPromptRuntimeMacroHint('affect', '{{runtime_affect_privacy_guidance}}', 'Privacy wording derived from the current trust-gated affect mode.', 'Express warmth openly; intimate details are okay here.'),
];

const INTERNAL_STATE_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_present}}', 'Whether a structured internal-state snapshot is available for the current turn.', 'true'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_cognitive_processing_quality}}', 'Processing quality label from the current internal cognitive state.', 'fluent'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_cognitive_certainty_label}}', 'Certainty label from the current internal cognitive state.', 'steady'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_cognitive_topic_engagement_label}}', 'Topic engagement label from the current internal cognitive state.', 'engaged'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_attention_conversation_trajectory}}', 'Conversation trajectory from the current internal attention state.', 'deepening'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_attention_active_concern_count}}', 'Active concern count from the current internal attention state.', '2'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_attention_active_concern_plural_suffix}}', 'Plural suffix for active-concern count prose.', 's'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_attention_pending_follow_up_count}}', 'Pending follow-up count from the current internal attention state.', '1'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_attention_pending_follow_up_plural_suffix}}', 'Plural suffix for pending follow-up count prose.', 's'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_relational_trust_level}}', 'Trust level from the current internal relational state.', 'trusted'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_relational_recent_interaction_frequency_label}}', 'Interaction frequency label from the current internal relational state.', 'frequent'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_relational_last_seen_label}}', 'Last-seen recency label from the current internal relational state.', 'recently interacted'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_emotional_mood_valence_label}}', 'Mood valence label from the current internal emotional state.', 'warm'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_emotional_mood_arousal_label}}', 'Mood arousal label from the current internal emotional state.', 'calm'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_emotional_prefix}}', 'Optional prose prefix when secondary emotions are present.', 'mostly '),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_emotional_secondary_clause}}', 'Optional prose clause describing secondary emotions.', ', with hopeful and curious secondary emotions present'),
  createPromptRuntimeMacroHint('internal_state', '{{runtime_internal_state_emotional_secondary_emotions}}', 'Bare comma-separated secondary emotion names for custom phrasing.', 'hopeful, curious'),
];

const ATTENTION_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  createPromptRuntimeMacroHint('attention', '{{runtime_concerns_count}}', 'Total deduplicated active concern count available to the current turn.', '2'),
  createPromptRuntimeMacroHint('attention', '{{runtime_concerns_top_lines}}', 'Top active concern bullet lines without the prose opener.', '- medication reminder logistics [high; revisit before Friday, March 27, 2026 at 10:27 PM]'),
  createPromptRuntimeMacroHint('attention', '{{runtime_concerns_top_priorities}}', 'Comma-joined priorities for the top active concerns.', 'high, low'),
  createPromptRuntimeMacroHint('attention', '{{runtime_concerns_omitted_count}}', 'Count of lower-salience active concerns omitted from the top list.', '1'),
  createPromptRuntimeMacroHint('attention', '{{runtime_concerns_omitted_plural_suffix}}', 'Plural suffix for omitted-concern count prose.', 's'),
  createPromptRuntimeMacroHint('attention', '{{runtime_emotion_appraisal_length}}', 'Total number of emotion appraisal entries in the current chain.', '3'),
  createPromptRuntimeMacroHint('attention', '{{runtime_emotion_appraisal_latest_trigger}}', 'Trigger label for the latest emotion appraisal entry.', 'user_checkin'),
  createPromptRuntimeMacroHint('attention', '{{runtime_emotion_appraisal_latest_summary}}', 'Compacted summary text from the latest emotion appraisal entry.', 'She relaxed after the reassurance and shifted back toward curiosity.'),
  createPromptRuntimeMacroHint('attention', '{{runtime_emotion_appraisal_latest_timestamp_iso}}', 'ISO-8601 timestamp for the latest emotion appraisal entry.', '2026-03-27T22:27:11.123Z'),
  createPromptRuntimeMacroHint('attention', '{{runtime_emotion_appraisal_recent_lines}}', 'Last two formatted emotion appraisal bullet lines, newline-joined.', '- Friday, March 27, 2026 at 10:27 PM (user_checkin): She relaxed after the reassurance.'),
  createPromptRuntimeMacroHint('attention', '{{runtime_emotion_appraisal_body}}', 'Preformatted appraisal-chain body ready to drop into the legacy attention section.', '- Friday, March 27, 2026 at 10:27 PM (user_checkin): She relaxed after the reassurance.'),
  createPromptRuntimeMacroHint('attention', '{{runtime_behavioral_notes_count}}', 'Count of current behavioral note lines available for the active contact.', '2'),
  createPromptRuntimeMacroHint('attention', '{{runtime_behavioral_notes_body_raw}}', 'Raw behavioral-notes body text without the wrapping XML tag.', '- validation: avg +0.45 over 1 outcome sample(s), 100% positive'),
  createPromptRuntimeMacroHint('attention', '{{runtime_behavioral_notes_body}}', 'Preformatted behavioral-notes body ready to drop into the legacy attention section.', '- validation: avg +0.45 over 1 outcome sample(s), 100% positive'),
  createPromptRuntimeMacroHint('attention', '{{runtime_skills_count}}', 'Count of skill entries present in the current skills index XML.', '2'),
  createPromptRuntimeMacroHint('attention', '{{runtime_skills_index_body}}', 'Preformatted skills-index body ready to drop into the legacy attention section.', '<skill id="memory.write">Persist durable relational memories.</skill>'),
];

const TOOLING_PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  createPromptRuntimeMacroHint('tooling', '{{runtime_analysis_workbench_available}}', 'Whether analysis_workbench is active and callable for the current turn.', 'false'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_analysis_workbench_guidance_body}}', 'Workbench guidance body rendered only when analysis_workbench is available.', 'analysis_workbench is a large-evidence escalation surface only.'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_tooling_active_count}}', 'Count of currently active tools.', '6'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_tooling_core_count}}', 'Count of active core tools.', '4'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_tooling_promoted_count}}', 'Count of promoted extended tools that are always active.', '1'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_tooling_loaded_count}}', 'Count of explicitly loaded extended tools active for the turn.', '1'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_tooling_autoload_count}}', 'Count of autoloaded extended tools active for the turn.', '2'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_tooling_deferred_count}}', 'Count of deferred tools still active for this turn.', '0'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_tooling_available_extended_count}}', 'Count of additional extended tools available for loading.', '3'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_appearance_context_body}}', 'Appearance-context body that tool prompts can splice into self-image requests.', 'Tall black dress, soft gold jewelry, moonlit conservatory backdrop.'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_self_image_tool_active}}', 'Whether a self-image generation tool is currently active.', 'false'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_extended_tools_total}}', 'Total number of extended tools registered for the current turn.', '3'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_extended_tools_activatable_count}}', 'Count of extended tools that can be activated immediately.', '1'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_extended_tools_blocked_count}}', 'Count of extended tools blocked by the current capability tier.', '1'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_extended_tool_names}}', 'Comma-joined extended tool names in registered order.', 'web, notify, background_probe'),
  createPromptRuntimeMacroHint('tooling', '{{runtime_extended_tool_directory_lines}}', 'Extended tool directory lines without any extra prose preface.', '- web: Fetch a web page (use toolset action="activate")'),
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

    output = resolveConditionalBlocks(output, variableLookup);

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
