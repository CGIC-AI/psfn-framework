import type { ChannelType } from '../../../shared/contracts/runtime.js';
import { inferSessionChannelType } from '../../../core/session/session-id.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import {
  type ChannelGroupMemoryConfig,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import type { ObservedGroupExtractionOptions } from '../extraction.js';
import {
  buildGroupMemoryRangePlan,
  createEmptyWatermark,
  type GroupMemoryRangeChunk,
  type GroupMemoryRangeSessionReader,
  type GroupMemoryWatermarkRecord,
  type GroupMemoryWatermarkStorePort,
} from './group-ranges.js';
import {
  classifyGroupMemoryChannel,
  resolveGroupMemorySettingsForChannel,
  type GroupMemoryClassification,
  type GroupMemorySessionReader,
} from './group-classifier.js';
import {
  selectGroupMemorySalienceCandidates,
  type GroupMemorySalienceTelemetry,
} from './group-salience.js';

export type GroupMemoryBackfillMode = 'dry_run' | 'live';
export type GroupMemoryBackfillStatus = 'planned' | 'completed' | 'skipped' | 'failed';

export interface GroupMemoryBackfillInput {
  mode?: GroupMemoryBackfillMode;
  dryRun?: boolean;
  startMessageId?: number;
  endMessageId?: number;
  startTimestamp?: number;
  endTimestamp?: number;
  resume?: boolean;
  maxMessagesPerRun?: number;
  maxChunksPerRun?: number;
  maxLlmCallsPerRun?: number;
}

export interface GroupMemoryBackfillExtractorPort {
  extractGroupBackfillRange(options: Omit<
    ObservedGroupExtractionOptions,
    'triggerReason' | 'backfill'
  >): Promise<boolean>;
  getPendingExtractionPromise?(channelId: string): Promise<void> | null;
}

export interface GroupMemoryBackfillRunnerOptions {
  groupMemory?: GroupMemorySettings;
  channelGroupMemory?: ChannelGroupMemoryConfig;
  sessionReader: GroupMemoryRangeSessionReader & GroupMemorySessionReader;
  watermarkStore: GroupMemoryWatermarkStorePort;
  memoryExtractor?: GroupMemoryBackfillExtractorPort | null;
  contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'>;
  companionNames?: readonly string[];
  companionAuthorIds?: readonly string[];
  nowMs?: () => number;
  estimateEntryTokens?: (entry: GroupMemoryRangeChunk['entries'][number]) => number;
}

export interface GroupMemoryBackfillTargetView {
  channelId: string;
  channelType: ChannelType;
  mode: GroupMemoryBackfillMode;
  resume: boolean;
  startMessageId: number;
  endMessageId: number | null;
  startTimestamp?: number;
  endTimestamp?: number;
}

export interface GroupMemoryBackfillChunkView {
  spanStartMessageId: number;
  spanEndMessageId: number;
  contextStartMessageId: number;
  contextEndMessageId: number;
  newEntryCount: number;
  overlapEntryCount: number;
  estimatedTokens: number;
  candidateSpanCount: number;
  candidateSourceMessageIds: number[];
  extractionEntryCount: number;
  estimatedLlmCalls: number;
  action: 'planned' | 'processed' | 'skipped' | 'failed';
  skipReason?: string;
  error?: string;
  salienceTelemetry: GroupMemorySalienceTelemetry;
}

export interface GroupMemoryBackfillResult {
  status: GroupMemoryBackfillStatus;
  channelId: string;
  target: GroupMemoryBackfillTargetView;
  resolvedConfig: GroupMemorySettings;
  classification: GroupMemoryClassification;
  watermarkBefore: GroupMemoryWatermarkRecord;
  watermarkAfter: GroupMemoryWatermarkRecord;
  headMessageId: number | null;
  watermarkLagMessageIds: number;
  hasDeferredBacklog: boolean;
  deferredAfterMessageId?: number;
  plannedChunkCount: number;
  plannedLlmCalls: number;
  executedLlmCalls: number;
  processedChunkCount: number;
  skippedChunkCount: number;
  failedChunkCount: number;
  candidateSpanCount: number;
  chunks: GroupMemoryBackfillChunkView[];
  privacy: {
    rawTranscriptTextIncluded: false;
    memoryTextIncluded: false;
  };
}

interface EffectiveBackfillPolicy {
  settings: GroupMemorySettings;
  requested: Required<Pick<GroupMemoryBackfillInput, 'maxMessagesPerRun' | 'maxChunksPerRun' | 'maxLlmCallsPerRun'>>;
}

export class GroupMemoryBackfillRunner {
  private readonly groupMemory?: GroupMemorySettings;
  private readonly channelGroupMemory?: ChannelGroupMemoryConfig;
  private readonly sessionReader: GroupMemoryRangeSessionReader & GroupMemorySessionReader;
  private readonly watermarkStore: GroupMemoryWatermarkStorePort;
  private readonly memoryExtractor?: GroupMemoryBackfillExtractorPort | null;
  private readonly contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'>;
  private readonly companionNames: readonly string[];
  private readonly companionAuthorIds: readonly string[];
  private readonly nowMs: () => number;
  private readonly estimateEntryTokens?: (entry: GroupMemoryRangeChunk['entries'][number]) => number;

  constructor(options: GroupMemoryBackfillRunnerOptions) {
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

  async run(channelId: string, input: GroupMemoryBackfillInput = {}): Promise<GroupMemoryBackfillResult> {
    const mode = resolveBackfillMode(input);
    const channelType = resolveBackfillChannelType(channelId);
    const resolved = resolveGroupMemorySettingsForChannel({
      base: this.groupMemory,
      channelConfig: this.channelGroupMemory,
      channelId,
    });
    const policy = resolveEffectiveBackfillPolicy(resolved.settings, input);
    const settings = policy.settings;
    const resume = input.resume ?? true;
    const target = resolveTarget({
      channelId,
      channelType,
      input,
      sessionReader: this.sessionReader,
    });
    const targetReader = createTargetRangeReader(this.sessionReader, target);
    const watermarkBefore = this.watermarkStore.get(channelId);
    const effectiveWatermark = resolveEffectiveWatermark({
      channelId,
      watermark: watermarkBefore,
      target,
      resume,
    });
    const recentEntries = await this.sessionReader.getRecent(
      channelId,
      settings.autoDetection.recentParticipantWindowMessages,
    );
    const classification = await classifyGroupMemoryChannel({
      channelId,
      channelType,
      groupMemory: settings,
      recentEntries,
      contactStore: this.contactStore,
      companionAuthorIds: this.companionAuthorIds,
    });
    const plan = buildGroupMemoryRangePlan({
      channelId,
      sessionReader: targetReader,
      watermark: effectiveWatermark,
      settings,
      ...(this.estimateEntryTokens ? { estimateEntryTokens: this.estimateEntryTokens } : {}),
    });

    const targetView: GroupMemoryBackfillTargetView = {
      channelId,
      channelType,
      mode,
      resume,
      startMessageId: target.startMessageId,
      endMessageId: target.endMessageId,
      ...(target.startTimestamp !== undefined ? { startTimestamp: target.startTimestamp } : {}),
      ...(target.endTimestamp !== undefined ? { endTimestamp: target.endTimestamp } : {}),
    };

    if (!settings.enabled || classification.mode === 'direct' || plan.chunks.length === 0) {
      return buildBackfillResult({
        status: 'skipped',
        channelId,
        target: targetView,
        settings,
        classification,
        watermarkBefore,
        watermarkAfter: watermarkBefore,
        headMessageId: plan.headMessageId,
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
        hasDeferredBacklog: plan.hasDeferredBacklog,
        deferredAfterMessageId: plan.deferredAfterMessageId,
        chunks: [],
      });
    }

    if (mode === 'live' && this.memoryExtractor?.getPendingExtractionPromise?.(channelId)) {
      return buildBackfillResult({
        status: 'skipped',
        channelId,
        target: targetView,
        settings,
        classification,
        watermarkBefore,
        watermarkAfter: watermarkBefore,
        headMessageId: plan.headMessageId,
        watermarkLagMessageIds: plan.watermarkLagMessageIds,
        hasDeferredBacklog: plan.hasDeferredBacklog,
        deferredAfterMessageId: plan.deferredAfterMessageId,
        chunks: [],
      });
    }

    const chunkViews: GroupMemoryBackfillChunkView[] = [];
    let watermarkAfter = watermarkBefore;
    let failed = false;
    for (const chunk of plan.chunks) {
      const salience = selectGroupMemorySalienceCandidates({
        chunk,
        settings,
        companionNames: this.companionNames,
        companionAuthorIds: this.companionAuthorIds,
      });
      const extractionEntries = selectExtractionEntries(chunk.entries, salience.candidateSpans);
      const baseView = buildChunkView({
        chunk,
        salienceTelemetry: salience.telemetry,
        candidateSourceMessageIds: salience.candidateSpans.flatMap(span => span.sourceMessageIds),
        candidateSpanCount: salience.candidateSpans.length,
        extractionEntryCount: extractionEntries.length,
        estimatedLlmCalls: extractionEntries.length > 0 ? 1 : 0,
      });

      if (mode === 'dry_run') {
        chunkViews.push({
          ...baseView,
          action: extractionEntries.length > 0 ? 'planned' : 'skipped',
          ...(extractionEntries.length === 0 ? { skipReason: 'no_salient_candidates' } : {}),
        });
        continue;
      }

      if (extractionEntries.length === 0) {
        watermarkAfter = this.watermarkStore.markSkipped({
          channelId,
          startMessageId: chunk.spanStartMessageId,
          endMessageId: chunk.spanEndMessageId,
          entryCount: chunk.newEntryCount,
          recordedAt: this.nowMs(),
          reason: 'no_salient_candidates',
        });
        chunkViews.push({
          ...baseView,
          action: 'skipped',
          skipReason: 'no_salient_candidates',
        });
        continue;
      }

      if (!this.memoryExtractor) {
        throw new Error('Group memory live backfill requires a memory extractor');
      }

      try {
        const accepted = await this.memoryExtractor.extractGroupBackfillRange({
          channelId,
          recoveredEntries: extractionEntries,
          groupWriteCaps: settings.writeCaps,
        });
        if (!accepted) {
          watermarkAfter = this.watermarkStore.markFailed({
            channelId,
            startMessageId: chunk.spanStartMessageId,
            endMessageId: chunk.spanEndMessageId,
            entryCount: chunk.newEntryCount,
            recordedAt: this.nowMs(),
            error: 'memory extractor rejected backfill range',
          });
          chunkViews.push({
            ...baseView,
            action: 'failed',
            error: 'memory extractor rejected backfill range',
          });
          failed = true;
          break;
        }
        watermarkAfter = this.watermarkStore.markProcessed({
          channelId,
          startMessageId: chunk.spanStartMessageId,
          endMessageId: chunk.spanEndMessageId,
          entryCount: chunk.newEntryCount,
          recordedAt: this.nowMs(),
        });
        chunkViews.push({
          ...baseView,
          action: 'processed',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        watermarkAfter = this.watermarkStore.markFailed({
          channelId,
          startMessageId: chunk.spanStartMessageId,
          endMessageId: chunk.spanEndMessageId,
          entryCount: chunk.newEntryCount,
          recordedAt: this.nowMs(),
          error: message,
        });
        chunkViews.push({
          ...baseView,
          action: 'failed',
          error: message,
        });
        failed = true;
        break;
      }
    }

    return buildBackfillResult({
      status: mode === 'dry_run' ? 'planned' : (failed ? 'failed' : 'completed'),
      channelId,
      target: targetView,
      settings,
      classification,
      watermarkBefore,
      watermarkAfter,
      headMessageId: plan.headMessageId,
      watermarkLagMessageIds: plan.watermarkLagMessageIds,
      hasDeferredBacklog: plan.hasDeferredBacklog,
      deferredAfterMessageId: plan.deferredAfterMessageId,
      chunks: chunkViews,
    });
  }
}

function resolveBackfillMode(input: GroupMemoryBackfillInput): GroupMemoryBackfillMode {
  if (input.mode) return input.mode;
  return input.dryRun === false ? 'live' : 'dry_run';
}

function resolveBackfillChannelType(channelId: string): ChannelType {
  const inferred = inferSessionChannelType(channelId);
  if (!inferred || inferred === 'subagent') {
    throw new Error(`Cannot infer group-memory backfill channel type for ${channelId}`);
  }
  return inferred;
}

function resolveEffectiveBackfillPolicy(
  settings: GroupMemorySettings,
  input: GroupMemoryBackfillInput,
): EffectiveBackfillPolicy {
  const maxMessagesPerRun = normalizePolicyBound({
    name: 'maxMessagesPerRun',
    requested: input.maxMessagesPerRun,
    ceiling: settings.backfill.maxMessagesPerRun,
  });
  const maxChunksPerRun = normalizePolicyBound({
    name: 'maxChunksPerRun',
    requested: input.maxChunksPerRun,
    ceiling: settings.backfill.maxChunksPerRun,
  });
  const maxLlmCallsPerRun = normalizePolicyBound({
    name: 'maxLlmCallsPerRun',
    requested: input.maxLlmCallsPerRun,
    ceiling: settings.backfill.maxLlmCallsPerRun,
  });
  const chunkSize = Math.min(
    settings.onlineExtraction.maxMessagesPerChunk,
    maxMessagesPerRun,
  );
  const chunksByMessageBudget = Math.max(1, Math.floor(maxMessagesPerRun / chunkSize));
  const effectiveChunkCount = Math.max(
    1,
    Math.min(maxChunksPerRun, maxLlmCallsPerRun, chunksByMessageBudget),
  );

  return {
    requested: {
      maxMessagesPerRun,
      maxChunksPerRun,
      maxLlmCallsPerRun,
    },
    settings: {
      ...settings,
      onlineExtraction: {
        ...settings.onlineExtraction,
        maxMessagesPerChunk: chunkSize,
        maxBacklogChunksPerRun: effectiveChunkCount,
      },
    },
  };
}

function normalizePolicyBound(params: {
  name: string;
  requested?: number;
  ceiling: number;
}): number {
  if (params.requested === undefined) return params.ceiling;
  if (!Number.isInteger(params.requested) || params.requested < 1) {
    throw new Error(`Invalid group memory backfill ${params.name}: expected positive integer`);
  }
  if (params.requested > params.ceiling) {
    throw new Error(
      `Invalid group memory backfill ${params.name}: ${params.requested} exceeds configured limit ${params.ceiling}`,
    );
  }
  return params.requested;
}

function resolveTarget(params: {
  channelId: string;
  channelType: ChannelType;
  input: GroupMemoryBackfillInput;
  sessionReader: GroupMemoryRangeSessionReader;
}): BackfillTarget {
  const head = params.sessionReader.getLastEntry(params.channelId);
  const requestedStart = normalizeOptionalMessageId(params.input.startMessageId, 'startMessageId');
  const requestedEnd = normalizeOptionalMessageId(params.input.endMessageId, 'endMessageId');
  const startMessageId = requestedStart ?? 1;
  const endMessageId = requestedEnd ?? head?.id ?? null;
  if (endMessageId !== null && endMessageId < startMessageId) {
    throw new Error('Invalid group memory backfill range: endMessageId must be >= startMessageId');
  }
  const startTimestamp = normalizeOptionalTimestamp(params.input.startTimestamp, 'startTimestamp');
  const endTimestamp = normalizeOptionalTimestamp(params.input.endTimestamp, 'endTimestamp');
  if (
    startTimestamp !== undefined
    && endTimestamp !== undefined
    && endTimestamp < startTimestamp
  ) {
    throw new Error('Invalid group memory backfill range: endTimestamp must be >= startTimestamp');
  }

  return {
    channelId: params.channelId,
    channelType: params.channelType,
    startMessageId,
    endMessageId,
    ...(startTimestamp !== undefined ? { startTimestamp } : {}),
    ...(endTimestamp !== undefined ? { endTimestamp } : {}),
  };
}

function normalizeOptionalMessageId(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid group memory backfill ${name}: expected positive integer`);
  }
  return value;
}

function normalizeOptionalTimestamp(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid group memory backfill ${name}: expected non-negative timestamp`);
  }
  return value;
}

interface BackfillTarget {
  channelId: string;
  channelType: ChannelType;
  startMessageId: number;
  endMessageId: number | null;
  startTimestamp?: number;
  endTimestamp?: number;
}

function createTargetRangeReader(
  sessionReader: GroupMemoryRangeSessionReader,
  target: BackfillTarget,
): GroupMemoryRangeSessionReader {
  return {
    getLastEntry: channelId => readTargetEntries(sessionReader, channelId, target).at(-1),
    getEntriesAfter: (channelId, afterId, limit) => readTargetEntries(
      sessionReader,
      channelId,
      {
        ...target,
        startMessageId: Math.max(target.startMessageId, afterId + 1),
      },
    ).slice(0, limit),
    getEntriesInRange: (channelId, startId, endId) => readTargetEntries(
      sessionReader,
      channelId,
      {
        ...target,
        startMessageId: Math.max(target.startMessageId, startId),
        endMessageId: Math.min(target.endMessageId ?? endId, endId),
      },
    ),
  };
}

function readTargetEntries(
  sessionReader: GroupMemoryRangeSessionReader,
  channelId: string,
  target: BackfillTarget,
): SessionEntry[] {
  const head = sessionReader.getLastEntry(channelId);
  const endMessageId = target.endMessageId ?? head?.id ?? 0;
  if (endMessageId < target.startMessageId) return [];
  return sessionReader
    .getEntriesInRange(channelId, target.startMessageId, endMessageId)
    .filter(entry => entry.id >= target.startMessageId && entry.id <= endMessageId)
    .filter(entry => target.startTimestamp === undefined || entry.timestamp >= target.startTimestamp)
    .filter(entry => target.endTimestamp === undefined || entry.timestamp <= target.endTimestamp)
    .sort((left, right) => left.id - right.id);
}

function resolveEffectiveWatermark(params: {
  channelId: string;
  watermark: GroupMemoryWatermarkRecord;
  target: BackfillTarget;
  resume: boolean;
}): GroupMemoryWatermarkRecord {
  const rangeStartWatermark = createEmptyWatermark(params.channelId);
  const coveredUpToMessageId = params.target.startMessageId - 1;
  return {
    ...(params.resume ? params.watermark : rangeStartWatermark),
    coveredUpToMessageId: Math.max(
      coveredUpToMessageId,
      params.resume ? params.watermark.coveredUpToMessageId : coveredUpToMessageId,
    ),
  };
}

function selectExtractionEntries(
  entries: readonly SessionEntry[],
  spans: readonly { contextMessageIds: readonly number[] }[],
): SessionEntry[] {
  const selectedIds = new Set(spans.flatMap(span => [...span.contextMessageIds]));
  return entries
    .filter(entry => selectedIds.has(entry.id))
    .sort((left, right) => left.id - right.id);
}

function buildChunkView(params: {
  chunk: GroupMemoryRangeChunk;
  salienceTelemetry: GroupMemorySalienceTelemetry;
  candidateSpanCount: number;
  candidateSourceMessageIds: number[];
  extractionEntryCount: number;
  estimatedLlmCalls: number;
}): Omit<GroupMemoryBackfillChunkView, 'action' | 'skipReason' | 'error'> {
  return {
    spanStartMessageId: params.chunk.spanStartMessageId,
    spanEndMessageId: params.chunk.spanEndMessageId,
    contextStartMessageId: params.chunk.contextStartMessageId,
    contextEndMessageId: params.chunk.contextEndMessageId,
    newEntryCount: params.chunk.newEntryCount,
    overlapEntryCount: params.chunk.overlapEntryCount,
    estimatedTokens: params.chunk.estimatedTokens,
    candidateSpanCount: params.candidateSpanCount,
    candidateSourceMessageIds: [...new Set(params.candidateSourceMessageIds)].sort((left, right) => left - right),
    extractionEntryCount: params.extractionEntryCount,
    estimatedLlmCalls: params.estimatedLlmCalls,
    salienceTelemetry: params.salienceTelemetry,
  };
}

function buildBackfillResult(params: {
  status: GroupMemoryBackfillStatus;
  channelId: string;
  target: GroupMemoryBackfillTargetView;
  settings: GroupMemorySettings;
  classification: GroupMemoryClassification;
  watermarkBefore: GroupMemoryWatermarkRecord;
  watermarkAfter: GroupMemoryWatermarkRecord;
  headMessageId: number | null;
  watermarkLagMessageIds: number;
  hasDeferredBacklog: boolean;
  deferredAfterMessageId?: number;
  chunks: GroupMemoryBackfillChunkView[];
}): GroupMemoryBackfillResult {
  return {
    status: params.status,
    channelId: params.channelId,
    target: params.target,
    resolvedConfig: params.settings,
    classification: params.classification,
    watermarkBefore: params.watermarkBefore,
    watermarkAfter: params.watermarkAfter,
    headMessageId: params.headMessageId,
    watermarkLagMessageIds: params.watermarkLagMessageIds,
    hasDeferredBacklog: params.hasDeferredBacklog,
    ...(params.deferredAfterMessageId !== undefined ? { deferredAfterMessageId: params.deferredAfterMessageId } : {}),
    plannedChunkCount: params.chunks.length,
    plannedLlmCalls: params.chunks.reduce((total, chunk) => total + chunk.estimatedLlmCalls, 0),
    executedLlmCalls: params.chunks
      .filter(chunk => chunk.action === 'processed')
      .reduce((total, chunk) => total + chunk.estimatedLlmCalls, 0),
    processedChunkCount: params.chunks.filter(chunk => chunk.action === 'processed').length,
    skippedChunkCount: params.chunks.filter(chunk => chunk.action === 'skipped').length,
    failedChunkCount: params.chunks.filter(chunk => chunk.action === 'failed').length,
    candidateSpanCount: params.chunks.reduce((total, chunk) => total + chunk.candidateSpanCount, 0),
    chunks: params.chunks,
    privacy: {
      rawTranscriptTextIncluded: false,
      memoryTextIncluded: false,
    },
  };
}
