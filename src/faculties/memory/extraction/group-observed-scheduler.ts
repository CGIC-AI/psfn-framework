import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import {
  type ChannelGroupMemoryConfig,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import type { ObservedGroupExtractionOptions } from '../extraction.js';
import type { ExtractionTriggerReason } from './types.js';
import {
  buildGroupMemoryRangePlan,
  type GroupMemoryRangeChunk,
  type GroupMemoryRangeSessionReader,
  type GroupMemoryWatermarkStorePort,
} from './group-ranges.js';
import {
  classifyGroupMemoryChannel,
  resolveGroupMemorySettingsForChannel,
  type GroupMemorySessionReader,
} from './group-classifier.js';
import { selectGroupMemorySalienceCandidates } from './group-salience.js';

export type ObservedGroupMemoryTriggerReason = Extract<
  ExtractionTriggerReason,
  'observed_count' | 'observed_time' | 'direct_mention' | 'high_salience' | 'backlog_lag'
>;

export type ObservedGroupMemorySkipReason =
  | 'disabled'
  | 'not_group'
  | 'in_flight'
  | 'no_backlog'
  | 'cooldown'
  | 'threshold_not_met'
  | 'extractor_rejected'
  | 'extraction_failed';

export type ObservedGroupMemoryScheduleDecision =
  | {
    status: 'scheduled';
    channelId: string;
    triggerReason: ObservedGroupMemoryTriggerReason;
    spanStartMessageId: number;
    spanEndMessageId: number;
    newEntryCount: number;
    watermarkLagMessageIds: number;
    hasDeferredBacklog: boolean;
  }
  | {
    status: 'skipped';
    channelId: string;
    reason: ObservedGroupMemorySkipReason;
    watermarkLagMessageIds?: number;
    cooldownRemainingMs?: number;
    error?: string;
  };

export interface ObservedGroupMemoryExtractorPort {
  extractObservedGroupRange(options: ObservedGroupExtractionOptions): Promise<boolean>;
  getPendingExtractionPromise?(channelId: string): Promise<void> | null;
}

export interface ObservedGroupMemorySchedulerOptions {
  groupMemory?: GroupMemorySettings;
  channelGroupMemory?: ChannelGroupMemoryConfig;
  sessionReader: GroupMemoryRangeSessionReader & GroupMemorySessionReader;
  watermarkStore: GroupMemoryWatermarkStorePort;
  memoryExtractor: ObservedGroupMemoryExtractorPort;
  contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'>;
  companionNames?: readonly string[];
  companionAuthorIds?: readonly string[];
  nowMs?: () => number;
  estimateEntryTokens?: (entry: GroupMemoryRangeChunk['entries'][number]) => number;
}

export class ObservedGroupMemoryScheduler {
  private readonly groupMemory?: GroupMemorySettings;
  private readonly channelGroupMemory?: ChannelGroupMemoryConfig;
  private readonly sessionReader: GroupMemoryRangeSessionReader & GroupMemorySessionReader;
  private readonly watermarkStore: GroupMemoryWatermarkStorePort;
  private readonly memoryExtractor: ObservedGroupMemoryExtractorPort;
  private readonly contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'>;
  private readonly companionNames: readonly string[];
  private readonly companionAuthorIds: readonly string[];
  private readonly nowMs: () => number;
  private readonly estimateEntryTokens?: (entry: GroupMemoryRangeChunk['entries'][number]) => number;
  private readonly lastScheduledAtByChannel = new Map<string, number>();
  private readonly firstPendingObservedAtByChannel = new Map<string, number>();

  constructor(options: ObservedGroupMemorySchedulerOptions) {
    this.groupMemory = options.groupMemory;
    this.channelGroupMemory = options.channelGroupMemory;
    this.sessionReader = options.sessionReader;
    this.watermarkStore = options.watermarkStore;
    this.memoryExtractor = options.memoryExtractor;
    this.contactStore = options.contactStore;
    this.companionNames = options.companionNames ?? [];
    this.companionAuthorIds = options.companionAuthorIds ?? [];
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.estimateEntryTokens = options.estimateEntryTokens;
  }

  async observeMessage(
    message: SubstrateMessage,
  ): Promise<ObservedGroupMemoryScheduleDecision> {
    const resolved = resolveGroupMemorySettingsForChannel({
      base: this.groupMemory,
      channelConfig: this.channelGroupMemory,
      channelId: message.channelId,
    });
    const settings = resolved.settings;
    if (!settings.enabled) {
      return {
        status: 'skipped',
        channelId: message.channelId,
        reason: 'disabled',
      };
    }

    const recentEntries = await this.sessionReader.getRecent(
      message.channelId,
      settings.autoDetection.recentParticipantWindowMessages,
    );
    const classification = await classifyGroupMemoryChannel({
      channelId: message.channelId,
      channelType: message.channelType,
      groupMemory: settings,
      recentEntries,
      contactStore: this.contactStore,
      companionAuthorIds: this.companionAuthorIds,
    });
    if (classification.mode === 'direct') {
      return {
        status: 'skipped',
        channelId: message.channelId,
        reason: 'not_group',
      };
    }

    if (this.memoryExtractor.getPendingExtractionPromise?.(message.channelId)) {
      return {
        status: 'skipped',
        channelId: message.channelId,
        reason: 'in_flight',
      };
    }

    const plan = buildGroupMemoryRangePlan({
      channelId: message.channelId,
      sessionReader: this.sessionReader,
      watermarkStore: this.watermarkStore,
      settings,
      ...(this.estimateEntryTokens ? { estimateEntryTokens: this.estimateEntryTokens } : {}),
    });
    if (plan.chunks.length === 0) {
      return {
        status: 'skipped',
        channelId: message.channelId,
        reason: 'no_backlog',
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
      };
    }
    const chunk = plan.chunks[0];

    const now = this.nowMs();
    if (!this.firstPendingObservedAtByChannel.has(message.channelId)) {
      this.firstPendingObservedAtByChannel.set(message.channelId, now);
    }
    const triggerReason = this.resolveTriggerReason({
      message,
      settings,
      chunk,
      watermarkLagMessageIds: plan.watermarkLagMessageIds,
      firstPendingObservedAt: this.firstPendingObservedAtByChannel.get(message.channelId) ?? now,
      now,
    });
    if (!triggerReason) {
      return {
        status: 'skipped',
        channelId: message.channelId,
        reason: 'threshold_not_met',
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
      };
    }

    const lastScheduledAt = this.lastScheduledAtByChannel.get(message.channelId);
    if (lastScheduledAt !== undefined) {
      const cooldownRemainingMs =
        settings.onlineExtraction.cooldownMs - (now - lastScheduledAt);
      if (cooldownRemainingMs > 0) {
        return {
          status: 'skipped',
          channelId: message.channelId,
          reason: 'cooldown',
          watermarkLagMessageIds: plan.watermarkLagMessageIds,
          cooldownRemainingMs,
        };
      }
    }

    try {
      const accepted = await this.memoryExtractor.extractObservedGroupRange({
        channelId: message.channelId,
        triggerReason,
        recoveredEntries: chunk.entries,
        groupWriteCaps: settings.writeCaps,
        backfill: triggerReason === 'backlog_lag' || plan.hasDeferredBacklog,
      });
      if (!accepted) {
        return {
          status: 'skipped',
          channelId: message.channelId,
          reason: 'extractor_rejected',
          watermarkLagMessageIds: plan.watermarkLagMessageIds,
        };
      }
      this.watermarkStore.markProcessed({
        channelId: message.channelId,
        startMessageId: chunk.spanStartMessageId,
        endMessageId: chunk.spanEndMessageId,
        entryCount: chunk.newEntryCount,
        recordedAt: now,
      });
      this.lastScheduledAtByChannel.set(message.channelId, now);
      this.firstPendingObservedAtByChannel.delete(message.channelId);
      return {
        status: 'scheduled',
        channelId: message.channelId,
        triggerReason,
        spanStartMessageId: chunk.spanStartMessageId,
        spanEndMessageId: chunk.spanEndMessageId,
        newEntryCount: chunk.newEntryCount,
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
        hasDeferredBacklog: plan.hasDeferredBacklog,
      };
    } catch (error) {
      this.watermarkStore.markFailed({
        channelId: message.channelId,
        startMessageId: chunk.spanStartMessageId,
        endMessageId: chunk.spanEndMessageId,
        entryCount: chunk.newEntryCount,
        recordedAt: now,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'skipped',
        channelId: message.channelId,
        reason: 'extraction_failed',
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveTriggerReason(params: {
    message: SubstrateMessage;
    settings: GroupMemorySettings;
    chunk: GroupMemoryRangeChunk;
    watermarkLagMessageIds: number;
    firstPendingObservedAt: number;
    now: number;
  }): ObservedGroupMemoryTriggerReason | null {
    if (
      params.watermarkLagMessageIds
      >= params.settings.onlineExtraction.backlogLagTriggerMessages
    ) {
      return 'backlog_lag';
    }

    const salience = selectGroupMemorySalienceCandidates({
      chunk: params.chunk,
      settings: params.settings,
      companionNames: this.companionNames,
      companionAuthorIds: this.companionAuthorIds,
    });
    const reasons = new Set(
      salience.candidateSpans.flatMap(span => span.reasons),
    );
    if (reasons.has('direct_address') || reasons.has('companion_mention')) {
      return 'direct_mention';
    }
    if (salience.candidateSpans.length > 0) {
      return 'high_salience';
    }

    if (
      params.watermarkLagMessageIds
      >= params.settings.onlineExtraction.observedMessageTriggerCount
    ) {
      return 'observed_count';
    }

    if (
      params.now - params.firstPendingObservedAt
      >= params.settings.onlineExtraction.observedTimeTriggerMs
    ) {
      return 'observed_time';
    }

    return null;
  }
}
