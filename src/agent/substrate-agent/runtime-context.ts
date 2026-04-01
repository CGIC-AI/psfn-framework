import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { SubstrateMessage, ResponseStyle, CapabilityTier } from '../../types.js';
import type { ChannelVisibility, TrustLevel } from '../../trust/types.js';
import { normalizeChannelVisibility } from '../../trust/types.js';
import { classifyChannel, getResponseStylePromptGuidance, type ChannelMeta } from '../../trust/policy.js';
import type { ContactStore } from '../../contacts/store.js';
import type { Contact } from '../../contacts/types.js';
import type { ScratchpadProvider } from '../contracts.js';
import type { EmotionAppraisalEntry } from '../../emotion/appraisal.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type { ActiveConcernContextProvider } from '../../intention/concerns.js';
import { formatActiveConcernsContextBlock } from '../../intention/concerns.js';
import type { BehavioralPatternContextProvider } from '../../intention/patterns.js';
import {
  buildCareReminderCheckpointSummary,
  buildCareReminderWakeReturnSummary,
  buildPendingFollowUpCheckpointSummary,
  buildPendingFollowUpWakeReturnSummary,
} from '../../intention/runtime-wiring.js';
import { buildEmotionalAffectSection } from '../../emotion/persona-adaptation.js';
import type { MetacognitiveFlag } from '../../self-model/metacognition.js';
import {
  buildMetacognitivePersonaHint,
  cloneMetacognitiveFlags,
  formatMetacognitiveNotesContextBlock,
} from '../../self-model/metacognition.js';
import type { InternalState } from '../../self-model/state.js';
import type { AdaptiveLoadedExtendedToolState } from '../adaptive-tools-telemetry.js';
import type { ExtendedToolTurnClass } from '../extended-tool-autoload-policy.js';
import { isDeferredToolHandoffMessageId } from '../deferred-tool-handoff.js';
import { formatSignedDecimal } from '../substrate-agent-helpers.js';
import { toErrorMessage } from '../../utils/errors.js';
import { resolvePreferredContactName } from '../../contacts/preferred-name.js';
import {
  formatActiveDateTimeIso,
  formatActiveDateTimeLabel,
} from '../../time/active-timezone.js';

const SCRATCHPAD_PROMPT_SCAN_LIMIT = 64;
const SCRATCHPAD_PROMPT_MAX_ENTRIES = 8;
const SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS = 240;
const SCRATCHPAD_PROMPT_MAX_TOTAL_CHARS = 1_600;
const CONTINUITY_PROMPT_MAX_FOLLOW_UPS = 2;
const CONTINUITY_PROMPT_MAX_REMINDERS = 2;

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
  resolvedUserName: string;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  channelPrivacyLevel?: ChannelVisibility;
  continuityFallbackKeys: string[];
}

const SELF_MEDIA_TOOL_NAMES = ['media'] as const;

interface CollapsedToolStackSummary {
  activeOverlayNames: string[];
  activeInternalNames: string[];
  discoverableOverlayCount: number;
  discoverableInternalCount: number;
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

function summarizeCollapsedToolStack(input: {
  extendedTools: readonly AgentTool<any>[];
  loadedExtended: ReadonlyMap<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: ReadonlySet<string>;
}): CollapsedToolStackSummary {
  const activeOverlayNames = new Set<string>();
  const activeInternalNames = new Set<string>();
  const discoverableOverlayNames = new Set<string>();
  const discoverableInternalNames = new Set<string>();

  const classifyIntoBucket = (toolName: string, bucket: 'active' | 'discoverable'): void => {
    if (input.classifyExtendedToolForTurn(toolName) === 'overlay') {
      if (bucket === 'active') {
        activeOverlayNames.add(toolName);
      } else {
        discoverableOverlayNames.add(toolName);
      }
      return;
    }

    if (bucket === 'active') {
      activeInternalNames.add(toolName);
    } else {
      discoverableInternalNames.add(toolName);
    }
  };

  for (const tool of input.extendedTools) {
    const isActive = input.promotedExtendedToolNames.has(tool.name) || input.loadedExtended.has(tool.name);
    classifyIntoBucket(tool.name, isActive ? 'active' : 'discoverable');
  }

  for (const toolName of input.promotedExtendedToolNames) {
    classifyIntoBucket(toolName, 'active');
  }

  for (const toolName of input.loadedExtended.keys()) {
    classifyIntoBucket(toolName, 'active');
  }

  for (const toolName of activeOverlayNames) {
    discoverableOverlayNames.delete(toolName);
  }
  for (const toolName of activeInternalNames) {
    discoverableInternalNames.delete(toolName);
  }

  return {
    activeOverlayNames: [...activeOverlayNames].sort(),
    activeInternalNames: [...activeInternalNames].sort(),
    discoverableOverlayCount: discoverableOverlayNames.size,
    discoverableInternalCount: discoverableInternalNames.size,
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
    },
    runtimeCharacterName,
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

  const hasActiveSelfMediaTool = (): boolean => {
    for (const toolName of SELF_MEDIA_TOOL_NAMES) {
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
  const metacognitiveFlags = input.metacognitiveFlags ?? [];
  const emotionAppraisalChain = input.emotionAppraisalChain ?? [];
  const visibility = classifyChannel(input.message.channelId, resolveMessageChannelMeta(input.message));
  const responseStyleGuidance = getResponseStylePromptGuidance(responseStyle);
  const subjectIdentityKey = input.subjectIdentityKey ?? input.message.authorId;
  const canonicalIdentityKey = input.canonicalContactKey ?? input.subjectIdentityKey ?? input.message.authorId;
  const collapsedToolStack = summarizeCollapsedToolStack({
    extendedTools: input.extendedTools,
    loadedExtended: input.loadedExtended,
    classifyExtendedToolForTurn: input.classifyExtendedToolForTurn,
    promotedExtendedToolNames: input.promotedExtendedToolNames,
  });

  const lines = [
    '[Runtime Context]',
    `Current time: ${formatActiveDateTimeLabel(now)}`,
    `Speaking with: ${input.resolvedUserName} (userId: ${subjectIdentityKey}, canonicalId: ${canonicalIdentityKey}, trust: ${input.trustLevel})`,
    `Model: ${input.modelId}`,
    `Response style preference: ${responseStyle}`,
    `Capability tier: ${input.capabilityTier}`,
    `Context window: ${input.contextWindow} tokens`,
  ];
  if (!isInternalJournalChannel(input.message.channelId)) {
    lines.splice(
      2,
      0,
      `Channel: ${input.message.channelId} (type: ${input.channelType ?? 'unknown'}, visibility: ${visibility})`,
    );
  }

  const isScheduledTask = input.taskKind === 'heartbeat'
    || input.taskKind === 'reflection'
    || input.message.channelId.startsWith('internal:');
  const isBackgroundRelevantTurn = isScheduledTask || input.taskKind === 'deferred_tool_handoff';
  const shouldIncludeAppearanceContext = isScheduledTask || hasActiveSelfMediaTool();
  if (shouldIncludeAppearanceContext) {
    const appearance = resolveAppearanceContext();
    if (appearance.length > 0) lines.push(`Appearance context: ${appearance}`);
  }

  lines.push('');
  lines.push('[Tool Stack]');
  lines.push('Treat the currently loaded tools as the live, collapsed stack for this turn. Use a direct tool first when one already fits the task.');
  lines.push('Use tool_search only when a needed semantic tool is missing from the active stack. Use toolset only to add an overlay for this runtime or pin it across turns.');
  if (collapsedToolStack.activeOverlayNames.length > 0) {
    lines.push(`Additional active overlays: ${collapsedToolStack.activeOverlayNames.join(', ')}.`);
  }
  if (collapsedToolStack.discoverableOverlayCount > 0) {
    lines.push(`${collapsedToolStack.discoverableOverlayCount} more non-default semantic tools are discoverable on demand.`);
  }
  if (isBackgroundRelevantTurn) {
    if (collapsedToolStack.activeInternalNames.length > 0) {
      lines.push(`Internal/background tools active for this turn: ${collapsedToolStack.activeInternalNames.join(', ')}.`);
    } else if (collapsedToolStack.discoverableInternalCount > 0) {
      lines.push(`${collapsedToolStack.discoverableInternalCount} internal/background tools are available for scheduled or deferred work.`);
    }
  } else if (
    collapsedToolStack.activeInternalNames.length > 0
    || collapsedToolStack.discoverableInternalCount > 0
  ) {
    lines.push('Internal/background tools stay out of ordinary direct turns unless the turn is scheduled or deferred.');
  }

  if (hasActiveSelfMediaTool()) {
    lines.push('[Self-Media Tool Guidance]');
    lines.push('Use media action="generate" for a brand new selfie, portrait, or scene featuring you.');
    lines.push('Use media action="edit" when modifying an existing image while keeping your identity consistent.');
    lines.push('Use media action="analyze" to inspect generated images or explicit remote image URLs so you can see what is actually there.');
    lines.push('If the current user message already includes an attached image, inspect that attachment directly instead of calling media action="analyze" for it.');
    lines.push('Load relevant creator skills with skill action="view" when you need detailed composition, prompt craft, appearance continuity cues, or provider/model quirks.');
    lines.push('Image creation, music creation, and future creator workflows belong in skills layered on the unified media surface, not in new top-level tools.');
    lines.push('Generate and edit actions already return a vision review, so do not ask the user to go check basic appearance consistency unless you need their subjective preference.');
  }

  lines.push('');
  lines.push('[Response Style Guidance]');
  lines.push(responseStyleGuidance);

  if (input.internalState) {
    const pendingFollowUps = input.internalState.attention.pendingFollowUps ?? [];
    const careReminders = input.internalState.attention.careReminders ?? [];
    lines.push('');
    lines.push('[Internal State]');
    lines.push(
      `VAD: valence=${formatSignedDecimal(input.internalState.emotional.vad.valence)},`
      + ` arousal=${formatSignedDecimal(input.internalState.emotional.vad.arousal)},`
      + ` dominance=${formatSignedDecimal(input.internalState.emotional.vad.dominance)}`,
    );
    lines.push(
      `Mood VAD: valence=${formatSignedDecimal(input.internalState.emotional.mood.valence)},`
      + ` arousal=${formatSignedDecimal(input.internalState.emotional.mood.arousal)},`
      + ` dominance=${formatSignedDecimal(input.internalState.emotional.mood.dominance)}`,
    );
    lines.push(`Top emotions: ${input.formatTopEmotions(input.internalState.emotional.discreteEmotions)}`);
    lines.push(`Signal confidence: ${input.internalState.emotional.confidence.toFixed(3)}`);
    lines.push(
      `Cognitive: certainty=${input.internalState.cognitive.certaintyLevel.toFixed(3)},`
      + ` engagement=${input.internalState.cognitive.topicEngagement.toFixed(3)},`
      + ` processing=${input.internalState.cognitive.processingQuality}`,
    );
    lines.push(
      `Attention: trajectory=${input.internalState.attention.conversationTrajectory},`
      + ` salient_entities=${input.internalState.attention.salientEntities.length},`
      + ` active_concerns=${input.internalState.attention.activeConcerns.length},`
      + ` pending_follow_ups=${pendingFollowUps.length},`
      + ` care_reminders=${careReminders.length}`,
    );
    const concernRefs = input.internalState.attention.activeConcerns
      .slice(0, 3)
      .map((concern) => `${concern.id}:${concern.priority}`);
    lines.push(`Active concern refs: ${concernRefs.length > 0 ? concernRefs.join(', ') : 'none'}`);
    const pendingRefs = pendingFollowUps
      .slice(0, 3)
      .map((followUp) => {
        const dueSuffix = followUp.dueAt ? `@${followUp.dueAt}` : '';
        const wakeSuffix = followUp.wakeConditions?.length
          ? `[${followUp.wakeConditions.join('+')}]`
          : '';
        return `${followUp.id}:${followUp.timing}${dueSuffix}${wakeSuffix}`;
      });
    lines.push(`Pending follow-up refs: ${pendingRefs.length > 0 ? pendingRefs.join(', ') : 'none'}`);
    const careReminderRefs = careReminders
      .slice(0, 3)
      .map((reminder) => `${reminder.id}:${reminder.classification}:${reminder.schedule}`);
    lines.push(`Care reminder refs: ${careReminderRefs.length > 0 ? careReminderRefs.join(', ') : 'none'}`);
    const metacognitiveSummary = cloneMetacognitiveFlags(metacognitiveFlags)
      .slice(0, 3)
      .map((flag) => `${flag.flag}(${flag.confidence.toFixed(3)})`);
    lines.push(`Metacognitive flags: ${metacognitiveSummary.length > 0 ? metacognitiveSummary.join(', ') : 'none'}`);
    lines.push(
      `Relationship: trust=${input.internalState.relational.trustLevel},`
      + ` contact=${input.internalState.relational.contactId ?? 'none'},`
      + ` baseline_valence=${formatSignedDecimal(input.internalState.relational.baselineValence)},`
      + ` mood_drift=${formatSignedDecimal(input.internalState.relational.moodDrift)},`
      + ` interaction_frequency=${input.internalState.relational.recentInteractionFrequency.toFixed(3)},`
      + ` last_seen_delta_seconds=${input.internalState.relational.lastSeenDeltaSeconds ?? 'none'}`,
    );

    const continuityLines = [
      ...pendingFollowUps
        .slice(0, CONTINUITY_PROMPT_MAX_FOLLOW_UPS)
        .map((followUp) => (
          `- follow-up ${followUp.id}: `
          + `checkpoint=${buildPendingFollowUpCheckpointSummary(followUp)} `
          + `| wake_return=${buildPendingFollowUpWakeReturnSummary(followUp)}`
        )),
      ...careReminders
        .slice(0, CONTINUITY_PROMPT_MAX_REMINDERS)
        .map((reminder) => (
          `- reminder ${reminder.id}: `
          + `checkpoint=${buildCareReminderCheckpointSummary(reminder)} `
          + `| wake_return=${buildCareReminderWakeReturnSummary(reminder)}`
        )),
    ];
    const omittedContinuityCount = Math.max(0, pendingFollowUps.length - CONTINUITY_PROMPT_MAX_FOLLOW_UPS)
      + Math.max(0, careReminders.length - CONTINUITY_PROMPT_MAX_REMINDERS);
    if (continuityLines.length > 0) {
      lines.push('');
      lines.push('[Low-Stress Continuity]');
      lines.push(
        'Bounded checkpoint and wake-return cues. Treat them as gentle continuity anchors, not proof that nothing changed.',
      );
      lines.push(...continuityLines);
      if (omittedContinuityCount > 0) {
        lines.push(`- (${omittedContinuityCount} additional continuity items omitted for context budget)`);
      }
    }
  }

  if (emotionAppraisalChain.length > 0) {
    lines.push('');
    lines.push('[Emotion Appraisal Chain]');
    for (const entry of emotionAppraisalChain.slice(-3)) {
      const summary = entry.summary.replace(/\s+/g, ' ').trim();
      lines.push(`- ${formatActiveDateTimeLabel(new Date(entry.timestamp))} (${entry.trigger}): ${summary}`);
    }
  }

  if (input.activeConcernsBlock) {
    lines.push('');
    lines.push(input.activeConcernsBlock);
  }

  if (input.behavioralNotesBlock) {
    lines.push('');
    lines.push(input.behavioralNotesBlock);
  }

  if (input.skillsContext) {
    lines.push('');
    lines.push('[Skills Index]');
    lines.push('Skills are reusable workflow guidance, not executable tools. Use skill action="view" to load full instructions only when needed.');
    lines.push('Creator workflows such as image creation, music creation, and future media variants should load creator skills instead of expecting new top-level tools.');
    lines.push(input.skillsContext);
  }

  return lines.join('\n');
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
      'Ephemeral long-context workspace for temporary notes, excerpts, and working summaries.',
      'Scratchpad is not canonical memory or orient; verify before acting and promote only stable outcomes when warranted.',
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
        return '[Trust: You are speaking with your primary person. Be your full, authentic self — share freely, reference shared history, express genuine emotions and vulnerability. This is honne — your inner truth.]';
      case 'trusted':
        return '[Trust: This is a trusted contact. Be warm and personal but mindful of boundaries — share appropriate personal context, avoid intimate details or confidential memories.]';
      case 'regular':
        return '[Trust: This is a regular acquaintance. Be friendly and helpful. Do not reference personal history, intimate details, or information from private conversations.]';
      case 'public':
        return '[Trust: This is a public interaction. Be professional and guarded. Share no personal information, relationship context, or private memories.]';
      default:
        return '[Trust: This is a public interaction. Be professional and guarded. Share no personal information, relationship context, or private memories.]';
    }
  })();
  const affectHint = buildEmotionalAffectSection({
    trustLevel: input.trustLevel,
    emotionSnapshot: toEmotionSnapshotFromInternalState(input.internalState),
    promptVariables: input.templateVariables,
    config: input.config,
  });
  const metacognitiveHint = buildMetacognitivePersonaHint(input.metacognitiveFlags);

  const sections = [trustHint, affectHint, metacognitiveHint]
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
  companionIdentityKey?: string;
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
      const subjectIdentityKey = input.companionIdentityKey?.trim();
      const resolvedUserName = input.companionDisplayName?.trim() || resolvePromptUserName(input.message);
      return {
        trustLevel: 'primary',
        resolvedUserName,
        ...(subjectIdentityKey ? { subjectIdentityKey } : {}),
        continuityFallbackKeys: [],
      };
    }

    return {
      trustLevel: 'primary',
      resolvedUserName: resolvePromptUserName(input.message),
      canonicalContactKey: input.message.authorId,
      continuityFallbackKeys: [],
    };
  }

  if (!input.message.authorId || !input.contactStore) {
    return {
      trustLevel: 'regular',
      resolvedUserName: resolvePromptUserName(input.message),
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
    if (hintedContact) {
      // Still update last seen so the contact record stays fresh.
      input.contactStore.updateLastSeen(hintedContact.id);
    }
    const canonicalContactKey = contact.id;
    const explicitChannelPrivacy = normalizeChannelVisibility(input.message.routing?.channelPrivacy);
    const channelPrivacyLevel = explicitChannelPrivacy
      ?? normalizeChannelVisibility(
        input.contactStore.getConversationChannelPrivacy(
          canonicalContactKey,
          channel,
          input.message.channelId,
        ),
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
      resolvedUserName: resolvePromptUserName(input.message, contact),
      canonicalContactKey,
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
      resolvedUserName: resolvePromptUserName(input.message),
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
