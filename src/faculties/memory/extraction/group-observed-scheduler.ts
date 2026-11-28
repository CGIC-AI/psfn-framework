import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import {
  type ChannelGroupMemoryConfig,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import type { GroupMemoryExtractionFailureRetryConfig } from '../../../system/config/scheduler-config.js';
import { formatErrorCauseChain } from '../../../shared/utils/errors.js';
import { findModelBudgetRefusal, ModelRefusalDeferralWindow } from '../model-budget-deferral.js';
import type { ObservedGroupExtractionOptions } from '../extraction.js';
import type { ExtractionTriggerReason } from './types.js';
import {
  buildGroupMemoryRangePlan,
  isGroupMemoryFailureRetryDue,
  type GroupMemoryFailedWatermarkSource,
  type GroupMemoryRangeChunk,
  type GroupMemoryRangePlan,
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
  | 'extraction_failed'
  /** A failed range is waiting out its bounded retry backoff (d5e0p.15). */
  | 'failure_backoff'
  /**
   * The model budget refused the extraction before dispatch (zwwo0): no attempt
   * was consumed and the range is re-probed by the retry sweep.
   */
  | 'model_budget_deferred';

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

/** One recorded group-range failure under the bounded retry policy (d5e0p.15). */
export interface GroupMemoryRangeFailureEvent {
  channelId: string;
  attemptCount: number;
  maxAttempts: number;
  /** This failure exhausted the attempt budget; timed retries stop. */
  terminal: boolean;
  timestamp: number;
}

export interface ObservedGroupMemoryExtractorPort {
  extractObservedGroupRange(options: ObservedGroupExtractionOptions): Promise<boolean>;
  getPendingExtractionPromise?(channelId: string): Promise<void> | null;
}

export interface ObservedGroupMemorySchedulerOptions {
  groupMemory?: GroupMemorySettings;
  channelGroupMemory?: ChannelGroupMemoryConfig;
  sessionReader: GroupMemoryRangeSessionReader & GroupMemorySessionReader;
  watermarkStore: GroupMemoryWatermarkStorePort & GroupMemoryFailedWatermarkSource;
  memoryExtractor: ObservedGroupMemoryExtractorPort;
  /** scheduler.json groupMemoryExtraction.failureRetry. */
  failureRetry: GroupMemoryExtractionFailureRetryConfig;
  onRangeFailure?: (event: GroupMemoryRangeFailureEvent) => void;
  contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'>;
  companionNames?: readonly string[];
  companionAuthorIds?: readonly string[];
  nowMs?: () => number;
  estimateEntryTokens?: (entry: GroupMemoryRangeChunk['entries'][number]) => number;
}

const MINUTE_MS = 60_000;

export class ObservedGroupMemoryScheduler {
  private readonly groupMemory?: GroupMemorySettings;
  private readonly channelGroupMemory?: ChannelGroupMemoryConfig;
  private readonly sessionReader: GroupMemoryRangeSessionReader & GroupMemorySessionReader;
  private readonly watermarkStore: GroupMemoryWatermarkStorePort & GroupMemoryFailedWatermarkSource;
  private readonly memoryExtractor: ObservedGroupMemoryExtractorPort;
  private readonly failureRetry: GroupMemoryExtractionFailureRetryConfig;
  private readonly onRangeFailure?: (event: GroupMemoryRangeFailureEvent) => void;
  private readonly contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'>;
  private readonly companionNames: readonly string[];
  private readonly companionAuthorIds: readonly string[];
  private readonly nowMs: () => number;
  private readonly estimateEntryTokens?: (entry: GroupMemoryRangeChunk['entries'][number]) => number;
  private readonly lastScheduledAtByChannel = new Map<string, number>();
  private readonly firstPendingObservedAtByChannel = new Map<string, number>();
  /**
   * Channels whose last attempt the model budget refused (zwwo0). Nothing is
   * written to their watermark, so the sweep re-probes them from here; after a
   * restart they recover on their next traffic or recorded-failure retry.
   */
  private readonly budgetDeferredChannels = new Set<string>();
  private readonly budgetDeferral: ModelRefusalDeferralWindow;

  constructor(options: ObservedGroupMemorySchedulerOptions) {
    this.groupMemory = options.groupMemory;
    this.channelGroupMemory = options.channelGroupMemory;
    this.sessionReader = options.sessionReader;
    this.watermarkStore = options.watermarkStore;
    this.memoryExtractor = options.memoryExtractor;
    if (options.failureRetry.maxAttempts < 1 || options.failureRetry.baseDelayMinutes < 1) {
      throw new Error('ObservedGroupMemoryScheduler requires a positive failure retry policy');
    }
    this.failureRetry = options.failureRetry;
    this.onRangeFailure = options.onRangeFailure;
    this.contactStore = options.contactStore;
    this.companionNames = options.companionNames ?? [];
    this.companionAuthorIds = options.companionAuthorIds ?? [];
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.budgetDeferral = new ModelRefusalDeferralWindow('group_extraction', this.nowMs);
    this.estimateEntryTokens = options.estimateEntryTokens;
  }

  /**
   * Canonical direct-vs-group memory scope for a channel, shared by group
   * extraction scheduling and other group-aware maintenance (e.g. sleeptime
   * cadence). Reuses the same memoryMode/topology classification pipeline as
   * observed extraction — do not add parallel detection paths.
   *
   * `group_capable_direct_tail` maps to 'group' to match observeMessage, which
   * only treats an explicit 'direct' classification as not-group.
   */
  async classifyChannelMemoryScope(
    message: Pick<SubstrateMessage, 'channelId' | 'channelType'>,
  ): Promise<'direct' | 'group'> {
    const settings = this.resolveSettingsForChannel(message.channelId);
    if (!settings.enabled) {
      return 'direct';
    }
    const classification = await this.classifyChannel(message, settings);
    return classification.mode === 'direct' ? 'direct' : 'group';
  }

  private resolveSettingsForChannel(channelId: string): GroupMemorySettings {
    return resolveGroupMemorySettingsForChannel({
      base: this.groupMemory,
      channelConfig: this.channelGroupMemory,
      channelId,
    }).settings;
  }

  private async classifyChannel(
    message: Pick<SubstrateMessage, 'channelId' | 'channelType'>,
    settings: GroupMemorySettings,
  ): Promise<Awaited<ReturnType<typeof classifyGroupMemoryChannel>>> {
    const recentEntries = await this.sessionReader.getRecent(
      message.channelId,
      settings.autoDetection.recentParticipantWindowMessages,
    );
    return await classifyGroupMemoryChannel({
      channelId: message.channelId,
      channelType: message.channelType,
      groupMemory: settings,
      recentEntries,
      contactStore: this.contactStore,
      companionAuthorIds: this.companionAuthorIds,
    });
  }

  async observeMessage(
    message: SubstrateMessage,
  ): Promise<ObservedGroupMemoryScheduleDecision> {
    const settings = this.resolveSettingsForChannel(message.channelId);
    if (!settings.enabled) {
      return {
        status: 'skipped',
        channelId: message.channelId,
        reason: 'disabled',
      };
    }

    const classification = await this.classifyChannel(message, settings);
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

    const plan = this.planRange(message.channelId, settings);
    const chunk = plan.chunks[0];
    if (chunk === undefined) {
      return {
        status: 'skipped',
        channelId: message.channelId,
        reason: 'no_backlog',
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
      };
    }

    const now = this.nowMs();
    // A failing range honours its backoff for traffic-triggered attempts too,
    // so a busy room cannot hammer a persistently failing extraction.
    const backoffRemainingMs = plan.watermark.status === 'failed'
      ? (plan.watermark.nextFailureRetryAt ?? 0) - now
      : 0;
    if (backoffRemainingMs > 0) {
      return {
        status: 'skipped',
        channelId: message.channelId,
        reason: 'failure_backoff',
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
        cooldownRemainingMs: backoffRemainingMs,
      };
    }
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

    return await this.extractChunk(message.channelId, triggerReason, plan, chunk, settings, now);
  }

  /**
   * Channels whose failed range is due for a bounded timed retry (d5e0p.15),
   * plus ranges the model budget deferred (zwwo0). Legacy failed records
   * without retry state are due immediately.
   */
  listDueFailureRetries(): string[] {
    const now = this.nowMs();
    const due = new Set(this.watermarkStore.listFailed()
      .filter(record => isGroupMemoryFailureRetryDue(record, now))
      .map(record => record.channelId));
    for (const channelId of this.budgetDeferredChannels) due.add(channelId);
    return [...due].filter(channelId => this.resolveSettingsForChannel(channelId).enabled);
  }

  /**
   * Timed retry of a channel's failed range without new traffic. The range is
   * re-planned from the watermark (not replayed from the stored span) and run
   * as backlog recovery. Channel classification is not re-run: a failed group
   * watermark exists only for a channel already classified as a group room,
   * and the retry has no observed message to classify.
   */
  async retryFailedRange(channelId: string): Promise<ObservedGroupMemoryScheduleDecision> {
    const settings = this.resolveSettingsForChannel(channelId);
    if (!settings.enabled) {
      return { status: 'skipped', channelId, reason: 'disabled' };
    }
    if (this.memoryExtractor.getPendingExtractionPromise?.(channelId)) {
      return { status: 'skipped', channelId, reason: 'in_flight' };
    }
    const plan = this.planRange(channelId, settings);
    const now = this.nowMs();
    const budgetDeferred = this.budgetDeferredChannels.has(channelId)
      && plan.watermark.failureRetryExhaustedAt === undefined;
    if (!budgetDeferred && !isGroupMemoryFailureRetryDue(plan.watermark, now)) {
      this.budgetDeferredChannels.delete(channelId);
      return {
        status: 'skipped',
        channelId,
        reason: 'failure_backoff',
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
      };
    }
    const chunk = plan.chunks[0];
    if (chunk === undefined) {
      this.budgetDeferredChannels.delete(channelId);
      return {
        status: 'skipped',
        channelId,
        reason: 'no_backlog',
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
      };
    }
    return await this.extractChunk(channelId, 'backlog_lag', plan, chunk, settings, now);
  }

  private planRange(channelId: string, settings: GroupMemorySettings): GroupMemoryRangePlan {
    return buildGroupMemoryRangePlan({
      channelId,
      sessionReader: this.sessionReader,
      watermarkStore: this.watermarkStore,
      settings,
      ...(this.estimateEntryTokens ? { estimateEntryTokens: this.estimateEntryTokens } : {}),
    });
  }

  private async extractChunk(
    channelId: string,
    triggerReason: ObservedGroupMemoryTriggerReason,
    plan: GroupMemoryRangePlan,
    chunk: GroupMemoryRangeChunk,
    settings: GroupMemorySettings,
    now: number,
  ): Promise<ObservedGroupMemoryScheduleDecision> {
    try {
      const accepted = await this.memoryExtractor.extractObservedGroupRange({
        channelId,
        triggerReason,
        recoveredEntries: chunk.entries,
        groupWriteCaps: settings.writeCaps,
        backfill: triggerReason === 'backlog_lag' || plan.hasDeferredBacklog,
      });
      if (!accepted) {
        return {
          status: 'skipped',
          channelId,
          reason: 'extractor_rejected',
          watermarkLagMessageIds: plan.watermarkLagMessageIds,
        };
      }
      this.budgetDeferredChannels.delete(channelId);
      this.budgetDeferral.noteAdmitted();
      this.watermarkStore.markProcessed({
        channelId,
        startMessageId: chunk.spanStartMessageId,
        endMessageId: chunk.spanEndMessageId,
        entryCount: chunk.newEntryCount,
        recordedAt: now,
      });
      this.lastScheduledAtByChannel.set(channelId, now);
      this.firstPendingObservedAtByChannel.delete(channelId);
      return {
        status: 'scheduled',
        channelId,
        triggerReason,
        spanStartMessageId: chunk.spanStartMessageId,
        spanEndMessageId: chunk.spanEndMessageId,
        newEntryCount: chunk.newEntryCount,
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
        hasDeferredBacklog: plan.hasDeferredBacklog,
      };
    } catch (error) {
      const refusal = findModelBudgetRefusal(error);
      if (refusal) {
        // zwwo0: refused before dispatch, so no evidence against the range:
        // nothing is recorded on its watermark and no attempt is consumed.
        this.budgetDeferredChannels.add(channelId);
        this.budgetDeferral.noteRefusal(refusal, { channelId, triggerReason });
        return {
          status: 'skipped',
          channelId,
          reason: 'model_budget_deferred',
          watermarkLagMessageIds: plan.watermarkLagMessageIds,
        };
      }
      this.budgetDeferredChannels.delete(channelId);
      // The extractor wraps its root cause (ExtractionIntegrityError.cause);
      // keep the whole chain so the durable record outlives pod logs.
      const errorText = formatErrorCauseChain(error);
      const { maxAttempts, baseDelayMinutes } = this.failureRetry;
      const attemptCount = (plan.watermark.consecutiveFailureCount ?? 0) + 1;
      const backoffExponent = Math.min(attemptCount, maxAttempts) - 1;
      this.watermarkStore.markFailed({
        channelId,
        startMessageId: chunk.spanStartMessageId,
        endMessageId: chunk.spanEndMessageId,
        entryCount: chunk.newEntryCount,
        recordedAt: now,
        error: errorText,
        retry: {
          consecutiveFailureCount: attemptCount,
          nextRetryAt: now + baseDelayMinutes * MINUTE_MS * 2 ** backoffExponent,
          exhausted: attemptCount >= maxAttempts,
        },
      });
      this.onRangeFailure?.({
        channelId,
        attemptCount,
        maxAttempts,
        terminal: attemptCount === maxAttempts,
        timestamp: now,
      });
      return {
        status: 'skipped',
        channelId,
        reason: 'extraction_failed',
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
        error: errorText,
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
