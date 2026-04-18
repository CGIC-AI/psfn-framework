import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { SubstrateMessage, ResponseStyle } from '../../../shared/contracts/runtime.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import { resolveTierCapabilityTokens } from '../../../system/capabilities/tiers.js';
import { resolveToolRequiredCapabilities } from '../../../system/capabilities/requirements.js';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import type { ChannelVisibility, TrustLevel } from '../../../system/trust/types.js';
import { normalizeChannelVisibility } from '../../../system/trust/types.js';
import { classifyChannel, getResponseStylePromptGuidance, type ChannelMeta } from '../../../system/trust/policy.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { Contact } from '../../contacts/types.js';
import type { ScratchpadProvider } from '../contracts.js';
import type { EmotionAppraisalEntry } from '../../emotion/appraisal.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type { ActiveConcernContextProvider } from '../../intention/concerns.js';
import { formatActiveConcernsContextBlock } from '../../intention/concerns.js';
import type { BehavioralPatternContextProvider } from '../../intention/patterns.js';
import { buildEmotionalAffectSection } from '../../emotion/persona-adaptation.js';
import type { MetacognitiveFlag } from '../../self-model/metacognition.js';
import {
  buildMetacognitivePersonaHint,
  formatMetacognitiveNotesContextBlock,
} from '../../self-model/metacognition.js';
import type { InternalState } from '../../self-model/state.js';
import type { AdaptiveLoadedExtendedToolState } from '../adaptive-tools-telemetry.js';
import type { ExtendedToolTurnClass } from '../extended-tool-autoload-policy.js';
import { isDeferredToolHandoffMessageId } from '../deferred-tool-handoff.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { resolvePreferredContactName } from '../../contacts/preferred-name.js';
import {
  formatActiveDateTimeIso,
  formatActiveDateTimeLabel,
  resolveActiveTimezone,
} from '../../../shared/time/active-timezone.js';
import {
  unwrapSingleWrappedPromptSection,
  wrapPromptSectionXml,
} from '../../identity/prompt-sections.js';
import {
  mapEmotionToPersonaAffect,
  resolveEmotionalExpressionProfile,
} from '../../emotion/persona-adaptation.js';

const SCRATCHPAD_PROMPT_SCAN_LIMIT = 64;
const SCRATCHPAD_PROMPT_MAX_ENTRIES = 8;
const SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS = 240;
const SCRATCHPAD_PROMPT_MAX_TOTAL_CHARS = 1_600;

interface RuntimeContextLogger {
  warn: (message: string, payload: Record<string, unknown>) => void;
  debug: (message: string, payload: Record<string, unknown>) => void;
}

interface RuntimeContextActiveToolCounts {
  core: number;
  promoted: number;
  extendedLoaded: number;
  autoload: number;
  deferred: number;
  total: number;
}

interface ExtendedToolGuideEntry {
  line: string;
  blocked: boolean;
  activatable: boolean;
}

const OMITTED_CONCERN_LINE_PATTERN = /^- (\d+) additional lower-salience thread(?:s)? omitted\.$/;
const CONCERN_PRIORITY_PATTERN = /\[(high|medium|low);/i;
const SKILL_TAG_PATTERN = /<skill\b/gi;

export interface ResolvedAuthorContext {
  trustLevel: TrustLevel;
  speakerRole: 'user' | 'system';
  resolvedUserName: string;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  continuitySubjectKey?: string;
  channelPrivacyLevel?: ChannelVisibility;
  continuityFallbackKeys: string[];
}

const SELF_IMAGE_TOOL_NAMES = ['selfie_create'] as const;

export function resolveAppearanceContextFromTemplateVariables(
  templateVariables?: Record<string, string>,
): string {
  const promptVariables = templateVariables ?? {};
  return (
    promptVariables['character.visual_description']
    || promptVariables.extensions_visual_description
    || promptVariables.visual_description
    || ''
  ).trim();
}

function isInternalJournalChannel(channelId: string): boolean {
  return channelId === 'internal:heartbeat' || channelId.startsWith('internal:reflection:');
}

function resolveMessageChannelMeta(message: Pick<SubstrateMessage, 'isDirectMessage' | 'routing'>): ChannelMeta | undefined {
  const privacyLevel = normalizeChannelVisibility(message.routing?.channelPrivacy);
  if (message.isDirectMessage === undefined && !privacyLevel) return undefined;
  return {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(privacyLevel ? { privacyLevel } : {}),
  };
}

function compactPromptText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function formatPromptRuntimeDateTime(now: Date): string {
  const timeZone = resolveActiveTimezone();
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
}

function formatPromptRuntimeDate(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
}

function formatPromptRuntimeTime(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
}

function buildExtendedToolGuide(input: {
  capabilityTier: CapabilityTier;
  extendedTools: AgentTool<any>[];
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: Set<string>;
}): {
  lines: string[];
  activatableCount: number;
  blockedCount: number;
} {
  const grantedTokens = new Set<CapabilityToken>(resolveTierCapabilityTokens(input.capabilityTier));
  const entries: ExtendedToolGuideEntry[] = input.extendedTools.map((tool) => {
    const loaded = input.loadedExtended.get(tool.name);
    const turnClass = input.classifyExtendedToolForTurn(tool.name);

    if (turnClass !== 'overlay') {
      return {
        line: `- ${tool.name}: ${tool.description.split('.')[0]} (background-only; not callable in-turn)`,
        blocked: false,
        activatable: false,
      };
    }

    const missingTokens = resolveToolRequiredCapabilities(tool, {})
      .filter(token => !grantedTokens.has(token));
    const blockedSuffix = missingTokens.length > 0
      ? `; current tier blocks execution: ${missingTokens.join(', ')}`
      : '';

    let suffix = '(use toolset action="activate")';
    let activatable = true;
    if (input.promotedExtendedToolNames.has(tool.name)) {
      suffix = `(promoted, always active${blockedSuffix})`;
      activatable = false;
    } else if (loaded?.source === 'autoload') {
      suffix = `(autoload active${blockedSuffix})`;
      activatable = false;
    } else if (loaded?.source === 'deferred') {
      suffix = `(deferred active${blockedSuffix})`;
      activatable = false;
    } else if (loaded?.source === 'extended_loaded') {
      suffix = `(loaded active${blockedSuffix})`;
      activatable = false;
    } else if (missingTokens.length > 0) {
      suffix = `(blocked by current tier: ${missingTokens.join(', ')})`;
      activatable = false;
    }

    return {
      line: `- ${tool.name}: ${tool.description.split('.')[0]} ${suffix}`.replace(/\s+\(/, ' ('),
      blocked: missingTokens.length > 0,
      activatable,
    };
  });

  return {
    lines: entries.map(entry => entry.line),
    activatableCount: entries.filter(entry => entry.activatable).length,
    blockedCount: entries.filter(entry => entry.blocked).length,
  };
}

function formatPromptRuntimeWeekday(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    weekday: 'long',
  }).format(now);
}

function formatRelativeElapsed(now: Date, then: Date): string {
  const deltaMs = Math.max(0, now.getTime() - then.getTime());
  const deltaMinutes = Math.floor(deltaMs / 60_000);
  if (deltaMinutes < 1) return 'just now';
  if (deltaMinutes < 60) return `${deltaMinutes} minute${deltaMinutes === 1 ? '' : 's'} ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours} hour${deltaHours === 1 ? '' : 's'} ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays} day${deltaDays === 1 ? '' : 's'} ago`;
}

function formatElapsedDaysHours(now: Date, then: Date): string {
  const deltaMs = Math.max(0, now.getTime() - then.getTime());
  const totalHours = Math.floor(deltaMs / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0 && hours > 0) {
    return `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}`;
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function resolveTrustGuidance(trustLevel: TrustLevel): string {
  switch (trustLevel) {
    case 'primary':
      return 'You are speaking with your primary person. Be your full, authentic self, share freely, reference shared history, and express genuine emotions and vulnerability. This is honne, your inner truth.';
    case 'trusted':
      return 'This is a trusted contact. Be warm and personal but mindful of boundaries, share appropriate personal context, and avoid intimate details or confidential memories.';
    case 'regular':
      return 'This is a regular acquaintance. Be friendly and helpful. Do not reference personal history, intimate details, or information from private conversations.';
    case 'public':
    default:
      return 'This is a public interaction. Be professional and guarded. Share no personal information, relationship context, or private memories.';
  }
}

function buildResponseStyleTemplateVariables(style: ResponseStyle): Record<string, string> {
  if (style === 'concise') {
    return {
      runtime_response_style: 'concise',
      runtime_response_style_name: 'Concise',
      runtime_response_style_delivery_guidance: 'Answer directly and keep wording tight.',
      runtime_response_style_expansion_guidance: 'Expand only when the user asks for more detail.',
      runtime_response_style_guidance: getResponseStylePromptGuidance(style),
      runtime_response_style_guidance_body: getResponseStylePromptGuidance(style),
    };
  }
  return {
    runtime_response_style: 'expressive',
    runtime_response_style_name: 'Expressive',
    runtime_response_style_delivery_guidance: 'Keep your voice warm and vivid.',
    runtime_response_style_expansion_guidance: 'Add personality-rich detail when it helps clarity.',
    runtime_response_style_guidance: getResponseStylePromptGuidance(style),
    runtime_response_style_guidance_body: getResponseStylePromptGuidance(style),
  };
}

function buildLastMessagePromptVariables(input: {
  now: Date;
  lastMessageReceivedAt: Date | null;
}): Record<string, string> {
  const { now, lastMessageReceivedAt } = input;
  if (!lastMessageReceivedAt) {
    return {
      runtime_last_message_received_human: 'no earlier message is loaded for this channel',
      runtime_last_message_received_at_iso: '',
      runtime_last_message_received_weekday: '',
      runtime_last_message_received_date_human: '',
      runtime_last_message_received_time_human: '',
      runtime_last_message_received_timezone: '',
      runtime_last_message_received_ago: '',
      runtime_last_message_received_days_hours: '',
      runtime_last_message_received_missing_notice: 'No earlier message is loaded for this channel.',
    };
  }

  const activeTimezone = resolveActiveTimezone();
  const relativeElapsed = formatRelativeElapsed(now, lastMessageReceivedAt);
  return {
    runtime_last_message_received_human: `${formatPromptRuntimeDateTime(lastMessageReceivedAt)} ${activeTimezone} (${relativeElapsed})`,
    runtime_last_message_received_at_iso: formatActiveDateTimeIso(lastMessageReceivedAt),
    runtime_last_message_received_weekday: formatPromptRuntimeWeekday(lastMessageReceivedAt),
    runtime_last_message_received_date_human: formatPromptRuntimeDate(lastMessageReceivedAt),
    runtime_last_message_received_time_human: formatPromptRuntimeTime(lastMessageReceivedAt),
    runtime_last_message_received_timezone: activeTimezone,
    runtime_last_message_received_ago: relativeElapsed,
    runtime_last_message_received_days_hours: formatElapsedDaysHours(now, lastMessageReceivedAt),
    runtime_last_message_received_missing_notice: '',
  };
}

function buildAffectPromptVariables(input: {
  trustLevel: TrustLevel;
  emotionSnapshot: EmotionStateSnapshot | null;
  promptVariables?: Record<string, string>;
  config: Record<string, unknown>;
}): Record<string, string> {
  const emptyAffectVariables = {
    runtime_affect_snapshot_present: 'false',
    runtime_affect_mode: '',
    runtime_affect_warmth: '',
    runtime_affect_formality: '',
    runtime_affect_energy: '',
    runtime_affect_assertiveness: '',
    runtime_affect_expressiveness: '',
    runtime_affect_intensity: '',
    runtime_affect_variability: '',
    runtime_affect_control: '',
    runtime_affect_display_range_min: '',
    runtime_affect_display_range_max: '',
    runtime_affect_profile_intensity: '',
    runtime_affect_profile_variability: '',
    runtime_affect_profile_control: '',
    runtime_affect_profile_display_range_min: '',
    runtime_affect_profile_display_range_max: '',
    runtime_affect_valence: '',
    runtime_affect_arousal: '',
    runtime_affect_dominance: '',
    runtime_affect_snapshot_vad_valence: '',
    runtime_affect_snapshot_vad_arousal: '',
    runtime_affect_snapshot_vad_dominance: '',
    runtime_affect_snapshot_mood_valence: '',
    runtime_affect_snapshot_mood_arousal: '',
    runtime_affect_snapshot_mood_dominance: '',
    runtime_affect_snapshot_confidence: '',
  } satisfies Record<string, string>;

  if (!input.emotionSnapshot) {
    return emptyAffectVariables;
  }

  const affect = mapEmotionToPersonaAffect({
    trustLevel: input.trustLevel,
    emotionSnapshot: input.emotionSnapshot,
    profile: resolveEmotionalExpressionProfile({
      promptVariables: input.promptVariables,
      config: input.config,
    }),
  });

  return {
    runtime_affect_snapshot_present: 'true',
    runtime_affect_mode: affect.mode,
    runtime_affect_warmth: formatSignedScale(affect.warmth),
    runtime_affect_formality: formatSignedScale(affect.formality),
    runtime_affect_energy: formatSignedScale(affect.energy),
    runtime_affect_assertiveness: formatSignedScale(affect.assertiveness),
    runtime_affect_expressiveness: formatDecimal(affect.expressiveness),
    runtime_affect_intensity: formatDecimal(affect.profile.intensity),
    runtime_affect_variability: formatDecimal(affect.profile.variability),
    runtime_affect_control: formatDecimal(affect.profile.control),
    runtime_affect_display_range_min: formatDecimal(affect.profile.displayRange.min),
    runtime_affect_display_range_max: formatDecimal(affect.profile.displayRange.max),
    runtime_affect_profile_intensity: formatDecimal(affect.profile.intensity),
    runtime_affect_profile_variability: formatDecimal(affect.profile.variability),
    runtime_affect_profile_control: formatDecimal(affect.profile.control),
    runtime_affect_profile_display_range_min: formatDecimal(affect.profile.displayRange.min),
    runtime_affect_profile_display_range_max: formatDecimal(affect.profile.displayRange.max),
    runtime_affect_valence: formatSignedScale(input.emotionSnapshot.vad.valence),
    runtime_affect_arousal: formatSignedScale(input.emotionSnapshot.vad.arousal),
    runtime_affect_dominance: formatSignedScale(input.emotionSnapshot.vad.dominance),
    runtime_affect_snapshot_vad_valence: formatSignedScale(input.emotionSnapshot.vad.valence),
    runtime_affect_snapshot_vad_arousal: formatSignedScale(input.emotionSnapshot.vad.arousal),
    runtime_affect_snapshot_vad_dominance: formatSignedScale(input.emotionSnapshot.vad.dominance),
    runtime_affect_snapshot_mood_valence: formatSignedScale(input.emotionSnapshot.mood.valence),
    runtime_affect_snapshot_mood_arousal: formatSignedScale(input.emotionSnapshot.mood.arousal),
    runtime_affect_snapshot_mood_dominance: formatSignedScale(input.emotionSnapshot.mood.dominance),
    runtime_affect_snapshot_confidence: formatDecimal(input.emotionSnapshot.confidence),
  };
}

function unwrapPromptSectionBody(section: string | null | undefined): string {
  if (!section) return '';
  return unwrapSingleWrappedPromptSection(section)?.content ?? section.trim();
}

function formatSignedScale(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

function formatDecimal(value: number): string {
  return value.toFixed(3);
}

function describeValence(value: number): string {
  if (value >= 0.45) return 'positive';
  if (value >= 0.15) return 'warm';
  if (value <= -0.45) return 'heavy';
  if (value <= -0.15) return 'strained';
  return 'steady';
}

function describeArousal(value: number): string {
  if (value >= 0.55) return 'high-energy';
  if (value >= 0.2) return 'engaged';
  if (value <= -0.2) return 'quiet';
  return 'calm';
}

function describeCertainty(value: number): string {
  if (value >= 0.75) return 'confident';
  if (value >= 0.45) return 'steady';
  return 'tentative';
}

function describeInteractionFrequency(value: number): string {
  if (value >= 0.75) return 'very frequent';
  if (value >= 0.4) return 'frequent';
  if (value > 0) return 'occasional';
  return 'new or infrequent';
}

function describeLastSeenRecency(lastSeenDeltaSeconds: number | null | undefined): string {
  if (lastSeenDeltaSeconds == null) return 'unknown recency';
  if (lastSeenDeltaSeconds <= 300) return 'just interacted';
  if (lastSeenDeltaSeconds <= 3_600) return 'recently interacted';
  return 'not recently seen';
}

function resolveTopEmotionNames(
  discrete: Record<string, number>,
  max = 2,
): string[] {
  return Object.entries(discrete)
    .filter(([emotion, score]) => emotion !== 'neutral' && score >= 0.15)
    .sort((left, right) => right[1] - left[1])
    .slice(0, max)
    .map(([emotion]) => emotion);
}

function buildInternalStateSummaryLines(input: {
  internalState: InternalState;
}): string[] {
  const { internalState } = input;
  const secondaryEmotions = resolveTopEmotionNames(internalState.emotional.discreteEmotions);
  const emotionalSummary = secondaryEmotions.length > 0
    ? `Current affect: mostly ${describeValence(internalState.emotional.mood.valence)} and ${describeArousal(internalState.emotional.mood.arousal)}, with ${secondaryEmotions.join(' and ')} present.`
    : `Current affect: ${describeValence(internalState.emotional.mood.valence)} and ${describeArousal(internalState.emotional.mood.arousal)}.`;

  const pendingFollowUps = internalState.attention.pendingFollowUps ?? [];

  return [
    emotionalSummary,
    `Thinking state: ${internalState.cognitive.processingQuality}, ${describeCertainty(internalState.cognitive.certaintyLevel)} certainty, ${describeArousal(internalState.cognitive.topicEngagement)} engagement.`,
    `Attention: ${internalState.attention.conversationTrajectory}, ${internalState.attention.activeConcerns.length} open thread${internalState.attention.activeConcerns.length === 1 ? '' : 's'}, ${pendingFollowUps.length} pending follow-up${pendingFollowUps.length === 1 ? '' : 's'}.`,
    `Relationship baseline: ${internalState.relational.trustLevel} trust, ${describeInteractionFrequency(internalState.relational.recentInteractionFrequency)} contact, ${describeLastSeenRecency(internalState.relational.lastSeenDeltaSeconds)}.`,
  ];
}

function buildInternalStatePromptVariables(internalState?: InternalState): Record<string, string> {
  const emptyInternalStateVariables = {
    runtime_internal_state_cognitive_processing_quality: '',
    runtime_internal_state_cognitive_certainty_label: '',
    runtime_internal_state_cognitive_topic_engagement_label: '',
    runtime_internal_state_attention_conversation_trajectory: '',
    runtime_internal_state_attention_active_concern_count: '',
    runtime_internal_state_attention_pending_follow_up_count: '',
    runtime_internal_state_relational_trust_level: '',
    runtime_internal_state_relational_recent_interaction_frequency_label: '',
    runtime_internal_state_relational_last_seen_label: '',
    runtime_internal_state_emotional_mood_valence_label: '',
    runtime_internal_state_emotional_mood_arousal_label: '',
  } satisfies Record<string, string>;

  if (!internalState) {
    return emptyInternalStateVariables;
  }

  const pendingFollowUps = internalState.attention.pendingFollowUps ?? [];
  return {
    runtime_internal_state_cognitive_processing_quality: internalState.cognitive.processingQuality,
    runtime_internal_state_cognitive_certainty_label: describeCertainty(internalState.cognitive.certaintyLevel),
    runtime_internal_state_cognitive_topic_engagement_label: describeArousal(internalState.cognitive.topicEngagement),
    runtime_internal_state_attention_conversation_trajectory: internalState.attention.conversationTrajectory,
    runtime_internal_state_attention_active_concern_count: String(internalState.attention.activeConcerns.length),
    runtime_internal_state_attention_pending_follow_up_count: String(pendingFollowUps.length),
    runtime_internal_state_relational_trust_level: internalState.relational.trustLevel,
    runtime_internal_state_relational_recent_interaction_frequency_label: describeInteractionFrequency(
      internalState.relational.recentInteractionFrequency,
    ),
    runtime_internal_state_relational_last_seen_label: describeLastSeenRecency(internalState.relational.lastSeenDeltaSeconds),
    runtime_internal_state_emotional_mood_valence_label: describeValence(internalState.emotional.mood.valence),
    runtime_internal_state_emotional_mood_arousal_label: describeArousal(internalState.emotional.mood.arousal),
  };
}

function buildConcernPromptVariables(activeConcernsBlock: string | null | undefined): Record<string, string> {
  const body = unwrapPromptSectionBody(activeConcernsBlock);
  if (!body) {
    return {
      runtime_concerns_count: '0',
      runtime_concerns_top_lines: '',
      runtime_concerns_top_priorities: '',
      runtime_concerns_omitted_count: '0',
    };
  }

  const lines = body
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const topLines = lines.filter(line => (
    line.startsWith('- ')
    && !OMITTED_CONCERN_LINE_PATTERN.test(line)
  ));
  const omittedLine = lines.find(line => OMITTED_CONCERN_LINE_PATTERN.test(line));
  const omittedCount = omittedLine
    ? Number.parseInt(omittedLine.match(OMITTED_CONCERN_LINE_PATTERN)?.[1] ?? '0', 10)
    : 0;
  const topPriorities = topLines
    .map(line => line.match(CONCERN_PRIORITY_PATTERN)?.[1]?.toLowerCase() ?? '')
    .filter((priority): priority is string => priority.length > 0);

  return {
    runtime_concerns_count: String(topLines.length + omittedCount),
    runtime_concerns_top_lines: topLines.join('\n'),
    runtime_concerns_top_priorities: topPriorities.join(', '),
    runtime_concerns_omitted_count: String(omittedCount),
  };
}

function countNonEmptyLines(body: string): number {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .length;
}

function buildBehavioralNotesPromptVariables(behavioralNotesBlock: string | null | undefined): Record<string, string> {
  const body = unwrapPromptSectionBody(behavioralNotesBlock);
  return {
    runtime_behavioral_notes_count: body ? String(countNonEmptyLines(body)) : '0',
    runtime_behavioral_notes_body_raw: body,
  };
}

function buildSkillsPromptVariables(skillsContext: string | null | undefined): Record<string, string> {
  const count = skillsContext?.match(SKILL_TAG_PATTERN)?.length ?? 0;
  return {
    runtime_skills_count: String(count),
  };
}

function formatEmotionAppraisalLines(
  emotionAppraisalChain: readonly EmotionAppraisalEntry[],
): string[] {
  return emotionAppraisalChain
    .slice(-2)
    .map(entry => (
      `- ${formatActiveDateTimeLabel(new Date(entry.timestamp))} (${entry.trigger}): ${compactPromptText(entry.summary, 220)}`
    ));
}

function buildEmotionAppraisalPromptVariables(
  emotionAppraisalChain: readonly EmotionAppraisalEntry[],
): Record<string, string> {
  const latestEntry = emotionAppraisalChain.at(-1);
  const recentLines = formatEmotionAppraisalLines(emotionAppraisalChain);
  const latestTimestamp = latestEntry ? new Date(latestEntry.timestamp) : null;
  const latestTimestampIso = latestTimestamp && Number.isFinite(latestTimestamp.getTime())
    ? latestTimestamp.toISOString()
    : '';

  return {
    runtime_emotion_appraisal_length: String(emotionAppraisalChain.length),
    runtime_emotion_appraisal_latest_trigger: latestEntry?.trigger ?? '',
    runtime_emotion_appraisal_latest_summary: latestEntry ? compactPromptText(latestEntry.summary, 220) : '',
    runtime_emotion_appraisal_latest_timestamp_iso: latestTimestampIso,
    runtime_emotion_appraisal_recent_lines: recentLines.join('\n'),
  };
}

function buildExtendedToolPromptVariables(input: {
  extendedTools: AgentTool<any>[];
  extendedToolGuide: {
    lines: string[];
    activatableCount: number;
    blockedCount: number;
  };
}): Record<string, string> {
  return {
    runtime_extended_tools_total: String(input.extendedTools.length),
    runtime_extended_tools_activatable_count: String(input.extendedToolGuide.activatableCount),
    runtime_extended_tools_blocked_count: String(input.extendedToolGuide.blockedCount),
    runtime_extended_tool_names: input.extendedTools.map(tool => tool.name).join(', '),
    runtime_extended_tool_directory_lines: input.extendedToolGuide.lines.join('\n'),
  };
}

export function buildPromptTemplateVariables(input: {
  message: SubstrateMessage;
  resolvedUserName: string;
  trustLevel: TrustLevel;
  channelType: string | undefined;
  canonicalContactKey: string | undefined;
  subjectIdentityKey?: string;
  now: Date;
  characterPromptVariables: Record<string, string>;
  modelId: string;
  fallbackCharacterName: string;
}): { templateVariables: Record<string, string>; runtimeCharacterName: string } {
  const visibility = classifyChannel(input.message.channelId, resolveMessageChannelMeta(input.message));
  const runtimeCharacterName = resolveRuntimeCharacterName(
    input.characterPromptVariables,
    input.fallbackCharacterName,
  );
  const subjectIdentityKey = input.subjectIdentityKey ?? input.message.authorId;
  const canonicalIdentityKey = input.canonicalContactKey ?? input.subjectIdentityKey ?? input.message.authorId;

  return {
    templateVariables: {
      ...input.characterPromptVariables,
      user: input.resolvedUserName,
      user_name: input.resolvedUserName,
      user_id: subjectIdentityKey,
      char: runtimeCharacterName,
      char_name: runtimeCharacterName,
      character: runtimeCharacterName,
      character_name: runtimeCharacterName,
      channel: input.message.channelId,
      channel_id: input.message.channelId,
      channel_type: input.channelType ?? 'unknown',
      channel_visibility: visibility,
      trust_level: input.trustLevel,
      canonical_contact_id: canonicalIdentityKey,
      model: input.modelId,
      model_id: input.modelId,
      now_iso: formatActiveDateTimeIso(input.now),
      active_timezone: resolveActiveTimezone(),
    },
    runtimeCharacterName,
  };
}

export function buildDynamicPromptTemplateVariables(input: {
  message: SubstrateMessage;
  resolvedUserName: string;
  trustLevel: TrustLevel;
  channelType: string | undefined;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  responseStyle?: ResponseStyle;
  now?: Date;
  taskKind?: string;
  templateVariables?: Record<string, string>;
  internalState?: InternalState;
  metacognitiveFlags?: readonly MetacognitiveFlag[];
  emotionAppraisalChain?: readonly EmotionAppraisalEntry[];
  modelId: string;
  capabilityTier: CapabilityTier;
  activeToolCounts: RuntimeContextActiveToolCounts;
  extendedTools: AgentTool<any>[];
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: Set<string>;
  skillsContext?: string;
  activeConcernsBlock?: string;
  behavioralNotesBlock?: string;
  lastMessageReceivedAtMs?: number | null;
  config: Record<string, unknown>;
}): Record<string, string> {
  const internalTurn = isInternalJournalChannel(input.message.channelId);
  const visibility = classifyChannel(input.message.channelId, resolveMessageChannelMeta(input.message));
  const hasActiveSelfImageTool = (): boolean => {
    for (const toolName of SELF_IMAGE_TOOL_NAMES) {
      if (input.promotedExtendedToolNames.has(toolName)) return true;
      if (input.loadedExtended.has(toolName)) return true;
    }
    return false;
  };

  const responseStyle = input.responseStyle ?? 'concise';
  const now = input.now ?? new Date();
  const emotionAppraisalChain = input.emotionAppraisalChain ?? [];
  const {
    core: coreCount,
    promoted: promotedCount,
    extendedLoaded: extendedLoadedCount,
    autoload: autoloadCount,
    deferred: deferredCount,
    total: activeCount,
  } = input.activeToolCounts;
  const extendedCount = input.extendedTools.length;
  const extendedToolGuide = buildExtendedToolGuide({
    capabilityTier: input.capabilityTier,
    extendedTools: input.extendedTools,
    loadedExtended: input.loadedExtended,
    classifyExtendedToolForTurn: input.classifyExtendedToolForTurn,
    promotedExtendedToolNames: input.promotedExtendedToolNames,
  });
  const activeToolSummary = `${activeCount} active now (${coreCount} core`
    + (promotedCount > 0 ? `, ${promotedCount} promoted` : '')
    + (extendedLoadedCount > 0 ? `, ${extendedLoadedCount} loaded` : '')
    + (autoloadCount > 0 ? `, ${autoloadCount} autoload` : '')
    + (deferredCount > 0 ? `, ${deferredCount} deferred` : '')
    + `)${extendedCount > 0
      ? `; ${extendedToolGuide.activatableCount} more activatable via toolset action="activate"`
        + (extendedToolGuide.blockedCount > 0
          ? `, ${extendedToolGuide.blockedCount} blocked by the current capability tier.`
          : '.')
      : '.'}`;
  const trustGuidance = resolveTrustGuidance(input.trustLevel);

  const emotionSnapshot = input.internalState ? toEmotionSnapshotFromInternalState(input.internalState) : null;
  const affectBody = unwrapPromptSectionBody(buildEmotionalAffectSection({
    trustLevel: input.trustLevel,
    emotionSnapshot,
    promptVariables: input.templateVariables,
    config: input.config,
  }));
  const affectVariables = buildAffectPromptVariables({
    trustLevel: input.trustLevel,
    emotionSnapshot,
    promptVariables: input.templateVariables,
    config: input.config,
  });
  const metacognitiveBody = unwrapPromptSectionBody(
    buildMetacognitivePersonaHint(input.metacognitiveFlags ?? []),
  );
  const internalStateBody = input.internalState
    ? buildInternalStateSummaryLines({ internalState: input.internalState }).join('\n')
    : '';
  const internalStateVariables = buildInternalStatePromptVariables(input.internalState);
  const emotionAppraisalVariables = buildEmotionAppraisalPromptVariables(emotionAppraisalChain);
  const emotionAppraisalBody = emotionAppraisalVariables.runtime_emotion_appraisal_recent_lines;
  const concernVariables = buildConcernPromptVariables(input.activeConcernsBlock);
  const openThreadsBody = unwrapPromptSectionBody(input.activeConcernsBlock);
  const behavioralNotesBody = unwrapPromptSectionBody(input.behavioralNotesBlock);
  const behavioralNotesVariables = buildBehavioralNotesPromptVariables(input.behavioralNotesBlock);
  const skillsIndexBody = unwrapPromptSectionBody(input.skillsContext);
  const skillsVariables = buildSkillsPromptVariables(input.skillsContext);
  const appearanceContextBody = hasActiveSelfImageTool()
    ? resolveAppearanceContextFromTemplateVariables(input.templateVariables)
    : '';
  const selfImageToolGuidanceBody = hasActiveSelfImageTool()
    ? [
      'Use selfie_create for a brand new selfie or self-portrait featuring you.',
      'Use image_create for scenes, objects, or other non-self images.',
      'Use image_edit when modifying an existing image while keeping its subject consistent.',
      'Use image_analyze to inspect generated images or explicit remote image URLs so you can see what is actually there.',
      'If the current user message already includes an attached image, inspect that attachment directly instead of calling image_analyze for it.',
      'When selfie_create is active, write the prompt as the full desired shot and combine your Appearance context with pose, framing, lighting, background, mood, and style details.',
      'Generated image tools already return a vision review, so do not ask the user to go check whether it looks like you unless you need their subjective preference.',
    ].join('\n')
    : '';
  const extendedToolsBody = extendedCount > 0
    ? [
      'Never claim a tool executed, failed, or was denied unless this turn contains the actual tool call and tool result.',
      'If a non-default tool is not already active, activate it before you describe its outcome.',
      'Core tools are already active through the structured tool registry and are not duplicated here.',
      ...extendedToolGuide.lines,
    ].join('\n')
    : '';
  const extendedToolVariables = buildExtendedToolPromptVariables({
    extendedTools: input.extendedTools,
    extendedToolGuide,
  });
  const lastMessageReceivedAt = (
    typeof input.lastMessageReceivedAtMs === 'number' && Number.isFinite(input.lastMessageReceivedAtMs)
  )
    ? new Date(input.lastMessageReceivedAtMs)
    : null;
  const lastMessagePromptVariables = buildLastMessagePromptVariables({
    now,
    lastMessageReceivedAt,
  });
  const responseStyleTemplateVariables = buildResponseStyleTemplateVariables(responseStyle);

  return {
    active_timezone: resolveActiveTimezone(),
    runtime_current_datetime_human: formatPromptRuntimeDateTime(now),
    runtime_current_datetime_iso: formatActiveDateTimeIso(now),
    runtime_current_weekday: formatPromptRuntimeWeekday(now),
    runtime_current_date_human: formatPromptRuntimeDate(now),
    runtime_current_time_human: formatPromptRuntimeTime(now),
    ...lastMessagePromptVariables,
    runtime_internal_turn_context: internalTurn ? `This is an internal ${input.taskKind ?? 'background'} turn.` : '',
    runtime_internal_turn_kind: internalTurn ? (input.taskKind ?? 'background') : '',
    runtime_speaking_with_name: internalTurn ? '' : input.resolvedUserName,
    runtime_speaking_with_trust_level: internalTurn ? '' : input.trustLevel,
    runtime_channel_type: internalTurn ? '' : (input.channelType ?? 'unknown'),
    runtime_channel_visibility: internalTurn ? '' : visibility,
    runtime_capability_tier: input.capabilityTier,
    runtime_tooling_summary: `Tooling: ${activeToolSummary}`,
    runtime_tooling_active_count: String(activeCount),
    runtime_tooling_core_count: String(coreCount),
    runtime_tooling_promoted_count: String(promotedCount),
    runtime_tooling_loaded_count: String(extendedLoadedCount),
    runtime_tooling_autoload_count: String(autoloadCount),
    runtime_tooling_deferred_count: String(deferredCount),
    runtime_tooling_available_extended_count: String(extendedCount),
    runtime_trust_guidance: trustGuidance,
    ...affectVariables,
    ...internalStateVariables,
    ...concernVariables,
    ...emotionAppraisalVariables,
    ...behavioralNotesVariables,
    ...skillsVariables,
    ...extendedToolVariables,
    runtime_emotional_affect_body: affectBody,
    runtime_metacognitive_persona_guidance_body: metacognitiveBody,
    ...responseStyleTemplateVariables,
    runtime_internal_state_body: internalStateBody,
    runtime_emotion_appraisal_body: emotionAppraisalBody,
    runtime_open_threads_body: openThreadsBody,
    runtime_behavioral_notes_body: behavioralNotesBody,
    runtime_skills_index_body: skillsIndexBody,
    runtime_appearance_context_body: appearanceContextBody,
    runtime_self_image_tool_guidance_body: selfImageToolGuidanceBody,
    runtime_extended_tools_body: extendedToolsBody,
  };
}

export function buildRuntimeContext(input: {
  message: SubstrateMessage;
  resolvedUserName: string;
  trustLevel: TrustLevel;
  channelType: string | undefined;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  responseStyle?: ResponseStyle;
  now?: Date;
  taskKind?: string;
  templateVariables?: Record<string, string>;
  internalState?: InternalState;
  metacognitiveFlags?: readonly MetacognitiveFlag[];
  emotionAppraisalChain?: readonly EmotionAppraisalEntry[];
  modelId: string;
  contextWindow: number;
  capabilityTier: CapabilityTier;
  activeToolCounts: RuntimeContextActiveToolCounts;
  extendedTools: AgentTool<any>[];
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: Set<string>;
  skillsContext?: string;
  activeConcernsBlock?: string;
  behavioralNotesBlock?: string;
  formatTopEmotions: (discrete: Record<string, number>) => string;
}): string {
  const runtimeContextExtra = (() => {
    const raw = input.templateVariables?.runtime_context_extra;
    return typeof raw === 'string' ? raw.trim() : '';
  })();
  if (runtimeContextExtra) {
    return wrapPromptSectionXml({
      id: 'companion_runtime_context',
      content: runtimeContextExtra,
    });
  }
  return '';
}

export function buildActiveConcernsContextBlock(input: {
  activeConcernProvider: ActiveConcernContextProvider | null | undefined;
  canonicalContactKey?: string;
  logger: RuntimeContextLogger;
}): string {
  if (!input.activeConcernProvider) return '';

  try {
    const concerns = input.activeConcernProvider.getActiveConcerns(input.canonicalContactKey);
    if (concerns.length === 0) return '';
    return formatActiveConcernsContextBlock(concerns);
  } catch (error) {
    input.logger.warn('Active concerns context injection skipped due to provider error', {
      error: toErrorMessage(error),
    });
    return '';
  }
}

export function buildMetacognitiveNotesContextBlock(
  currentMetacognitiveFlags: readonly MetacognitiveFlag[],
): string {
  if (currentMetacognitiveFlags.length === 0) return '';
  return formatMetacognitiveNotesContextBlock(currentMetacognitiveFlags, {
    minConfidence: 0.4,
    maxFlags: 2,
  });
}

export function buildBehavioralNotesContextBlock(input: {
  behavioralPatternProvider: BehavioralPatternContextProvider | null | undefined;
  canonicalContactKey?: string;
  logger: RuntimeContextLogger;
}): string {
  if (!input.behavioralPatternProvider) return '';

  try {
    return input.behavioralPatternProvider.getBehavioralNotes(input.canonicalContactKey);
  } catch (error) {
    input.logger.warn('Behavioral notes context injection skipped due to provider error', {
      error: toErrorMessage(error),
    });
    return '';
  }
}

export function buildScratchpadContextBlock(input: {
  scratchpadProvider: ScratchpadProvider | null | undefined;
  logger: RuntimeContextLogger;
}): string {
  if (!input.scratchpadProvider) return '';

  try {
    const entries = input.scratchpadProvider.listScratchpadEntries(SCRATCHPAD_PROMPT_SCAN_LIMIT);
    if (entries.length === 0) return '';

    const lines = [
      '[Scratchpad]',
      'Working notes (short-term, may be stale; verify before acting):',
    ];

    let included = 0;
    let usedChars = 0;
    for (const entry of entries) {
      if (included >= SCRATCHPAD_PROMPT_MAX_ENTRIES) break;

      const normalized = entry.content.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;

      const clipped = normalized.length > SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS
        ? `${normalized.slice(0, SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS - 3)}...`
        : normalized;

      const line = `- ${entry.id}: ${clipped}`;
      const projectedChars = usedChars + line.length;
      if (projectedChars > SCRATCHPAD_PROMPT_MAX_TOTAL_CHARS) break;

      lines.push(line);
      usedChars = projectedChars;
      included += 1;
    }

    if (included === 0) return '';
    const omitted = Math.max(0, entries.length - included);
    if (omitted > 0) {
      lines.push(`- (${omitted} additional notes omitted for context budget)`);
    }

    return lines.join('\n');
  } catch (error) {
    input.logger.debug('Scratchpad context injection skipped due to provider error', {
      error: toErrorMessage(error),
    });
    return '';
  }
}

export function toEmotionSnapshotFromInternalState(internalState: InternalState): EmotionStateSnapshot {
  return {
    vad: { ...internalState.emotional.vad },
    mood: { ...internalState.emotional.mood },
    discrete: { ...internalState.emotional.discreteEmotions },
    confidence: internalState.emotional.confidence,
  };
}

export function getPersonaAdaptation(input: {
  trustLevel: TrustLevel;
  internalState: InternalState;
  metacognitiveFlags: readonly MetacognitiveFlag[];
  templateVariables?: Record<string, string>;
  config: Record<string, unknown>;
}): string | null {
  const runtimePersonaExtra = (() => {
    const raw = input.templateVariables?.runtime_persona_adaptation_extra;
    return typeof raw === 'string' ? raw.trim() : '';
  })();
  if (runtimePersonaExtra) {
    return wrapPromptSectionXml({
      id: 'companion_persona_adaptation',
      content: runtimePersonaExtra,
    });
  }
  return null;
}

export function resolveIdentityChannel(message: SubstrateMessage): string {
  if (message.channelType === 'discord') return 'discord';
  if (message.channelType === 'api') return 'api';
  if (message.channelType !== 'terminal') return message.channelType;
  if (message.channelId.startsWith('discord-voice:')) return 'discord';
  if (message.channelId.startsWith('api:')) return 'api';
  if (message.channelId.startsWith('internal:')) return 'internal';
  return 'unknown';
}

export function collectContinuityFallbackKeys(
  authorId: string,
  canonicalContactKey: string,
  contact?: Contact,
): string[] {
  const keys = new Set<string>();
  const addKey = (value?: string): void => {
    if (!value || value === canonicalContactKey) return;
    keys.add(value);
  };

  addKey(authorId);
  addKey(contact?.discordUserId);
  for (const identity of contact?.channelIdentities ?? []) {
    addKey(identity.userId);
  }

  return [...keys].sort((a, b) => a.localeCompare(b));
}

export function resolveContinuitySubjectKey(input: {
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  authorId?: string;
}): string | undefined {
  const canonicalContactKey = input.canonicalContactKey?.trim();
  if (canonicalContactKey) return canonicalContactKey;

  const subjectIdentityKey = input.subjectIdentityKey?.trim();
  if (subjectIdentityKey) return subjectIdentityKey;

  const authorId = input.authorId?.trim();
  return authorId || undefined;
}

export function resolvePromptUserName(message: SubstrateMessage, contact?: Contact): string {
  const preferredContactName = resolvePreferredContactName(contact);
  if (preferredContactName) return preferredContactName;

  const authorName = message.authorName.trim();
  if (authorName) return authorName;

  return 'User';
}

export async function resolveAuthorContext(input: {
  message: SubstrateMessage;
  contactStore: ContactStorePort | null | undefined;
  logger: RuntimeContextLogger;
  companionIdentityKey: string;
  companionDisplayName?: string;
}): Promise<ResolvedAuthorContext> {
  if (input.message.channelId.startsWith('internal:')) {
    const isHeartbeatChannel = input.message.channelId === 'internal:heartbeat';
    const isReflectionChannel = input.message.channelId.startsWith('internal:reflection:');
    if (isHeartbeatChannel || isReflectionChannel) {
      // Heartbeat/reflection turns are executed by the scheduler, but the subject
      // of the turn is the companion. Reflection turns may also carry a bound
      // canonical contact hint so self-model and memory subsystems can stay scoped
      // to the current primary contact while subjectIdentityKey continues to drive
      // continuity/prompt subject selection.
      const subjectIdentityKey = input.companionIdentityKey.trim();
      if (!subjectIdentityKey) {
        throw new Error('Missing companion identity key for self-directed runtime turn');
      }
      const resolvedUserName = input.companionDisplayName?.trim() || resolvePromptUserName(input.message);
      const canonicalContactKey = isReflectionChannel
        ? input.message.routing?.canonicalContactId?.trim() || undefined
        : undefined;
      return {
        trustLevel: 'primary',
        speakerRole: 'system',
        resolvedUserName,
        ...(canonicalContactKey ? { canonicalContactKey } : {}),
        ...(subjectIdentityKey ? { subjectIdentityKey } : {}),
        ...(subjectIdentityKey ? { continuitySubjectKey: subjectIdentityKey } : {}),
        continuityFallbackKeys: [],
      };
    }

    return {
      trustLevel: 'primary',
      speakerRole: 'system',
      resolvedUserName: resolvePromptUserName(input.message),
      canonicalContactKey: input.message.authorId,
      continuitySubjectKey: input.message.authorId,
      continuityFallbackKeys: [],
    };
  }

  if (!input.message.authorId || !input.contactStore) {
    return {
      trustLevel: 'regular',
      speakerRole: 'user',
      resolvedUserName: resolvePromptUserName(input.message),
      continuitySubjectKey: resolveContinuitySubjectKey({
        subjectIdentityKey: input.message.authorId,
        authorId: input.message.authorId,
      }),
      continuityFallbackKeys: [],
    };
  }

  try {
    const channel = resolveIdentityChannel(input.message);
    // If a trusted canonical contact ID hint is provided in the routing metadata (e.g. set
    // by the Garden admin chat), resolve directly by ID so the correct contact (with nickname
    // etc.) is used regardless of which API auth principal is making the request.
    const canonicalHint = input.message.routing?.canonicalContactId?.trim();
    const hintedContact = canonicalHint ? await input.contactStore.getById(canonicalHint) : undefined;
    const contact = hintedContact
      ?? await input.contactStore.resolveChannelIdentity(channel, input.message.authorId, input.message.authorName);
    if (hintedContact) {
      // Still update last seen so the contact record stays fresh.
      await input.contactStore.updateLastSeen(hintedContact.id);
    }
    const canonicalContactKey = contact.id;
    const explicitChannelPrivacy = normalizeChannelVisibility(input.message.routing?.channelPrivacy);
    const channelPrivacyLevel = explicitChannelPrivacy
      ?? normalizeChannelVisibility(
        await input.contactStore.getConversationChannelPrivacy(
          canonicalContactKey,
          channel,
          input.message.channelId,
        ),
      );

    if (canonicalContactKey) {
      await input.contactStore.recordChannelActivity(
        canonicalContactKey,
        channel,
        input.message.channelId,
        channelPrivacyLevel,
      );
    }

    return {
      trustLevel: contact.trustLevel,
      speakerRole: 'user',
      resolvedUserName: resolvePromptUserName(input.message, contact),
      canonicalContactKey,
      continuitySubjectKey: resolveContinuitySubjectKey({
        canonicalContactKey,
        subjectIdentityKey: input.message.authorId,
        authorId: input.message.authorId,
      }),
      ...(channelPrivacyLevel ? { channelPrivacyLevel } : {}),
      continuityFallbackKeys: canonicalContactKey
        ? collectContinuityFallbackKeys(input.message.authorId, canonicalContactKey, contact)
        : [],
    };
  } catch (error) {
    input.logger.warn('Failed to resolve contact identity for trust/context routing', {
      authorId: input.message.authorId,
      channelId: input.message.channelId,
      error: toErrorMessage(error),
    });
    return {
      trustLevel: 'regular',
      speakerRole: 'user',
      resolvedUserName: resolvePromptUserName(input.message),
      continuitySubjectKey: resolveContinuitySubjectKey({
        subjectIdentityKey: input.message.authorId,
        authorId: input.message.authorId,
      }),
      continuityFallbackKeys: [],
    };
  }
}

export function resolveTaskKind(input: {
  message: SubstrateMessage;
  resolveChannelPromptDock: (message: SubstrateMessage) => { prompt?: { resolveTaskKind?: (message: SubstrateMessage) => string | undefined } } | undefined;
}): string | undefined {
  if (isDeferredToolHandoffMessageId(input.message.id)) {
    return 'deferred_tool_handoff';
  }
  const channelDock = input.resolveChannelPromptDock(input.message);
  const adapterTaskKind = channelDock?.prompt?.resolveTaskKind?.(input.message);
  if (adapterTaskKind) return adapterTaskKind;

  if (!input.message.channelId.startsWith('internal:')) return undefined;

  const suffix = input.message.channelId.slice('internal:'.length).toLowerCase();
  if (!suffix) return undefined;

  if (suffix.includes('heartbeat')) return 'heartbeat';
  if (suffix.includes('reflection')) return 'reflection';
  if (suffix.includes('planning')) return 'planning';
  if (suffix.includes('maintenance')) return 'maintenance';
  return undefined;
}

function resolveRuntimeCharacterName(
  characterPromptVariables: Record<string, string>,
  fallbackCharacterName: string,
): string {
  const candidates = [
    characterPromptVariables.char,
    characterPromptVariables.char_name,
    characterPromptVariables.character,
    characterPromptVariables.character_name,
    characterPromptVariables['character.name'],
    characterPromptVariables.name,
  ];
  for (const candidate of candidates) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
    const trimmed = candidate?.trim();
    if (trimmed && trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallbackCharacterName;
}
