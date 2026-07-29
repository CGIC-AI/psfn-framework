import { randomUUID } from 'node:crypto';
import { clampSigned, clampUnit } from '../../shared/utils/numeric.js';
import type { SensitivityLevel, MemoryType } from '../memory/types.js';
import {
  VALID_SENSITIVITY_LEVELS,
  normalizeMemoryTypeValue,
} from '../memory/types.js';
import type {
  ShardMergeReview,
  ShardRuntimeRecord,
  ShardTaggedOutput,
  ShardTaggedOutputKind,
  ShardTaggedOutputProvenance,
  ShardTaggedOutputSource,
  ShardWorkLogEntry,
} from './types.js';
import { truncateShardContextText } from './context-pack.js';

export interface StagedShardMemoryCandidate {
  text: string;
  type?: MemoryType;
  importance?: number;
  emotionalValence?: number;
  confidence?: number;
  tags: string[];
  sensitivity?: SensitivityLevel;
}

export interface StagedShardMemoryOutput {
  outputId: string;
  kind: ShardTaggedOutputKind;
  label: string;
  content: string;
  preview: string;
  createdAt: number;
  reviewRequired: true;
  reviewState: ShardTaggedOutput['reviewState'];
  blockedCorePromotion: boolean;
  blockedCorePromotionReason?: string;
  source: ShardTaggedOutputSource;
  provenanceTags: string[];
  provenance: ShardTaggedOutputProvenance;
  candidate: StagedShardMemoryCandidate;
}

export function buildShardValidationPath(shardId: string): string {
  return `/api/admin/shards/${encodeURIComponent(shardId)}`;
}

export function createEmptyShardMergeReview(shardId: string, timestamp: number): ShardMergeReview {
  return {
    required: false,
    status: 'none',
    validationPath: buildShardValidationPath(shardId),
    lastUpdatedAt: timestamp,
    pendingTaggedOutputCount: 0,
    blockingReasons: [],
  };
}

export function cloneShardTaggedOutputs(outputs: readonly ShardTaggedOutput[]): ShardTaggedOutput[] {
  return outputs.map(output => ({
    ...output,
    provenance: {
      ...output.provenance,
      tags: [...output.provenance.tags],
    },
  }));
}

export function cloneShardWorkLog(workLog: readonly ShardWorkLogEntry[]): ShardWorkLogEntry[] {
  return workLog.map(entry => ({
    ...entry,
    details: [...entry.details],
  }));
}

export function cloneShardMergeReview(review: ShardMergeReview): ShardMergeReview {
  return {
    ...review,
    blockingReasons: [...review.blockingReasons],
  };
}

export function createShardTaggedOutputProvenance(
  shard: Pick<ShardRuntimeRecord, 'channelId' | 'task' | 'lineage'>,
  source: ShardTaggedOutputSource,
  options: {
    sourceToolName?: string;
    toolCallId?: string;
    provenanceTags?: string[];
  } = {},
): ShardTaggedOutputProvenance {
  return {
    coreCompanionId: shard.lineage.coreCompanionId,
    shardCompanionId: shard.lineage.shardCompanionId,
    shardId: shard.lineage.shardId,
    channelId: shard.channelId,
    task: shard.task,
    source,
    lineage: shard.lineage,
    ...(options.sourceToolName ? { sourceToolName: options.sourceToolName } : {}),
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    tags: [...new Set(options.provenanceTags?.filter(Boolean) ?? [])],
  };
}

export function createShardTaggedOutput(
  shard: ShardRuntimeRecord,
  kind: ShardTaggedOutputKind,
  label: string,
  content: string,
  source: ShardTaggedOutputSource,
  createdAt: number,
  previewMaxChars: number,
  options: {
    sourceToolName?: string;
    toolCallId?: string;
    provenanceTags?: string[];
    reviewState?: ShardTaggedOutput['reviewState'];
    blockedCorePromotionReason?: string;
  } = {},
): ShardTaggedOutput {
  const normalizedContent = content.trim();
  const reviewState = options.reviewState ?? 'pending';
  return {
    outputId: `output-${randomUUID()}`,
    kind,
    label,
    content: normalizedContent,
    preview: truncateShardContextText(normalizedContent, previewMaxChars),
    createdAt,
    reviewRequired: true,
    reviewState,
    blockedCorePromotion: reviewState !== 'approved',
    ...(options.blockedCorePromotionReason
      ? { blockedCorePromotionReason: options.blockedCorePromotionReason }
      : {}),
    provenance: createShardTaggedOutputProvenance(shard, source, {
      ...options,
      provenanceTags: [
        'fold_back',
        `tagged_output_kind:${kind}`,
        `tagged_output_source:${source}`,
        ...(options.provenanceTags ?? []),
      ],
    }),
  };
}

export function computeShardMergeReviewBlockingReasons(shard: ShardRuntimeRecord): string[] {
  const pendingOutputs = shard.taggedOutputs.filter(output => output.reviewState === 'pending');
  const reasons = new Set<string>();
  if (pendingOutputs.some(output => output.kind === 'l0_output')) {
    reasons.add('artifact_output_pending_merge_review');
  }
  if (pendingOutputs.some(output => output.kind === 'l2_memory')) {
    reasons.add('staged_shard_memory_pending_merge_review');
  }
  if (pendingOutputs.some(output => output.provenance.tags.includes('interpretive:emotional_or_relational'))) {
    reasons.add('emotional_or_relational_interpretation_requires_core_review');
  }
  return [...reasons];
}

export function parseShardMemoryTags(rawTags: unknown): string[] {
  if (Array.isArray(rawTags)) {
    return rawTags
      .flatMap(tag => typeof tag === 'string' ? [tag.trim().toLowerCase()] : [])
      .filter(Boolean);
  }
  if (typeof rawTags !== 'string') {
    return [];
  }
  return rawTags
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeShardMemorySensitivity(value: unknown): SensitivityLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase() as SensitivityLevel;
  return VALID_SENSITIVITY_LEVELS.includes(normalized) ? normalized : undefined;
}

/**
 * Canonical memory types where core stays authoritative and a shard-derived
 * interpretation must carry the heightened-review provenance tag (charter 6.13).
 * `relational` and `boundary` are first-class MemoryTypes (memory-retrieval-
 * policy), not only `emotional` — omitting them let a boundary/consent
 * interpretation reach the fold-review queue as an ordinary staged memory
 * (bead 6arrc). Kept in sync with the subagent governance classifier by being
 * its single source of truth (memory-governance reuses this module).
 */
const RESTRICTED_SHARD_MEMORY_TYPES: ReadonlySet<string> = new Set([
  'emotional',
  'relational',
  'boundary',
]);
/** Tag substrings marking a relational/contact interpretation. */
const RELATIONAL_TAG_HINTS: readonly string[] = [
  'relationship',
  'relational',
  'contact',
  'partner',
  'family',
  'friend',
];
/** Tag substrings marking a boundary/consent interpretation. */
const BOUNDARY_TAG_HINTS: readonly string[] = ['boundary', 'consent'];
/**
 * Free-text hints for restricted lived-history content (childhood, upbringing,
 * trauma, grief). Mirrors the subagent governance content hints so both queues
 * flag the same material.
 */
export const RESTRICTED_SHARD_CONTENT_HINTS: readonly RegExp[] = [
  /\bchildhood\b/iu,
  /\bupbringing\b/iu,
  /\b(?:grew|growing)\s+up\b/iu,
  /\b(?:as|when)\s+(?:i|you|they|he|she|the\s+operator|the\s+partner)\s+(?:was|were)\s+(?:an?\s+)?(?:child|kid|teenager)\b/iu,
  /\b(?:trauma|traumatic|abuse|grief|grieving|bereavement|heartbreak)\b/iu,
];

/**
 * Single authoritative classifier for shard-derived interpretations that must
 * stay core-authoritative (charter 6.13). Flags the restricted memory TYPES
 * ({emotional, relational, boundary}), relational and boundary/consent TAG
 * hints, and restricted lived-history CONTENT hints. Both the shard fold-back
 * provenance path and the subagent governance path consume this, so the
 * fold-review queue never receives an asymmetric under-scrutinized boundary or
 * relational interpretation (bead 6arrc).
 */
export function isEmotionalOrRelationalShardMemory(
  memoryType: string | undefined,
  tags: readonly string[],
  text = '',
): boolean {
  const normalizedType = memoryType?.trim().toLowerCase();
  if (normalizedType && RESTRICTED_SHARD_MEMORY_TYPES.has(normalizedType)) {
    return true;
  }
  if (tags.some(tag => RELATIONAL_TAG_HINTS.some(hint => tag.includes(hint)))) {
    return true;
  }
  if (tags.some(tag => BOUNDARY_TAG_HINTS.some(hint => tag.includes(hint)))) {
    return true;
  }
  return RESTRICTED_SHARD_CONTENT_HINTS.some(pattern => pattern.test(text));
}

export function buildShardMemoryOutputProvenanceTags(
  memoryType: unknown,
  rawTags: unknown,
  sensitivity: unknown,
  text: unknown = '',
): string[] {
  const tags = parseShardMemoryTags(rawTags);
  const normalizedType = typeof memoryType === 'string' ? memoryType.trim().toLowerCase() : '';
  const normalizedSensitivity = typeof sensitivity === 'string' ? sensitivity.trim().toLowerCase() : '';
  const memoryText = typeof text === 'string' ? text : '';
  return [
    ...(normalizedType ? [`memory_type:${normalizedType}`] : []),
    ...(normalizedSensitivity ? [`sensitivity:${normalizedSensitivity}`] : []),
    ...tags.map(tag => `memory_tag:${tag}`),
    ...(isEmotionalOrRelationalShardMemory(normalizedType || undefined, tags, memoryText)
      ? ['interpretive:emotional_or_relational']
      : []),
  ];
}

export function resolveStagedShardMemoryOutputs(
  shard: Pick<ShardRuntimeRecord, 'channelId' | 'task' | 'lineage'>,
  toolName: string,
  toolCallId: string,
  params: unknown,
  options: {
    blockedCorePromotionReason?: string;
  } = {},
): StagedShardMemoryOutput[] {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return [];
  }
  const input = params as Record<string, unknown>;

  const toWriteOutput = (
    record: Record<string, unknown>,
    labelPrefix: string,
    source: ShardTaggedOutputSource,
  ): StagedShardMemoryOutput[] => {
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (!text) {
      return [];
    }
    const memoryType = normalizeMemoryTypeValue(record.type);
    if (!memoryType) {
      return [];
    }
    const candidateTags = parseShardMemoryTags(record.tags);
    const sensitivity = normalizeShardMemorySensitivity(record.sensitivity);
    const provenanceTags = buildShardMemoryOutputProvenanceTags(
      memoryType,
      candidateTags,
      sensitivity,
      text,
    );
    const provenance = createShardTaggedOutputProvenance(shard, source, {
      sourceToolName: toolName,
      toolCallId,
      provenanceTags,
    });
    const reviewState: ShardTaggedOutput['reviewState'] = 'pending';
    return [{
      outputId: `${source}-${toolCallId}-${randomUUID()}`,
      kind: 'l2_memory',
      label: `${labelPrefix} (${memoryType})`,
      content: text,
      preview: truncateShardContextText(text, 200),
      createdAt: Date.now(),
      reviewRequired: true,
      reviewState,
      blockedCorePromotion: true,
      ...(options.blockedCorePromotionReason
        ? { blockedCorePromotionReason: options.blockedCorePromotionReason }
        : {}),
      source,
      provenanceTags,
      provenance,
      candidate: {
        text,
        type: memoryType,
        importance: clampUnit(record.importance, undefined),
        emotionalValence: clampSigned(record.emotional_valence, undefined),
        confidence: clampUnit(record.confidence, undefined),
        tags: candidateTags,
        sensitivity,
      },
    }];
  };

  const toImportOutputs = (
    records: unknown,
    sourceLabel: string,
  ): StagedShardMemoryOutput[] => {
    if (!Array.isArray(records)) {
      return [];
    }
    return records.flatMap((record, index) => {
      if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        return [];
      }
      const entry = record as Record<string, unknown>;
      const text = typeof entry.text === 'string' ? entry.text.trim() : '';
      if (!text) {
        return [];
      }
      const memoryType = normalizeMemoryTypeValue(entry.type);
      if (!memoryType) {
        return [];
      }
      const candidateTags = parseShardMemoryTags(entry.tags);
      const sensitivity = normalizeShardMemorySensitivity(entry.sensitivity);
      const provenanceTags = buildShardMemoryOutputProvenanceTags(
        memoryType,
        candidateTags,
        sensitivity,
        text,
      );
      const provenance = createShardTaggedOutputProvenance(shard, 'memory_import_batch', {
        sourceToolName: toolName,
        toolCallId,
        provenanceTags,
      });
      const reviewState: ShardTaggedOutput['reviewState'] = 'pending';
      return [{
        outputId: `memory_import_batch-${toolCallId}-${randomUUID()}`,
        kind: 'l2_memory',
        label: `Imported shard memory ${index + 1} from ${sourceLabel} (${memoryType})`,
        content: text,
        preview: truncateShardContextText(text, 200),
        createdAt: Date.now(),
        reviewRequired: true,
        reviewState,
        blockedCorePromotion: true,
        ...(options.blockedCorePromotionReason
          ? { blockedCorePromotionReason: options.blockedCorePromotionReason }
          : {}),
        source: 'memory_import_batch',
        provenanceTags,
        provenance,
        candidate: {
          text,
          type: memoryType,
          importance: clampUnit(entry.importance, undefined),
          emotionalValence: clampSigned(entry.emotional_valence, undefined),
          confidence: clampUnit(entry.confidence, undefined),
          tags: candidateTags,
          sensitivity,
        },
      }];
    });
  };

  if (toolName === 'memory') {
    const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : '';
    if (action === 'write') {
      return toWriteOutput(input, 'Staged shard memory', 'memory_write');
    }
    if (action === 'import') {
      const source = typeof input.source === 'string' && input.source.trim()
        ? input.source.trim().toLowerCase()
        : 'import';
      return toImportOutputs(input.records, source);
    }
    return [];
  }

  if (toolName === 'memory_write') {
    return toWriteOutput(input, 'Staged shard memory', 'memory_write');
  }
  if (toolName === 'memory_import_batch') {
    const source = typeof input.source === 'string' && input.source.trim()
      ? input.source.trim().toLowerCase()
      : 'import';
    return toImportOutputs(input.records, source);
  }
  return [];
}
