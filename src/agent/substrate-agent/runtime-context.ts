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
import {
  formatActiveDateTimeIso,
  formatActiveDateTimeLabel,
} from '../../time/active-timezone.js';

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
  resolvedUserName: string;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  channelPrivacyLevel?: ChannelVisibility;
  continuityFallbackKeys: string[];
}

const SELF_IMAGE_TOOL_NAMES = ['image_create', 'image_edit'] as const;

function resolveMessageChannelMeta(message: Pick<SubstrateMessage, 'isDirectMessage' | 'routing'>): ChannelMeta | undefined {
  const privacyLevel = normalizeChannelVisibility(message.routing?.channelPrivacy);
  if (message.isDirectMessage === undefined && !privacyLevel) return undefined;
  return {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(privacyLevel ? { privacyLevel } : {}),
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
  const metacognitiveFlags = input.metacognitiveFlags ?? [];
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
  const subjectIdentityKey = input.subjectIdentityKey ?? input.message.authorId;
  const canonicalIdentityKey = input.canonicalContactKey ?? input.subjectIdentityKey ?? input.message.authorId;
  const extendedBreakdown = [
    extendedLoadedCount > 0 ? `${extendedLoadedCount} loaded` : null,
    autoloadCount > 0 ? `${autoloadCount} autoload` : null,
    deferredCount > 0 ? `${deferredCount} deferred` : null,
  ].filter(Boolean).join(' + ');

  const lines = [
    '[Runtime Context]',
    `Current time: ${formatActiveDateTimeLabel(now)}`,
    `Channel: ${input.message.channelId} (type: ${input.channelType ?? 'unknown'}, visibility: ${visibility})`,
    `Speaking with: ${input.resolvedUserName} (userId: ${subjectIdentityKey}, canonicalId: ${canonicalIdentityKey}, trust: ${input.trustLevel})`,
    `Model: ${input.modelId}`,
    `Response style preference: ${responseStyle}`,
    `Capability tier: ${input.capabilityTier}`,
    `Context window: ${input.contextWindow} tokens`,
    `Tools: ${activeCount} active`
    + ` (${coreCount} core`
    + (promotedCount > 0 ? ` + ${promotedCount} promoted` : '')
    + (extendedBreakdown ? ` + ${extendedBreakdown}` : '')
    + ')'
    + (extendedCount > 0 ? `, ${extendedCount} available via load_tools` : ''),
  ];

  const isScheduledTask = input.taskKind === 'heartbeat'
    || input.taskKind === 'reflection'
    || input.message.channelId.startsWith('internal:');
  const shouldIncludeAppearanceContext = isScheduledTask || hasActiveSelfImageTool();
  if (shouldIncludeAppearanceContext) {
    const appearance = resolveAppearanceContext();
    if (appearance.length > 0) lines.push(`Appearance context: ${appearance}`);
  }

  if (hasActiveSelfImageTool()) {
    lines.push('[Self-Image Tool Guidance]');
    lines.push('Use image_create for a brand new selfie, portrait, or scene featuring you.');
    lines.push('Use image_edit when modifying an existing image while keeping your identity consistent.');
    lines.push('Write the prompt as the full desired shot, then combine your Appearance context with pose, framing, lighting, background, mood, and style details.');
  }

  if (extendedCount > 0) {
    lines.push('');
    lines.push('Available extended tools:');
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
      lines.push(`- ${t.name}: ${t.description.split('.')[0]}${suffix}`);
    }
  }

  lines.push('');
  lines.push('[Response Style Guidance]');
  lines.push(responseStyleGuidance);

  if (input.internalState) {
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
      + ` active_concerns=${input.internalState.attention.activeConcerns.length}`,
    );
    const concernRefs = input.internalState.attention.activeConcerns
      .slice(0, 3)
      .map((concern) => `${concern.id}:${concern.priority}`);
    lines.push(`Active concern refs: ${concernRefs.length > 0 ? concernRefs.join(', ') : 'none'}`);
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
    lines.push('Use skill_view(name) to load full instructions only when needed.');
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
  const nickname = contact?.nickname?.trim();
  if (nickname) return nickname;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Contact from mocks may lack displayName
  const displayName = contact?.displayName?.trim();
  if (displayName) return displayName;

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
      const maybeLastSeenUpdater = input.contactStore as ContactStore & {
        updateLastSeen?: (id: string) => void;
      };
      maybeLastSeenUpdater.updateLastSeen?.(hintedContact.id);
    }
    const canonicalContactKey = contact.id;
    const explicitChannelPrivacy = normalizeChannelVisibility(input.message.routing?.channelPrivacy);
    const maybeChannelPrivacyReader = input.contactStore as ContactStore & {
      getConversationChannelPrivacy?: (contactId: string, channel: string, channelId: string) => ChannelVisibility | undefined;
    };
    const channelPrivacyLevel = explicitChannelPrivacy
      ?? (typeof maybeChannelPrivacyReader.getConversationChannelPrivacy === 'function'
        ? normalizeChannelVisibility(
          maybeChannelPrivacyReader.getConversationChannelPrivacy(
            canonicalContactKey,
            channel,
            input.message.channelId,
          ),
        )
        : undefined);

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
