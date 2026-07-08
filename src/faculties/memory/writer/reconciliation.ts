import type {
  MemoryEvolutionLinkInput,
  MemoryEvolutionRelation,
} from '../memory-store-port.js';
import type {
  MemoryProvenance,
  MemorySourceType,
  MemoryType,
  PurrMemory,
} from '../types.js';
import { clampUnit } from '../../../shared/utils/numeric.js';

type ReconciliationWriteAction = 'created' | 'updated' | 'superseded' | 'negated' | 'conflict';

export interface MemoryEvolutionDecision {
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

export function chooseWriteAction(decisions: readonly MemoryEvolutionDecision[]): ReconciliationWriteAction {
  if (decisions.some(decision => decision.relation === 'supersedes' && decision.destructive)) return 'superseded';
  if (decisions.some(decision => decision.relation === 'negates')) return 'negated';
  if (decisions.some(decision => decision.relation === 'conflicts_with')) return 'conflict';
  if (decisions.some(decision => decision.relation === 'updates')) return 'updated';
  return 'created';
}

export function classifyEvolutionDecision(input: {
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

function mergeEvolutionProvenanceRefs(
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

export function buildEvolutionLinkInput(input: {
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
    provenanceRefs: mergeEvolutionProvenanceRefs(
      [`memory:${input.memory.id}`, `memory:${input.decision.oldMemory.id}`],
      input.incomingProvenanceRefs,
    ),
    provenance: input.provenance,
  };
}
