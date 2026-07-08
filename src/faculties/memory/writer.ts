// ── Memory Writer ──
// Shared write/dedup/contradiction logic used by both MemoryExtractor and tools.

import { v7 as uuidv7 } from 'uuid';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import type {
  MemoryEvolutionLink,
  MemoryEvolutionLinkInput,
  MemoryEvolutionRelation,
  MemoryStorePort,
} from './memory-store-port.js';
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
  MemorySourceType,
  MemoryProvenance,
} from './types.js';
import {
  DEDUP_THRESHOLD,
  DURABLE_PREFERENCE_MEMORY_TAG,
  DURABLE_RETENTION_TAG,
  MEMORY_CONFIG,
  inferMemorySourceTypeFromSourceRef,
  inferPreferenceMemoryTags,
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  VALID_MEMORY_TYPES,
  getSensitivityWriteThreshold,
  inferMemoryRetentionClass,
  isDurableMemory,
  normalizeFormationVAD,
  normalizeMemoryTags,
  normalizeMemoryProvenance,
  normalizeMemorySourceType,
  resolveConsentRedactionBehavior,
} from './types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { clampSigned, clampUnit } from '../../shared/utils/numeric.js';
import {
  MemoryMaintenanceScheduler,
  type MemoryMaintenanceSchedulerOptions,
} from './maintenance-review.js';
import {
  evaluateCogSecMemoryCandidacy,
  type CogSecMemoryCandidacyDecision,
} from '../../core/cogsec/memory-candidacy.js';

const log = createComponentLogger('MemoryWriter');
const IMPORT_BATCH_EMBED_CHUNK_SIZE = 200;

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
  sourceType?: MemorySourceType;
  provenance?: MemoryProvenance;
  provenanceRefs?: string[];
  sensitivity?: SensitivityLevel;    // default 'personal'
  consentFlags?: ConsentFlags;       // default {}
  retentionClass?: MemoryRetentionClass;
  contactId?: string;
  scopeRef?: MemoryScopeRef;
  scopeTags?: string[];
  extractedAt?: number;
}

export interface WriteResult {
  action: 'created' | 'deduplicated' | 'updated' | 'superseded' | 'negated' | 'conflict';
  memory: PurrMemory;
  /** If deduplicated, the existing memory that was bumped */
  existingId?: string;
  /** Existing memory ids affected by explicit evolution reconciliation. */
  relatedMemoryIds?: string[];
  /** Existing memory ids deactivated by this write. */
  supersededMemoryIds?: string[];
  evolutionLinks?: MemoryEvolutionLink[];
}

export interface MemoryPatchOptions {
  memoryId: string;
  text?: string;
  importance?: number;
  confidence?: number;
  emotionalValence?: number;
  formationVAD?: MemoryFormationVAD;
  clearFormationVAD?: boolean;
  tags?: string[];
  appendTags?: string[];
  reason?: string;
  sourceRef?: string;
  sourceType?: MemorySourceType;
  provenance?: MemoryProvenance;
  requestedBy?: string;
  referencePath?: string;
}

export interface MemoryPatchResult {
  memory: PurrMemory;
  patchEventId: string;
  updatedFields: string[];
}

export interface MemoryCorrectionResult {
  sourceMemory: PurrMemory;
  replacementMemory: PurrMemory;
  reason?: string;
  reviewReferencePath?: string;
}

export interface BatchImportResult {
  written: number;
  deduplicated: number;
  superseded: number;
  errors: number;
  results: WriteResult[];
}

export interface MemoryWriterOptions {
  maintenanceScheduler?: MemoryMaintenanceScheduler | null;
  maintenanceSchedule?: MemoryMaintenanceSchedulerOptions['schedule'];
  maintenanceNow?: MemoryMaintenanceSchedulerOptions['now'];
  onMaintenanceError?: MemoryMaintenanceSchedulerOptions['onError'];
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

export class MemoryCandidacyPolicyError extends Error {
  readonly decision: CogSecMemoryCandidacyDecision;

  constructor(decision: CogSecMemoryCandidacyDecision) {
    super(
      `Memory write rejected by CogSec candidacy policy: ${decision.riskClass} `
      + `(${decision.reasonCodes.join(', ')})`,
    );
    this.name = 'MemoryCandidacyPolicyError';
    this.decision = decision;
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
  text: string;
  type: MemoryType;
  importance: number;
  tags: readonly string[];
  retentionClass?: MemoryRetentionClass;
}): {
  tags: string[];
  retentionClass?: MemoryRetentionClass;
} {
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

function normalizeSourceRef(sourceRef: string | undefined, fallback: string): string {
  const trimmed = sourceRef?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizeExactDuplicateText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeSourceContext(input: {
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

function validateEmbeddingDimensions(
  embedding: Float32Array,
  expectedDims: number,
  operation: string,
): void {
  if (embedding.length !== expectedDims) {
    throw new Error(`Memory writer ${operation} embedding dimension mismatch: expected ${expectedDims}, got ${embedding.length}`);
  }
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

type ReconciliationWriteAction = Exclude<WriteResult['action'], 'deduplicated'>;

interface MemoryEvolutionDecision {
  oldMemory: PurrMemory & { similarity: number };
  relation: MemoryEvolutionRelation;
  destructive: boolean;
  reason: string;
}

const HIGH_IMPACT_MEMORY_TYPES = new Set<MemoryType>(['boundary', 'emotional', 'relational']);
const HIGH_IMPACT_TAG_HINTS = new Set([
  'identity',
  'profile',
  'contact',
  'contact_profile',
  'core_profile',
  'core_relationship',
  'relationship_core',
  'relationship',
  'boundary',
  'consent',
  'emotion',
  'emotional',
  'feeling',
  'family',
  'partner',
]);
const CURRENT_STATE_TAG_HINTS = new Set(['current', 'current_state', 'current-state', 'latest', 'active']);
const COMPATIBLE_UPDATE_TAG_HINTS = new Set(['preference', 'likes', 'interest', 'routine', 'tool', 'workspace']);
const CURRENT_STATE_TEXT_HINT = /\b(current|currently|now|latest|active|moved to|changed to|updated?:|update:|is now|are now|no longer)\b/i;
const COMPATIBLE_UPDATE_TEXT_HINT = /\b(also|additionally|another|besides|after lunch|in addition|likes both|also likes)\b/i;
const EXPLICIT_NEGATION_TEXT_HINT = /\b(no longer|not|never|doesn't|does not|isn't|is not|aren't|are not|must not|should not|cannot|can't|won't)\b/i;
const CONTRASTING_TERM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['on', 'off'],
  ['enabled', 'disabled'],
  ['active', 'inactive'],
  ['available', 'unavailable'],
  ['open', 'closed'],
  ['allowed', 'disallowed'],
  ['yes', 'no'],
  ['true', 'false'],
];

function normalizeReconciliationTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function hasAnyTag(tags: readonly string[] | undefined, hints: ReadonlySet<string>): boolean {
  for (const raw of tags ?? []) {
    const normalized = normalizeReconciliationTag(raw);
    if (hints.has(normalized)) return true;
  }
  return false;
}

function textHasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

function hasContrastingTerms(incomingText: string, existingText: string): boolean {
  for (const [left, right] of CONTRASTING_TERM_PAIRS) {
    if (
      (textHasWord(incomingText, left) && textHasWord(existingText, right))
      || (textHasWord(incomingText, right) && textHasWord(existingText, left))
    ) {
      return true;
    }
  }
  return false;
}

function isCurrentStateMemory(input: {
  text: string;
  tags: readonly string[];
}): boolean {
  return hasAnyTag(input.tags, CURRENT_STATE_TAG_HINTS) || CURRENT_STATE_TEXT_HINT.test(input.text);
}

function isCompatibleMemoryUpdate(input: {
  text: string;
  tags: readonly string[];
  existing: PurrMemory;
}): boolean {
  if (COMPATIBLE_UPDATE_TEXT_HINT.test(input.text)) return true;
  if (!hasAnyTag(input.tags, COMPATIBLE_UPDATE_TAG_HINTS)) return false;
  const incomingTags = new Set(input.tags.map(normalizeReconciliationTag));
  return input.existing.tags
    .map(normalizeReconciliationTag)
    .some(tag => incomingTags.has(tag));
}

function isExplicitContradiction(input: {
  text: string;
  existingText: string;
}): boolean {
  return EXPLICIT_NEGATION_TEXT_HINT.test(input.text)
    || hasContrastingTerms(input.text, input.existingText);
}

function isHighImpactMemory(input: Pick<PurrMemory, 'type' | 'tags' | 'contactId' | 'text'>): boolean {
  return HIGH_IMPACT_MEMORY_TYPES.has(input.type)
    || !!input.contactId
    || hasAnyTag(input.tags, HIGH_IMPACT_TAG_HINTS)
    || /\b(identity|profile|partner|family|boundary|consent|feeling|emotion|contact)\b/i.test(input.text);
}

function chooseWriteAction(decisions: readonly MemoryEvolutionDecision[]): ReconciliationWriteAction {
  if (decisions.some(decision => decision.relation === 'supersedes' && decision.destructive)) return 'superseded';
  if (decisions.some(decision => decision.relation === 'negates')) return 'negated';
  if (decisions.some(decision => decision.relation === 'conflicts_with')) return 'conflict';
  if (decisions.some(decision => decision.relation === 'updates')) return 'updated';
  return 'created';
}

function classifyEvolutionDecision(input: {
  incomingText: string;
  incomingTags: readonly string[];
  incomingConfidence: number;
  incomingType: MemoryType;
  incomingContactId?: string;
  oldMemory: PurrMemory & { similarity: number };
}): MemoryEvolutionDecision | null {
  const incomingMemoryLike: Pick<PurrMemory, 'type' | 'tags' | 'contactId' | 'text'> = {
    type: input.incomingType,
    tags: [...input.incomingTags],
    contactId: input.incomingContactId,
    text: input.incomingText,
  };
  const currentState = isCurrentStateMemory({
    text: input.incomingText,
    tags: input.incomingTags,
  });
  const compatibleUpdate = isCompatibleMemoryUpdate({
    text: input.incomingText,
    tags: input.incomingTags,
    existing: input.oldMemory,
  });
  const explicitContradiction = isExplicitContradiction({
    text: input.incomingText,
    existingText: input.oldMemory.text,
  });
  const highImpact = isHighImpactMemory(incomingMemoryLike) || isHighImpactMemory(input.oldMemory);
  const higherConfidence = input.incomingConfidence > input.oldMemory.confidence;

  if (currentState && higherConfidence) {
    return {
      oldMemory: input.oldMemory,
      relation: 'supersedes',
      destructive: true,
      reason: 'memory_writer:current_state_replacement',
    };
  }

  if (compatibleUpdate && !explicitContradiction) {
    return {
      oldMemory: input.oldMemory,
      relation: 'updates',
      destructive: false,
      reason: 'memory_writer:compatible_update',
    };
  }

  if (highImpact) {
    return {
      oldMemory: input.oldMemory,
      relation: explicitContradiction ? 'negates' : 'conflicts_with',
      destructive: false,
      reason: explicitContradiction
        ? 'memory_writer:high_impact_negation_review'
        : 'memory_writer:high_impact_conflict_review',
    };
  }

  if (explicitContradiction) {
    return {
      oldMemory: input.oldMemory,
      relation: higherConfidence ? 'supersedes' : 'conflicts_with',
      destructive: higherConfidence,
      reason: higherConfidence
        ? 'memory_writer:contradiction_replacement'
        : 'memory_writer:contradiction_conflict',
    };
  }

  if (higherConfidence) {
    return {
      oldMemory: input.oldMemory,
      relation: 'supersedes',
      destructive: true,
      reason: 'memory_writer:higher_confidence_replacement',
    };
  }

  return null;
}

function buildEvolutionLinkInput(input: {
  memory: PurrMemory;
  decision: MemoryEvolutionDecision;
  sourceRef: string;
  sourceType: MemorySourceType;
  provenance?: MemoryProvenance;
  incomingProvenanceRefs: readonly string[];
}): MemoryEvolutionLinkInput {
  return {
    sourceMemoryId: input.memory.id,
    targetMemoryId: input.decision.oldMemory.id,
    relation: input.decision.relation,
    confidence: clampUnit(
      Math.max(input.memory.confidence, input.decision.oldMemory.confidence),
      input.memory.confidence,
    ),
    reason: input.decision.reason,
    sourceRef: input.sourceRef,
    sourceType: input.sourceType,
    provenanceRefs: mergeProvenanceRefs(
      [`memory:${input.memory.id}`, `memory:${input.decision.oldMemory.id}`],
      input.incomingProvenanceRefs,
    ),
    provenance: input.provenance,
  };
}

export class MemoryWriter {
  private readonly maintenanceScheduler: MemoryMaintenanceScheduler | null;

  constructor(
    private memoryStore: MemoryStorePort,
    private embeddingService: EmbeddingProviderPort,
    options: MemoryWriterOptions = {},
  ) {
    this.maintenanceScheduler = options.maintenanceScheduler === undefined
      ? new MemoryMaintenanceScheduler(memoryStore, {
        schedule: options.maintenanceSchedule,
        now: options.maintenanceNow,
        onError: options.onMaintenanceError,
      })
      : options.maintenanceScheduler;
  }

  private validateEmbedding(embedding: Float32Array, operation: string): void {
    if (Number.isFinite(this.embeddingService.dims) && this.embeddingService.dims > 0) {
      validateEmbeddingDimensions(embedding, this.embeddingService.dims, operation);
    }
  }

  private queueMaintenanceReview(input: {
    memory: PurrMemory;
    candidates: Array<PurrMemory & { similarity: number }>;
  }): void {
    this.maintenanceScheduler?.queuePostWriteReview(input);
  }

  /**
   * Record evolution links for an already-committed memory. The memory has been
   * durably persisted by persistMemoryWrite before this runs, and the runtime
   * store (Postgres) has no shared transaction spanning the two, so a link
   * failure cannot roll the memory back. Surfacing it as a write failure would
   * report failure for a persisted memory and invite duplicate re-writes, so
   * link failures are logged durably and skipped instead — the returned links
   * reflect only what was committed, matching the reported write result
   * (mlwk.6).
   */
  private async recordEvolutionLinks(
    memory: PurrMemory,
    decisions: readonly MemoryEvolutionDecision[],
    context: {
      sourceRef: string;
      sourceType: MemorySourceType;
      provenance?: MemoryProvenance;
      incomingProvenanceRefs: readonly string[];
    },
  ): Promise<MemoryEvolutionLink[]> {
    const links: MemoryEvolutionLink[] = [];
    for (const decision of decisions) {
      try {
        links.push(await this.memoryStore.recordEvolutionLink(buildEvolutionLinkInput({
          memory,
          decision,
          sourceRef: context.sourceRef,
          sourceType: context.sourceType,
          provenance: context.provenance,
          incomingProvenanceRefs: context.incomingProvenanceRefs,
        })));
      } catch (error) {
        log.error('Failed to record memory evolution link after memory commit; memory is durable, link skipped', {
          memoryId: memory.id,
          oldMemoryId: decision.oldMemory.id,
          relation: decision.relation,
          reason: decision.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return links;
  }

  private assertCogSecCandidacy(
    opts: MemoryWriteOptions,
    options: { logRejection?: boolean } = {},
  ): void {
    const decision = evaluateCogSecMemoryCandidacy({
      text: opts.text,
      type: opts.type,
      tags: opts.tags,
      sourceRef: opts.sourceRef,
      sourceType: opts.sourceType,
    });
    if (decision.disposition === 'allow') return;
    if (options.logRejection ?? true) {
      log.info('Rejected memory write by CogSec candidacy policy', {
        type: opts.type,
        riskClass: decision.riskClass,
        disposition: decision.disposition,
        reasonCodes: decision.reasonCodes,
        sourceType: opts.sourceType,
      });
    }
    throw new MemoryCandidacyPolicyError(decision);
  }

  /**
   * Write a single memory with dedup/contradiction handling.
   *
   * 1. Embed the text
   * 2. Check for duplicates at type-specific threshold -- if found, bump salience
   * 3. Check for contradictions at lower threshold -- if found and new confidence > old, supersede
   * 4. Insert new memory
   */
  async write(opts: MemoryWriteOptions): Promise<WriteResult> {
    this.assertCogSecCandidacy(opts);
    const embedding = await this.embeddingService.embed(opts.text);
    return this.writeWithEmbedding(opts, embedding);
  }

  private async writeWithEmbedding(
    opts: MemoryWriteOptions,
    embedding: Float32Array,
  ): Promise<WriteResult> {
    this.assertCogSecCandidacy(opts);
    this.validateEmbedding(embedding, 'write');

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
      sourceType,
      provenance,
      provenanceRefs,
      sensitivity = 'personal',
      consentFlags,
      retentionClass,
      contactId,
      scopeRef,
      scopeTags,
      extractedAt,
    } = opts;

    // Validate type
    if (!VALID_MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}. Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`);
    }

    const retention = applyRetentionSemantics({
      text,
      type,
      importance,
      tags,
      retentionClass,
    });
    const normalizedConsentFlags = consentFlags === undefined
      ? undefined
      : normalizeConsentFlags(consentFlags);
    const normalizedFormationVAD = normalizeFormationVAD(formationVAD);
    const normalizedSource = normalizeSourceContext({
      sourceRef,
      sourceType,
      provenance,
      fallbackRef: 'tool:memory_write',
    });
    const normalizedSourceRef = normalizedSource.sourceRef;
    const incomingProvenanceRefs = normalizeProvenanceRefs(provenanceRefs, normalizedSourceRef);
    const normalizedScopeRef = normalizeMemoryScopeRef(scopeRef);
    const normalizedScopeTags = normalizeMemoryScopeTags(scopeTags);
    const targetSalience = clampUnit(salience ?? importance, importance);

    // 1. Check for exact duplicates (high threshold per type)
    const duplicates = await this.memoryStore.searchByEmbedding(
      embedding,
      DEDUP_THRESHOLD[type],
      3,
    );

    const sameTypeDups = duplicates.filter(d => (
      d.type === type && (
        !contactId
        || d.contactId === contactId
      ) && shouldConsiderDuplicateForScope(d, normalizedScopeRef)
      && normalizeExactDuplicateText(d.text) === normalizeExactDuplicateText(text)
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
        retentionClass?: MemoryRetentionClass;
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
        updates.retentionClass = 'durable';
      } else if (retention.retentionClass === 'durable' && existing.retentionClass !== 'durable') {
        updates.retentionClass = 'durable';
      }

      await this.memoryStore.updateMemory(existing.id, updates);
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
          retentionClass: updates.retentionClass ?? retention.retentionClass ?? existing.retentionClass,
          scopeRef: updates.scopeRef ?? existing.scopeRef,
          scopeTags: updates.scopeTags ?? existing.scopeTags,
        },
        existingId: existing.id,
      };
    }

    // 2. Check for contradictions (lower threshold)
    const broader = await this.memoryStore.searchByEmbedding(
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

    const evolutionDecisions = sameContactBroader
      .map(old => classifyEvolutionDecision({
        incomingText: text,
        incomingTags: retention.tags,
        incomingConfidence: confidence,
        incomingType: type,
        incomingContactId: contactId,
        oldMemory: old,
      }))
      .filter((decision): decision is MemoryEvolutionDecision => decision !== null);
    const supersededMemories = evolutionDecisions
      .filter(decision => decision.destructive)
      .map(decision => decision.oldMemory);

    // 3. Insert new memory
    const now = Number.isFinite(extractedAt) ? Number(extractedAt) : Date.now();
    const memory: PurrMemory = {
      id: uuidv7(),
      text,
      type,
      importance,
      confidence,
      emotionalValence,
      formationVAD: normalizedFormationVAD,
      salience: targetSalience,
      sourceRef: normalizedSourceRef,
      sourceType: normalizedSource.sourceType,
      ...(normalizedSource.provenance ? { provenance: normalizedSource.provenance } : {}),
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

    await this.memoryStore.persistMemoryWrite({
      memory,
      embedding,
      supersededMemoryIds: supersededMemories.map(old => old.id),
    });
    const evolutionLinks = await this.recordEvolutionLinks(memory, evolutionDecisions, {
      sourceRef: normalizedSourceRef,
      sourceType: normalizedSource.sourceType,
      provenance: normalizedSource.provenance,
      incomingProvenanceRefs,
    });
    this.queueMaintenanceReview({
      memory,
      candidates: sameContactBroader,
    });

    for (const old of supersededMemories) {
      log.debug('Superseded memory', { oldId: old.id, replacementId: memory.id, text: text.slice(0, 60) });
    }
    for (const link of evolutionLinks) {
      log.debug('Recorded memory evolution link', {
        sourceMemoryId: link.sourceMemoryId,
        targetMemoryId: link.targetMemoryId,
        relation: link.relation,
        reason: link.reason,
      });
    }
    log.debug('Created memory', { id: memory.id, type, text: text.slice(0, 60) });

    return {
      action: chooseWriteAction(evolutionDecisions),
      memory,
      relatedMemoryIds: evolutionDecisions.map(decision => decision.oldMemory.id),
      supersededMemoryIds: supersededMemories.map(old => old.id),
      evolutionLinks,
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
      sourceType,
      provenance,
      provenanceRefs,
      sensitivity = 'personal',
      consentFlags,
      retentionClass,
      contactId,
      scopeRef,
      scopeTags,
      extractedAt,
    } = opts;

    if (!VALID_MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}. Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`);
    }

    const retention = applyRetentionSemantics({
      text,
      type,
      importance,
      tags,
      retentionClass,
    });
    const normalizedFormationVAD = normalizeFormationVAD(formationVAD);
    const normalizedSource = normalizeSourceContext({
      sourceRef,
      sourceType,
      provenance,
      fallbackRef: 'tool:memory_upsert',
    });
    const normalizedSourceRef = normalizedSource.sourceRef;
    const normalizedProvenanceRefs = normalizeProvenanceRefs(provenanceRefs, normalizedSourceRef);
    const normalizedScopeRef = normalizeMemoryScopeRef(scopeRef);
    const normalizedScopeTags = normalizeMemoryScopeTags(scopeTags);
    const targetSalience = clampUnit(salience ?? importance, importance);

    const embedding = await this.embeddingService.embed(text);
    this.validateEmbedding(embedding, 'upsert');

    // Find similar memories of the same type at the dedup threshold
    const similar = await this.memoryStore.searchByEmbedding(
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
    const now = Number.isFinite(extractedAt) ? Number(extractedAt) : Date.now();
    const memory: PurrMemory = {
      id: uuidv7(),
      text,
      type,
      importance,
      confidence,
      emotionalValence,
      formationVAD: normalizedFormationVAD,
      salience: targetSalience,
      sourceRef: normalizedSourceRef,
      sourceType: normalizedSource.sourceType,
      ...(normalizedSource.provenance ? { provenance: normalizedSource.provenance } : {}),
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

    await this.memoryStore.persistMemoryWrite({
      memory,
      embedding,
      supersededMemoryIds: supersededMemories.map(old => old.id),
    });
    const evolutionDecisions: MemoryEvolutionDecision[] = supersededMemories.map(oldMemory => ({
      oldMemory,
      relation: 'supersedes',
      destructive: true,
      reason: 'memory_writer:explicit_upsert_replacement',
    }));
    const evolutionLinks = await this.recordEvolutionLinks(memory, evolutionDecisions, {
      sourceRef: normalizedSourceRef,
      sourceType: normalizedSource.sourceType,
      provenance: normalizedSource.provenance,
      incomingProvenanceRefs: normalizedProvenanceRefs,
    });
    this.queueMaintenanceReview({
      memory,
      candidates: sameType,
    });
    for (const old of supersededMemories) {
      log.debug('Upsert superseded memory', { oldId: old.id, replacementId: memory.id, text: text.slice(0, 60) });
    }
    log.debug('Upsert created memory', { id: memory.id, type, superseded: didSupersede, text: text.slice(0, 60) });

    return {
      action: didSupersede ? 'superseded' : 'created',
      memory,
      relatedMemoryIds: evolutionDecisions.map(decision => decision.oldMemory.id),
      supersededMemoryIds: supersededMemories.map(old => old.id),
      evolutionLinks,
    };
  }

  async patchMemory(opts: MemoryPatchOptions): Promise<MemoryPatchResult | null> {
    const memoryId = opts.memoryId.trim();
    if (!memoryId) {
      throw new Error('memoryId is required');
    }
    if (opts.tags && opts.appendTags) {
      throw new Error('patchMemory accepts either tags or appendTags, not both');
    }

    const existing = await this.memoryStore.getById(memoryId);
    if (!existing || existing.deletedAt !== undefined) {
      return null;
    }

    const updates: Partial<PurrMemory> = {};
    const previousValues: Record<string, unknown> = {};
    const nextValues: Record<string, unknown> = {};
    const patch: Record<string, unknown> = {};
    const updatedFields: string[] = [];

    if (opts.text !== undefined) {
      const text = opts.text.trim();
      if (!text) throw new Error('patchMemory text cannot be empty');
      if (text !== existing.text) {
        updates.text = text;
        previousValues.text = existing.text;
        nextValues.text = text;
        patch.text = text;
        updatedFields.push('text');
      }
    }
    if (opts.importance !== undefined) {
      const importance = clampUnit(opts.importance, 0.5);
      if (importance !== existing.importance) {
        updates.importance = importance;
        previousValues.importance = existing.importance;
        nextValues.importance = importance;
        patch.importance = importance;
        updatedFields.push('importance');
      }
    }
    if (opts.confidence !== undefined) {
      const confidence = clampUnit(opts.confidence, 0.5);
      if (confidence !== existing.confidence) {
        updates.confidence = confidence;
        previousValues.confidence = existing.confidence;
        nextValues.confidence = confidence;
        patch.confidence = confidence;
        updatedFields.push('confidence');
      }
    }
    if (opts.emotionalValence !== undefined) {
      const emotionalValence = clampSigned(opts.emotionalValence);
      if (emotionalValence !== existing.emotionalValence) {
        updates.emotionalValence = emotionalValence;
        previousValues.emotionalValence = existing.emotionalValence;
        nextValues.emotionalValence = emotionalValence;
        patch.emotionalValence = emotionalValence;
        updatedFields.push('emotionalValence');
      }
    }
    if (opts.clearFormationVAD) {
      if (existing.formationVAD !== undefined) {
        updates.formationVAD = undefined;
        previousValues.formationVAD = existing.formationVAD;
        nextValues.formationVAD = null;
        patch.clearFormationVAD = true;
        updatedFields.push('formationVAD');
      }
    } else if (opts.formationVAD !== undefined) {
      const formationVAD = normalizeFormationVAD(opts.formationVAD);
      const currentSerialized = JSON.stringify(existing.formationVAD ?? null);
      const nextSerialized = JSON.stringify(formationVAD ?? null);
      if (currentSerialized !== nextSerialized) {
        updates.formationVAD = formationVAD;
        previousValues.formationVAD = existing.formationVAD ?? null;
        nextValues.formationVAD = formationVAD ?? null;
        patch.formationVAD = formationVAD ?? null;
        updatedFields.push('formationVAD');
      }
    }

    const replacementTags = opts.tags ? normalizeMemoryTags(opts.tags) : undefined;
    const appendedTags = opts.appendTags ? normalizeMemoryTags(opts.appendTags) : undefined;
    if (replacementTags || appendedTags) {
      const nextTagInput = replacementTags ?? [...existing.tags, ...(appendedTags ?? [])];
      const retention = applyRetentionSemantics({
        text: updates.text ?? existing.text,
        type: existing.type,
        importance: updates.importance ?? existing.importance,
        tags: nextTagInput,
        retentionClass: existing.retentionClass,
      });
      const currentSerialized = JSON.stringify(existing.tags);
      const nextSerialized = JSON.stringify(retention.tags);
      if (currentSerialized !== nextSerialized) {
        updates.tags = retention.tags;
        previousValues.tags = existing.tags;
        nextValues.tags = retention.tags;
        patch.tags = retention.tags;
        if (appendedTags?.length) {
          patch.appendTags = appendedTags;
        }
        updatedFields.push('tags');
      }
    }

    if (updatedFields.length === 0) {
      throw new Error('patchMemory produced no changes');
    }

    let embedding: Float32Array | undefined;
    if (updates.text !== undefined) {
      this.assertCogSecCandidacy({
        text: updates.text,
        type: existing.type,
        tags: updates.tags ?? existing.tags,
        sourceRef: opts.sourceRef,
        sourceType: opts.sourceType,
        provenance: opts.provenance,
      });
      embedding = await this.embeddingService.embed(updates.text);
      this.validateEmbedding(embedding, 'patchMemory');
      updates.embedding = embedding;
    }

    const auditContext = normalizeSourceContext({
      sourceRef: opts.sourceRef,
      sourceType: opts.sourceType,
      provenance: opts.provenance,
      fallbackRef: 'tool:memory_patch',
    });
    if (opts.reason?.trim()) {
      patch.reason = opts.reason.trim();
    }

    const updatedMemory: PurrMemory = {
      ...existing,
      ...updates,
      text: updates.text ?? existing.text,
      importance: updates.importance ?? existing.importance,
      confidence: updates.confidence ?? existing.confidence,
      emotionalValence: updates.emotionalValence ?? existing.emotionalValence,
      formationVAD: Object.prototype.hasOwnProperty.call(updates, 'formationVAD')
        ? updates.formationVAD
        : existing.formationVAD,
      tags: updates.tags ?? existing.tags,
    };
    const patchEventId = uuidv7();

    await this.memoryStore.runInTransaction(() => {
      this.memoryStore.updateMemory(memoryId, updates);
      this.memoryStore.recordPatchEvent({
        id: patchEventId,
        memoryId,
        sourceRef: auditContext.sourceRef,
        sourceType: auditContext.sourceType,
        provenance: auditContext.provenance,
        reason: opts.reason?.trim() || undefined,
        patch,
        previousValues,
        nextValues,
        createdAt: Date.now(),
      });
    });

    return {
      memory: updatedMemory,
      patchEventId,
      updatedFields,
    };
  }

  async patch(opts: MemoryPatchOptions): Promise<MemoryCorrectionResult | null> {
    const memoryId = opts.memoryId.trim();
    if (!memoryId) {
      throw new Error('memoryId is required');
    }

    const existing = await this.memoryStore.getById(memoryId);
    if (!existing || existing.deletedAt !== undefined) {
      return null;
    }

    const nextText = opts.text?.trim();
    if (!nextText) {
      throw new Error('patch text is required');
    }
    if (nextText === existing.text) {
      throw new Error('patch text must change the memory');
    }

    const auditContext = normalizeSourceContext({
      sourceRef: opts.sourceRef,
      sourceType: opts.sourceType,
      provenance: opts.provenance,
      fallbackRef: 'tool:memory_patch',
    });
    const reason = opts.reason?.trim() || undefined;
    const reviewReferencePath = opts.referencePath?.trim() || undefined;
    const referenceRef = reviewReferencePath ? `reference:${reviewReferencePath}` : undefined;
    const replacementId = uuidv7();
    const now = Date.now();
    this.assertCogSecCandidacy({
      text: nextText,
      type: existing.type,
      tags: [...existing.tags, 'corrected'],
      sourceRef: opts.sourceRef,
      sourceType: opts.sourceType,
      provenance: opts.provenance,
    });
    const embedding = await this.embeddingService.embed(nextText);
    this.validateEmbedding(embedding, 'patch');
    const replacementRetention = applyRetentionSemantics({
      text: nextText,
      type: existing.type,
      importance: opts.importance ?? existing.importance,
      tags: [...existing.tags, 'corrected'],
      retentionClass: existing.retentionClass,
    });
    const replacementProvenanceRefs = normalizeProvenanceRefs([
      `memory:${existing.id}`,
      ...(existing.provenanceRefs ?? []),
      `supersedes:${existing.id}`,
      ...(referenceRef ? [referenceRef] : []),
    ]);
    const sourceProvenanceRefs = normalizeProvenanceRefs([
      ...(existing.provenanceRefs ?? []),
      `superseded_by:${replacementId}`,
      ...(referenceRef ? [referenceRef] : []),
    ]);
    const replacementMemory: PurrMemory = {
      ...existing,
      id: replacementId,
      text: nextText,
      importance: opts.importance ?? existing.importance,
      confidence: opts.confidence ?? existing.confidence,
      emotionalValence: opts.emotionalValence ?? existing.emotionalValence,
      formationVAD: opts.clearFormationVAD
        ? undefined
        : normalizeFormationVAD(opts.formationVAD) ?? existing.formationVAD,
      sourceRef: auditContext.sourceRef,
      sourceType: auditContext.sourceType,
      ...(auditContext.provenance ? { provenance: auditContext.provenance } : {}),
      extractedAt: now,
      lastAccessed: now,
      accessCount: 1,
      tags: replacementRetention.tags,
      provenanceRefs: replacementProvenanceRefs,
      retentionClass: replacementRetention.retentionClass,
      supersededBy: undefined,
      deletedAt: undefined,
      deletedBy: undefined,
      deleteReason: undefined,
    };

    await this.memoryStore.runInTransaction(() => {
      this.memoryStore.updateMemory(existing.id, {
        supersededBy: replacementId,
        provenanceRefs: sourceProvenanceRefs,
      });
      this.memoryStore.insertMemory(replacementMemory, embedding);
    });
    await this.memoryStore.recordEvolutionLink({
      sourceMemoryId: replacementMemory.id,
      targetMemoryId: existing.id,
      relation: 'supersedes',
      confidence: clampUnit(Math.max(replacementMemory.confidence, existing.confidence), replacementMemory.confidence),
      reason: reason ? `memory_writer:patch_correction:${reason}` : 'memory_writer:patch_correction',
      sourceRef: auditContext.sourceRef,
      sourceType: auditContext.sourceType,
      provenanceRefs: mergeProvenanceRefs(replacementProvenanceRefs, sourceProvenanceRefs),
      provenance: auditContext.provenance,
    });

    return {
      sourceMemory: {
        ...existing,
        supersededBy: replacementId,
        provenanceRefs: sourceProvenanceRefs,
      },
      replacementMemory,
      reason,
      reviewReferencePath,
    };
  }

  async redact(opts: MemoryRedactionOptions): Promise<MemoryRedactionResult | null> {
    const memoryId = opts.memoryId.trim();
    if (!memoryId) {
      throw new Error('memoryId is required');
    }

    const source = await this.memoryStore.getById(memoryId);
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
      const deleted = await this.memoryStore.softDeleteMemory(memoryId, {
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
    const externalRef = `abstraction:${uuidv7()}`;
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

    await this.memoryStore.recordAbstractionLink({
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

    const deleted = await this.memoryStore.softDeleteMemory(memoryId, {
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

    const acceptedRecords: MemoryWriteOptions[] = [];
    for (const record of records) {
      try {
        this.assertCogSecCandidacy(record, { logRejection: false });
        acceptedRecords.push(record);
      } catch (err) {
        errors++;
        if (err instanceof MemoryCandidacyPolicyError) {
          log.info('Rejected memory during batch import by CogSec candidacy policy', {
            riskClass: err.decision.riskClass,
            disposition: err.decision.disposition,
            reasonCodes: err.decision.reasonCodes,
            type: record.type,
          });
          continue;
        }
        throw err;
      }
    }

    if (acceptedRecords.length === 0) {
      log.info('Batch import complete', { written, deduplicated, superseded, errors, total: records.length });
      return { written, deduplicated, superseded, errors, results };
    }

    let batchEmbeddings: Float32Array[] | null = null;
    try {
      const embeddedChunks: Float32Array[][] = [];
      for (let start = 0; start < acceptedRecords.length; start += IMPORT_BATCH_EMBED_CHUNK_SIZE) {
        const chunk = acceptedRecords.slice(start, start + IMPORT_BATCH_EMBED_CHUNK_SIZE);
        const embedded = await this.embeddingService.embedBatch(chunk.map(record => record.text));
        if (embedded.length !== chunk.length) {
          throw new Error(`Expected ${chunk.length} embeddings, received ${embedded.length}`);
        }
        for (const embedding of embedded) {
          this.validateEmbedding(embedding, 'importBatch');
        }
        embeddedChunks.push(embedded);
      }
      batchEmbeddings = embeddedChunks.flat();
    } catch (error) {
      log.warn('Batch embedding failed during import; falling back to per-record embedding', {
        error: String(error),
        total: acceptedRecords.length,
      });
    }

    for (const [index, record] of acceptedRecords.entries()) {
      try {
        const result = batchEmbeddings
          ? await this.writeWithEmbedding(record, batchEmbeddings[index])
          : await this.write(record);
        results.push(result);

        switch (result.action) {
          case 'created':
          case 'updated':
          case 'negated':
          case 'conflict':
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
        if (err instanceof MemoryCandidacyPolicyError) {
          log.info('Rejected memory during batch import by CogSec candidacy policy', {
            riskClass: err.decision.riskClass,
            disposition: err.decision.disposition,
            reasonCodes: err.decision.reasonCodes,
            type: record.type,
          });
          continue;
        }
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
