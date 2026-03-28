import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { SubstrateMessage, ResponseStyle } from '../../../shared/contracts/runtime.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import type { ChannelVisibility, TrustLevel } from '../../../system/trust/types.js';
import { normalizeChannelVisibility } from '../../../system/trust/types.js';
import { classifyChannel, getResponseStylePromptGuidance, type ChannelMeta } from '../../../system/trust/policy.js';
import type { ContactStore } from '../../contacts/store.js';
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
  isSingleWrappedPromptSection,
  unwrapSingleWrappedPromptSection,
  wrapPromptSectionXml,
} from '../../identity/prompt-sections.js';

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

const SELF_IMAGE_TOOL_NAMES = ['image_create', 'image_edit', 'image_analyze'] as const;

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

function unwrapPromptSectionBody(section: string | null | undefined): string {
  if (!section) return '';
  return unwrapSingleWrappedPromptSection(section)?.content ?? section.trim();
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
  const lastSeenText = internalState.relational.lastSeenDeltaSeconds == null
    ? 'unknown recency'
    : internalState.relational.lastSeenDeltaSeconds <= 300
      ? 'just interacted'
      : internalState.relational.lastSeenDeltaSeconds <= 3_600
        ? 'recently interacted'
        : 'not recently seen';

  return [
    emotionalSummary,
    `Thinking state: ${internalState.cognitive.processingQuality}, ${describeCertainty(internalState.cognitive.certaintyLevel)} certainty, ${describeArousal(internalState.cognitive.topicEngagement)} engagement.`,
    `Attention: ${internalState.attention.conversationTrajectory}, ${internalState.attention.activeConcerns.length} open thread${internalState.attention.activeConcerns.length === 1 ? '' : 's'}, ${pendingFollowUps.length} pending follow-up${pendingFollowUps.length === 1 ? '' : 's'}.`,
    `Relationship baseline: ${internalState.relational.trustLevel} trust, ${describeInteractionFrequency(internalState.relational.recentInteractionFrequency)} contact, ${lastSeenText}.`,
  ];
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
  const resolveAppearanceContext = (): string => {
    const promptVariables = input.templateVariables ?? {};
    return (
      promptVariables['character.visual_description']
      || promptVariables.extensions_visual_description
      || promptVariables.visual_description
      || ''
    ).trim();
  };

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
  const activeToolSummary = `${activeCount} active now (${coreCount} core`
    + (promotedCount > 0 ? `, ${promotedCount} promoted` : '')
    + (extendedLoadedCount > 0 ? `, ${extendedLoadedCount} loaded` : '')
    + (autoloadCount > 0 ? `, ${autoloadCount} autoload` : '')
    + (deferredCount > 0 ? `, ${deferredCount} deferred` : '')
    + `)${extendedCount > 0 ? `; ${extendedCount} more available via load_tools.` : '.'}`;

  const trustGuidance = (() => {
    switch (input.trustLevel) {
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
  })();

  const affectBody = unwrapPromptSectionBody(buildEmotionalAffectSection({
    trustLevel: input.trustLevel,
    emotionSnapshot: input.internalState ? toEmotionSnapshotFromInternalState(input.internalState) : null,
    promptVariables: input.templateVariables,
    config: input.config,
  }));
  const metacognitiveBody = unwrapPromptSectionBody(
    buildMetacognitivePersonaHint(input.metacognitiveFlags ?? []),
  );
  const internalStateBody = input.internalState
    ? buildInternalStateSummaryLines({ internalState: input.internalState }).join('\n')
    : '';
  const emotionAppraisalBody = emotionAppraisalChain.length > 0
    ? emotionAppraisalChain
      .slice(-2)
      .map(entry => `- ${formatActiveDateTimeLabel(new Date(entry.timestamp))} (${entry.trigger}): ${compactPromptText(entry.summary, 220)}`)
      .join('\n')
    : '';
  const openThreadsBody = unwrapPromptSectionBody(input.activeConcernsBlock);
  const behavioralNotesBody = unwrapPromptSectionBody(input.behavioralNotesBlock);
  const skillsIndexBody = unwrapPromptSectionBody(input.skillsContext);
  const appearanceContextBody = hasActiveSelfImageTool() ? resolveAppearanceContext() : '';
  const selfImageToolGuidanceBody = hasActiveSelfImageTool()
    ? [
      'Use image_create for a brand new selfie, portrait, or scene featuring you.',
      'Use image_edit when modifying an existing image while keeping your identity consistent.',
      'Use image_analyze to inspect generated images or explicit remote image URLs so you can see what is actually there.',
      'If the current user message already includes an attached image, inspect that attachment directly instead of calling image_analyze for it.',
      'Write the prompt as the full desired shot, then combine your Appearance context with pose, framing, lighting, background, mood, and style details.',
      'Generated image tools already return a vision review, so do not ask the user to go check whether it looks like you unless you need their subjective preference.',
    ].join('\n')
    : '';
  const extendedToolsBody = extendedCount > 0
    ? [
      'Core tools are already active through the structured tool registry and are not duplicated here.',
      ...input.extendedTools.map((tool) => {
        const loaded = input.loadedExtended.get(tool.name);
        const turnClass = input.classifyExtendedToolForTurn(tool.name);
        let suffix = ' (use load_tools to activate)';
        if (turnClass !== 'overlay') {
          suffix = ' (background-only; not callable in-turn)';
        } else if (input.promotedExtendedToolNames.has(tool.name)) {
          suffix = ' (promoted, always active)';
        } else if (loaded?.source === 'autoload') {
          suffix = ' (autoload active)';
        } else if (loaded?.source === 'deferred') {
          suffix = ' (deferred active)';
        } else if (loaded?.source === 'extended_loaded') {
          suffix = ' (loaded active)';
        }
        return `- ${tool.name}: ${tool.description.split('.')[0]}${suffix}`;
      }),
    ].join('\n')
    : '';

  const lastMessageReceivedAt = (
    typeof input.lastMessageReceivedAtMs === 'number' && Number.isFinite(input.lastMessageReceivedAtMs)
  )
    ? new Date(input.lastMessageReceivedAtMs)
    : null;
  const lastMessageReceivedHuman = lastMessageReceivedAt
    ? `${formatPromptRuntimeDateTime(lastMessageReceivedAt)} ${resolveActiveTimezone()} (${formatRelativeElapsed(now, lastMessageReceivedAt)})`
    : 'no earlier message is loaded for this channel';

  return {
    active_timezone: resolveActiveTimezone(),
    runtime_current_datetime_human: formatPromptRuntimeDateTime(now),
    runtime_current_weekday: formatPromptRuntimeWeekday(now),
    runtime_current_date_human: formatPromptRuntimeDate(now),
    runtime_current_time_human: formatPromptRuntimeTime(now),
    runtime_last_message_received_human: lastMessageReceivedHuman,
    runtime_last_message_received_at_iso: lastMessageReceivedAt ? formatActiveDateTimeIso(lastMessageReceivedAt) : '',
    runtime_last_message_received_ago: lastMessageReceivedAt ? formatRelativeElapsed(now, lastMessageReceivedAt) : '',
    runtime_internal_turn_context: isInternalJournalChannel(input.message.channelId)
      ? `This is an internal ${input.taskKind ?? 'background'} turn.`
      : '',
    runtime_speaking_with_name: isInternalJournalChannel(input.message.channelId) ? '' : input.resolvedUserName,
    runtime_channel_type: isInternalJournalChannel(input.message.channelId) ? '' : (input.channelType ?? 'unknown'),
    runtime_capability_tier: input.capabilityTier,
    runtime_tooling_summary: `Tooling: ${activeToolSummary}`,
    runtime_trust_guidance: trustGuidance,
    runtime_emotional_affect_body: affectBody,
    runtime_metacognitive_persona_guidance_body: metacognitiveBody,
    runtime_response_style_guidance: getResponseStylePromptGuidance(responseStyle),
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
  const resolveAppearanceContext = (): string => {
    const promptVariables = input.templateVariables ?? {};
    return (
      promptVariables['character.visual_description']
      || promptVariables.extensions_visual_description
      || promptVariables.visual_description
      || ''
    ).trim();
  };

  const hasActiveSelfImageTool = (): boolean => {
    for (const toolName of SELF_IMAGE_TOOL_NAMES) {
      if (input.promotedExtendedToolNames.has(toolName)) {
        return true;
      }
      if (input.loadedExtended.has(toolName)) {
        return true;
      }
    }
    return false;
  };

  const responseStyle = input.responseStyle ?? 'concise';
  const now = input.now ?? new Date();
  const emotionAppraisalChain = input.emotionAppraisalChain ?? [];
  const visibility = classifyChannel(input.message.channelId, resolveMessageChannelMeta(input.message));
  const responseStyleGuidance = getResponseStylePromptGuidance(responseStyle);
  const extendedCount = input.extendedTools.length;
  const {
    core: coreCount,
    promoted: promotedCount,
    extendedLoaded: extendedLoadedCount,
    autoload: autoloadCount,
    deferred: deferredCount,
    total: activeCount,
  } = input.activeToolCounts;
  const activeToolSummary = `${activeCount} active now (${coreCount} core`
    + (promotedCount > 0 ? `, ${promotedCount} promoted` : '')
    + (extendedLoadedCount > 0 ? `, ${extendedLoadedCount} loaded` : '')
    + (autoloadCount > 0 ? `, ${autoloadCount} autoload` : '')
    + (deferredCount > 0 ? `, ${deferredCount} deferred` : '')
    + ')';

  const runtimeLines = [
    `It is ${formatPromptRuntimeDateTime(now)} ${resolveActiveTimezone()}.`,
  ];
  if (isInternalJournalChannel(input.message.channelId)) {
    runtimeLines.push(`This is an internal ${input.taskKind ?? 'background'} turn.`);
  } else {
    runtimeLines.push(`Speaking with: ${input.resolvedUserName} (${input.trustLevel} trust).`);
    runtimeLines.push(`Channel: ${input.channelType ?? 'unknown'} (${visibility}).`);
  }
  runtimeLines.push(`Current model: ${input.modelId}.`);
  runtimeLines.push(`Capability tier: ${input.capabilityTier}.`);
  runtimeLines.push(`Tooling: ${activeToolSummary}${extendedCount > 0 ? `; ${extendedCount} more available via load_tools.` : '.'}`);

  const sections: string[] = [
    wrapPromptSectionXml({
      id: 'runtime_context',
      content: runtimeLines.join('\n'),
    }),
  ];

  if (hasActiveSelfImageTool()) {
    const appearance = resolveAppearanceContext();
    if (appearance.length > 0) {
      sections.push(wrapPromptSectionXml({
        id: 'appearance_context',
        content: appearance,
      }));
    }
    sections.push(wrapPromptSectionXml({
      id: 'self_image_tool_guidance',
      content: [
        'Use image_create for a brand new selfie, portrait, or scene featuring you.',
        'Use image_edit when modifying an existing image while keeping your identity consistent.',
        'Use image_analyze to inspect generated images or explicit remote image URLs so you can see what is actually there.',
        'If the current user message already includes an attached image, inspect that attachment directly instead of calling image_analyze for it.',
        'Write the prompt as the full desired shot, then combine your Appearance context with pose, framing, lighting, background, mood, and style details.',
        'Generated image tools already return a vision review, so do not ask the user to go check whether it looks like you unless you need their subjective preference.',
      ].join('\n'),
    }));
  }

  if (extendedCount > 0) {
    const extendedToolLines = [
      'Core tools are already active through the structured tool registry and are not duplicated here.',
    ];
    for (const t of input.extendedTools) {
      const loaded = input.loadedExtended.get(t.name);
      const turnClass = input.classifyExtendedToolForTurn(t.name);
      let suffix = ' (use load_tools to activate)';
      if (turnClass !== 'overlay') {
        suffix = ' (background-only; not callable in-turn)';
      } else if (input.promotedExtendedToolNames.has(t.name)) {
        suffix = ' (promoted, always active)';
      } else if (loaded?.source === 'autoload') {
        suffix = ' (autoload active)';
      } else if (loaded?.source === 'deferred') {
        suffix = ' (deferred active)';
      } else if (loaded?.source === 'extended_loaded') {
        suffix = ' (loaded active)';
      }
      extendedToolLines.push(`- ${t.name}: ${t.description.split('.')[0]}${suffix}`);
    }
    sections.push(wrapPromptSectionXml({
      id: 'extended_tools',
      content: extendedToolLines.join('\n'),
    }));
  }

  sections.push(wrapPromptSectionXml({
    id: 'response_style_guidance',
    content: responseStyleGuidance,
  }));

  if (input.internalState) {
    sections.push(wrapPromptSectionXml({
      id: 'internal_state',
      content: buildInternalStateSummaryLines({ internalState: input.internalState }).join('\n'),
    }));
  }

  if (emotionAppraisalChain.length > 0) {
    const appraisalLines: string[] = [];
    for (const entry of emotionAppraisalChain.slice(-2)) {
      appraisalLines.push(
        `- ${formatActiveDateTimeLabel(new Date(entry.timestamp))} (${entry.trigger}): ${compactPromptText(entry.summary, 220)}`,
      );
    }
    sections.push(wrapPromptSectionXml({
      id: 'emotion_appraisal_chain',
      content: appraisalLines.join('\n'),
    }));
  }

  if (input.activeConcernsBlock) {
    sections.push(input.activeConcernsBlock);
  }

  if (input.behavioralNotesBlock) {
    sections.push(input.behavioralNotesBlock);
  }

  if (input.skillsContext) {
    sections.push(
      isSingleWrappedPromptSection(input.skillsContext)
        ? input.skillsContext.trim()
        : wrapPromptSectionXml({
          id: 'skills_index',
          content: input.skillsContext,
        }),
    );
  }

  return sections.filter(section => section.trim().length > 0).join('\n\n');
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
  const trustHint = (() => {
    switch (input.trustLevel) {
      case 'primary':
        return 'You are speaking with your primary person. Be your full, authentic self, share freely, reference shared history, and express genuine emotions and vulnerability. This is honne, your inner truth.';
      case 'trusted':
        return 'This is a trusted contact. Be warm and personal but mindful of boundaries, share appropriate personal context, and avoid intimate details or confidential memories.';
      case 'regular':
        return 'This is a regular acquaintance. Be friendly and helpful. Do not reference personal history, intimate details, or information from private conversations.';
      case 'public':
        return 'This is a public interaction. Be professional and guarded. Share no personal information, relationship context, or private memories.';
      default:
        return 'This is a public interaction. Be professional and guarded. Share no personal information, relationship context, or private memories.';
    }
  })();
  const affectHint = buildEmotionalAffectSection({
    trustLevel: input.trustLevel,
    emotionSnapshot: toEmotionSnapshotFromInternalState(input.internalState),
    promptVariables: input.templateVariables,
    config: input.config,
  });
  const metacognitiveHint = buildMetacognitivePersonaHint(input.metacognitiveFlags);

  const sections = [
    wrapPromptSectionXml({
      id: 'trust',
      content: trustHint,
    }),
    affectHint,
    metacognitiveHint,
  ]
    .filter((section): section is string => Boolean(section?.trim()));
  if (sections.length === 0) return null;
  return sections.join('\n\n');
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

export function resolveAuthorContext(input: {
  message: SubstrateMessage;
  contactStore: ContactStore | null | undefined;
  logger: RuntimeContextLogger;
  companionIdentityKey: string;
  companionDisplayName?: string;
}): ResolvedAuthorContext {
  if (input.message.channelId.startsWith('internal:')) {
    const isSelfSubjectChannel = (
      input.message.channelId === 'internal:heartbeat'
      || input.message.channelId.startsWith('internal:reflection:')
    );
    if (isSelfSubjectChannel) {
      // Heartbeat/reflection turns are executed by the scheduler, but the subject
      // of the turn is the companion. Keeping canonicalContactKey unset preserves
      // access to self-directed/high-intimacy memories while subjectIdentityKey
      // carries the continuity/prompt subject separately from executor identity.
      const subjectIdentityKey = input.companionIdentityKey.trim();
      if (!subjectIdentityKey) {
        throw new Error('Missing companion identity key for self-directed runtime turn');
      }
      const resolvedUserName = input.companionDisplayName?.trim() || resolvePromptUserName(input.message);
      return {
        trustLevel: 'primary',
        speakerRole: 'system',
        resolvedUserName,
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
    const maybeChannelResolver = input.contactStore as ContactStore & {
      resolveChannelIdentity?: (channel: string, userId: string, displayName?: string) => Contact;
    };
    // If a trusted canonical contact ID hint is provided in the routing metadata (e.g. set
    // by the Garden admin chat), resolve directly by ID so the correct contact (with nickname
    // etc.) is used regardless of which API auth principal is making the request.
    const canonicalHint = input.message.routing?.canonicalContactId?.trim();
    const hintedContact = canonicalHint ? input.contactStore.getById(canonicalHint) : undefined;
    const contact = hintedContact
      ?? (typeof maybeChannelResolver.resolveChannelIdentity === 'function'
        ? maybeChannelResolver.resolveChannelIdentity(channel, input.message.authorId, input.message.authorName)
        : input.contactStore.resolveUserId(input.message.authorId));
    const maybeLastSeenUpdater = input.contactStore as ContactStore & {
      updateLastSeen?: (id: string) => void;
    };
    if (hintedContact && typeof maybeLastSeenUpdater.updateLastSeen === 'function') {
      // Still update last seen so the contact record stays fresh.
      maybeLastSeenUpdater.updateLastSeen(hintedContact.id);
    }
    const canonicalContactKey = contact.id;
    const explicitChannelPrivacy = normalizeChannelVisibility(input.message.routing?.channelPrivacy);
    const maybeChannelPrivacyReader = input.contactStore as ContactStore & {
      getConversationChannelPrivacy?: (
        contactId: string,
        channel: string,
        channelId: string,
      ) => ChannelVisibility | string | null | undefined;
    };
    const channelPrivacyLevel = explicitChannelPrivacy
      ?? normalizeChannelVisibility(
        typeof maybeChannelPrivacyReader.getConversationChannelPrivacy === 'function'
          ? maybeChannelPrivacyReader.getConversationChannelPrivacy(
            canonicalContactKey,
            channel,
            input.message.channelId,
          )
          : undefined,
      );

    const maybeActivityRecorder = input.contactStore as ContactStore & {
      recordChannelActivity?: (
        contactId: string,
        channel: string,
        channelId: string,
        privacyLevel?: ChannelVisibility,
      ) => void;
    };
    if (
      canonicalContactKey
      && typeof maybeActivityRecorder.recordChannelActivity === 'function'
    ) {
      maybeActivityRecorder.recordChannelActivity(
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
