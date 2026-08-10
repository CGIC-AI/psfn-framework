// ── Auto-compaction lane (charter 12.1 split, emh3p.3) ──
// Between-turns auto-compaction scheduling and recent-entry capture,
// extracted from SessionManager. The queueing (one pending compaction per
// resolved channel), token budgeting, core-memory block assembly, room-window
// masking, and focus compaction ranges all stay byte-identical; only the
// assembly location moved.

import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { PromptRegistryStatePort } from '../../identity/prompt-state-port.js';
import { countTokens } from '../../../primitives/llm/tokens.js';
import { classifyChannelEnvelope, type ChannelMeta } from '../../../system/trust/policy.js';
import {
  COMPACTION_SUMMARY_PROMPT_KEY,
  getDefaultPromptText,
} from '../../identity/prompt-registry.js';
import {
  resolveAdaptiveContextBudgetProfile,
  resolveSessionHistoryBudget,
} from '../../../shared/context-budget.js';
import { shouldPersistSessionChannel } from './compaction-boundary-store.js';
import { collectRecentEntriesWithinTokenBudget } from '../manager-primitives.js';
import { applyObservationMasking, DEFAULT_OBSERVATION_MASKING_WINDOW } from './context-builder.js';
import { runAutoCompaction } from './compaction-service.js';
import { applyFocusCompactionRanges, type FocusCompactionRange } from '../focus-knowledge.js';
import { roomContentWindowFloorMs, type RoomContentWindow } from '../room-content-window.js';
import type {
  AutoCompactionBetweenTurnsParams,
  AutoCompactionRecentEntriesCaptureParams,
} from './session-manager-type-surface.js';
import type { SessionEntry } from '../types.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { ConversationScope } from '../conversation-scope.js';
import type { PreCompactionExtractionHandler } from './contracts.js';
import type { CoreMemoryFormatContext } from '../../../faculties/core-memory/store.js';
import type { createComponentLogger } from '../../../shared/logger.js';

type Log = ReturnType<typeof createComponentLogger>;


export interface AutoCompactionLaneDeps {
  config: SubstrateConfig;
  eventBus: EventBus | null;
  promptRegistry: PromptRegistryStatePort | null;
  compactionBoundaryStore: SessionStore;
  pendingAutoCompactions: Map<string, Promise<void>>;
  getPreCompactionExtractionHandler: () => PreCompactionExtractionHandler | null;
  compressionGuidelineRuntime: {
    recordCompactionTrajectory(input: {
      channelId: string;
      originalContext: string;
      compressedContext: string;
      capturedAt: number;
    }): void;
  };
  getCoreMemoryProvider: () => { formatForContext(context: CoreMemoryFormatContext): string } | null;
  assertMutableSessionReadAllowed: (callSite: string) => void;
  resolveSessionChannelId: (channelId: string) => string;
  resolveCompactionPromptText: (basePrompt: string) => string;
  buildCoreMemoryFormatContext: (scope: ConversationScope) => CoreMemoryFormatContext;
  resolveConversationScopeForResolvedChannel: (
    resolvedChannelId: string,
    input: { channelMeta?: ChannelMeta; userId?: string },
  ) => ConversationScope;
  getFocusCompactionRanges: (channelId: string) => FocusCompactionRange[];
  resolveRoomContentWindow: (resolvedChannelId: string) => RoomContentWindow;
  log: Log;
}

function resolveCompactionTokenCount(input: {
  count: number | undefined;
  text: string | undefined;
  field: string;
}): number {
  if (input.count !== undefined) {
    if (!Number.isSafeInteger(input.count) || input.count < 0) {
      throw new Error(`Auto-compaction ${input.field} token count must be a non-negative safe integer`);
    }
    return input.count;
  }
  return input.text ? countTokens(input.text) : 0;
}

export class AutoCompactionLane {
  constructor(private readonly deps: AutoCompactionLaneDeps) {}

  scheduleBetweenTurns(params: AutoCompactionBetweenTurnsParams): Promise<void> {
    this.deps.assertMutableSessionReadAllowed(
      'SessionManager.scheduleAutoCompactionBetweenTurns',
    );
    const { channelId, ...capturedParams } = params;
    return this.scheduleForResolvedChannel(
      this.deps.resolveSessionChannelId(channelId),
      capturedParams,
    );
  }

  scheduleForResolvedChannel(
    resolvedChannelId: string,
    params: Omit<AutoCompactionBetweenTurnsParams, 'channelId'>,
  ): Promise<void> {
    if (!shouldPersistSessionChannel(resolvedChannelId)) {
      return Promise.resolve();
    }

    const { pendingAutoCompactions, log } = this.deps;
    const previous = pendingAutoCompactions.get(resolvedChannelId) ?? Promise.resolve();
    const next = previous
      .catch((error) => {
        log.error('Auto-compaction queue continuation failed', {
          channelId: resolvedChannelId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(async () => {
        const adaptiveProfile = params.adaptiveProfile ?? resolveAdaptiveContextBudgetProfile(
          this.deps.config,
          params.turnBudgetCharacteristics,
        );
        const historyBudget = resolveSessionHistoryBudget(this.deps.config, {
          ...(params.turnBudgetCharacteristics ? { turn: params.turnBudgetCharacteristics } : {}),
          adaptiveProfile,
        });
        const recent = params.capturedRecentEntries !== undefined
          ? [...params.capturedRecentEntries]
          : this.captureForResolvedChannel(resolvedChannelId, {
              adaptiveProfile,
              ...(params.turnBudgetCharacteristics
                ? { turnBudgetCharacteristics: params.turnBudgetCharacteristics }
                : {}),
            });
        const coreMemoryBlock = this.deps.getCoreMemoryProvider()
          ?.formatForContext(this.deps.buildCoreMemoryFormatContext(
            // Between-turns work resolves its own scope at drain time; the
            // session store may have advanced since the turn that scheduled it.
            this.deps.resolveConversationScopeForResolvedChannel(resolvedChannelId, {
              ...(params.channelMeta ? { channelMeta: params.channelMeta } : {}),
              ...(params.userId ? { userId: params.userId } : {}),
            }),
          ))
          .trim() ?? '';
        const baseCompactionPrompt = this.deps.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
          ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
        const systemTokens = resolveCompactionTokenCount({
          count: params.systemPromptTokenCount,
          text: params.systemPrompt,
          field: 'systemPrompt',
        })
          + countTokens(coreMemoryBlock)
          + resolveCompactionTokenCount({
            count: params.memoriesTokenCount,
            text: params.memoriesBlock,
            field: 'memoriesBlock',
          });
        await runAutoCompaction({
          channelId: resolvedChannelId,
          recent,
          channelVisibility: classifyChannelEnvelope(resolvedChannelId, params.channelMeta).privacy,
          systemTokens,
          compactionPromptText: params.compactionPromptText
            ?? this.deps.resolveCompactionPromptText(baseCompactionPrompt),
          llmProvider: params.llmProvider,
          store: this.deps.compactionBoundaryStore,
          config: this.deps.config,
          ...(params.icpCorrelation ? { icpCorrelation: params.icpCorrelation } : {}),
          eventBus: this.deps.eventBus,
          promptRegistry: this.deps.promptRegistry,
          preCompactionExtractionHandler: this.deps.getPreCompactionExtractionHandler(),
          onCompactionComplete: ({ channelId, originalContext, compressedContext, capturedAt }) => {
            this.deps.compressionGuidelineRuntime.recordCompactionTrajectory({
              channelId,
              originalContext,
              compressedContext,
              capturedAt,
            });
          },
          userId: params.userId,
          ...(params.throwOnFailure === true ? { throwOnFailure: true } : {}),
          ...(params.assertEffectAllowed
            ? { assertEffectAllowed: params.assertEffectAllowed }
            : {}),
          triggerTokenBudget: historyBudget.tokenBudget,
        });
      })
      .finally(() => {
        if (pendingAutoCompactions.get(resolvedChannelId) === next) {
          pendingAutoCompactions.delete(resolvedChannelId);
        }
      });

    pendingAutoCompactions.set(resolvedChannelId, next);
    return next;
  }

  captureRecentEntries(
    params: AutoCompactionRecentEntriesCaptureParams,
  ): SessionEntry[] {
    this.deps.assertMutableSessionReadAllowed(
      'SessionManager.captureAutoCompactionRecentEntries',
    );
    const { channelId, ...capturedParams } = params;
    return this.captureForResolvedChannel(
      this.deps.resolveSessionChannelId(channelId),
      capturedParams,
    );
  }

  captureForResolvedChannel(
    resolvedChannelId: string,
    params: Omit<AutoCompactionRecentEntriesCaptureParams, 'channelId'>,
  ): SessionEntry[] {
    const adaptiveProfile = params.adaptiveProfile ?? resolveAdaptiveContextBudgetProfile(
      this.deps.config,
      params.turnBudgetCharacteristics,
    );
    const historyBudget = resolveSessionHistoryBudget(this.deps.config, {
      ...(params.turnBudgetCharacteristics ? { turn: params.turnBudgetCharacteristics } : {}),
      adaptiveProfile,
    });
    const maxSessionEntryId = params.maxSessionEntryId;
    if (maxSessionEntryId !== undefined
      && (!Number.isSafeInteger(maxSessionEntryId) || maxSessionEntryId < 1)) {
      throw new Error('Auto-compaction maxSessionEntryId must be a positive safe integer');
    }
    const boundedStore: Pick<SessionStore, 'getRecent'> = maxSessionEntryId === undefined
      ? this.deps.compactionBoundaryStore
      : {
          getRecent: (channelId: string, limit: number): SessionEntry[] => (
            this.deps.compactionBoundaryStore.getEntriesBefore(
              channelId,
              maxSessionEntryId + 1,
              limit,
            )
          ),
        };
    const collected = collectRecentEntriesWithinTokenBudget({
      store: boundedStore,
      channelId: resolvedChannelId,
      estimatedCount: historyBudget.estimatedCount,
      tokenBudget: historyBudget.tokenBudget,
      turnBudgetCharacteristics: params.turnBudgetCharacteristics,
      ...(params.now ? { now: params.now } : {}),
    });
    let recent = collected.sourceEntries ?? collected.entries;
    // A compaction summary is a served surface: never let it reintroduce room
    // content from before the current presence window.
    const roomWindow = this.deps.resolveRoomContentWindow(resolvedChannelId);
    if (roomWindow.kind !== 'unwindowed') {
      const floor = roomContentWindowFloorMs(roomWindow);
      recent = recent.filter(entry => entry.timestamp >= floor);
    }
    recent = applyFocusCompactionRanges(
      recent,
      this.deps.getFocusCompactionRanges(resolvedChannelId),
    ).entries;
    return applyObservationMasking(
      recent,
      this.deps.config.observationMaskingWindow ?? DEFAULT_OBSERVATION_MASKING_WINDOW,
    ).entries;
  }
}
