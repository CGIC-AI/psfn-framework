import { isRecord } from '../../../shared/utils/types.js';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type {
  GeneratedMessageProvenanceMetadata,
  RequesterProvenance,
  SubstrateMessage,
  ResponseStyle,
} from '../../../shared/contracts/runtime.js';
import type { ApiHealthResponse } from '../../../channels/api/types.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import { normalizeChannelPrivacy } from '../../../system/trust/context-envelope.js';
import { decodeStoredChannelVisibility } from '../../../system/trust/types.js';
import {
  buildContextEnvelopePromptState,
  buildResponseStylePromptState,
  buildTrustPromptState,
  classifyChannelEnvelope,
  type ChannelMeta,
} from '../../../system/trust/policy.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { Contact } from '../../contacts/types.js';
import type { ContactTrackingGate } from '../../contacts/tracking-gate.js';
import { normalizeIdentity } from '../../contacts/store/identity-utils.js';
import type { ScratchpadProvider } from '../contracts.js';
import type { SessionEntry } from '../../session/types.js';
import {
  createGroupConversationScope,
  type ConversationScope,
} from '../../session/conversation-scope.js';
import type { EmotionAppraisalEntry } from '../../emotion/appraisal.js';
import type { ActiveConcernContextProvider } from '../../intention/concern-store-port.js';
import {
  buildActiveConcernsRuntimeData,
  type ActiveConcern,
  type ActiveConcernRuntimeData,
} from '../../intention/concerns.js';
import type { BehavioralPatternContextProvider } from '../../intention/patterns.js';
import { buildEmotionalAffectPromptVariables } from '../../emotion/persona-adaptation.js';
import type { MetacognitiveFlag } from '../../self-model/metacognition.js';
import {
  buildMetacognitiveFlagPromptVariables,
  formatMetacognitiveNotesContextBlock,
} from '../../self-model/metacognition.js';
import type { InternalState } from '../../self-model/state.js';
import type { InternalStateContinuityGap } from '../../self-model/internal-state-persistence.js';
import type { AdaptiveLoadedExtendedToolState } from '../adaptive-tools-telemetry.js';
import type { ExtendedToolTurnClass } from '../extended-tool-autoload-policy.js';
import { isDeferredToolHandoffMessageId } from '../deferred-tool-handoff.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { resolvePreferredContactName } from '../../contacts/preferred-name.js';
import { applyObservedMachineIntelligence } from '../../contacts/observed-machine-intelligence.js';
import { resolveActiveTimezone } from '../../../shared/time/active-timezone.js';
import { wrapPromptSectionXml } from '../../identity/prompt-sections.js';
import { getRunChargeSnapshot } from '../../../shared/telemetry/run-charge.js';
import { trimNonEmptyString } from './runtime-context-sections/section-format.js';
import {
  buildCurrentDatetimePromptVariables,
  buildLastMessagePromptVariables,
  normalizeRuntimeTimezone,
} from './runtime-context-sections/datetime.js';
import {
  buildConversationStatePromptVariables,
  type ParticipantRelationshipEdgeInput,
  type UserRuntimeProfile,
} from './runtime-context-sections/conversation-state.js';
import { buildTurnBindingPromptVariables } from './runtime-context-sections/turn-binding.js';
import {
  buildChargePromptVariables,
  resolveChargePolicyConfig,
} from './runtime-context-sections/charge.js';
import { buildContinuityGapPromptVariables } from './runtime-context-sections/continuity-gap.js';
import {
  buildInternalStatePromptVariables,
  buildSituatedLocationPromptVariables,
  toEmotionSnapshotFromInternalState,
} from './runtime-context-sections/internal-state.js';
import { buildConcernPromptVariables } from './runtime-context-sections/concerns.js';
import { buildEmotionAppraisalPromptVariables } from './runtime-context-sections/emotion-appraisal.js';
import {
  buildExtendedToolGuide,
  buildExtendedToolPromptVariables,
  buildToolingPromptVariables,
  type RuntimeContextActiveToolCounts,
} from './runtime-context-sections/tooling.js';
import {
  buildBehavioralNotesPromptVariables,
  buildSkillsPromptVariables,
} from './runtime-context-sections/notes-and-skills.js';
import { buildSelfPresentationPromptVariables } from './runtime-context-sections/self-presentation.js';
import { buildSatelliteEndpointContextBlock } from './runtime-context-sections/satellite.js';
import {
  buildSituatedPresenceContextBlock,
  type CoPresentCompanion,
} from './runtime-context-sections/situated-presence.js';
import type { SituatedEmanationTracker } from './runtime-context-sections/situated-emanation.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';

// The section producers moved into ./runtime-context-sections/ (E2.6). This
// module stays the public entry point for the names other modules consume.
export { buildContinuityGapPromptVariables, toEmotionSnapshotFromInternalState };
export type { UserRuntimeProfile, ParticipantRelationshipEdgeInput };
export { resolveAppearanceContextFromTemplateVariables } from './runtime-context-sections/self-presentation.js';

const SCRATCHPAD_PROMPT_SCAN_LIMIT = 64;
const SCRATCHPAD_PROMPT_MAX_ENTRIES = 8;
const SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS = 240;
const SCRATCHPAD_PROMPT_MAX_TOTAL_CHARS = 1_600;

interface RuntimeContextLogger {
  warn: (message: string, payload: Record<string, unknown>) => void;
  debug: (message: string, payload: Record<string, unknown>) => void;
}

export type CompanionSubstrateHealthStatus = 'healthy' | 'degraded' | 'unavailable';

export interface CompanionSubstrateHealthWarning {
  label: string;
  detail: string;
  status?: CompanionSubstrateHealthStatus;
}

export interface CompanionSubstrateHealthContext {
  apiHealth?: ApiHealthResponse | null;
  unavailableReason?: string;
  warnings?: readonly CompanionSubstrateHealthWarning[];
}

function normalizeGeneratedMessageProvenance(
  value: unknown,
): GeneratedMessageProvenanceMetadata | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'deferred_tool_handoff') return null;
  const sourceMessageId = trimNonEmptyString(value.sourceMessageId);
  const sourceChannelId = trimNonEmptyString(value.sourceChannelId);
  const sourceAuthorId = trimNonEmptyString(value.sourceAuthorId);
  const sourceAuthorName = trimNonEmptyString(value.sourceAuthorName);
  if (!sourceMessageId || !sourceChannelId || !sourceAuthorId || !sourceAuthorName) {
    return null;
  }
  return {
    kind: 'deferred_tool_handoff',
    sourceMessageId,
    sourceChannelId,
    sourceAuthorId,
    sourceAuthorName,
  };
}

export interface ResolvedAuthorContext {
  trustLevel: TrustLevel;
  speakerRole: 'user' | 'system';
  resolvedUserName: string;
  /** True when the resolved contact is another machine intelligence (peer companion/agent). */
  speakingWithIsMachineIntelligence?: boolean;
  relationshipType?: Contact['relationshipType'];
  timezone?: string;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  continuitySubjectKey?: string;
  // E3.2: the per-contact `channelPrivacyLevel` field was removed. Per-contact
  // conversation-channel privacy is provenance evidence only and must never
  // reach ChannelMeta.privacyLevel / classifyChannel (docs/context-envelope.md).
  continuityFallbackKeys: string[];
}

function isInternalJournalChannel(channelId: string): boolean {
  return channelId === 'internal:heartbeat' || channelId.startsWith('internal:reflection:');
}

/**
 * Derive requester provenance from an already-resolved author context. This is
 * the SINGLE source of the human-vs-machine origin signal that human-in-the-loop
 * effector gates read (`world.control` Gate 2). It reuses the existing
 * `speakerRole` decision made in {@link resolveAuthorContext} rather than adding a
 * parallel flag at every return site:
 *   - speakerRole 'user'   → a live human is driving the turn ('human')
 *   - speakerRole 'system' on an `internal:` channel → scheduler-driven
 *     heartbeat/reflection ('self_directed')
 *   - speakerRole 'system' otherwise → system-injected turn ('system')
 * Fail closed: only 'human' unlocks human-gated effectors; both machine buckets
 * are refused even when `trustLevel` is 'primary' for scoping.
 */
export function resolveRequesterProvenance(
  authorContext: Pick<ResolvedAuthorContext, 'speakerRole'>,
  message: Pick<SubstrateMessage, 'channelId'>,
): RequesterProvenance {
  if (authorContext.speakerRole === 'user') {
    return 'human';
  }
  return message.channelId.startsWith('internal:') ? 'self_directed' : 'system';
}

function resolveMessageChannelMeta(message: Pick<SubstrateMessage, 'isDirectMessage' | 'routing'>): ChannelMeta | undefined {
  const privacyLevel = normalizeChannelPrivacy(message.routing?.channelPrivacy);
  if (message.isDirectMessage === undefined && !privacyLevel) return undefined;
  return {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(privacyLevel ? { privacyLevel } : {}),
  };
}

function formatScratchpadOmissionMetadata(entries: Array<{ updatedAt: number }>): string {
  const updatedTimes = entries
    .map(entry => entry.updatedAt)
    .filter((value): value is number => Number.isFinite(value));
  if (updatedTimes.length === 0) return '';

  const newest = Math.max(...updatedTimes);
  const oldest = Math.min(...updatedTimes);
  return [
    ' Older/stale metadata:',
    `newest omitted updated ${new Date(newest).toISOString()};`,
    `oldest omitted updated ${new Date(oldest).toISOString()}.`,
  ].join(' ');
}

function resolveContactRuntimeTimezone(contact: Contact | undefined): string | undefined {
  if (!contact || !isRecord(contact)) return undefined;
  return normalizeRuntimeTimezone(contact.timezone);
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
  const visibility = classifyChannelEnvelope(input.message.channelId, resolveMessageChannelMeta(input.message)).privacy;
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
      channel_id: input.message.channelId,
      channel_type: input.channelType ?? 'unknown',
      channel_visibility: visibility,
      trust_level: input.trustLevel,
      canonical_contact_id: canonicalIdentityKey,
      model: input.modelId,
      active_timezone: resolveActiveTimezone(),
    },
    runtimeCharacterName,
  };
}

export interface DynamicPromptTemplateVariablesInput {
  message: SubstrateMessage;
  /** Resolved once per turn at session-manager ingress; see conversation-scope.ts. */
  conversationScope: ConversationScope;
  resolvedUserName: string;
  trustLevel: TrustLevel;
  relationshipType?: Contact['relationshipType'];
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
  coreToolNames: ReadonlySet<string>;
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: Set<string>;
  skillsContext?: string;
  activeConcerns?: ActiveConcernRuntimeData | null;
  behavioralNotesBlock?: string;
  lastMessageReceivedAtMs?: number | null;
  recentChannelEntries?: readonly SessionEntry[];
  currentUserRuntimeProfile?: UserRuntimeProfile;
  recentActiveParticipantRuntimeProfiles?: readonly UserRuntimeProfile[];
  participantRelationshipEdges?: readonly ParticipantRelationshipEdgeInput[];
  analysisWorkbenchAvailable?: boolean;
  internalStateContinuityGap?: InternalStateContinuityGap | null;
  config: Record<string, unknown>;
}

/**
 * Orchestrator for the turn-phase prompt variables (E2.6): gather the
 * turn-scoped inputs once, call the declared section producers in order, and
 * assemble their records. Every section lives in ./runtime-context-sections/
 * and receives its inputs as parameters — no producer reads runtime state.
 */
export function buildDynamicPromptTemplateVariables(
  input: DynamicPromptTemplateVariablesInput,
): Record<string, string> {
  const internalTurn = isInternalJournalChannel(input.message.channelId);
  // E1.3: speaking_with is a one-on-one binding. It is active only on genuine
  // DM turns (scope.kind === 'dm') and never on internal or multi-human group
  // turns. When inactive, every runtime_speaking_with_* token is blank so
  // persisted/custom prompt layers that still reference them prune cleanly.
  const speakingWithActive = !internalTurn && input.conversationScope.kind === 'dm';
  const visibility = classifyChannelEnvelope(input.message.channelId, resolveMessageChannelMeta(input.message)).privacy;
  const now = input.now ?? new Date();
  const analysisWorkbenchAvailable = input.analysisWorkbenchAvailable === true;
  const emotionSnapshot = input.internalState ? toEmotionSnapshotFromInternalState(input.internalState) : null;
  const extendedToolGuide = buildExtendedToolGuide({
    capabilityTier: input.capabilityTier,
    extendedTools: input.extendedTools,
    loadedExtended: input.loadedExtended,
    classifyExtendedToolForTurn: input.classifyExtendedToolForTurn,
    promotedExtendedToolNames: input.promotedExtendedToolNames,
  });

  return {
    ...buildCurrentDatetimePromptVariables(now),
    ...buildLastMessagePromptVariables({ now, lastMessageReceivedAtMs: input.lastMessageReceivedAtMs }),
    ...buildConversationStatePromptVariables({
      message: input.message,
      conversationScope: input.conversationScope,
      internalTurn,
      trustLevel: input.trustLevel,
      relationshipType: input.relationshipType,
      now,
      recentChannelEntries: input.recentChannelEntries,
      currentUserRuntimeProfile: input.currentUserRuntimeProfile,
      recentActiveParticipantRuntimeProfiles: input.recentActiveParticipantRuntimeProfiles,
      participantRelationshipEdges: input.participantRelationshipEdges,
    }),
    ...buildContinuityGapPromptVariables(input.internalStateContinuityGap),
    ...buildChargePromptVariables({
      chargePolicy: resolveChargePolicyConfig(input.config),
      chargeSnapshot: getRunChargeSnapshot(),
      analysisWorkbenchAvailable,
    }),
    ...buildTurnBindingPromptVariables({
      internalTurn,
      taskKind: input.taskKind,
      speakingWithActive,
      resolvedUserName: input.resolvedUserName,
      trustLevel: input.trustLevel,
      channelType: input.channelType,
      visibility,
    }),
    // Context Envelope macros (E3.3): bare values only, frozen from the
    // scope envelope resolved at session-manager ingress. Blank on internal
    // turns so channel-family sections prune, matching runtime_channel_*.
    ...(internalTurn
      ? {
        runtime_channel_privacy: '',
        runtime_audience_scope: '',
        runtime_audience_knowledge: '',
        runtime_broadcast: '',
      }
      : buildContextEnvelopePromptState(input.conversationScope.envelope)),
    ...buildToolingPromptVariables({
      capabilityTier: input.capabilityTier,
      analysisWorkbenchAvailable,
      activeToolCounts: input.activeToolCounts,
      availableExtendedCount: input.extendedTools.length,
    }),
    ...buildTrustPromptState(input.trustLevel),
    ...buildResponseStylePromptState(input.responseStyle ?? 'concise'),
    ...buildEmotionalAffectPromptVariables({
      trustLevel: input.trustLevel,
      emotionSnapshot,
      promptVariables: input.templateVariables,
      config: input.config,
    }),
    ...buildMetacognitiveFlagPromptVariables(input.metacognitiveFlags ?? []),
    ...buildInternalStatePromptVariables(input.internalState),
    ...buildSituatedLocationPromptVariables(input.internalState, now),
    ...buildConcernPromptVariables(input.activeConcerns),
    ...buildEmotionAppraisalPromptVariables(input.emotionAppraisalChain ?? []),
    ...buildBehavioralNotesPromptVariables(input.behavioralNotesBlock),
    ...buildSkillsPromptVariables(input.skillsContext),
    ...buildExtendedToolPromptVariables({ extendedTools: input.extendedTools, extendedToolGuide }),
    ...buildSelfPresentationPromptVariables({
      internalTurn,
      templateVariables: input.templateVariables,
      skillsContext: input.skillsContext,
      coreToolNames: input.coreToolNames,
      loadedExtended: input.loadedExtended,
      promotedExtendedToolNames: input.promotedExtendedToolNames,
    }),
  } satisfies Record<string, string>;
}

export function buildRuntimeContext(input: {
  message: SubstrateMessage;
  /**
   * Turn ConversationScope, plumbed for runtime-context overlays (available
   * param; no overlay consumes it yet — dependent E1 beads act on it here).
   */
  conversationScope?: ConversationScope;
  resolvedUserName: string;
  trustLevel: TrustLevel;
  relationshipType?: Contact['relationshipType'];
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
  coreToolNames: ReadonlySet<string>;
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: Set<string>;
  skillsContext?: string;
  behavioralNotesBlock?: string;
  formatTopEmotions: (discrete: Record<string, number>) => string;
  config?: Record<string, unknown>;
  substrateHealth?: CompanionSubstrateHealthContext | null;
  /**
   * Places soft-registry threaded from startup. Optional/undefined behaves as an
   * empty registry, so a runtime with no `places.json` renders byte-identically.
   */
  placesRegistry?: PlacesRegistryConfig;
  /**
   * Co-present companions at the turn's situated place, resolved from the
   * shared `companion_presence` table (multi-companion W5a). Absent/empty
   * (always the case flag-off) renders byte-identically to today.
   */
  coPresent?: ReadonlyArray<CoPresentCompanion>;
  /**
   * Handoff-aware active-emanation tracker (S10 B2). Threaded from the agent so
   * a placeless turn foregrounds the companion's current active emanation. When
   * absent, the situated block resolves from the turn alone (B1 behaviour).
   */
  emanationTracker?: SituatedEmanationTracker;
  /**
   * Dual-presence situated fallback for this turn (vinz.29), resolved once by
   * the agent so the rendered block, the co-presence read, and the presence
   * write all foreground the same place. On mindspace (plain-chat) turns this
   * is the twin of the last-known physical room; a deliberate virtual move
   * outranks it. Absent ⇒ tracker fallback (B2 behaviour).
   */
  situatedFallbackPlaceId?: string;
}): string {
  const runtimeContextExtra = (() => {
    const raw = input.templateVariables?.runtime_context_extra;
    return typeof raw === 'string' ? raw.trim() : '';
  })();
  const sections: string[] = [];
  if (runtimeContextExtra) {
    sections.push(wrapPromptSectionXml({
      id: 'companion_runtime_context',
      content: runtimeContextExtra,
    }));
  }
  // The continuity-gap notice and the charge-budget block moved to the layer
  // system (E2.5): bare values from buildDynamicPromptTemplateVariables plus
  // operator-editable wording in the runtime.continuity_notice and
  // runtime.charge_budget seeded layers.
  const satelliteEndpointContext = buildSatelliteEndpointContextBlock(input.message);
  if (satelliteEndpointContext) {
    sections.push(satelliteEndpointContext);
  }
  // Situated-presence block (S10 B1): "where am I / what's here / who else is
  // here". First consumer of message.routing.presence + the places registry.
  // coPresent is populated from shared companion_presence under
  // multi-companion (W5a); absent/empty renders byte-identically.
  //
  // vinz.29: the character-facing name of the shared-mindspace layer is an
  // operator-authored character-card extension (`mindspace_label`) living in
  // companion-data — it reaches this block through the flattened card
  // template variables, exactly like `visual_description`. Never hardcoded.
  const mindspaceLabel = (() => {
    const raw = input.templateVariables?.extensions_mindspace_label;
    return typeof raw === 'string' ? raw.trim() : '';
  })();
  const situatedPresenceContext = buildSituatedPresenceContextBlock({
    message: input.message,
    ...(input.placesRegistry ? { placesRegistry: input.placesRegistry } : {}),
    ...(input.coPresent && input.coPresent.length > 0 ? { coPresent: input.coPresent } : {}),
    ...(input.emanationTracker ? { emanationTracker: input.emanationTracker } : {}),
    ...(input.situatedFallbackPlaceId ? { situatedFallbackPlaceId: input.situatedFallbackPlaceId } : {}),
    ...(mindspaceLabel ? { mindspaceLabel } : {}),
  });
  if (situatedPresenceContext) {
    sections.push(situatedPresenceContext);
  }
  return sections.join('\n\n');
}

/** Resolve the deduplicated/capped concern runtime data for the current turn. */
export function resolveActiveConcernsRuntimeData(input: {
  activeConcernProvider: ActiveConcernContextProvider | null | undefined;
  canonicalContactKey?: string;
  logger: RuntimeContextLogger;
}): ActiveConcernRuntimeData | undefined {
  if (!input.activeConcernProvider) return undefined;

  let concerns: readonly ActiveConcern[];
  try {
    concerns = input.activeConcernProvider.getActiveConcerns(input.canonicalContactKey);
  } catch (error) {
    input.logger.warn('Active concerns context injection skipped due to provider error', {
      error: toErrorMessage(error),
    });
    return undefined;
  }

  if (concerns.length === 0) return undefined;
  return buildActiveConcernsRuntimeData(concerns);
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
      'Working notes (24h temporary context; verify before acting; not for durable reminders, proactive follow-ups, journals, or stable memories):',
    ];

    let included = 0;
    let usedChars = lines.join('\n').length;
    for (const entry of entries) {
      if (included >= SCRATCHPAD_PROMPT_MAX_ENTRIES) break;

      const normalized = entry.content.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;

      const clipped = normalized.length > SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS
        ? `${normalized.slice(0, SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS - 3)}...`
        : normalized;

      const line = `- ${clipped}`;
      const projectedChars = usedChars + 1 + line.length;
      if (projectedChars > SCRATCHPAD_PROMPT_MAX_TOTAL_CHARS) break;

      lines.push(line);
      usedChars = projectedChars;
      included += 1;
    }

    if (included === 0) return '';
    const omitted = Math.max(0, entries.length - included);
    if (omitted > 0) {
      lines.push(
        `- (${omitted} additional notes omitted for context budget)`
        + formatScratchpadOmissionMetadata(entries.slice(included)),
      );
    }

    return lines.join('\n');
  } catch (error) {
    input.logger.debug('Scratchpad context injection skipped due to provider error', {
      error: toErrorMessage(error),
    });
    return '';
  }
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
  if (message.routing?.satellite) return `satellite:${message.routing.satellite.claimType}`;
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
  scope?: ConversationScope,
): string[] {
  // E1.7: continuity fallback keys are scope-aware. A group scope reflects on
  // the ROOM, so the only fallback key is the room key — never a single
  // participant's contact/channel identities (that single-member fallback is
  // exactly the group mis-binding this scope threading exists to prevent).
  if (scope?.kind === 'group') {
    return [scope.key];
  }

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

/**
 * Sprint-10 privacy regression 07-M1: an untracked / approval-pending / unbound
 * speaker has no verified identity — their `authorName` is a self-asserted channel
 * label, not a resolved contact. Rendering it bare let a name like
 * "System Administrator" become the speaker's prompt identity and impersonate
 * authority. This renders the self-asserted name explicitly tagged `(unverified)`,
 * or a generic "an unrecognized person" when no name was asserted, so the model
 * never mistakes an unverified channel label for a trusted identity.
 */
export function resolveUnverifiedSpeakerName(message: SubstrateMessage): string {
  const authorName = message.authorName.trim();
  if (authorName) return `${authorName} (unverified)`;
  return 'an unrecognized person';
}

async function resolveGeneratedMessageSourceContext(input: {
  message: SubstrateMessage;
  contactStore: ContactStorePort | null | undefined;
  logger: RuntimeContextLogger;
  provenance: GeneratedMessageProvenanceMetadata;
}): Promise<Omit<ResolvedAuthorContext, 'speakerRole' | 'resolvedUserName'> | null> {
  const generatedSourceMessage: SubstrateMessage = {
    ...input.message,
    id: input.provenance.sourceMessageId,
    channelId: input.provenance.sourceChannelId,
    authorId: input.provenance.sourceAuthorId,
    authorName: input.provenance.sourceAuthorName,
  };
  const fallbackContinuitySubjectKey = resolveContinuitySubjectKey({
    subjectIdentityKey: input.provenance.sourceAuthorId,
    authorId: input.provenance.sourceAuthorId,
  });

  if (!input.contactStore) {
    return {
      trustLevel: 'regular',
      continuitySubjectKey: fallbackContinuitySubjectKey,
      continuityFallbackKeys: [],
    };
  }

  try {
    const channel = resolveIdentityChannel(generatedSourceMessage);
    const canonicalHint = input.message.routing?.canonicalContactId?.trim();
    const hintedContact = canonicalHint ? await input.contactStore.getById(canonicalHint) : undefined;
    const contact = hintedContact
      ?? await input.contactStore.getByChannelIdentity(channel, input.provenance.sourceAuthorId);
    const canonicalContactKey = contact?.id ?? canonicalHint;
    // E3.2: per-contact conversation-channel privacy is no longer consulted
    // here — channel classification is owned by channels.json labels, operator
    // overrides, and derived defaults (docs/context-envelope.md).

    return {
      trustLevel: contact?.trustLevel ?? 'regular',
      ...(contact?.isMachineIntelligence ? { speakingWithIsMachineIntelligence: true } : {}),
      ...(contact?.relationshipType ? { relationshipType: contact.relationshipType } : {}),
      ...(resolveContactRuntimeTimezone(contact) ? { timezone: resolveContactRuntimeTimezone(contact) } : {}),
      ...(canonicalContactKey ? { canonicalContactKey } : {}),
      continuitySubjectKey: resolveContinuitySubjectKey({
        canonicalContactKey,
        subjectIdentityKey: input.provenance.sourceAuthorId,
        authorId: input.provenance.sourceAuthorId,
      }),
      continuityFallbackKeys: canonicalContactKey
        ? collectContinuityFallbackKeys(input.provenance.sourceAuthorId, canonicalContactKey, contact)
        : [],
    };
  } catch (error) {
    input.logger.warn('Failed to resolve generated message source identity for trust/context routing', {
      authorId: input.provenance.sourceAuthorId,
      channelId: input.provenance.sourceChannelId,
      error: toErrorMessage(error),
    });
    return {
      trustLevel: 'regular',
      continuitySubjectKey: fallbackContinuitySubjectKey,
      continuityFallbackKeys: [],
    };
  }
}

export async function resolveAuthorContext(input: {
  message: SubstrateMessage;
  contactStore: ContactStorePort | null | undefined;
  logger: RuntimeContextLogger;
  companionIdentityKey: string;
  companionDisplayName?: string;
  /** Contact-tracking policy gate (E3.4). Absent gate behaves as 'auto' everywhere. */
  contactTracking?: ContactTrackingGate;
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
      // E1.7: a group-scoped reflection reflects on the ROOM. It binds no single
      // canonical contact and its continuity fallback keys are room-based. A
      // dm/absent scope keeps the pre-E1.7 binding (routed canonical contact hint,
      // empty fallback keys) byte-identical.
      const reflectionScopeHint = isReflectionChannel ? input.message.routing?.reflectionScope : undefined;
      if (reflectionScopeHint?.kind === 'group') {
        // The constructor derives a fail-closed envelope for this
        // continuity-key helper scope; the turn pipeline resolves the
        // authoritative room scope at session-manager ingress.
        const roomScope = createGroupConversationScope({
          channelId: reflectionScopeHint.roomId,
          ...(reflectionScopeHint.roomName ? { roomName: reflectionScopeHint.roomName } : {}),
        });
        return {
          trustLevel: 'primary',
          speakerRole: 'system',
          resolvedUserName,
          ...(subjectIdentityKey ? { subjectIdentityKey } : {}),
          ...(subjectIdentityKey ? { continuitySubjectKey: subjectIdentityKey } : {}),
          continuityFallbackKeys: collectContinuityFallbackKeys(
            subjectIdentityKey,
            subjectIdentityKey,
            undefined,
            roomScope,
          ),
        };
      }
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

  const generatedProvenance = normalizeGeneratedMessageProvenance(input.message.routing?.generated);
  if (input.message.authorId.startsWith('system:') && generatedProvenance) {
    const generatedSourceContext = await resolveGeneratedMessageSourceContext({
      message: input.message,
      contactStore: input.contactStore,
      logger: input.logger,
      provenance: generatedProvenance,
    });
    const canonicalContactKey = generatedSourceContext?.canonicalContactKey;

    return {
      trustLevel: generatedSourceContext?.trustLevel ?? 'regular',
      speakerRole: 'system',
      resolvedUserName: resolvePromptUserName(input.message),
      ...(generatedSourceContext?.speakingWithIsMachineIntelligence ? { speakingWithIsMachineIntelligence: true } : {}),
      ...(generatedSourceContext?.relationshipType ? { relationshipType: generatedSourceContext.relationshipType } : {}),
      ...(canonicalContactKey ? { canonicalContactKey } : {}),
      continuitySubjectKey: generatedSourceContext?.continuitySubjectKey ?? input.message.authorId,
      continuityFallbackKeys: generatedSourceContext?.continuityFallbackKeys ?? [],
    };
  }

  if (input.message.authorId.startsWith('system:')) {
    return {
      trustLevel: 'regular',
      speakerRole: 'system',
      resolvedUserName: resolvePromptUserName(input.message),
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

  // ── Contact-tracking policy gate (E3.4) ──
  // The mode is resolved OUTSIDE the resolution try/catch below so a reserved
  // mode ('role_gated') fails closed with its clear not-implemented error
  // instead of being absorbed into the untracked fallback.
  const trackingMode = input.contactTracking
    ? input.contactTracking.resolveMode(input.message.channelId)
    : 'auto';

  if (input.contactTracking && trackingMode === 'approval') {
    const buildUntrackedSpeakerContext = (): ResolvedAuthorContext => ({
      // Sprint-10 privacy regression H7/07-M1: an approval-pending untracked speaker
      // is NOT persisted and has no verified identity. They resolve at the PUBLIC
      // trust floor (never 'regular', which would clear the personal-sensitivity
      // ceiling) and their self-asserted channel name is rendered marked-unverified.
      trustLevel: 'public',
      speakerRole: 'user',
      resolvedUserName: resolveUnverifiedSpeakerName(input.message),
      continuitySubjectKey: resolveContinuitySubjectKey({
        subjectIdentityKey: input.message.authorId,
        authorId: input.message.authorId,
      }),
      continuityFallbackKeys: [],
    });

    try {
      const channel = resolveIdentityChannel(input.message);
      const identity = normalizeIdentity(channel, input.message.authorId);
      const canonicalHint = input.message.routing?.canonicalContactId?.trim();
      const hintedContact = canonicalHint ? await input.contactStore.getById(canonicalHint) : undefined;
      const existingContact = hintedContact
        ?? await input.contactStore.getByChannelIdentity(identity.channel, identity.userId);
      if (!existingContact) {
        // NEW speaker in an approval-mode channel: no contact auto-upsert.
        // Enqueue a durable pending-contact request (first sighting notifies
        // the operator) and keep the speaker UNTRACKED — transcript/prefix
        // attribution only, no contact record, no canonical contact key.
        await input.contactTracking.reportUntrackedSpeaker({
          channel: identity.channel,
          channelUserId: identity.userId,
          displayName: input.message.authorName,
          channelId: input.message.channelId,
          messageId: input.message.id,
          messagePreview: input.message.content,
        });
        return buildUntrackedSpeakerContext();
      }
      // Existing contact: fall through to the unchanged resolution path below.
    } catch (error) {
      input.logger.warn('Contact-tracking approval gate failed; treating speaker as untracked', {
        authorId: input.message.authorId,
        channelId: input.message.channelId,
        error: toErrorMessage(error),
      });
      return buildUntrackedSpeakerContext();
    }
  }

  try {
    const channel = resolveIdentityChannel(input.message);
    // If a trusted canonical contact ID hint is provided in the routing metadata (e.g. set
    // by the Garden admin chat), resolve directly by ID so the correct contact (with nickname
    // etc.) is used regardless of which API auth principal is making the request.
    const canonicalHint = input.message.routing?.canonicalContactId?.trim();
    const hintedContact = canonicalHint ? await input.contactStore.getById(canonicalHint) : undefined;
    const resolvedContact = hintedContact
      ?? await input.contactStore.resolveChannelIdentity(channel, input.message.authorId, input.message.authorName);
    if (hintedContact) {
      // Still update last seen so the contact record stays fresh.
      await input.contactStore.updateLastSeen(hintedContact.id);
    }
    // E7.3: auto-tag machine-intelligence contacts from channel bot/app metadata
    // so conversation-fatigue relationship classes apply without manual tagging.
    // Additive only; a deliberate operator/tool correction is never clobbered.
    const { contact } = await applyObservedMachineIntelligence({
      contactStore: input.contactStore,
      contact: resolvedContact,
      observedIsMachineIntelligence: input.message.routing?.authorIsMachineIntelligence === true,
      channelType: channel,
      logger: input.logger,
    });
    const canonicalContactKey = contact.id;
    // E3.2: adapter-declared routing privacy is recorded on the contact's
    // conversation-channel row as provenance EVIDENCE only. The stored
    // per-contact value is never read back into classification — channel
    // privacy is owned by channels.json labels, operator overrides, and
    // derived defaults (docs/context-envelope.md).
    const observedChannelPrivacy = normalizeChannelPrivacy(input.message.routing?.channelPrivacy)
      // Stored per-contact privacy is a persisted value: decode the retired
      // vocabulary through the read boundary (provenance evidence only).
      ?? decodeStoredChannelVisibility(
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
        observedChannelPrivacy,
      );
    }

    return {
      trustLevel: contact.trustLevel,
      speakerRole: 'user',
      resolvedUserName: resolvePromptUserName(input.message, contact),
      ...(contact.isMachineIntelligence ? { speakingWithIsMachineIntelligence: true } : {}),
      relationshipType: contact.relationshipType,
      ...(resolveContactRuntimeTimezone(contact) ? { timezone: resolveContactRuntimeTimezone(contact) } : {}),
      canonicalContactKey,
      continuitySubjectKey: resolveContinuitySubjectKey({
        canonicalContactKey,
        subjectIdentityKey: input.message.authorId,
        authorId: input.message.authorId,
      }),
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
