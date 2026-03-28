// ── Memory Writer ──
// Shared write/dedup/contradiction logic used by both MemoryExtractor and tools.

import { v4 as uuidv4 } from 'uuid';
import type { EmbeddingService } from '../core/agent/contracts.js';
import type { MemoryStore } from './store.js';
import { abstractMemoryText } from './abstraction.js';
import type {
  PurrMemory,
  MemoryType,
  SensitivityLevel,
  ConsentFlags,
  ConsentRedactionBehavior,
  MemoryRedactionOperation,
  MemoryRetentionClass,
  MemoryFormationVAD,
  MemoryScopeRef,
} from './types.js';
import {
  DEDUP_THRESHOLD,
  DURABLE_RETENTION_TAG,
  MEMORY_CONFIG,
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  VALID_MEMORY_TYPES,
  getSensitivityWriteThreshold,
  inferMemoryRetentionClass,
  isDurableMemory,
  normalizeFormationVAD,
  normalizeMemoryTags,
  resolveConsentRedactionBehavior,
} from './types.js';
import { createComponentLogger } from '../shared/logger.js';

const log = createComponentLogger('MemoryWriter');

export interface MemoryWriteOptions {
  text: string;
  type: MemoryType;
  importance?: number;       // default 0.5
  salience?: number;         // default to importance when omitted
  emotionalValence?: number; // default 0
  formationVAD?: MemoryFormationVAD;
  confidence?: number;       // default 0.8
  tags?: string[];
  sourceRef?: string;        // default 'tool:memory_write'
  provenanceRefs?: string[];
  sensitivity?: SensitivityLevel;    // default 'personal'
  consentFlags?: ConsentFlags;       // default {}
  retentionClass?: MemoryRetentionClass;
  contactId?: string;
  scopeRef?: MemoryScopeRef;
  scopeTags?: string[];
}

export interface WriteResult {
  action: 'created' | 'deduplicated' | 'superseded';
  memory: PurrMemory;
  /** If deduplicated, the existing memory that was bumped */
  existingId?: string;
}

export interface BatchImportResult {
  written: number;
  deduplicated: number;
  superseded: number;
  errors: number;
  results: WriteResult[];
}

export type MemoryWritePolicyReason =
  | 'default_allow'
  | 'consent_deny_override'
  | 'salience_below_threshold'
  | 'novelty_below_threshold';

export class MemoryWritePolicyError extends Error {
  readonly reason: Exclude<MemoryWritePolicyReason, 'default_allow' | 'consent_deny_override'>;
  readonly sensitivity: SensitivityLevel;
  readonly salience: number;
  readonly novelty: number;
  readonly minSalience: number;
  readonly minNovelty: number;

  constructor(input: {
    reason: Exclude<MemoryWritePolicyReason, 'default_allow' | 'consent_deny_override'>;
    sensitivity: SensitivityLevel;
    salience: number;
    novelty: number;
    minSalience: number;
    minNovelty: number;
  }) {
    const thresholdLabel = input.reason === 'salience_below_threshold' ? 'salience' : 'novelty';
    super(
      `Sensitive memory write rejected: ${thresholdLabel} below threshold for ${input.sensitivity} `
      + `(salience=${input.salience.toFixed(2)} min=${input.minSalience.toFixed(2)}, `
      + `novelty=${input.novelty.toFixed(2)} min=${input.minNovelty.toFixed(2)})`,
    );
    this.name = 'MemoryWritePolicyError';
    this.reason = input.reason;
    this.sensitivity = input.sensitivity;
    this.salience = input.salience;
    this.novelty = input.novelty;
    this.minSalience = input.minSalience;
    this.minNovelty = input.minNovelty;
  }
}

export interface MemoryRedactionOptions {
  memoryId: string;
  operation?: MemoryRedactionOperation;
  reason?: string;
  requestedBy?: string;
  sourceRef?: string;
}

export interface MemoryRedactionResult {
  operation: 'deleted' | 'abstracted';
  behavior: ConsentRedactionBehavior;
  sourceMemoryId: string;
  deleteId: string;
  abstractedMemoryId?: string;
  abstractedText?: string;
  externalProvenanceRef?: string;
}

function applyRetentionSemantics(input: {
  type: MemoryType;
  importance: number;
  tags: readonly string[];
  retentionClass?: MemoryRetentionClass;
}): {
  tags: string[];
  retentionClass?: MemoryRetentionClass;
} {
  const tags = normalizeMemoryTags(input.tags);
  const inferred = inferMemoryRetentionClass({
    type: input.type,
    importance: input.importance,
    tags,
    retentionClass: input.retentionClass,
  });

  if (inferred === 'durable' && !tags.includes(DURABLE_RETENTION_TAG)) {
    tags.push(DURABLE_RETENTION_TAG);
  }

  return {
    tags,
    retentionClass: inferred === 'durable' ? 'durable' : undefined,
  };
}

function normalizeSourceRef(sourceRef: string | undefined, fallback: string): string {
  const trimmed = sourceRef?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function clampUnit(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(-1, Math.min(1, value));
}

function normalizeProvenanceRefs(
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

function mergeScopeTags(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): string[] {
  return normalizeMemoryScopeTags([...(existing ?? []), ...(incoming ?? [])]);
}

function scopeRefEquals(
  left: MemoryScopeRef | undefined,
  right: MemoryScopeRef | undefined,
): boolean {
  return left?.kind === right?.kind
    && left?.id === right?.id
    && left?.label === right?.label;
}

function shouldConsiderDuplicateForScope(
  memory: Pick<PurrMemory, 'scopeRef'>,
  scopeRef: MemoryScopeRef | undefined,
): boolean {
  if (!scopeRef) return true;
  return memory.scopeRef?.kind === scopeRef.kind && memory.scopeRef.id === scopeRef.id;
}

function mergeProvenanceRefs(
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

function normalizeConsentFlags(flags: ConsentFlags | undefined): ConsentFlags | undefined {
  if (!flags) return undefined;
  const normalized: ConsentFlags = {};
  if (flags.allowRecall !== undefined) normalized.allowRecall = flags.allowRecall;
  if (flags.allowAbstraction !== undefined) normalized.allowAbstraction = flags.allowAbstraction;
  if (flags.deleteOnRequest !== undefined) normalized.deleteOnRequest = flags.deleteOnRequest;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function mergeConsentFlags(
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

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function consentFlagsEqual(left: ConsentFlags | undefined, right: ConsentFlags | undefined): boolean {
  const a = normalizeConsentFlags(left);
  const b = normalizeConsentFlags(right);
  return (
    a?.allowRecall === b?.allowRecall
    && a?.allowAbstraction === b?.allowAbstraction
    && a?.deleteOnRequest === b?.deleteOnRequest
  );
}

function computeNoveltyFromSimilarities(similarities: readonly number[]): number {
  if (similarities.length === 0) return 1;
  const maxSimilarity = similarities.reduce((max, value) => Math.max(max, clampUnit(value, 0)), 0);
  return clampUnit(1 - maxSimilarity, 1);
}

type MemoryWritePolicyDecision =
  | {
    accepted: true;
    reason: Extract<MemoryWritePolicyReason, 'default_allow' | 'consent_deny_override'>;
    minSalience: number;
    minNovelty: number;
  }
  | {
    accepted: false;
    reason: Exclude<MemoryWritePolicyReason, 'default_allow' | 'consent_deny_override'>;
    minSalience: number;
    minNovelty: number;
  };

function evaluateSensitivityWritePolicy(input: {
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

export class MemoryWriter {
  constructor(
    private memoryStore: MemoryStore,
    private embeddingService: EmbeddingService,
  ) {}

  /**
   * Write a single memory with dedup/contradiction handling.
   *
   * 1. Embed the text
   * 2. Check for duplicates at type-specific threshold -- if found, bump salience
   * 3. Check for contradictions at lower threshold -- if found and new confidence > old, supersede
   * 4. Insert new memory
   */
  async write(opts: MemoryWriteOptions): Promise<WriteResult> {
    const embedding = await this.embeddingService.embed(opts.text);
    return this.writeWithEmbedding(opts, embedding);
  }

  private async writeWithEmbedding(
    opts: MemoryWriteOptions,
    embedding: Float32Array,
  ): Promise<WriteResult> {
    const {
      text,
      type,
      importance = 0.5,
      salience,
      emotionalValence = 0,
      formationVAD,
      confidence = 0.8,
      tags = [],
      sourceRef,
      provenanceRefs,
      sensitivity = 'personal',
      consentFlags,
      retentionClass,
      contactId,
      scopeRef,
      scopeTags,
    } = opts;

    // Validate type
    if (!VALID_MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}. Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`);
    }

    const retention = applyRetentionSemantics({
      type,
      importance,
      tags,
      retentionClass,
    });
    const normalizedConsentFlags = consentFlags === undefined
      ? undefined
      : normalizeConsentFlags(consentFlags);
    const normalizedFormationVAD = normalizeFormationVAD(formationVAD);
    const normalizedSourceRef = normalizeSourceRef(sourceRef, 'tool:memory_write');
    const incomingProvenanceRefs = normalizeProvenanceRefs(provenanceRefs, normalizedSourceRef);
    const normalizedScopeRef = normalizeMemoryScopeRef(scopeRef);
    const normalizedScopeTags = normalizeMemoryScopeTags(scopeTags);
    const targetSalience = clampUnit(salience ?? importance, importance);

    // 1. Check for exact duplicates (high threshold per type)
    const duplicates = this.memoryStore.searchByEmbedding(
      embedding,
      DEDUP_THRESHOLD[type],
      3,
    );

    const sameTypeDups = duplicates.filter(d => (
      d.type === type && (
        !contactId
        || d.contactId === contactId
      ) && shouldConsiderDuplicateForScope(d, normalizedScopeRef)
    ));
    if (sameTypeDups.length > 0) {
      // Duplicate found -- bump access count and salience
      const existing = sameTypeDups[0];
      const updates: {
        lastAccessed: number;
        accessCount: number;
        salience: number;
        tags?: string[];
        provenanceRefs?: string[];
        consentFlags?: ConsentFlags;
        scopeRef?: MemoryScopeRef;
        scopeTags?: string[];
      } = {
        lastAccessed: Date.now(),
        accessCount: existing.accessCount + 1,
        salience: Math.min(
          1,
          Math.max(
            existing.salience + MEMORY_CONFIG.salienceBumpOnAccess,
            targetSalience,
          ),
        ),
      };

      const mergedTags = normalizeMemoryTags([...existing.tags, ...retention.tags]);
      if (mergedTags.length !== existing.tags.length || mergedTags.some((tag, idx) => tag !== existing.tags[idx])) {
        updates.tags = mergedTags;
      }

      const existingProvenanceRefs = normalizeProvenanceRefs(existing.provenanceRefs, existing.sourceRef);
      const mergedProvenanceRefs = mergeProvenanceRefs(existingProvenanceRefs, incomingProvenanceRefs);
      if (
        mergedProvenanceRefs.length !== existingProvenanceRefs.length
        || mergedProvenanceRefs.some((ref, idx) => ref !== existingProvenanceRefs[idx])
      ) {
        updates.provenanceRefs = mergedProvenanceRefs;
      }

      const mergedConsentFlags = mergeConsentFlags(existing.consentFlags, consentFlags);
      if (!consentFlagsEqual(existing.consentFlags, mergedConsentFlags)) {
        updates.consentFlags = mergedConsentFlags;
      }
      if (!scopeRefEquals(existing.scopeRef, normalizedScopeRef) && normalizedScopeRef) {
        updates.scopeRef = normalizedScopeRef;
      }
      const mergedScopeTags = mergeScopeTags(existing.scopeTags, normalizedScopeTags);
      if (
        mergedScopeTags.length !== (existing.scopeTags?.length ?? 0)
        || mergedScopeTags.some((tag, idx) => tag !== existing.scopeTags?.[idx])
      ) {
        updates.scopeTags = mergedScopeTags;
      }

      // If this write is durable, upgrade duplicate memory tags so durability survives persistence.
      if (retention.retentionClass === 'durable' && !isDurableMemory(existing)) {
        updates.tags = normalizeMemoryTags([...(updates.tags ?? existing.tags), DURABLE_RETENTION_TAG]);
      }

      this.memoryStore.updateMemory(existing.id, updates);
      log.debug('Deduplicated memory', {
        existingId: existing.id,
        text: text.slice(0, 60),
        rationale: {
          action: 'accepted',
          reason: 'exact_duplicate',
          sensitivity,
          preservedConsentDeny: mergedConsentFlags?.allowRecall === false,
        },
      });
      return {
        action: 'deduplicated',
        memory: {
          ...existing,
          lastAccessed: updates.lastAccessed,
          accessCount: updates.accessCount,
          salience: updates.salience,
          tags: updates.tags ?? existing.tags,
          provenanceRefs: updates.provenanceRefs ?? existingProvenanceRefs,
          consentFlags: updates.consentFlags ?? existing.consentFlags,
          retentionClass: retention.retentionClass ?? existing.retentionClass,
          scopeRef: updates.scopeRef ?? existing.scopeRef,
          scopeTags: updates.scopeTags ?? existing.scopeTags,
        },
        existingId: existing.id,
      };
    }

    // 2. Check for contradictions (lower threshold)
    const broader = this.memoryStore.searchByEmbedding(
      embedding,
      DEDUP_THRESHOLD[type] - MEMORY_CONFIG.contradictionThresholdOffset,
      5,
    );

    const sameTypeBroader = broader.filter(b => (
      b.type === type
      && shouldConsiderDuplicateForScope(b, normalizedScopeRef)
    ));
    const sameContactBroader = contactId
      ? sameTypeBroader.filter(b => b.contactId === contactId)
      : sameTypeBroader;
    const novelty = computeNoveltyFromSimilarities(sameContactBroader.map(memory => memory.similarity));
    const writePolicy = evaluateSensitivityWritePolicy({
      sensitivity,
      salience: targetSalience,
      novelty,
      consentFlags,
    });
    if (!writePolicy.accepted) {
      log.info('Rejected memory write by sensitivity policy', {
        type,
        sensitivity,
        salience: targetSalience,
        novelty,
        minSalience: writePolicy.minSalience,
        minNovelty: writePolicy.minNovelty,
        reason: writePolicy.reason,
        text: text.slice(0, 60),
      });
      throw new MemoryWritePolicyError({
        reason: writePolicy.reason,
        sensitivity,
        salience: targetSalience,
        novelty,
        minSalience: writePolicy.minSalience,
        minNovelty: writePolicy.minNovelty,
      });
    }

    log.debug('Accepted memory write by sensitivity policy', {
      type,
      sensitivity,
      salience: targetSalience,
      novelty,
      minSalience: writePolicy.minSalience,
      minNovelty: writePolicy.minNovelty,
      reason: writePolicy.reason,
      text: text.slice(0, 60),
    });

    const supersededMemories = sameContactBroader.filter(old => confidence > old.confidence);
    const didSupersede = supersededMemories.length > 0;

    // 3. Insert new memory
    const now = Date.now();
    const memory: PurrMemory = {
      id: uuidv4(),
      text,
      type,
      importance,
      confidence,
      emotionalValence,
      formationVAD: normalizedFormationVAD,
      salience: targetSalience,
      sourceRef: normalizedSourceRef,
      extractedAt: now,
      lastAccessed: now,
      accessCount: 1,
      tags: retention.tags,
      ...(normalizedScopeRef ? { scopeRef: normalizedScopeRef } : {}),
      ...(normalizedScopeTags.length > 0 ? { scopeTags: normalizedScopeTags } : {}),
      provenanceRefs: incomingProvenanceRefs,
      retentionClass: retention.retentionClass,
      sensitivity,
      consentFlags: normalizedConsentFlags,
      contactId,
    };

    this.memoryStore.runInTransaction(() => {
      for (const old of supersededMemories) {
        this.memoryStore.updateMemory(old.id, { supersededBy: memory.id });
      }
      this.memoryStore.insertMemory(memory, embedding);
    });

    for (const old of supersededMemories) {
      log.debug('Superseded memory', { oldId: old.id, replacementId: memory.id, text: text.slice(0, 60) });
    }
    log.debug('Created memory', { id: memory.id, type, text: text.slice(0, 60) });

    return {
      action: didSupersede ? 'superseded' : 'created',
      memory,
    };
  }

  /**
   * Upsert a memory: if a similar memory of the same type exists, supersede it
   * and create a new one with updated content. Unlike write() which bumps salience
   * on dedup, upsert always replaces the old memory.
   */
  async upsert(opts: MemoryWriteOptions): Promise<WriteResult> {
    const {
      text,
      type,
      importance = 0.5,
      salience,
      emotionalValence = 0,
      formationVAD,
      confidence = 0.8,
      tags = [],
      sourceRef,
      provenanceRefs,
      sensitivity = 'personal',
      consentFlags,
      retentionClass,
      contactId,
      scopeRef,
      scopeTags,
    } = opts;

    if (!VALID_MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}. Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`);
    }

    const retention = applyRetentionSemantics({
      type,
      importance,
      tags,
      retentionClass,
    });
    const normalizedFormationVAD = normalizeFormationVAD(formationVAD);
    const normalizedSourceRef = normalizeSourceRef(sourceRef, 'tool:memory_upsert');
    const normalizedProvenanceRefs = normalizeProvenanceRefs(provenanceRefs, normalizedSourceRef);
    const normalizedScopeRef = normalizeMemoryScopeRef(scopeRef);
    const normalizedScopeTags = normalizeMemoryScopeTags(scopeTags);
    const targetSalience = clampUnit(salience ?? importance, importance);

    const embedding = await this.embeddingService.embed(text);

    // Find similar memories of the same type at the dedup threshold
    const similar = this.memoryStore.searchByEmbedding(
      embedding,
      DEDUP_THRESHOLD[type] - MEMORY_CONFIG.contradictionThresholdOffset,
      5,
    );

    const sameType = similar.filter(s => (
      s.type === type && (
        !contactId
        || s.contactId === contactId
      ) && shouldConsiderDuplicateForScope(s, normalizedScopeRef)
    ));
    const mergedIncomingConsentFlags = sameType.reduce<ConsentFlags | undefined>(
      (merged, old) => mergeConsentFlags(merged, old.consentFlags),
      consentFlags,
    );
    const novelty = computeNoveltyFromSimilarities(sameType.map(memory => memory.similarity));
    const writePolicy = evaluateSensitivityWritePolicy({
      sensitivity,
      salience: targetSalience,
      novelty,
      consentFlags: mergedIncomingConsentFlags,
    });
    if (!writePolicy.accepted) {
      log.info('Rejected memory upsert by sensitivity policy', {
        type,
        sensitivity,
        salience: targetSalience,
        novelty,
        minSalience: writePolicy.minSalience,
        minNovelty: writePolicy.minNovelty,
        reason: writePolicy.reason,
        text: text.slice(0, 60),
      });
      throw new MemoryWritePolicyError({
        reason: writePolicy.reason,
        sensitivity,
        salience: targetSalience,
        novelty,
        minSalience: writePolicy.minSalience,
        minNovelty: writePolicy.minNovelty,
      });
    }

    log.debug('Accepted memory upsert by sensitivity policy', {
      type,
      sensitivity,
      salience: targetSalience,
      novelty,
      minSalience: writePolicy.minSalience,
      minNovelty: writePolicy.minNovelty,
      reason: writePolicy.reason,
      text: text.slice(0, 60),
    });

    const supersededMemories = [...sameType];
    const didSupersede = supersededMemories.length > 0;

    // Always insert the new memory
    const now = Date.now();
    const memory: PurrMemory = {
      id: uuidv4(),
      text,
      type,
      importance,
      confidence,
      emotionalValence,
      formationVAD: normalizedFormationVAD,
      salience: targetSalience,
      sourceRef: normalizedSourceRef,
      extractedAt: now,
      lastAccessed: now,
      accessCount: 1,
      tags: retention.tags,
      ...(normalizedScopeRef ? { scopeRef: normalizedScopeRef } : {}),
      ...(normalizedScopeTags.length > 0 ? { scopeTags: normalizedScopeTags } : {}),
      provenanceRefs: normalizedProvenanceRefs,
      retentionClass: retention.retentionClass,
      sensitivity,
      consentFlags: mergedIncomingConsentFlags,
      contactId,
    };

    this.memoryStore.runInTransaction(() => {
      for (const old of supersededMemories) {
        this.memoryStore.updateMemory(old.id, { supersededBy: memory.id });
      }
      this.memoryStore.insertMemory(memory, embedding);
    });
    for (const old of supersededMemories) {
      log.debug('Upsert superseded memory', { oldId: old.id, replacementId: memory.id, text: text.slice(0, 60) });
    }
    log.debug('Upsert created memory', { id: memory.id, type, superseded: didSupersede, text: text.slice(0, 60) });

    return {
      action: didSupersede ? 'superseded' : 'created',
      memory,
    };
  }

  async redact(opts: MemoryRedactionOptions): Promise<MemoryRedactionResult | null> {
    const memoryId = opts.memoryId.trim();
    if (!memoryId) {
      throw new Error('memoryId is required');
    }

    const source = this.memoryStore.getById(memoryId);
    if (!source || source.deletedAt !== undefined) {
      return null;
    }

    const behavior = resolveConsentRedactionBehavior(
      source.consentFlags,
      opts.operation ?? 'auto',
    );
    const requestedBy = normalizeSourceRef(opts.requestedBy, 'agent:memory_redact');
    const reason = opts.reason?.trim() || undefined;

    if (behavior === 'delete') {
      const deleted = this.memoryStore.softDeleteMemory(memoryId, {
        deletedBy: requestedBy,
        reason,
      });
      if (!deleted) return null;
      return {
        operation: 'deleted',
        behavior,
        sourceMemoryId: memoryId,
        deleteId: deleted.deleteId,
      };
    }

    const abstraction = abstractMemoryText(source.text);
    const externalRef = `abstraction:${uuidv4()}`;
    const abstractionSourceRef = normalizeSourceRef(opts.sourceRef, 'tool:memory_redact');
    const abstractionImportance = clampUnit(Math.max(source.importance, 0.55), 0.55);
    const abstractionConfidence = clampUnit(Math.max(source.confidence, 0.6), 0.6);
    const abstractionSensitivity = (
      source.sensitivity === 'intimate' || source.sensitivity === 'confidential'
    )
      ? 'personal'
      : source.sensitivity;

    const written = await this.write({
      text: abstraction.text,
      type: 'reflection',
      importance: abstractionImportance,
      emotionalValence: clampSigned(source.emotionalValence, 0),
      confidence: abstractionConfidence,
      tags: normalizeMemoryTags([...source.tags, 'abstracted', 'lesson']),
      sourceRef: abstractionSourceRef,
      provenanceRefs: [externalRef],
      sensitivity: abstractionSensitivity,
      consentFlags: source.consentFlags,
      contactId: source.contactId,
    });

    this.memoryStore.recordAbstractionLink({
      sourceMemoryId: source.id,
      abstractedMemoryId: written.memory.id,
      externalRef,
      createdBy: requestedBy,
      reason,
    });

    const deleteReasonParts = [
      reason,
      `abstracted_memory:${written.memory.id}`,
      `external_ref:${externalRef}`,
    ].filter((part): part is string => typeof part === 'string' && part.length > 0);

    const deleted = this.memoryStore.softDeleteMemory(memoryId, {
      deletedBy: requestedBy,
      reason: deleteReasonParts.join(' | '),
    });
    if (!deleted) {
      throw new Error(`Failed to delete source memory ${memoryId} after abstraction`);
    }

    return {
      operation: 'abstracted',
      behavior,
      sourceMemoryId: memoryId,
      deleteId: deleted.deleteId,
      abstractedMemoryId: written.memory.id,
      abstractedText: written.memory.text,
      externalProvenanceRef: externalRef,
    };
  }

  /**
   * Import a batch of memories. Processes sequentially to allow dedup between items.
   * For large batches, this avoids overwhelming the embedding service.
   */
  async importBatch(records: MemoryWriteOptions[]): Promise<BatchImportResult> {
    const results: WriteResult[] = [];
    let written = 0;
    let deduplicated = 0;
    let superseded = 0;
    let errors = 0;

    if (records.length === 0) {
      log.info('Batch import complete', { written, deduplicated, superseded, errors, total: records.length });
      return { written, deduplicated, superseded, errors, results };
    }

    let batchEmbeddings: Float32Array[] | null = null;
    try {
      const embedded = await this.embeddingService.embedBatch(records.map(record => record.text));
      if (embedded.length !== records.length) {
        throw new Error(`Expected ${records.length} embeddings, received ${embedded.length}`);
      }
      batchEmbeddings = embedded;
    } catch (error) {
      log.warn('Batch embedding failed during import; falling back to per-record embedding', {
        error: String(error),
        total: records.length,
      });
    }

    for (const [index, record] of records.entries()) {
      try {
        const result = batchEmbeddings
          ? await this.writeWithEmbedding(record, batchEmbeddings[index])
          : await this.write(record);
        results.push(result);

        switch (result.action) {
          case 'created':
            written++;
            break;
          case 'deduplicated':
            deduplicated++;
            break;
          case 'superseded':
            written++;
            superseded++;
            break;
        }
      } catch (err) {
        errors++;
        if (err instanceof MemoryWritePolicyError) {
          log.info('Rejected memory during batch import by sensitivity policy', {
            reason: err.reason,
            sensitivity: err.sensitivity,
            salience: err.salience,
            novelty: err.novelty,
            minSalience: err.minSalience,
            minNovelty: err.minNovelty,
            text: record.text.slice(0, 60),
          });
          continue;
        }
        log.error('Error importing memory', { error: String(err), text: record.text.slice(0, 60) });
      }
    }

    log.info('Batch import complete', { written, deduplicated, superseded, errors, total: records.length });
    return { written, deduplicated, superseded, errors, results };
  }
}
