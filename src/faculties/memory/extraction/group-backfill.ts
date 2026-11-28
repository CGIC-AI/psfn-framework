import type { ChannelType } from '../../../shared/contracts/runtime.js';
import { inferSessionChannelType } from '../../../core/session/session-id.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import {
  COMPANION_CHANNEL_TYPE,
  parseCompanionChannelId,
} from '../../../shared/contracts/companion-channels.js';
import type { SessionCounterpartyContactStore } from '../session-counterparty-resolution.js';
import {
  type ChannelGroupMemoryConfig,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import type { ObservedGroupExtractionOptions } from '../extraction.js';
import {
  buildGroupMemoryRangePlan,
  createEmptyWatermark,
  GROUP_MEMORY_POLICY_VERSION,
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
import {
  capDirectBackfillChunkSize,
  DIRECT_BACKFILL_WATERMARK_VERSION,
  resolveBackfillChannelTopology,
  resolveDirectBackfillCounterparty,
  selectDirectBackfillEntries,
  summarizeDirectBackfillExtraction,
  type DirectBackfillExtractionView,
  type DirectBackfillExtractorPort,
} from './direct-backfill-lane.js';

export type GroupMemoryBackfillMode = 'dry_run' | 'live';
export type GroupMemoryBackfillStatus = 'planned' | 'completed' | 'skipped' | 'failed';
/** `direct` replays a 1:1 or companion-DM transcript through direct extraction. */
export type GroupMemoryBackfillLane = 'group' | 'direct';
export type GroupMemoryBackfillSkipReason =
  | 'group_memory_disabled'
  | 'no_unprocessed_entries'
  | 'extraction_in_flight'
  | 'direct_counterparty_unresolved';

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
  extractDirectBackfillRange?: DirectBackfillExtractorPort['extractDirectBackfillRange'];
  getPendingExtractionPromise?(channelId: string): Promise<void> | null;
}

export interface GroupMemoryBackfillRunnerOptions {
  groupMemory?: GroupMemorySettings;
  channelGroupMemory?: ChannelGroupMemoryConfig;
  sessionReader: GroupMemoryRangeSessionReader & GroupMemorySessionReader;
  watermarkStore: GroupMemoryWatermarkStorePort;
  memoryExtractor?: GroupMemoryBackfillExtractorPort | null;
  contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'> & SessionCounterpartyContactStore;
  /** This companion's id, so a companion-DM resolves its peer as the counterparty. */
  localCompanionId?: string;
  companionNames?: readonly string[];
  companionAuthorIds?: readonly string[];
  nowMs?: () => number;
  estimateEntryTokens?: (entry: GroupMemoryRangeChunk['entries'][number]) => number;
}

export interface GroupMemoryBackfillTargetView {
  channelId: string;
  channelType: ChannelType;
  lane: GroupMemoryBackfillLane;
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
  /** Group lane only: the direct lane extracts every conversational entry. */
  salienceTelemetry?: GroupMemorySalienceTelemetry;
  /** Direct lane, live chunks: what the normal extraction pipeline did. */
  extraction?: DirectBackfillExtractionView;
}

export interface GroupMemoryBackfillResult {
  status: GroupMemoryBackfillStatus;
  skipReason?: GroupMemoryBackfillSkipReason;
  channelId: string;
  target: GroupMemoryBackfillTargetView;
  /** Direct lane: the single contact the replayed facts are attributed from. */
  counterpartyContactId?: string;
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
  private readonly contactStore?: GroupMemoryBackfillRunnerOptions['contactStore'];
  private readonly localCompanionId?: string;
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
    this.localCompanionId = options.localCompanionId;
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
    const resume = input.resume ?? true;
    const target = resolveTarget({
      channelId,
      channelType,
      input,
      sessionReader: this.sessionReader,
    });
    const targetReader = createTargetRangeReader(this.sessionReader, target);
    const recentEntries = await this.sessionReader.getRecent(
      channelId,
      resolved.settings.autoDetection.recentParticipantWindowMessages,
    );
    const channelTopology = resolveBackfillChannelTopology(channelId, recentEntries);
    const classification = await classifyGroupMemoryChannel({
      channelId,
      channelType,
      groupMemory: resolved.settings,
      recentEntries,
      contactStore: this.contactStore,
      companionAuthorIds: this.companionAuthorIds,
      ...(channelTopology ? { channelTopology } : {}),
    });
    // A disabled group-memory setting classifies every channel as direct; that
    // is a refusal of the group lane, not topology evidence for the direct one.
    const lane: GroupMemoryBackfillLane = classification.mode === 'direct' && classification.reason !== 'disabled'
      ? 'direct'
      : 'group';
    const settings = resolveEffectiveBackfillPolicy(resolved.settings, input, lane).settings;
    const policyVersion = lane === 'direct' ? DIRECT_BACKFILL_WATERMARK_VERSION : GROUP_MEMORY_POLICY_VERSION;
    const watermarkBefore = this.watermarkStore.get(channelId, policyVersion);
    const effectiveWatermark = resolveEffectiveWatermark({
      channelId,
      policyVersion,
      watermark: watermarkBefore,
      target,
      resume,
    });
    const plan = buildGroupMemoryRangePlan({
      channelId,
      sessionReader: targetReader,
      watermark: effectiveWatermark,
      settings,
      policyVersion,
      ...(this.estimateEntryTokens ? { estimateEntryTokens: this.estimateEntryTokens } : {}),
    });

    const targetView: GroupMemoryBackfillTargetView = {
      channelId,
      channelType,
      lane,
      mode,
      resume,
      startMessageId: target.startMessageId,
      endMessageId: target.endMessageId,
      ...(target.startTimestamp !== undefined ? { startTimestamp: target.startTimestamp } : {}),
      ...(target.endTimestamp !== undefined ? { endTimestamp: target.endTimestamp } : {}),
    };
    const resultBase = {
      channelId,
      target: targetView,
      settings,
      classification,
      watermarkBefore,
      headMessageId: plan.headMessageId,
      watermarkLagMessageIds: plan.watermarkLagMessageIds,
      hasDeferredBacklog: plan.hasDeferredBacklog,
      deferredAfterMessageId: plan.deferredAfterMessageId,
    };
    const skipped = (skipReason: GroupMemoryBackfillSkipReason, counterpartyContactId?: string) => (
      buildBackfillResult({
        ...resultBase,
        status: 'skipped',
        skipReason,
        ...(counterpartyContactId ? { counterpartyContactId } : {}),
        watermarkAfter: watermarkBefore,
        chunks: [],
      })
    );

    if (!settings.enabled) return skipped('group_memory_disabled');
    if (plan.chunks.length === 0) return skipped('no_unprocessed_entries');
    if (mode === 'live' && this.memoryExtractor?.getPendingExtractionPromise?.(channelId)) {
      return skipped('extraction_in_flight');
    }
    if (lane === 'direct') {
      const counterpartyContactId = await resolveDirectBackfillCounterparty({
        channelId,
        entries: plan.chunks.flatMap(chunk => chunk.newEntries),
        contactStore: this.contactStore,
        ...(this.localCompanionId ? { localCompanionId: this.localCompanionId } : {}),
        companionAuthorIds: this.companionAuthorIds,
      });
      if (!counterpartyContactId) return skipped('direct_counterparty_unresolved');
      return this.runChunks({
        ...resultBase,
        mode,
        policyVersion,
        plan,
        counterpartyContactId,
      });
    }
    return this.runChunks({ ...resultBase, mode, policyVersion, plan });
  }

  private async runChunks(params: {
    channelId: string;
    target: GroupMemoryBackfillTargetView;
    settings: GroupMemorySettings;
    classification: GroupMemoryClassification;
    watermarkBefore: GroupMemoryWatermarkRecord;
    headMessageId: number | null;
    watermarkLagMessageIds: number;
    hasDeferredBacklog: boolean;
    deferredAfterMessageId?: number;
    mode: GroupMemoryBackfillMode;
    policyVersion: string;
    plan: ReturnType<typeof buildGroupMemoryRangePlan>;
    counterpartyContactId?: string;
  }): Promise<GroupMemoryBackfillResult> {
    const { channelId, settings, mode, policyVersion } = params;
    const chunkViews: GroupMemoryBackfillChunkView[] = [];
    let watermarkAfter = params.watermarkBefore;
    let failed = false;
    for (const chunk of params.plan.chunks) {
      const prepared = this.prepareChunk(chunk, settings, params.target.lane);
      const span = {
        channelId,
        policyVersion,
        startMessageId: chunk.spanStartMessageId,
        endMessageId: chunk.spanEndMessageId,
        entryCount: chunk.newEntryCount,
      };
      const emptyReason = params.target.lane === 'direct' ? 'no_conversational_entries' : 'no_salient_candidates';

      if (mode === 'dry_run') {
        chunkViews.push({
          ...prepared.view,
          action: prepared.entries.length > 0 ? 'planned' : 'skipped',
          ...(prepared.entries.length === 0 ? { skipReason: emptyReason } : {}),
        });
        continue;
      }

      if (prepared.entries.length === 0) {
        watermarkAfter = this.watermarkStore.markSkipped({
          ...span,
          recordedAt: this.nowMs(),
          reason: emptyReason,
        });
        chunkViews.push({ ...prepared.view, action: 'skipped', skipReason: emptyReason });
        continue;
      }

      if (!this.memoryExtractor) {
        throw new Error('Memory live backfill requires a memory extractor');
      }

      try {
        const outcome = await this.extractChunk(channelId, prepared.entries, settings, params.counterpartyContactId);
        if (!outcome.accepted) {
          const error = 'memory extractor rejected backfill range';
          watermarkAfter = this.watermarkStore.markFailed({ ...span, recordedAt: this.nowMs(), error });
          chunkViews.push({ ...prepared.view, action: 'failed', error });
          failed = true;
          break;
        }
        watermarkAfter = this.watermarkStore.markProcessed({ ...span, recordedAt: this.nowMs() });
        chunkViews.push({
          ...prepared.view,
          action: 'processed',
          ...(outcome.extraction ? { extraction: outcome.extraction } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        watermarkAfter = this.watermarkStore.markFailed({ ...span, recordedAt: this.nowMs(), error: message });
        chunkViews.push({ ...prepared.view, action: 'failed', error: message });
        failed = true;
        break;
      }
    }

    return buildBackfillResult({
      ...params,
      status: mode === 'dry_run' ? 'planned' : (failed ? 'failed' : 'completed'),
      watermarkAfter,
      chunks: chunkViews,
    });
  }

  private prepareChunk(
    chunk: GroupMemoryRangeChunk,
    settings: GroupMemorySettings,
    lane: GroupMemoryBackfillLane,
  ): { entries: SessionEntry[]; view: Omit<GroupMemoryBackfillChunkView, 'action' | 'skipReason' | 'error'> } {
    if (lane === 'direct') {
      const entries = selectDirectBackfillEntries(chunk.newEntries);
      return {
        entries,
        view: buildChunkView({
          chunk,
          candidateSourceMessageIds: entries.map(entry => entry.id),
          candidateSpanCount: entries.length > 0 ? 1 : 0,
          extractionEntryCount: entries.length,
          estimatedLlmCalls: entries.length > 0 ? 1 : 0,
        }),
      };
    }
    const salience = selectGroupMemorySalienceCandidates({
      chunk,
      settings,
      companionNames: this.companionNames,
      companionAuthorIds: this.companionAuthorIds,
    });
    const entries = selectExtractionEntries(chunk.entries, salience.candidateSpans);
    return {
      entries,
      view: buildChunkView({
        chunk,
        salienceTelemetry: salience.telemetry,
        candidateSourceMessageIds: salience.candidateSpans.flatMap(span => span.sourceMessageIds),
        candidateSpanCount: salience.candidateSpans.length,
        extractionEntryCount: entries.length,
        estimatedLlmCalls: entries.length > 0 ? 1 : 0,
      }),
    };
  }

  private async extractChunk(
    channelId: string,
    entries: SessionEntry[],
    settings: GroupMemorySettings,
    counterpartyContactId: string | undefined,
  ): Promise<{ accepted: boolean; extraction?: DirectBackfillExtractionView }> {
    const extractor = this.memoryExtractor!;
    if (counterpartyContactId === undefined) {
      return {
        accepted: await extractor.extractGroupBackfillRange({
          channelId,
          recoveredEntries: entries,
          groupWriteCaps: settings.writeCaps,
        }),
      };
    }
    if (!extractor.extractDirectBackfillRange) {
      throw new Error('Direct memory backfill requires a direct-capable memory extractor');
    }
    const result = await extractor.extractDirectBackfillRange({
      channelId,
      recoveredEntries: entries,
      canonicalContactId: counterpartyContactId,
    });
    return { accepted: true, extraction: summarizeDirectBackfillExtraction(result) };
  }
}

function resolveBackfillMode(input: GroupMemoryBackfillInput): GroupMemoryBackfillMode {
  if (input.mode) return input.mode;
  return input.dryRun === false ? 'live' : 'dry_run';
}

function resolveBackfillChannelType(channelId: string): ChannelType {
  if (parseCompanionChannelId(channelId)?.kind === 'dm') return COMPANION_CHANNEL_TYPE;
  const inferred = inferSessionChannelType(channelId);
  if (!inferred || inferred === 'subagent') {
    throw new Error(`Cannot infer group-memory backfill channel type for ${channelId}`);
  }
  return inferred;
}

function resolveEffectiveBackfillPolicy(
  settings: GroupMemorySettings,
  input: GroupMemoryBackfillInput,
  lane: GroupMemoryBackfillLane,
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
  const configuredChunkSize = Math.min(
    settings.onlineExtraction.maxMessagesPerChunk,
    maxMessagesPerRun,
  );
  const chunkSize = lane === 'direct'
    ? capDirectBackfillChunkSize(configuredChunkSize)
    : configuredChunkSize;
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
  policyVersion: string;
  watermark: GroupMemoryWatermarkRecord;
  target: BackfillTarget;
  resume: boolean;
}): GroupMemoryWatermarkRecord {
  const rangeStartWatermark = createEmptyWatermark(params.channelId, params.policyVersion);
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
  salienceTelemetry?: GroupMemorySalienceTelemetry;
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
    ...(params.salienceTelemetry ? { salienceTelemetry: params.salienceTelemetry } : {}),
  };
}

function buildBackfillResult(params: {
  status: GroupMemoryBackfillStatus;
  skipReason?: GroupMemoryBackfillSkipReason;
  counterpartyContactId?: string;
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
    ...(params.skipReason ? { skipReason: params.skipReason } : {}),
    channelId: params.channelId,
    target: params.target,
    ...(params.counterpartyContactId ? { counterpartyContactId: params.counterpartyContactId } : {}),
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
