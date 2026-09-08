import { clampUnit } from '../../../shared/utils/numeric.js';
import type { CogSecStructuredProvenanceRef } from '../../../shared/contracts/provenance-ref.js';
import {
  DURABLE_PREFERENCE_MEMORY_TAG,
  DURABLE_RETENTION_TAG,
  getSensitivityWriteThreshold,
  inferMemoryRetentionClass,
  inferPreferenceMemoryTags,
  inferMemorySourceTypeFromSourceRef,
  normalizeMemoryProvenance,
  normalizeMemoryScopeTags,
  normalizeMemorySourceType,
  normalizeMemoryTags,
} from '../types.js';
import type {
  ConsentFlags,
  MemoryProvenance,
  MemoryRetentionClass,
  MemoryScopeRef,
  MemorySourceType,
  PurrMemory,
  SensitivityLevel,
  MemoryType,
} from '../types.js';
export interface RetentionSemantics {
  tags: string[];
  retentionClass?: MemoryRetentionClass;
}

export interface RetentionSemanticsInput {
  text: string;
  type: MemoryType;
  importance: number;
  tags: readonly string[];
  retentionClass?: MemoryRetentionClass;
}

export function applyRetentionSemantics(input: RetentionSemanticsInput): RetentionSemantics {
  const tags = normalizeMemoryTags([
    ...input.tags,
    ...inferPreferenceMemoryTags({
      text: input.text,
      type: input.type,
      tags: input.tags,
    }),
  ]);
  const inferred = inferMemoryRetentionClass({
    type: input.type,
    importance: input.importance,
    text: input.text,
    tags,
    retentionClass: input.retentionClass,
  });

  if (inferred === 'durable' && !tags.includes(DURABLE_RETENTION_TAG)) {
    tags.push(DURABLE_RETENTION_TAG);
  }
  if (
    inferred === 'durable'
    && tags.includes('preference')
    && !tags.includes(DURABLE_PREFERENCE_MEMORY_TAG)
  ) {
    tags.push(DURABLE_PREFERENCE_MEMORY_TAG);
  }

  return {
    tags,
    retentionClass: inferred === 'durable' ? 'durable' : undefined,
  };
}

export function normalizeSourceRef(sourceRef: string | undefined, fallback: string): string {
  const trimmed = sourceRef?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeExactDuplicateText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeSourceContext(input: {
  sourceRef: string | undefined;
  sourceType: MemorySourceType | undefined;
  provenance: MemoryProvenance | undefined;
  fallbackRef: string;
}): {
  sourceRef: string;
  sourceType: MemorySourceType;
  provenance?: MemoryProvenance;
} {
  const normalizedSourceRef = normalizeSourceRef(input.sourceRef, input.fallbackRef);
  return {
    sourceRef: normalizedSourceRef,
    sourceType: normalizeMemorySourceType(
      input.sourceType,
      inferMemorySourceTypeFromSourceRef(normalizedSourceRef),
    ),
    provenance: normalizeMemoryProvenance(input.provenance),
  };
}

/**
 * Merge the incoming write's admission identity onto an existing memory's
 * provenance (psfn-framework-ccgdz.3).
 *
 * Additive by construction: it appends admission refs the row does not already
 * carry and never removes, replaces, or reorders what is there. Returns
 * `undefined` when nothing new arrived, so an unchanged row is not rewritten.
 *
 * `derivationRunId` is deliberately NOT merged: it names the run that CREATED
 * the memory, and a later deduplicated write is a different run touching the
 * same row, not a second author of it.
 */
export function mergeAdmissionProvenance(
  existing: MemoryProvenance | undefined,
  incoming: MemoryProvenance | undefined,
): MemoryProvenance | undefined {
  const incomingAdmissions = incoming?.sourceAdmissions ?? [];
  if (incomingAdmissions.length === 0) return undefined;
  const existingAdmissions = existing?.sourceAdmissions ?? [];
  const seen = new Set(existingAdmissions.map(admissionKey));
  const added = incomingAdmissions.filter(ref => !seen.has(admissionKey(ref)));
  if (added.length === 0) return undefined;
  return {
    ...(existing ?? {}),
    sourceAdmissions: [...existingAdmissions, ...added],
  };
}

function admissionKey(ref: CogSecStructuredProvenanceRef): string {
  return [ref.kind, ref.refId, ref.receiptId ?? '', ref.contentSha256 ?? '', ref.envelopeId ?? ''].join(' ');
}

export function normalizeProvenanceRefs(
  refs: readonly string[] | undefined,
  fallbackRef?: string,
): string[] {
  const out = new Set<string>();
  for (const raw of refs ?? []) {
    const normalized = raw.trim();
    if (normalized.length > 0) out.add(normalized);
  }
  const fallback = fallbackRef?.trim();
  if (fallback && fallback.length > 0) out.add(fallback);
  return [...out];
}

export function mergeScopeTags(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): string[] {
  return normalizeMemoryScopeTags([...(existing ?? []), ...(incoming ?? [])]);
}

export function scopeRefEquals(
  left: MemoryScopeRef | undefined,
  right: MemoryScopeRef | undefined,
): boolean {
  return left?.kind === right?.kind
    && left?.id === right?.id
    && left?.label === right?.label;
}

export function shouldConsiderDuplicateForScope(
  memory: Pick<PurrMemory, 'scopeRef'>,
  scopeRef: MemoryScopeRef | undefined,
): boolean {
  if (!scopeRef) return true;
  return memory.scopeRef?.kind === scopeRef.kind && memory.scopeRef.id === scopeRef.id;
}

export function mergeProvenanceRefs(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): string[] {
  const out = new Set<string>();
  for (const ref of existing ?? []) {
    const normalized = ref.trim();
    if (normalized.length > 0) out.add(normalized);
  }
  for (const ref of incoming ?? []) {
    const normalized = ref.trim();
    if (normalized.length > 0) out.add(normalized);
  }
  return [...out];
}

/**
 * `redactionBehavior` is carried through (psfn-framework-alco2, via
 * psfn-framework-ccgdz.8). It used to be dropped here while the STORAGE
 * normalizer in `system/trust/types.ts` preserved it, so a producer that set it
 * lost it on the way in and `resolveConsentRedactionBehavior` — the only reader
 * — silently fell back to its default. The two normalizers now agree on the
 * same four fields.
 */
export function normalizeConsentFlags(flags: ConsentFlags | undefined): ConsentFlags | undefined {
  if (!flags) return undefined;
  const normalized: ConsentFlags = {};
  if (flags.allowRecall !== undefined) normalized.allowRecall = flags.allowRecall;
  if (flags.allowAbstraction !== undefined) normalized.allowAbstraction = flags.allowAbstraction;
  if (flags.deleteOnRequest !== undefined) normalized.deleteOnRequest = flags.deleteOnRequest;
  if (flags.redactionBehavior === 'delete' || flags.redactionBehavior === 'abstract') {
    normalized.redactionBehavior = flags.redactionBehavior;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergeConsentFlags(
  existing: ConsentFlags | undefined,
  incoming: ConsentFlags | undefined,
): ConsentFlags | undefined {
  const left = normalizeConsentFlags(existing);
  const right = normalizeConsentFlags(incoming);
  if (!left && !right) return undefined;

  const merged: ConsentFlags = {};

  const recallValues = [left?.allowRecall, right?.allowRecall];
  if (recallValues.includes(false)) {
    merged.allowRecall = false;
  } else if (recallValues.includes(true)) {
    merged.allowRecall = true;
  }

  const abstractionValues = [left?.allowAbstraction, right?.allowAbstraction];
  if (abstractionValues.includes(false)) {
    merged.allowAbstraction = false;
  } else if (abstractionValues.includes(true)) {
    merged.allowAbstraction = true;
  }

  const deleteValues = [left?.deleteOnRequest, right?.deleteOnRequest];
  if (deleteValues.includes(true)) {
    merged.deleteOnRequest = true;
  } else if (deleteValues.includes(false)) {
    merged.deleteOnRequest = false;
  }

  // `delete` is the stricter behavior and wins, matching every other field
  // here: a merge of two consent records never relaxes either one.
  const behaviors = [left?.redactionBehavior, right?.redactionBehavior];
  if (behaviors.includes('delete')) {
    merged.redactionBehavior = 'delete';
  } else if (behaviors.includes('abstract')) {
    merged.redactionBehavior = 'abstract';
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function consentFlagsEqual(left: ConsentFlags | undefined, right: ConsentFlags | undefined): boolean {
  const a = normalizeConsentFlags(left);
  const b = normalizeConsentFlags(right);
  return (
    a?.allowRecall === b?.allowRecall
    && a?.allowAbstraction === b?.allowAbstraction
    && a?.deleteOnRequest === b?.deleteOnRequest
    && a?.redactionBehavior === b?.redactionBehavior
  );
}

export function computeNoveltyFromSimilarities(similarities: readonly number[]): number {
  if (similarities.length === 0) return 1;
  const maxSimilarity = similarities.reduce((max, value) => Math.max(max, clampUnit(value, 0)), 0);
  return clampUnit(1 - maxSimilarity, 1);
}

export function validateEmbeddingDimensions(
  embedding: Float32Array,
  expectedDims: number,
  operation: string,
): void {
  if (embedding.length !== expectedDims) {
    throw new Error(`Memory writer ${operation} embedding dimension mismatch: expected ${expectedDims}, got ${embedding.length}`);
  }
}

export type MemoryWritePolicyDecision =
  | {
    accepted: true;
    reason: 'default_allow' | 'consent_deny_override';
    minSalience: number;
    minNovelty: number;
  }
  | {
    accepted: false;
    reason: 'salience_below_threshold' | 'novelty_below_threshold';
    minSalience: number;
    minNovelty: number;
  };

export function evaluateSensitivityWritePolicy(input: {
  sensitivity: SensitivityLevel;
  salience: number;
  novelty: number;
  consentFlags?: ConsentFlags;
}): MemoryWritePolicyDecision {
  const threshold = getSensitivityWriteThreshold(input.sensitivity);
  if (input.consentFlags?.allowRecall === false) {
    return {
      accepted: true,
      reason: 'consent_deny_override',
      minSalience: threshold.minSalience,
      minNovelty: threshold.minNovelty,
    };
  }
  if (input.salience < threshold.minSalience) {
    return {
      accepted: false,
      reason: 'salience_below_threshold',
      minSalience: threshold.minSalience,
      minNovelty: threshold.minNovelty,
    };
  }
  if (input.novelty < threshold.minNovelty) {
    return {
      accepted: false,
      reason: 'novelty_below_threshold',
      minSalience: threshold.minSalience,
      minNovelty: threshold.minNovelty,
    };
  }
  return {
    accepted: true,
    reason: 'default_allow',
    minSalience: threshold.minSalience,
    minNovelty: threshold.minNovelty,
  };
}
