import type { LLMProviderPort } from '../../agent/contracts.js';
import type { IntakeSinkGate } from '../../cogsec/intake/sink-gates.js';
import { applyPromptAssemblySinkGate } from '../intake-sink-gating.js';
import { countMessageTokens, countTokens } from '../../../primitives/llm/tokens.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { ContextMessage, LLMContext } from '../../../shared/contracts/runtime.js';
import {
  buildAuthenticityProvenance,
  DERIVED_DETAIL_LOSS_NOTE,
  DERIVED_EMOTIONAL_TEXTURE_NOTE,
} from '../../../shared/authenticity-provenance.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  resolveAdaptiveContextBudgetProfile,
  resolveMemoryRetrievalBudget,
  resolveSessionHistoryBudget,
  type ContextBudgetTurnCharacteristics,
} from '../../../shared/context-budget.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { PromptRegistryStatePort } from '../../identity/prompt-state-port.js';
import { wrapCompactionSummaryAsUntrustedContext } from '../../identity/prompt-composer.js';
import { renderSystemLanguageTemplate } from '../../identity/system-language.js';
import {
  orderPromptRuntimeSystemPromptSections,
  type PromptRuntimeSystemPromptBlockId,
} from '../../identity/prompt-runtime.js';
import { resolveCachedPromptRuntimeLayoutStore } from '../../identity/prompt-runtime-store-cache.js';
import type { TurnSessionContextSnapshot } from '../../turns/snapshot.js';
import {
  buildSnapshotVersionPointer,
  cloneSessionContinuityArtifact,
  cloneSessionEntry,
} from '../../turns/snapshot.js';
import type { SessionEntry } from '../types.js';
import type { SessionContinuityArtifact } from '../continuity-artifacts.js';
import { resolveSessionEntryTurnContext } from '../turn-provenance.js';
import {
  classifyChannelDisclosure,
  type ChannelMeta,
} from '../../../system/trust/policy.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { CrossChannelContinuityPort } from '../cross-channel-continuity-port.js';
import type {
  ContextManifest,
  ContextManifestMemorySeed,
} from '../context-manifest.js';
import {
  roomContentWindowFloorMs,
  type RoomContentWindow,
} from '../room-content-window.js';
import {
  collectRecentEntriesWithinHistorySpan,
  DEFAULT_CONTINUITY_CONTEXT_LIMIT,
  applyTemporalSessionHistoryWindow,
  resolveMaxHistorySpanMs,
} from '../manager-primitives.js';
import {
  isBondedForeignEntry,
  resolveBondedSessionTimeline,
  sortBondedTimelineEntries,
  type TurnChannelBondInput,
} from '../channel-bond.js';
import type { PreCompactionExtractionHandler } from './contracts.js';
import {
  countIntentionAppraisalArtifacts,
  entriesToMessages,
} from './context-support.js';
import { runAutoCompaction, shouldCompact } from './compaction-service.js';
import { MASKED_TOOL_OBSERVATION_CONTENT } from '../tool-observation.js';
import { applyFocusCompactionRanges, type FocusCompactionRange } from '../focus-knowledge.js';
import { buildPromptSectionTelemetryList } from '../../identity/prompt-sections.js';
import type { CogSecEvent } from '../../cogsec/events.js';
import {
  buildCogSecEventNoticeBlock,
  listAgentVisibleCogSecEvents,
} from '../../cogsec/safe-log.js';
import {
  assembleSessionHistoryForContextWithLlmSummary,
  buildSessionHistoryMessages,
} from './context-history-assembly.js';
import { buildContinuityMetadataBlock } from './continuity-metadata-block.js';
import { createRolledOutSessionBoundary } from '../rolled-out-session-boundary.js';
import {
  buildActiveTemporalFrame,
  type ActiveTemporalFrameConfig,
} from '../active-temporal-frame.js';

export { assembleSessionHistoryForContextWithLlmSummary } from './context-history-assembly.js';

const log = createComponentLogger('ContextBuilder');
const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';
// Keep the persisted channel id so existing reflection-session continuity is
// not split by a source-code terminology cleanup.
const REFLECTION_TURN_CHANNEL = 'internal:heartbeat';

export function isReflectionTurnChannel(channelId: string): boolean {
  return channelId === REFLECTION_TURN_CHANNEL;
}

export function isInternalReflectionChannel(channelId: string): boolean {
  return channelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX);
}

function shouldIncludeContinuityEntryForChannel(targetChannelId: string, sourceChannelId: string): boolean {
  if (isReflectionTurnChannel(sourceChannelId)) {
    return false;
  }
  if (isInternalReflectionChannel(sourceChannelId)) {
    return isInternalReflectionChannel(targetChannelId);
  }
  return true;
}

export function filterContinuityEntriesForChannel(
  targetChannelId: string,
  entries: readonly SessionEntry[],
): SessionEntry[] {
  return entries.filter(entry => shouldIncludeContinuityEntryForChannel(
    targetChannelId,
    entry.originChannelId ?? entry.channelId,
  ));
}

function shouldRenderSessionHistoryUserAttribution(
  channelVisibility: ChannelPrivacy,
  channelMeta?: ChannelMeta,
): boolean {
  if (channelMeta?.isDirectMessage === true) return false;
  if (channelMeta?.isDirectMessage === false) return true;
  return channelVisibility === 'public';
}

export interface CaptureTurnSessionContextParams {
  /** Resolved session channel id. */
  channelId: string;
  sourceChannelId: string;
  userId?: string;
  channelMeta?: ChannelMeta;
  continuityFallbackUserIds?: string[];
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
  config: SubstrateConfig;
  /** Compaction-boundary-scoped store: recent entries + compaction summaries. */
  store: SessionStore;
  crossChannelContinuity: CrossChannelContinuityPort;
  focusCompactionRanges: FocusCompactionRange[];
  focusKnowledgeTexts: string[];
  wakeReturnArtifacts: SessionContinuityArtifact[];
  compactionPromptText: string;
  characterName?: string;
  /** Optional LLM provider for foreground history-budget summarization. */
  llmProvider?: LLMProviderPort;
  promptRegistry: PromptRegistryStatePort | null;
  /** Exact just-recorded turn entry to remove before merging or summarizing. */
  excludeSessionEntryId?: number;
  /**
   * Channel bonding opt-in for the turn, resolved from
   * the author's contact record. Absent = no bond, byte-identical behavior.
   */
  channelBond?: TurnChannelBondInput;
  /**
   * Presence-windowed room content gate (bead s10rm). Absent or
   * `unwindowed` keeps every surface byte-identical; `windowed`/`closed`
   * restricts EVERY served room surface (history entries, compaction
   * summaries, wake-return artifacts, room-origin continuity) to the
   * recipient's current presence window.
   */
  roomContentWindow?: RoomContentWindow;
  /** Latest-only temporal frame derived for an actual active model turn. */
  activeTemporalFrame?: ActiveTemporalFrameConfig;
}

/**
 * The single session-context derivation for a turn (E2.2).
 *
 * This is the ONE place session history, continuity, focus knowledge, and
 * compaction summaries are derived for a context build. The turn pipeline
 * captures once (pre-turn, feeding the retrieval
 * query and the persisted PromptPlan turn snapshot) and buildSessionContext
 * consumes the captured snapshot; direct callers capture through
 * SessionManager.buildContext, which performs this capture inline. The former
 * session-manager snapshot builder and the builder's live re-derivation
 * branches were both deleted with the PromptPlan consolidation.
 */
export async function captureTurnSessionContext(
  params: CaptureTurnSessionContextParams,
): Promise<TurnSessionContextSnapshot> {
  const adaptiveProfile = resolveAdaptiveContextBudgetProfile(
    params.config,
    params.turnBudgetCharacteristics,
  );
  const historyBudget = resolveSessionHistoryBudget(params.config, {
    ...(params.turnBudgetCharacteristics ? { turn: params.turnBudgetCharacteristics } : {}),
    adaptiveProfile,
  });
  const maxHistorySpanMs = resolveMaxHistorySpanMs(params.config);
  const collected = collectRecentEntriesWithinHistorySpan({
    store: params.store,
    channelId: params.channelId,
    estimatedCount: historyBudget.estimatedCount,
    maxHistorySpanMs,
  });
  // Presence-window gate (bead s10rm): on a windowed private room,
  // nothing recorded before the recipient's current join (`since`) may be
  // served — including a companion's OWN earlier windows (a rejoin opens a
  // NEW window; earlier windows live on in extracted memory, not here).
  const roomWindow = params.roomContentWindow ?? { kind: 'unwindowed' as const };
  const roomWindowGated = roomWindow.kind !== 'unwindowed';
  const roomWindowFloor = roomContentWindowFloorMs(roomWindow);
  const rolledOutSessionBoundary = !roomWindowGated && collected.rolledOutBeforeMs !== undefined
    ? createRolledOutSessionBoundary(params.channelId, collected.rolledOutBeforeMs)
    : undefined;
  const presenceWindowEntries = roomWindowGated
    ? collected.entries.filter(entry => entry.timestamp >= roomWindowFloor)
    : collected.entries;
  const roomWindowFilteredEntryCount = collected.entries.length - presenceWindowEntries.length;
  const excludedSessionEntryCount = params.excludeSessionEntryId === undefined
    ? 0
    : presenceWindowEntries.filter(entry => entry.id === params.excludeSessionEntryId).length;
  const windowedEntries = params.excludeSessionEntryId === undefined
    ? presenceWindowEntries
    : presenceWindowEntries.filter(entry => entry.id !== params.excludeSessionEntryId);
  // Focus knowledge/ranges carry no timestamps we can gate on, so on a
  // windowed channel they are dropped wholesale (fail closed) rather than
  // risking pre-join derived content in the room context.
  const effectiveFocusCompactionRanges = roomWindowGated ? [] : params.focusCompactionRanges;
  const effectiveFocusKnowledgeTexts = roomWindowGated ? [] : params.focusKnowledgeTexts;
  const effectiveWakeReturnArtifacts = roomWindowGated
    ? params.wakeReturnArtifacts.filter(
      artifact => Date.parse(artifact.createdAt) >= roomWindowFloor,
    )
    : params.wakeReturnArtifacts;
  let recent = applyTemporalSessionHistoryWindow(
    windowedEntries,
    params.turnBudgetCharacteristics,
  );
  const focusCompaction = applyFocusCompactionRanges(recent, effectiveFocusCompactionRanges);
  recent = focusCompaction.entries;
  const intentionAppraisalArtifactCount = countIntentionAppraisalArtifacts(recent);
  recent = applyObservationMasking(
    recent,
    params.config.observationMaskingWindow ?? DEFAULT_OBSERVATION_MASKING_WINDOW,
  ).entries;
  // Channel bonding: interleave bonded member channels'
  // conversational entries into the timeline AFTER the own-channel gates
  // (exclusion, focus compaction, masking) so those id-keyed transforms only
  // ever see own-channel entries. Presence-windowed rooms never bond (the
  // bond is a 1:1 continuity surface; a windowed room gate must not be
  // widened by foreign timelines). A null resolution changes nothing.
  const bondedTimeline = params.channelBond && !roomWindowGated
    ? resolveBondedSessionTimeline({
      bond: params.channelBond,
      continuityUserId: params.userId,
      channelId: params.channelId,
      sourceChannelId: params.sourceChannelId,
      channelMeta: params.channelMeta,
      ownEntries: recent,
      crossChannelContinuity: params.crossChannelContinuity,
      store: params.store,
      maxHistorySpanMs,
    })
    : null;
  if (bondedTimeline) {
    recent = bondedTimeline.entries;
  }
  const channelVisibility = classifyChannelDisclosure(params.sourceChannelId, params.channelMeta).channelPrivacy;
  const assembledHistory = await assembleSessionHistoryForContextWithLlmSummary({
    entries: recent,
    channelVisibility,
    renderGroupUserAttribution: shouldRenderSessionHistoryUserAttribution(
      channelVisibility,
      params.channelMeta,
    ),
    tokenBudget: historyBudget.tokenBudget,
    characterName: params.characterName,
    channelId: params.channelId,
    llmProvider: params.llmProvider,
    promptRegistry: params.promptRegistry,
  });
  recent = assembledHistory.verbatimEntries;

  const rawContinuityEntries = params.userId
    ? params.crossChannelContinuity.getMerged({
      canonicalUserId: params.userId,
      limit: params.config.continuityMessageLimit ?? DEFAULT_CONTINUITY_CONTEXT_LIMIT,
      fallbackUserIds: params.continuityFallbackUserIds ?? [],
      channelId: params.sourceChannelId,
      channelMeta: params.channelMeta,
    })
    : [];
  // Continuity that ORIGINATED in this room must obey the same window: a
  // mirrored pre-join room entry re-entering the room context would defeat the
  // gate. Continuity from other channels is not room history and passes.
  const continuityEntries = roomWindowGated
    ? rawContinuityEntries.filter(entry => (
      (entry.originChannelId ?? entry.channelId) !== params.channelId
      || entry.timestamp >= roomWindowFloor
    ))
    : rawContinuityEntries;
  // A compaction summary minted in an earlier presence window summarizes
  // content from that window; gate on its creation time.
  const compactionSummaryTexts = params.store
    .getCompactionSummaries(params.channelId)
    .filter(summary => !roomWindowGated || summary.createdAt >= roomWindowFloor)
    .map(summary => summary.summary);
  const orientation = params.activeTemporalFrame
    ? buildActiveTemporalFrame({
      ...params.activeTemporalFrame,
      channelId: params.channelId,
      sourceChannelId: params.sourceChannelId,
      channelMeta: params.channelMeta,
      recentEntries: presenceWindowEntries,
      ...(params.excludeSessionEntryId !== undefined
        ? { currentTurnEntryId: params.excludeSessionEntryId }
        : {}),
    })
    : undefined;
  return {
    channelId: params.channelId,
    recentEntries: recent.map(cloneSessionEntry),
    sourceEntryCount: Math.max(0, collected.sourceCount - excludedSessionEntryCount),
    ...(rolledOutSessionBoundary
      ? { rolledOutSessionBoundary }
      : {}),
    ...(collected.storeWindowMaxEntryId !== undefined
      ? { storeWindowMaxEntryId: collected.storeWindowMaxEntryId }
      : {}),
    ...(roomWindowGated
      ? {
        roomWindowFloorMs: roomWindowFloor,
        roomWindowFilteredEntryCount,
      }
      : {}),
    ...(assembledHistory.summaryText
      ? { historySummaryText: assembledHistory.summaryText }
      : {}),
    ...(assembledHistory.summarizedEntryCount > 0
      ? { historySummaryEntryCount: assembledHistory.summarizedEntryCount }
      : {}),
    ...(bondedTimeline
      ? {
        bondedEntryCount: bondedTimeline.bondedEntryCount,
        bondedMemberChannelIds: [...bondedTimeline.memberChannelIds],
        bondedEffectivePrivacy: bondedTimeline.effectivePrivacy,
      }
      : {}),
    compactionSummaryTexts: [...compactionSummaryTexts],
    focusKnowledgeTexts: [...effectiveFocusKnowledgeTexts],
    continuityEntries: continuityEntries.map(cloneSessionEntry),
    wakeReturnArtifacts: effectiveWakeReturnArtifacts.map(cloneSessionContinuityArtifact),
    ...(orientation ? { orientation } : {}),
    intentionAppraisalArtifactCount,
    compactionPromptText: params.compactionPromptText,
    versionPointer: buildSnapshotVersionPointer([
      params.channelId,
      rolledOutSessionBoundary?.sessionId,
      rolledOutSessionBoundary?.beforeMs,
      roomWindowGated ? `roomWindow:${roomWindowFloor}` : undefined,
      bondedTimeline
        ? `bond:${bondedTimeline.effectivePrivacy}:${bondedTimeline.memberChannelIds.join(',')}:${bondedTimeline.bondedEntryCount}`
        : undefined,
      recent.at(-1)?.id,
      recent.at(-1)?.timestamp,
      assembledHistory.summaryText,
      assembledHistory.summarizedEntryCount,
      compactionSummaryTexts.join('\n'),
      effectiveFocusKnowledgeTexts.join('\n'),
      focusCompaction.compactedCount,
      continuityEntries.at(-1)?.id,
      continuityEntries.at(-1)?.timestamp,
      effectiveWakeReturnArtifacts.at(0)?.id,
      effectiveWakeReturnArtifacts.at(0)?.createdAt,
      effectiveWakeReturnArtifacts.at(0)?.summary,
      effectiveWakeReturnArtifacts.at(0)?.nextAnchor,
      orientation?.observedAt,
      orientation?.lastActivityAt,
      orientation?.idleGapMs,
      orientation?.noteText,
      params.compactionPromptText,
    ]),
  };
}

interface BuildSessionContextParams {
  channelId: string;
  sourceChannelId?: string;
  systemPrompt: string;
  coreMemoryBlock: string;
  memoriesBlock: string;
  compactionPromptText?: string;
  llmProvider?: LLMProviderPort;
  userId?: string;
  channelMeta?: ChannelMeta;
  continuityFallbackUserIds: string[];
  store: SessionStore;
  config: SubstrateConfig;
  eventBus: EventBus | null;
  promptRegistry: PromptRegistryStatePort | null;
  preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  onCompactionComplete?: (event: {
    channelId: string;
    originalContext: string;
    compressedContext: string;
    capturedAt: number;
  }) => void;
  /** Character name from identity card (e.g. 'Companion'). Used for display labels. */
  characterName?: string;
  /**
   * The turn's captured session context (captureTurnSessionContext). The
   * builder is a pure consumer of this snapshot: there is no parallel live
   * re-derivation path (E2.2).
   */
  turnSessionContext: TurnSessionContextSnapshot;
  /** Exact just-recorded turn entry to exclude from prior-history assembly. */
  excludeSessionEntryId?: number;
  memoryManifestSeed?: ContextManifestMemorySeed;
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
  compactionMode?: 'deferred' | 'foreground';
  pendingCompaction?: boolean;
  cogSecEvents?: readonly CogSecEvent[];
  /**
   * Intake sink gate (htm9.3). When present, entries carrying persisted
   * intake-screening metadata are checked against the prompt_assembly sink
   * before context assembly; enforce-mode denials render as the withheld
   * placeholder. Null/absent = firewall off, byte-identical behavior.
   */
  intakeSinkGate?: IntakeSinkGate | null;
}

export async function buildSessionContext(params: BuildSessionContextParams): Promise<LLMContext> {
  const sourceChannelId = params.sourceChannelId ?? params.channelId;
  const channelVisibility = classifyChannelDisclosure(sourceChannelId, params.channelMeta).channelPrivacy;
  const renderGroupUserAttribution = shouldRenderSessionHistoryUserAttribution(
    channelVisibility,
    params.channelMeta,
  );
  const adaptiveBudgetProfile = resolveAdaptiveContextBudgetProfile(
    params.config,
    params.turnBudgetCharacteristics,
  );
  const historyBudget = resolveSessionHistoryBudget(params.config, {
    ...(params.turnBudgetCharacteristics ? { turn: params.turnBudgetCharacteristics } : {}),
    adaptiveProfile: adaptiveBudgetProfile,
  });
  const memoryBudget = resolveMemoryRetrievalBudget(params.config, {
    ...(params.turnBudgetCharacteristics ? { turn: params.turnBudgetCharacteristics } : {}),
    adaptiveProfile: adaptiveBudgetProfile,
  });
  const capturedRecent = params.turnSessionContext.recentEntries.map(cloneSessionEntry);
  const excludedSessionEntryCount = params.excludeSessionEntryId === undefined
    ? 0
    : capturedRecent.filter(entry => entry.id === params.excludeSessionEntryId).length;
  let recent = params.excludeSessionEntryId === undefined
    ? capturedRecent
    : capturedRecent.filter(entry => entry.id !== params.excludeSessionEntryId);
  // htm9.3: prompt_assembly sink gate. Applied to the cloned entries before
  // any downstream use (history messages, compaction, summaries), so a
  // gate-denied entry's content never reaches the assembled prompt in
  // enforce mode.
  recent = applyPromptAssemblySinkGate(
    recent,
    params.intakeSinkGate ?? null,
    { channelId: params.channelId },
  ).entries;
  const historySummaryEntryCountFromSnapshot = params.turnSessionContext.historySummaryEntryCount ?? 0;
  const sourceEntryCount = Math.max(
    0,
    (params.turnSessionContext.sourceEntryCount
      ?? (capturedRecent.length + historySummaryEntryCountFromSnapshot)) - excludedSessionEntryCount,
  );
  const historySummaryText = params.turnSessionContext.historySummaryText?.trim() ?? '';
  const historySummaryEntryCount = historySummaryEntryCountFromSnapshot;
  const intentionAppraisalArtifactCount = countIntentionAppraisalArtifacts(recent);
  const masking = applyObservationMasking(
    recent,
    params.config.observationMaskingWindow ?? DEFAULT_OBSERVATION_MASKING_WINDOW,
  );
  recent = masking.entries;
  let compactionSummaryTexts = [...params.turnSessionContext.compactionSummaryTexts];
  const focusKnowledgeTexts = [...params.turnSessionContext.focusKnowledgeTexts];
  const memoryIncludedCount = params.memoryManifestSeed?.returnedCount ?? 0;
  const coreMemoryProvenance = buildAuthenticityProvenance({
    kind: 'memory_retrieval',
    sourceAuthor: 'memory',
    transformedBy: 'retrieval',
    wording: 'derived',
    directSpeech: false,
    detailLoss: 'possible',
    emotionalTexture: 'may_be_flattened',
    safeAsPartnerSpeech: false,
    notes: [DERIVED_DETAIL_LOSS_NOTE, DERIVED_EMOTIONAL_TEXTURE_NOTE],
  });
  const memorySectionProvenance = buildAuthenticityProvenance({
    kind: 'memory_retrieval',
    sourceAuthor: 'memory',
    transformedBy: 'retrieval',
    wording: 'derived',
    directSpeech: false,
    detailLoss: 'possible',
    emotionalTexture: 'may_be_flattened',
    safeAsPartnerSpeech: false,
    sourceSpanCount: memoryIncludedCount || undefined,
    notes: [DERIVED_DETAIL_LOSS_NOTE, DERIVED_EMOTIONAL_TEXTURE_NOTE],
  });
  // Channel bonding: foreign bonded entries carry namespaced negative ids and
  // are never compacted (compaction coverage is keyed on own-channel ids). The
  // compaction TRIGGER and the compactor must both run on own-channel entries
  // only — otherwise up to 40 pulled-in foreign entries inflate the token total,
  // force foreground compaction, and summarize away the user's OWN DM history
  // while the foreign entries bypass compaction entirely (net: enabling bonding
  // degrades own history). The bond marker is authoritative for this split.
  const bondedForeignRecent = recent.filter(entry => isBondedForeignEntry(entry));
  const ownChannelRecent = bondedForeignRecent.length > 0
    ? recent.filter(entry => !isBondedForeignEntry(entry))
    : recent;
  const baseSystemTokenCount = countTokens(params.systemPrompt);
  const hasCoreMemorySection = params.coreMemoryBlock.trim().length > 0;
  const coreMemorySectionText = hasCoreMemorySection
    ? params.coreMemoryBlock
    : '';
  const coreMemoryTokenCount = countTokens(coreMemorySectionText);
  const hasMemorySection = params.memoriesBlock.trim().length > 0;
  const memorySectionText = hasMemorySection
    ? params.memoriesBlock
    : '';
  const memoryTokenCount = countTokens(memorySectionText);
  const systemTokens = baseSystemTokenCount + coreMemoryTokenCount + memoryTokenCount;
  const preAssemblySessionMessageTokens = countMessageTokens(
    entriesToMessages(recent, channelVisibility, false, false, renderGroupUserAttribution),
  );
  const compactionMode = params.compactionMode ?? 'deferred';
  const compactionCheck = shouldCompact({
    recent: ownChannelRecent,
    channelVisibility,
    systemTokens,
    config: params.config,
  });
  let compactionManifest = {
    triggered: false,
    compactedEntryCount: 0,
    eligible: compactionCheck.trigger,
    pending: params.pendingCompaction ?? false,
    mode: compactionMode,
    totalTokensBefore: systemTokens + preAssemblySessionMessageTokens,
    totalTokensAfter: systemTokens + preAssemblySessionMessageTokens,
  };

  // Explicit foreground compaction remains available for callers that opt into it.
  if (params.llmProvider && compactionMode === 'foreground') {
    // Bonded foreign entries never reach the compactor (compaction coverage is
    // keyed on own-channel ids); they are re-interleaved afterwards. Uses the
    // same own/foreign split that gated the compaction trigger above.
    const preCompactionEntryCount = ownChannelRecent.length;
    const result = await runAutoCompaction({
      channelId: params.channelId,
      recent: ownChannelRecent,
      channelVisibility,
      systemTokens,
      compactionPromptText: params.compactionPromptText ?? params.turnSessionContext.compactionPromptText,
      llmProvider: params.llmProvider,
      store: params.store,
      config: params.config,
      eventBus: params.eventBus,
      promptRegistry: params.promptRegistry,
      preCompactionExtractionHandler: params.preCompactionExtractionHandler,
      onCompactionComplete: params.onCompactionComplete,
      userId: params.userId,
    });
    recent = bondedForeignRecent.length > 0
      ? sortBondedTimelineEntries([...result.recent, ...bondedForeignRecent])
      : result.recent;
    if (result.compactionSummaryText) {
      compactionSummaryTexts = [
        ...compactionSummaryTexts,
        wrapCompactionSummaryAsUntrustedContext(result.compactionSummaryText),
      ];
    }
    const postCompactionMessageTokens = countMessageTokens(
      entriesToMessages(recent, channelVisibility, false, false, renderGroupUserAttribution),
    );
    const newSummaryTokenCount = result.compactionSummaryText
      ? countTokens(wrapCompactionSummaryAsUntrustedContext(result.compactionSummaryText))
      : 0;
    compactionManifest = {
      triggered: result.compacted,
      compactedEntryCount: result.compacted
        ? Math.max(0, preCompactionEntryCount - result.recent.length)
        : 0,
      eligible: compactionCheck.trigger,
      pending: params.pendingCompaction ?? false,
      mode: compactionMode,
      totalTokensBefore: systemTokens + preAssemblySessionMessageTokens,
      totalTokensAfter: systemTokens + postCompactionMessageTokens + newSummaryTokenCount,
    };
  }
  const compactionThresholdTokenBudget = Math.floor(
    historyBudget.contextWindow * (params.config.compactionThresholdPct / 100),
  );

  // Build system prompt with memories
  let fullSystem = params.systemPrompt;

  // Prepend compaction summaries as context
  let compactionSummarySectionText = '';
  if (compactionSummaryTexts.length > 0) {
    const summaryBlock = compactionSummaryTexts.join('\n\n');
    compactionSummarySectionText = `${renderSystemLanguageTemplate('compaction.header')}\n${summaryBlock}`;
  }

  let focusKnowledgeSectionText = '';
  if (focusKnowledgeTexts.length > 0) {
    focusKnowledgeSectionText = '[Focus knowledge]\n' + focusKnowledgeTexts.join('\n');
  }

  // Cross-channel continuity: include recent activity from other channels
  const rawCrossChannel = params.turnSessionContext.continuityEntries.map(cloneSessionEntry);
  const crossChannel = filterContinuityEntriesForChannel(sourceChannelId, rawCrossChannel);
  const continuityProvenance = buildAuthenticityProvenance({
    kind: 'projection',
    sourceAuthor: 'mixed',
    transformedBy: 'projection',
    wording: 'transformed',
    directSpeech: false,
    detailLoss: 'possible',
    emotionalTexture: 'unknown',
    safeAsPartnerSpeech: false,
    sourceSpanCount: crossChannel.length,
    notes: ['Retrieved continuity is context, not current partner-authored direct speech.'],
  });
  const continuityBlock = buildContinuityMetadataBlock(
    crossChannel,
    Date.now(),
  );
  const continuitySectionText = continuityBlock
    ? continuityBlock
    : '';
  const cogSecNoticeChannelIds = sourceChannelId === params.channelId
    ? [params.channelId]
    : [params.channelId, sourceChannelId];
  const cogSecVisibleEvents = listAgentVisibleCogSecEvents(params.cogSecEvents ?? [], {
    channelIds: cogSecNoticeChannelIds,
    limit: 5,
  });
  const cogSecNoticeSectionText = buildCogSecEventNoticeBlock(params.cogSecEvents ?? [], {
    channelIds: cogSecNoticeChannelIds,
    limit: 5,
  });
  const orientationSectionText = params.turnSessionContext.orientation?.fired
    ? params.turnSessionContext.orientation.noteText?.trim() ?? ''
    : '';

  const promptRuntimeLayout = resolveCachedPromptRuntimeLayoutStore(params.config);
  const orderedRuntimeSections = orderPromptRuntimeSystemPromptSections([
    {
      id: 'memory.core' as PromptRuntimeSystemPromptBlockId,
      content: coreMemorySectionText,
    },
    {
      id: 'memory.retrieval' as PromptRuntimeSystemPromptBlockId,
      content: memorySectionText,
    },
    {
      id: 'session.compaction_summary' as PromptRuntimeSystemPromptBlockId,
      content: compactionSummarySectionText,
    },
    {
      id: 'session.focus_knowledge' as PromptRuntimeSystemPromptBlockId,
      content: focusKnowledgeSectionText,
    },
    {
      id: 'session.orientation' as PromptRuntimeSystemPromptBlockId,
      content: orientationSectionText,
    },
    {
      id: 'session.continuity' as PromptRuntimeSystemPromptBlockId,
      content: continuitySectionText,
    },
    {
      id: 'session.cogsec_notices' as PromptRuntimeSystemPromptBlockId,
      content: cogSecNoticeSectionText,
    },
  ], promptRuntimeLayout);
  // Ordered nonempty session blocks, exposed for PromptPlan block emission.
  const sessionPromptBlocks: Array<{ id: string; content: string }> = [];
  for (const section of orderedRuntimeSections) {
    const trimmed = section.content.trim();
    if (!trimmed) continue;
    fullSystem += '\n\n' + trimmed;
    sessionPromptBlocks.push({ id: section.id, content: trimmed });
  }

  // Convert session entries to LLM messages
  const messages: ContextMessage[] = buildSessionHistoryMessages(
    recent,
    channelVisibility,
    renderGroupUserAttribution,
    historySummaryText,
    historySummaryEntryCount,
  );
  const sessionMessageTokenCount = countMessageTokens(messages);
  const roomWindowFilteredEntryCount = params.turnSessionContext.roomWindowFilteredEntryCount;
  // Bonded foreign entries are not own-channel source entries; keep the
  // trim accounting scoped to the channel's own log.
  const bondedEntryCount = (params.turnSessionContext.bondedEntryCount ?? 0) > 0
    ? recent.filter(entry => isBondedForeignEntry(entry)).length
    : 0;
  const trimmedEntryCount = Math.max(
    0,
    sourceEntryCount - (recent.length - bondedEntryCount) - historySummaryEntryCount
      - (roomWindowFilteredEntryCount ?? 0),
  );
  const seededMemoryHardLimit = params.memoryManifestSeed?.retrievalLimitMode === 'hard_limit'
    ? params.memoryManifestSeed.retrievalLimit
    : undefined;
  const manifest: ContextManifest = {
    channelId: params.channelId,
    generatedAt: Date.now(),
    session: {
      sourceEntryCount,
      trimmedEntryCount,
      ...(roomWindowFilteredEntryCount !== undefined
        ? { roomWindowFilteredEntryCount }
        : {}),
      maskedEntryCount: masking.maskedCount,
      compactedEntryCount: compactionManifest.compactedEntryCount,
      intentionAppraisalArtifactCount,
      ...(bondedEntryCount > 0 ? { bondedEntryCount } : {}),
      finalEntryCount: recent.length,
      finalMessageCount: messages.length,
      historySummaryEntryCount,
      compactionSummaryCount: compactionSummaryTexts.length,
      continuityEntryCount: crossChannel.length,
    },
    memory: {
      includedCount: memoryIncludedCount,
      includedTypes: { ...(params.memoryManifestSeed?.selectedTypes ?? {}) },
      includedTokenCount: memoryTokenCount,
      reason: params.memoryManifestSeed?.reason ?? (memorySectionText ? 'seed_missing' : 'empty_input'),
      ...(params.memoryManifestSeed?.retrievalSource
        ? { retrievalSource: params.memoryManifestSeed.retrievalSource }
        : {}),
      candidateCount: params.memoryManifestSeed?.candidateCount ?? 0,
      policyAllowedCount: params.memoryManifestSeed?.policyAllowedCount ?? 0,
      rankedCount: params.memoryManifestSeed?.rankedCount ?? 0,
      returnedCount: memoryIncludedCount,
        excluded: {
          ...(params.memoryManifestSeed?.sessionQuarantineRejectedCount !== undefined
            ? { sessionQuarantineRejectedCount: params.memoryManifestSeed.sessionQuarantineRejectedCount }
            : {}),
          ...(params.memoryManifestSeed?.roomVisibilityRejectedCount !== undefined
            ? { roomVisibilityRejectedCount: params.memoryManifestSeed.roomVisibilityRejectedCount }
          : {}),
        ...(params.memoryManifestSeed?.contactScopeRejectedCount !== undefined
          ? { contactScopeRejectedCount: params.memoryManifestSeed.contactScopeRejectedCount }
          : {}),
        sensitivityRejectedCount: params.memoryManifestSeed?.sensitivityRejectedCount ?? 0,
        policyRejectedCount: params.memoryManifestSeed?.policyRejectedCount ?? 0,
        ...(params.memoryManifestSeed?.policyRejectedReasonTags
          ? { policyRejectedReasonTags: { ...params.memoryManifestSeed.policyRejectedReasonTags } }
          : {}),
        ...(params.memoryManifestSeed?.withheldCount !== undefined
          ? { withheldCount: params.memoryManifestSeed.withheldCount }
          : {}),
        ...(params.memoryManifestSeed?.withheldReasonCounts
          ? { withheldReasonCounts: { ...params.memoryManifestSeed.withheldReasonCounts } }
          : {}),
        ...(params.memoryManifestSeed?.withheldRelevanceBands
          ? { withheldRelevanceBands: { ...params.memoryManifestSeed.withheldRelevanceBands } }
          : {}),
        scoreRejectedCount: params.memoryManifestSeed?.scoreRejectedCount ?? 0,
        budgetCappedCount: params.memoryManifestSeed?.budgetCappedCount ?? 0,
      },
      retrieval: {
        mode: params.memoryManifestSeed?.retrievalLimitMode ?? memoryBudget.mode,
        budgetPct: params.memoryManifestSeed?.retrievalBudgetPct ?? memoryBudget.budgetPct,
        tokenBudget: params.memoryManifestSeed?.retrievalTokenBudget ?? memoryBudget.tokenBudget,
        limit: params.memoryManifestSeed?.retrievalLimit ?? memoryBudget.estimatedCount,
        ...(params.memoryManifestSeed?.compositionalMode
          ? { compositionalMode: params.memoryManifestSeed.compositionalMode }
          : {}),
      },
    },
    budgets: {
      contextWindow: historyBudget.contextWindow,
      adaptive: {
        enabled: adaptiveBudgetProfile.enabled,
        source: adaptiveBudgetProfile.source,
        category: adaptiveBudgetProfile.category,
      },
      sessionHistory: {
        mode: historyBudget.mode,
        budgetPct: historyBudget.budgetPct,
        tokenBudget: historyBudget.tokenBudget,
        estimatedCount: historyBudget.estimatedCount,
        ...(historyBudget.hardLimit !== undefined ? { hardLimit: historyBudget.hardLimit } : {}),
        actualCount: messages.length,
        actualTokenCount: sessionMessageTokenCount,
      },
      memoryRetrieval: {
        mode: params.memoryManifestSeed?.retrievalLimitMode ?? memoryBudget.mode,
        budgetPct: params.memoryManifestSeed?.retrievalBudgetPct ?? memoryBudget.budgetPct,
        tokenBudget: params.memoryManifestSeed?.retrievalTokenBudget ?? memoryBudget.tokenBudget,
        estimatedCount: memoryBudget.estimatedCount,
        ...(seededMemoryHardLimit !== undefined
          ? { hardLimit: seededMemoryHardLimit }
          : memoryBudget.hardLimit !== undefined
            ? { hardLimit: memoryBudget.hardLimit }
            : {}),
        actualCount: memoryIncludedCount,
        actualTokenCount: memoryTokenCount,
      },
      sections: [
        { section: 'system_prompt', tokenCount: baseSystemTokenCount },
        { section: 'core_memory', tokenCount: coreMemoryTokenCount },
        { section: 'memories', tokenCount: memoryTokenCount },
        {
          section: 'compaction_summary',
          tokenCount: countTokens(compactionSummarySectionText) + countTokens(focusKnowledgeSectionText),
        },
        { section: 'orientation', tokenCount: countTokens(orientationSectionText) },
        { section: 'continuity', tokenCount: countTokens(continuitySectionText) },
        { section: 'cogsec_notices', tokenCount: countTokens(cogSecNoticeSectionText) },
        { section: 'session_history', tokenCount: sessionMessageTokenCount },
      ],
    },
    compaction: {
      triggered: compactionManifest.triggered,
      eligible: compactionManifest.eligible,
      pending: compactionManifest.pending,
      mode: compactionManifest.mode,
      thresholdPct: params.config.compactionThresholdPct,
      tokenBudget: compactionThresholdTokenBudget,
      totalTokensBefore: compactionManifest.totalTokensBefore,
      totalTokensAfter: compactionManifest.totalTokensAfter,
    },
  };
  log.debug('Built context manifest', manifest);

  const systemPromptSections = buildPromptSectionTelemetryList([
    {
      id: 'pre_session_prompt',
      title: 'Pre-Session Prompt',
      content: params.systemPrompt,
    },
    {
      id: 'core_memory',
      title: 'Core Memory',
      content: coreMemorySectionText,
      provenance: coreMemoryProvenance,
    },
    {
      id: 'retrieved_memory',
      title: 'Retrieved Memory',
      content: memorySectionText,
      provenance: memorySectionProvenance,
    },
    {
      id: 'previous_conversation_summary',
      title: 'Previous Conversation Summary',
      content: compactionSummarySectionText,
      provenance: buildAuthenticityProvenance({
        kind: 'compaction_summary',
        sourceAuthor: 'mixed',
        transformedBy: 'compaction',
        wording: 'derived',
        directSpeech: false,
        detailLoss: 'possible',
        emotionalTexture: 'may_be_flattened',
        safeAsPartnerSpeech: false,
        sourceSpanCount: compactionSummaryTexts.length || undefined,
        notes: [DERIVED_DETAIL_LOSS_NOTE, DERIVED_EMOTIONAL_TEXTURE_NOTE],
      }),
    },
    {
      id: 'focus_knowledge',
      title: 'Focus Knowledge',
      content: focusKnowledgeSectionText,
      provenance: buildAuthenticityProvenance({
        kind: 'extraction_artifact',
        sourceAuthor: 'mixed',
        transformedBy: 'extraction',
        wording: 'derived',
        directSpeech: false,
        detailLoss: 'possible',
        emotionalTexture: 'may_be_flattened',
        safeAsPartnerSpeech: false,
        sourceSpanCount: focusKnowledgeTexts.length || undefined,
        notes: [DERIVED_DETAIL_LOSS_NOTE, DERIVED_EMOTIONAL_TEXTURE_NOTE],
      }),
    },
    {
      id: 'wake_orientation',
      title: 'Active Temporal Frame',
      content: orientationSectionText,
      provenance: buildAuthenticityProvenance({
        kind: 'system_note',
        sourceAuthor: 'system',
        transformedBy: 'runtime',
        wording: 'direct',
        directSpeech: false,
        detailLoss: 'none',
        emotionalTexture: 'preserved',
        safeAsPartnerSpeech: false,
        sourceSpanCount: orientationSectionText ? 1 : undefined,
        notes: ['Ephemeral active-turn temporal frame; not a persisted session message.'],
      }),
    },
    {
      id: 'cross_channel_continuity',
      title: 'Cross-Channel Continuity',
      content: continuitySectionText,
      provenance: continuityProvenance,
    },
    {
      id: 'cogsec_notices',
      title: 'CogSec Notices',
      content: cogSecNoticeSectionText,
      provenance: buildAuthenticityProvenance({
        kind: 'system_note',
        sourceAuthor: 'system',
        transformedBy: 'redaction',
        wording: 'redacted',
        directSpeech: false,
        detailLoss: 'likely',
        emotionalTexture: 'unknown',
        safeAsPartnerSpeech: false,
        sourceSpanCount: cogSecVisibleEvents.length || undefined,
        notes: ['Safe CogSec notice; sealed material remains outside companion runtime.'],
      }),
    },
  ]);

  return {
    systemPrompt: fullSystem,
    sessionPromptBlocks,
    messages,
    manifest,
    systemPromptSections,
  };
}

export const DEFAULT_OBSERVATION_MASKING_WINDOW = 1;

export function applyObservationMasking(
  entries: SessionEntry[],
  window: number,
): { entries: SessionEntry[]; maskedCount: number } {
  const normalizedWindow = Number.isFinite(window)
    ? Math.max(0, Math.floor(window))
    : DEFAULT_OBSERVATION_MASKING_WINDOW;
  if (entries.length === 0) {
    return { entries, maskedCount: 0 };
  }

  const unmaskedTurnIds = new Set<string>();
  if (normalizedWindow > 0) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.role === 'system') continue;
      const turnContext = resolveSessionEntryTurnContext(entry);
      unmaskedTurnIds.add(turnContext.turnId);
      if (unmaskedTurnIds.size >= normalizedWindow) {
        break;
      }
    }
  }

  let maskedCount = 0;
  const maskedEntries = entries.map((entry) => {
    if (entry.role !== 'tool') return entry;
    const turnContext = resolveSessionEntryTurnContext(entry);
    if (unmaskedTurnIds.has(turnContext.turnId)) {
      return entry;
    }
    maskedCount += 1;
    return {
      ...entry,
      content: MASKED_TOOL_OBSERVATION_CONTENT,
    };
  });

  return {
    entries: maskedEntries,
    maskedCount,
  };
}
