import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SensitivityLevel, MemoryType, MemoryProvenance } from '../memory/types.js';
import type { MemoryWriteOptions, WriteResult, MemoryWriter } from '../memory/writer.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import type { ArtifactReturnBatch } from './artifact-return-port.js';
import type { ShardReturnedArtifact } from './artifact-policy.js';
import { buildShardValidationPath, type StagedShardMemoryOutput } from './output-review.js';
import type { ShardResultLineageEnvelope } from './result-lineage.js';
import type { ShardTaggedOutput, ShardTaggedOutputReviewState } from './types.js';

const SHARD_FOLD_REVIEW_STORE_SCHEMA_VERSION = 1;
const EMOTIONAL_REVIEW_TAG = 'interpretive:emotional_or_relational';
const ARTIFACT_PENDING_REASON = 'artifact_output_pending_merge_review';
const MEMORY_PENDING_REASON = 'staged_shard_memory_pending_merge_review';
const EMOTIONAL_PENDING_REASON = 'emotional_or_relational_interpretation_requires_core_review';
const PROMOTION_UNAVAILABLE_REASON = 'fold_review_memory_promotion_unavailable';
const INVALID_MEMORY_CANDIDATE_REASON = 'fold_review_memory_candidate_invalid';
const PROMOTION_FAILED_REASON_PREFIX = 'fold_review_memory_promotion_failed';

export type ShardFoldReviewState = ShardTaggedOutputReviewState;
export type ShardFoldReviewDecision = 'approve' | 'deny';

export interface ShardFoldReviewMemoryCandidate {
  text: string;
  type?: MemoryType;
  importance?: number;
  emotionalValence?: number;
  confidence?: number;
  tags: string[];
  sensitivity?: SensitivityLevel;
}

export interface ShardFoldReviewMemoryItem {
  kind: 'memory';
  output: ShardTaggedOutput;
  candidate: ShardFoldReviewMemoryCandidate;
  reviewState: ShardFoldReviewState;
  blockingReasons: string[];
  createdAt: number;
  resolvedAt?: number;
  resolutionNote?: string;
  promotedMemoryId?: string;
  promotionAction?: WriteResult['action'];
}

export interface ShardFoldReviewArtifactItem {
  kind: 'artifact';
  artifact: ShardReturnedArtifact;
  reviewState: ShardFoldReviewState;
  blockingReasons: string[];
  createdAt: number;
  resolvedAt?: number;
  resolutionNote?: string;
}

export interface ShardFoldReviewVisibilitySignals {
  emotionalOrRelational: boolean;
  provenanceTags: string[];
  emotionalOrRelationalOutputIds: string[];
}

export interface ShardFoldReviewRecord {
  schemaVersion: 1;
  shardId: string;
  channelId: string;
  task: string;
  lineage: ShardResultLineageEnvelope;
  validationPath: string;
  reviewState: ShardFoldReviewState;
  createdAt: number;
  updatedAt: number;
  lastReviewedAt?: number;
  lastReviewedBy?: string;
  lastReviewDecision?: ShardFoldReviewDecision;
  lastReviewNote?: string;
  blockingReasons: string[];
  visibilitySignals: ShardFoldReviewVisibilitySignals;
  memoryItems: ShardFoldReviewMemoryItem[];
  artifactItems: ShardFoldReviewArtifactItem[];
}

interface ShardFoldReviewStorePayload {
  schemaVersion: 1;
  reviews: ShardFoldReviewRecord[];
}

export interface ShardFoldReviewRecordInput {
  shardId: string;
  channelId: string;
  task: string;
  lineage: ShardResultLineageEnvelope;
  timestamp?: number;
}

export interface ShardFoldReviewResolveParams {
  shardId: string;
  decision: ShardFoldReviewDecision;
  actor?: string;
  note?: string;
}

export interface ShardFoldReviewPort {
  listFoldReviews(): Promise<ShardFoldReviewRecord[]>;
  getFoldReview(shardId: string): Promise<ShardFoldReviewRecord | null>;
  resolveFoldReview(params: ShardFoldReviewResolveParams): Promise<ShardFoldReviewRecord | null>;
}

function clampUnit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(-1, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneTaggedOutput(output: ShardTaggedOutput): ShardTaggedOutput {
  return {
    ...output,
    provenance: {
      ...output.provenance,
      lineage: {
        ...output.provenance.lineage,
        companionProvenance: { ...output.provenance.lineage.companionProvenance },
        ...(output.provenance.lineage.sourceContext
          ? { sourceContext: { ...output.provenance.lineage.sourceContext } }
          : {}),
        ...(output.provenance.lineage.satelliteRouting
          ? { satelliteRouting: { ...output.provenance.lineage.satelliteRouting } }
          : {}),
        sourceMessage: { ...output.provenance.lineage.sourceMessage },
      },
      tags: [...output.provenance.tags],
    },
  };
}

function cloneArtifact(artifact: ShardReturnedArtifact): ShardReturnedArtifact {
  return {
    ...artifact,
    provenance: {
      ...artifact.provenance,
      lineage: {
        ...artifact.provenance.lineage,
        companionProvenance: { ...artifact.provenance.lineage.companionProvenance },
        ...(artifact.provenance.lineage.sourceContext
          ? { sourceContext: { ...artifact.provenance.lineage.sourceContext } }
          : {}),
        ...(artifact.provenance.lineage.satelliteRouting
          ? { satelliteRouting: { ...artifact.provenance.lineage.satelliteRouting } }
          : {}),
        sourceMessage: { ...artifact.provenance.lineage.sourceMessage },
      },
    },
  };
}

function cloneVisibilitySignals(signals: ShardFoldReviewVisibilitySignals): ShardFoldReviewVisibilitySignals {
  return {
    emotionalOrRelational: signals.emotionalOrRelational,
    provenanceTags: [...signals.provenanceTags],
    emotionalOrRelationalOutputIds: [...signals.emotionalOrRelationalOutputIds],
  };
}

function cloneMemoryCandidate(candidate: ShardFoldReviewMemoryCandidate): ShardFoldReviewMemoryCandidate {
  return {
    ...candidate,
    tags: [...candidate.tags],
  };
}

function cloneMemoryItem(item: ShardFoldReviewMemoryItem): ShardFoldReviewMemoryItem {
  return {
    ...item,
    output: cloneTaggedOutput(item.output),
    candidate: cloneMemoryCandidate(item.candidate),
    blockingReasons: [...item.blockingReasons],
  };
}

function cloneArtifactItem(item: ShardFoldReviewArtifactItem): ShardFoldReviewArtifactItem {
  return {
    ...item,
    artifact: cloneArtifact(item.artifact),
    blockingReasons: [...item.blockingReasons],
  };
}

function cloneFoldReviewRecord(record: ShardFoldReviewRecord): ShardFoldReviewRecord {
  return {
    ...record,
    lineage: {
      ...record.lineage,
      companionProvenance: { ...record.lineage.companionProvenance },
      ...(record.lineage.sourceContext ? { sourceContext: { ...record.lineage.sourceContext } } : {}),
      ...(record.lineage.satelliteRouting ? { satelliteRouting: { ...record.lineage.satelliteRouting } } : {}),
      sourceMessage: { ...record.lineage.sourceMessage },
    },
    blockingReasons: [...record.blockingReasons],
    visibilitySignals: cloneVisibilitySignals(record.visibilitySignals),
    memoryItems: record.memoryItems.map(cloneMemoryItem),
    artifactItems: record.artifactItems.map(cloneArtifactItem),
  };
}

function createEmptyVisibilitySignals(): ShardFoldReviewVisibilitySignals {
  return {
    emotionalOrRelational: false,
    provenanceTags: [],
    emotionalOrRelationalOutputIds: [],
  };
}

function createEmptyFoldReviewRecord(input: ShardFoldReviewRecordInput): ShardFoldReviewRecord {
  const createdAt = input.timestamp ?? Date.now();
  return {
    schemaVersion: SHARD_FOLD_REVIEW_STORE_SCHEMA_VERSION,
    shardId: input.shardId,
    channelId: input.channelId,
    task: input.task,
    lineage: cloneLineage(input.lineage),
    validationPath: buildShardValidationPath(input.shardId),
    reviewState: 'pending',
    createdAt,
    updatedAt: createdAt,
    blockingReasons: [],
    visibilitySignals: createEmptyVisibilitySignals(),
    memoryItems: [],
    artifactItems: [],
  };
}

function cloneLineage(lineage: ShardResultLineageEnvelope): ShardResultLineageEnvelope {
  return {
    ...lineage,
    companionProvenance: { ...lineage.companionProvenance },
    ...(lineage.sourceContext ? { sourceContext: { ...lineage.sourceContext } } : {}),
    ...(lineage.satelliteRouting ? { satelliteRouting: { ...lineage.satelliteRouting } } : {}),
    sourceMessage: { ...lineage.sourceMessage },
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function buildMemoryItemBlockingReasons(output: ShardTaggedOutput): string[] {
  const reasons = [MEMORY_PENDING_REASON];
  if (output.provenance.tags.includes(EMOTIONAL_REVIEW_TAG)) {
    reasons.push(EMOTIONAL_PENDING_REASON);
  }
  return uniqueStrings(reasons);
}

function buildArtifactItemBlockingReasons(): string[] {
  return [ARTIFACT_PENDING_REASON];
}

function recomputeFoldReviewRecord(record: ShardFoldReviewRecord): void {
  const blockingReasons = uniqueStrings([
    ...record.memoryItems.flatMap(item => item.blockingReasons),
    ...record.artifactItems.flatMap(item => item.blockingReasons),
  ]);
  const provenanceTags = uniqueStrings(record.memoryItems.flatMap(item => item.output.provenance.tags));
  const emotionalOutputIds = record.memoryItems
    .filter(item => item.output.provenance.tags.includes(EMOTIONAL_REVIEW_TAG))
    .map(item => item.output.outputId);

  const states = [
    ...record.memoryItems.map(item => item.reviewState),
    ...record.artifactItems.map(item => item.reviewState),
  ];

  record.reviewState = resolveFoldReviewState(states);
  record.blockingReasons = blockingReasons;
  record.visibilitySignals = {
    emotionalOrRelational: emotionalOutputIds.length > 0,
    provenanceTags,
    emotionalOrRelationalOutputIds: emotionalOutputIds,
  };
}

function resolveFoldReviewState(states: readonly ShardFoldReviewState[]): ShardFoldReviewState {
  if (states.length === 0) return 'pending';
  if (states.includes('pending')) return 'pending';
  if (states.includes('blocked')) return 'blocked';
  const approvedCount = states.filter(state => state === 'approved').length;
  const rejectedCount = states.filter(state => state === 'rejected').length;
  if (approvedCount > 0 && rejectedCount > 0) {
    return 'blocked';
  }
  if (rejectedCount > 0) {
    return 'rejected';
  }
  return 'approved';
}

function normalizeActor(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : 'operator';
}

function normalizeNote(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function parseFoldReviewRecord(value: unknown): ShardFoldReviewRecord | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SHARD_FOLD_REVIEW_STORE_SCHEMA_VERSION) return null;
  const shardId = typeof value.shardId === 'string' ? value.shardId.trim() : '';
  const channelId = typeof value.channelId === 'string' ? value.channelId.trim() : '';
  const task = typeof value.task === 'string' ? value.task : '';
  const lineage = value.lineage;
  if (!shardId || !channelId || !task || !isRecord(lineage)) {
    return null;
  }
  return value as ShardFoldReviewRecord;
}

class ShardFoldReviewStore {
  private readonly records = new Map<string, ShardFoldReviewRecord>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  list(): ShardFoldReviewRecord[] {
    return [...this.records.values()]
      .sort((left, right) => (
        right.updatedAt - left.updatedAt
        || right.createdAt - left.createdAt
        || left.shardId.localeCompare(right.shardId)
      ))
      .map(cloneFoldReviewRecord);
  }

  get(shardId: string): ShardFoldReviewRecord | null {
    const record = this.records.get(shardId);
    return record ? cloneFoldReviewRecord(record) : null;
  }

  put(record: ShardFoldReviewRecord): void {
    this.records.set(record.shardId, cloneFoldReviewRecord(record));
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    const raw = readFileSync(this.filePath, 'utf-8').trim();
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as ShardFoldReviewStorePayload;
    if (!Array.isArray(parsed.reviews)) {
      throw new Error('Shard fold review store is malformed.');
    }
    for (const candidate of parsed.reviews) {
      const record = parseFoldReviewRecord(candidate);
      if (!record) {
        throw new Error('Shard fold review store contains an invalid record.');
      }
      this.records.set(record.shardId, cloneFoldReviewRecord(record));
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeJsonAtomic(this.filePath, {
      schemaVersion: SHARD_FOLD_REVIEW_STORE_SCHEMA_VERSION,
      reviews: [...this.records.values()].map(cloneFoldReviewRecord),
    } satisfies ShardFoldReviewStorePayload);
  }
}

export class ShardFoldReviewController implements ShardFoldReviewPort {
  private readonly store: ShardFoldReviewStore;

  constructor(
    filePath: string,
    private readonly memoryWriter?: Pick<MemoryWriter, 'write'> | null,
  ) {
    this.store = new ShardFoldReviewStore(filePath);
  }

  async listFoldReviews(): Promise<ShardFoldReviewRecord[]> {
    return this.store.list();
  }

  async getFoldReview(shardId: string): Promise<ShardFoldReviewRecord | null> {
    return this.store.get(shardId);
  }

  async recordPendingMemoryCandidates(
    input: ShardFoldReviewRecordInput & { outputs: readonly StagedShardMemoryOutput[] },
  ): Promise<ShardFoldReviewRecord> {
    const timestamp = input.timestamp ?? Date.now();
    const record = this.ensureRecord(input);
    const existingOutputIds = new Set(record.memoryItems.map(item => item.output.outputId));
    for (const output of input.outputs) {
      if (existingOutputIds.has(output.outputId)) continue;
      record.memoryItems.push({
        kind: 'memory',
        output: cloneTaggedOutput(output),
        candidate: {
          text: output.candidate.text,
          type: output.candidate.type,
          importance: clampUnit(output.candidate.importance),
          emotionalValence: clampSigned(output.candidate.emotionalValence),
          confidence: clampUnit(output.candidate.confidence),
          tags: [...output.candidate.tags],
          sensitivity: output.candidate.sensitivity,
        },
        reviewState: 'pending',
        blockingReasons: buildMemoryItemBlockingReasons(output),
        createdAt: output.createdAt,
      });
    }
    record.updatedAt = timestamp;
    recomputeFoldReviewRecord(record);
    this.store.put(record);
    return cloneFoldReviewRecord(record);
  }

  async recordArtifactReturn(
    input: ShardFoldReviewRecordInput & { artifactReturn: ArtifactReturnBatch },
  ): Promise<ShardFoldReviewRecord> {
    const timestamp = input.timestamp ?? Date.now();
    const record = this.ensureRecord(input);
    const existingArtifactIds = new Set(record.artifactItems.map(item => item.artifact.artifactId));
    for (const artifact of input.artifactReturn.artifacts) {
      if (existingArtifactIds.has(artifact.artifactId)) continue;
      record.artifactItems.push({
        kind: 'artifact',
        artifact: cloneArtifact(artifact),
        reviewState: 'pending',
        blockingReasons: buildArtifactItemBlockingReasons(),
        createdAt: timestamp,
      });
    }
    record.updatedAt = timestamp;
    recomputeFoldReviewRecord(record);
    this.store.put(record);
    return cloneFoldReviewRecord(record);
  }

  async resolveFoldReview(params: ShardFoldReviewResolveParams): Promise<ShardFoldReviewRecord | null> {
    const shardId = params.shardId.trim();
    if (!shardId) {
      throw new Error('Shard id is required.');
    }
    const record = this.store.get(shardId);
    if (!record) {
      return null;
    }

    const now = Date.now();
    const actor = normalizeActor(params.actor);
    const note = normalizeNote(params.note);

    if (params.decision === 'deny') {
      for (const item of [...record.memoryItems, ...record.artifactItems]) {
        if (item.reviewState === 'approved') continue;
        item.reviewState = 'rejected';
        item.resolvedAt = now;
        item.resolutionNote = note ?? 'operator_denied_fold_review';
      }
    } else {
      const memoryItemsToPromote = record.memoryItems.filter(item => item.reviewState !== 'approved');
      const artifactItemsToResolve = record.artifactItems.filter(item => item.reviewState !== 'approved');
      if (memoryItemsToPromote.length > 0 && !this.memoryWriter) {
        for (const item of [...memoryItemsToPromote, ...artifactItemsToResolve]) {
          item.reviewState = 'blocked';
          item.resolvedAt = now;
          item.resolutionNote = note ?? 'memory_promotion_unavailable';
          item.blockingReasons = uniqueStrings([...item.blockingReasons, PROMOTION_UNAVAILABLE_REASON]);
        }
      } else {
        const approvalFailures: string[] = [];
        for (const item of memoryItemsToPromote) {
          const writeOptions = buildMemoryWriteOptions(record, item, note);
          if (!writeOptions) {
            item.reviewState = 'blocked';
            item.resolvedAt = now;
            item.resolutionNote = note ?? 'invalid_memory_candidate';
            item.blockingReasons = uniqueStrings([...item.blockingReasons, INVALID_MEMORY_CANDIDATE_REASON]);
            approvalFailures.push(INVALID_MEMORY_CANDIDATE_REASON);
            continue;
          }
          try {
            const result = await this.memoryWriter!.write(writeOptions);
            item.reviewState = 'approved';
            item.resolvedAt = now;
            item.resolutionNote = note;
            item.promotedMemoryId = result.memory.id;
            item.promotionAction = result.action;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const blockingReason = `${PROMOTION_FAILED_REASON_PREFIX}:${message}`;
            item.reviewState = 'blocked';
            item.resolvedAt = now;
            item.resolutionNote = note ?? 'memory_promotion_failed';
            item.blockingReasons = uniqueStrings([...item.blockingReasons, blockingReason]);
            approvalFailures.push(blockingReason);
          }
        }

        if (approvalFailures.length === 0) {
          for (const item of artifactItemsToResolve) {
            item.reviewState = 'approved';
            item.resolvedAt = now;
            item.resolutionNote = note;
          }
        } else {
          for (const item of artifactItemsToResolve) {
            item.reviewState = 'blocked';
            item.resolvedAt = now;
            item.resolutionNote = note ?? 'fold_review_blocked';
            item.blockingReasons = uniqueStrings([...item.blockingReasons, ...approvalFailures]);
          }
        }
      }
    }

    record.updatedAt = now;
    record.lastReviewedAt = now;
    record.lastReviewedBy = actor;
    record.lastReviewDecision = params.decision;
    record.lastReviewNote = note;
    recomputeFoldReviewRecord(record);
    this.store.put(record);
    return cloneFoldReviewRecord(record);
  }

  private ensureRecord(input: ShardFoldReviewRecordInput): ShardFoldReviewRecord {
    const existing = this.store.get(input.shardId);
    if (existing) {
      existing.channelId = input.channelId;
      existing.task = input.task;
      existing.lineage = cloneLineage(input.lineage);
      existing.validationPath = buildShardValidationPath(input.shardId);
      return existing;
    }
    return createEmptyFoldReviewRecord(input);
  }
}

function buildMemoryWriteOptions(
  record: ShardFoldReviewRecord,
  item: ShardFoldReviewMemoryItem,
  note: string | undefined,
): MemoryWriteOptions | null {
  if (!item.candidate.type) {
    return null;
  }

  const provenance: MemoryProvenance = {
    channelId: record.channelId,
    shardId: record.shardId,
    toolName: item.output.provenance.sourceToolName,
    toolCallId: item.output.provenance.toolCallId,
    actor: 'operator',
    reason: note ?? 'shard_fold_review_approved',
  };

  return {
    text: item.candidate.text,
    type: item.candidate.type,
    importance: item.candidate.importance,
    emotionalValence: item.candidate.emotionalValence,
    confidence: item.candidate.confidence,
    tags: [...item.candidate.tags],
    sensitivity: item.candidate.sensitivity,
    extractedAt: item.output.createdAt,
    sourceRef: [
      `source:shard:${record.shardId}`,
      item.output.provenance.sourceToolName ? `tool:${item.output.provenance.sourceToolName}` : null,
      item.output.provenance.toolCallId ? `invocation:${item.output.provenance.toolCallId}` : null,
      'fold_review:approved',
    ].filter((part): part is string => Boolean(part)).join('|'),
    sourceType: 'shard',
    provenance,
    provenanceRefs: uniqueStrings([
      `review:${record.validationPath}`,
      `shard_output:${item.output.outputId}`,
      `shard_lineage:${record.lineage.shardId}`,
    ]),
  };
}
