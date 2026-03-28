import type {
  SensitivityLevel,
  ConsentFlags,
  ConsentRedactionBehavior,
  MemoryRedactionOperation,
} from '../../system/trust/types.js';
// Re-export for convenience
export type {
  SensitivityLevel,
  ConsentFlags,
  ConsentRedactionBehavior,
  MemoryRedactionOperation,
};
export {
  VALID_SENSITIVITY_LEVELS,
  VALID_CONSENT_REDACTION_BEHAVIORS,
  VALID_MEMORY_REDACTION_OPERATIONS,
  normalizeConsentFlags,
  resolveConsentRedactionBehavior,
} from '../../system/trust/types.js';

export type MemoryType =
  | 'episodic'
  | 'semantic'
  | 'emotional'
  | 'procedural'
  | 'boundary'
  | 'reflection'
  | 'relational';
export type MemoryRetentionClass = 'standard' | 'durable';
export type MemoryScopeKind =
  | 'conversation'
  | 'contact'
  | 'project'
  | 'north_star'
  | 'task_worker'
  | 'shard'
  | 'system';
export type MemoryScopeQueryMode = 'prefer' | 'only';
export interface MemoryFormationVAD {
  valence: number;
  arousal: number;
  dominance: number;
}
export interface MemoryScopeRef {
  kind: MemoryScopeKind;
  id: string;
  label?: string;
}
export interface MemoryScopeQuery {
  refs?: MemoryScopeRef[];
  tags?: string[];
  mode?: MemoryScopeQueryMode;
}

export const VALID_MEMORY_SCOPE_KINDS: MemoryScopeKind[] = [
  'conversation',
  'contact',
  'project',
  'north_star',
  'task_worker',
  'shard',
  'system',
];

export const DURABLE_RETENTION_TAG = 'durable';
export const CORE_DURABLE_MEMORY_TAGS = [
  'core_profile',
  'core_relationship',
  'relationship_core',
] as const;
const AUTO_DURABLE_RELATIONAL_TAG_HINTS = [
  'identity',
  'profile',
  'relationship',
  'partner',
  'spouse',
  'anniversary',
  'family',
] as const;
const DURABLE_RETENTION_TAG_SET = new Set<string>([
  DURABLE_RETENTION_TAG,
  ...CORE_DURABLE_MEMORY_TAGS,
]);
const AUTO_DURABLE_RELATIONAL_TAG_HINT_SET = new Set<string>(AUTO_DURABLE_RELATIONAL_TAG_HINTS);
const CRITICAL_MEMORY_TAG_HINTS = new Set<string>([
  'critical',
  'core',
  'must_remember',
  'safety',
  'boundary',
  'urgent',
  'durable',
  'core_profile',
  'core_relationship',
  'relationship_core',
]);
const MEMORY_TYPE_TAG_HINTS: Readonly<Record<MemoryType, readonly string[]>> = {
  boundary: ['boundary', 'consent', 'limit', 'safety', 'refusal'],
  emotional: ['emotion', 'feeling', 'mood', 'sentiment', 'affect'],
  episodic: ['event', 'timeline', 'history', 'date', 'episode'],
  procedural: ['routine', 'procedure', 'workflow', 'habit', 'howto'],
  reflection: ['reflection', 'insight', 'lesson', 'meta'],
  relational: ['relationship', 'partner', 'family', 'friend', 'contact'],
  semantic: ['fact', 'profile', 'identity', 'preference', 'knowledge'],
};
const BOUNDARY_TEXT_HINT = /\b(boundary|limit|consent|do not|don't|cannot|can't|won't|must not)\b/i;
const EMOTIONAL_TEXT_HINT = /\b(feel|feeling|felt|emotion|mood|happy|sad|angry|anxious|excited)\b/i;
const PROCEDURAL_TEXT_HINT = /\b(always|usually|routine|process|step|workflow|procedure|habit)\b/i;
const REFLECTION_TEXT_HINT = /\b(learned|insight|realized|reflection|meta|lesson)\b/i;
const RELATIONAL_TEXT_HINT = /\b(partner|spouse|wife|husband|boyfriend|girlfriend|family|friend|sibling|parent|child)\b/i;
const EPISODIC_TEXT_HINT = /\b(yesterday|today|last\s+\w+|ago|on\s+\d{4}-\d{2}-\d{2}|when\s+we)\b/i;

export const VALID_MEMORY_TYPES: MemoryType[] = [
  'episodic', 'semantic', 'emotional', 'procedural', 'boundary', 'reflection', 'relational',
];

export interface PurrMemory {
  id: string;
  text: string;
  type: MemoryType;
  importance: number;
  confidence: number;
  emotionalValence: number;
  formationVAD?: MemoryFormationVAD;
  salience: number;
  embedding?: Float32Array;
  sourceRef: string;
  extractedAt: number;
  lastAccessed: number;
  accessCount: number;
  supersededBy?: string;
  tags: string[];
  scopeRef?: MemoryScopeRef;
  scopeTags?: string[];
  provenanceRefs?: string[];
  retentionClass?: MemoryRetentionClass;
  sensitivity: SensitivityLevel;    // default 'personal'
  consentFlags?: ConsentFlags;      // default {}
  contactId?: string;               // FK to contacts table (for relational memories)
  deletedAt?: number;
  deletedBy?: string;
  deleteReason?: string;
}

export interface ExtractedFact {
  text: string;
  type: MemoryType;
  importance: number;
  emotionalValence: number;
  confidence: number;
  tags: string[];
  retentionClass?: MemoryRetentionClass;
  sensitivity?: SensitivityLevel;
  consentFlags?: ConsentFlags;
}

export interface MemoryDecayProfile {
  retentionClass: MemoryRetentionClass;
  salienceFloor: number;
  halflifeMultiplier: number;
}

export interface SensitivityWriteThreshold {
  minSalience: number;
  minNovelty: number;
}

export interface MemoryPrivacyRiskBreakdown {
  sensitivity: number;
  tagBoost: number;
  sourceContextAdjustment: number;
  consentBoost: number;
}

export interface MemoryPrivacyRiskEvaluation {
  risk: number;
  breakdown: MemoryPrivacyRiskBreakdown;
}

const SENSITIVE_PRIVACY_TAG_HINTS = new Set<string>([
  'confidential',
  'private',
  'secret',
  'sensitive',
  'intimate',
  'medical',
  'health',
  'financial',
  'legal',
  'sexual',
  'trauma',
]);
const SENSITIVE_PRIVACY_TAG_HINT_LIST = [...SENSITIVE_PRIVACY_TAG_HINTS];

const PUBLIC_SOURCE_PREFIXES = ['twitter:', 'x:', 'mastodon:', 'bluesky:', 'public:'] as const;
const PRIVATE_SOURCE_PREFIXES = ['api:', 'shard:', 'discord:', 'telegram:', 'signal:', 'dm:'] as const;

// Decay half-lives in milliseconds
export const DECAY_HALFLIFE: Record<MemoryType, number> = {
  episodic:   7  * 24 * 60 * 60 * 1000,
  semantic:   30 * 24 * 60 * 60 * 1000,
  emotional:  14 * 24 * 60 * 60 * 1000,
  procedural: 90 * 24 * 60 * 60 * 1000,
  boundary:   120 * 24 * 60 * 60 * 1000,
  reflection: 60 * 24 * 60 * 60 * 1000,
  relational: 60 * 24 * 60 * 60 * 1000,
};

// Embedding similarity thresholds for dedup per type
export const DEDUP_THRESHOLD: Record<MemoryType, number> = {
  episodic:   0.92,
  semantic:   0.90,
  emotional:  0.88,
  procedural: 0.97,
  boundary:   0.96,
  reflection: 0.85,
  relational: 0.90,
};

export const MEMORY_CONFIG = {
  extractionInterval: 5,
  maxRetrievalCount: 15,
  retrievalThreshold: 0.3,
  retrievalAccessFreshnessDays: 21,
  retrievalAccessCountCap: 8,
  retrievalAccessFreshnessWeight: 0.65,
  retrievalAccessReinforcementMaxBoost: 0.25,
  privacyRiskPenaltyWeight: 0.45,
  maintenanceIntervalMs: 60_000,
  salienceFloor: 0.05,
  durableSalienceFloor: 0.25,
  durableHalflifeMultiplier: 8,
  emotionalIntensityPersistenceMinMultiplier: 1,
  emotionalIntensityPersistenceMaxMultiplier: 1.8,
  durableAutoImportanceThreshold: 0.75,
  contradictionThresholdOffset: 0.15,
  salienceBumpOnAccess: 0.05,
  sensitivityWriteThresholds: {
    public: { minSalience: 0, minNovelty: 0 },
    personal: { minSalience: 0, minNovelty: 0 },
    intimate: { minSalience: 0.6, minNovelty: 0.18 },
    confidential: { minSalience: 0.72, minNovelty: 0.3 },
  },
} as const;

export function normalizeMemoryTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag.length > 0) out.add(tag);
  }
  return Array.from(out);
}

export function normalizeMemoryScopeTags(tags: readonly string[] | undefined): string[] {
  return normalizeMemoryTags(tags ?? []);
}

export function normalizeMemoryScopeRef(
  value: Partial<MemoryScopeRef> | { kind?: string; id?: string; label?: string } | undefined,
): MemoryScopeRef | undefined {
  if (!value) return undefined;
  const kind = typeof value.kind === 'string'
    ? value.kind.trim().toLowerCase() as MemoryScopeKind
    : undefined;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (!kind || !VALID_MEMORY_SCOPE_KINDS.includes(kind) || id.length === 0) {
    return undefined;
  }
  return {
    kind,
    id,
    ...(label.length > 0 ? { label } : {}),
  };
}

export function normalizeMemoryScopeRefs(
  refs: readonly MemoryScopeRef[] | undefined,
): MemoryScopeRef[] {
  const deduped = new Map<string, MemoryScopeRef>();
  for (const candidate of refs ?? []) {
    const normalized = normalizeMemoryScopeRef(candidate);
    if (!normalized) continue;
    deduped.set(`${normalized.kind}:${normalized.id}`, normalized);
  }
  return [...deduped.values()];
}

export function normalizeMemoryScopeQuery(
  query: MemoryScopeQuery | undefined,
): MemoryScopeQuery | undefined {
  if (!query) return undefined;
  const refs = normalizeMemoryScopeRefs(query.refs);
  const tags = normalizeMemoryScopeTags(query.tags);
  const mode: MemoryScopeQueryMode = query.mode === 'only' ? 'only' : 'prefer';
  if (refs.length === 0 && tags.length === 0) return undefined;
  return {
    ...(refs.length > 0 ? { refs } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    mode,
  };
}

export function memoryMatchesScopeQuery(
  memory: Pick<PurrMemory, 'scopeRef' | 'scopeTags'>,
  query: MemoryScopeQuery | undefined,
): boolean {
  const normalized = normalizeMemoryScopeQuery(query);
  if (!normalized) return true;
  const refMatch = normalized.refs?.some((ref) => (
    memory.scopeRef?.kind === ref.kind
    && memory.scopeRef.id === ref.id
  )) ?? false;
  const memoryScopeTags = new Set(normalizeMemoryScopeTags(memory.scopeTags));
  const tagMatch = normalized.tags?.some(tag => memoryScopeTags.has(tag)) ?? false;
  return refMatch || tagMatch;
}

export function computeMemoryScopeMatchStrength(
  memory: Pick<PurrMemory, 'scopeRef' | 'scopeTags'>,
  query: MemoryScopeQuery | undefined,
): number {
  const normalized = normalizeMemoryScopeQuery(query);
  if (!normalized) return 0;
  let strength = 0;
  if (normalized.refs?.some((ref) => (
    memory.scopeRef?.kind === ref.kind
    && memory.scopeRef.id === ref.id
  ))) {
    strength = Math.max(strength, 1);
  }
  const scopeTags = new Set(normalizeMemoryScopeTags(memory.scopeTags));
  if (normalized.tags?.some(tag => scopeTags.has(tag))) {
    strength = Math.max(strength, 0.6);
  }
  return strength;
}

function clampUnit(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(-1, Math.min(1, value));
}

export function normalizeFormationVAD(
  value: Partial<MemoryFormationVAD> | undefined,
): MemoryFormationVAD | undefined {
  if (!value) return undefined;
  const hasAnyDimension = (
    value.valence !== undefined
    || value.arousal !== undefined
    || value.dominance !== undefined
  );
  if (!hasAnyDimension) return undefined;

  return {
    valence: clampSigned(value.valence ?? 0),
    arousal: clampSigned(value.arousal ?? 0),
    dominance: clampSigned(value.dominance ?? 0),
  };
}

export function getSensitivityWriteThreshold(sensitivity: SensitivityLevel): SensitivityWriteThreshold {
  return MEMORY_CONFIG.sensitivityWriteThresholds[sensitivity];
}

export function evaluateMemoryPrivacyRisk(
  input: Pick<PurrMemory, 'sensitivity' | 'tags' | 'sourceRef' | 'consentFlags'>,
): MemoryPrivacyRiskEvaluation {
  const sensitivityBase: Record<SensitivityLevel, number> = {
    public: 0.05,
    personal: 0.22,
    intimate: 0.62,
    confidential: 0.82,
  };

  const normalizedTags = normalizeMemoryTags(input.tags);
  const tagMatches = normalizedTags.filter(tag => (
    SENSITIVE_PRIVACY_TAG_HINTS.has(tag)
    || SENSITIVE_PRIVACY_TAG_HINT_LIST.some(hint => tag.includes(hint))
  ));
  const tagBoost = Math.min(0.18, tagMatches.length * 0.06);

  const sourceRef = input.sourceRef.trim().toLowerCase();
  let sourceContextAdjustment = 0;
  if (PUBLIC_SOURCE_PREFIXES.some(prefix => sourceRef.startsWith(prefix))) {
    sourceContextAdjustment -= 0.08;
  } else if (PRIVATE_SOURCE_PREFIXES.some(prefix => sourceRef.startsWith(prefix))) {
    sourceContextAdjustment += 0.08;
  } else if (sourceRef.includes(':dm') || sourceRef.includes('private')) {
    sourceContextAdjustment += 0.04;
  }

  const consentFlags = input.consentFlags ?? {};
  const consentBoost = (
    (consentFlags.allowRecall === false ? 0.22 : 0)
    + (consentFlags.allowAbstraction === false ? 0.04 : 0)
    + (consentFlags.deleteOnRequest ? 0.04 : 0)
  );

  const risk = clampUnit(
    sensitivityBase[input.sensitivity]
    + tagBoost
    + sourceContextAdjustment
    + consentBoost,
    sensitivityBase[input.sensitivity],
  );

  return {
    risk,
    breakdown: {
      sensitivity: sensitivityBase[input.sensitivity],
      tagBoost,
      sourceContextAdjustment,
      consentBoost,
    },
  };
}

export function normalizeMemoryTypeValue(value: unknown): MemoryType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase() as MemoryType;
  return VALID_MEMORY_TYPES.includes(normalized) ? normalized : undefined;
}

export function inferImportedMemoryType(input: {
  text: string;
  explicitType?: unknown;
  tags?: readonly string[];
}): MemoryType {
  const explicit = normalizeMemoryTypeValue(input.explicitType);
  if (explicit) return explicit;

  const normalizedTags = normalizeMemoryTags(input.tags ?? []);
  const tagSet = new Set(normalizedTags);
  const taggedType = VALID_MEMORY_TYPES.find(type => (
    MEMORY_TYPE_TAG_HINTS[type].some(tag => tagSet.has(tag))
  ));
  if (taggedType) return taggedType;

  const text = input.text.trim();
  if (!text) return 'semantic';
  if (BOUNDARY_TEXT_HINT.test(text)) return 'boundary';
  if (RELATIONAL_TEXT_HINT.test(text)) return 'relational';
  if (EMOTIONAL_TEXT_HINT.test(text)) return 'emotional';
  if (PROCEDURAL_TEXT_HINT.test(text)) return 'procedural';
  if (REFLECTION_TEXT_HINT.test(text)) return 'reflection';
  if (EPISODIC_TEXT_HINT.test(text)) return 'episodic';
  return 'semantic';
}

export function estimateImportedMemoryCriticality(input: {
  type: MemoryType;
  importance: number;
  tags?: readonly string[];
  text?: string;
}): number {
  const normalizedTags = normalizeMemoryTags(input.tags ?? []);
  let score = 0;
  if (input.type === 'boundary') score += 0.4;
  if (input.type === 'relational') score += 0.2;
  if (input.importance >= 0.85) score += 0.25;
  if (normalizedTags.some(tag => CRITICAL_MEMORY_TAG_HINTS.has(tag))) score += 0.3;
  if (input.text && BOUNDARY_TEXT_HINT.test(input.text)) score += 0.2;
  return clampUnit(score, 0);
}

export function initializeImportedMemorySalience(input: {
  importance?: number;
  salience?: number;
  type: MemoryType;
  tags?: readonly string[];
  text?: string;
  extractedAt?: number;
  lastAccessed?: number;
  now?: number;
}): number {
  const importance = clampUnit(input.importance ?? 0.5, 0.5);
  if (Number.isFinite(input.salience)) {
    return clampUnit(input.salience ?? importance, importance);
  }

  const now = Number.isFinite(input.now) ? input.now as number : Date.now();
  const recencyTimestamp = Number.isFinite(input.lastAccessed)
    ? input.lastAccessed as number
    : (Number.isFinite(input.extractedAt) ? input.extractedAt as number : now);
  const ageMs = Math.max(0, now - recencyTimestamp);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyWeight = 1 / (1 + ageDays / 28);
  const criticality = estimateImportedMemoryCriticality({
    type: input.type,
    importance,
    tags: input.tags,
    text: input.text,
  });

  const recencyFloor = ageDays > 365 ? 0.18 : ageDays > 180 ? 0.28 : 0.38;
  const importanceFloor = criticality >= 0.75 ? 0.72 : Math.max(recencyFloor, importance * 0.4);
  const blendedScore = (
    importance * 0.55
    + recencyWeight * 0.3
    + criticality * 0.15
  );

  return clampUnit(Math.max(importanceFloor, blendedScore), importanceFloor);
}

export function isDurableMemory(memory: Pick<PurrMemory, 'tags' | 'retentionClass'>): boolean {
  if (memory.retentionClass === 'durable') return true;
  const normalizedTags = normalizeMemoryTags(memory.tags);
  return normalizedTags.some(tag => DURABLE_RETENTION_TAG_SET.has(tag));
}

export function inferMemoryRetentionClass(input: {
  type: MemoryType;
  tags?: readonly string[];
  importance?: number;
  retentionClass?: MemoryRetentionClass;
}): MemoryRetentionClass {
  if (input.retentionClass === 'durable') return 'durable';

  const normalizedTags = normalizeMemoryTags(input.tags ?? []);
  if (normalizedTags.some(tag => DURABLE_RETENTION_TAG_SET.has(tag))) {
    return 'durable';
  }

  if (
    input.type === 'relational'
    && (input.importance ?? 0) >= MEMORY_CONFIG.durableAutoImportanceThreshold
    && normalizedTags.some(tag => AUTO_DURABLE_RELATIONAL_TAG_HINT_SET.has(tag))
  ) {
    return 'durable';
  }

  return 'standard';
}

type MemoryDecayProfileInput = Pick<PurrMemory, 'type' | 'tags' | 'retentionClass'> & Partial<Pick<PurrMemory, 'emotionalValence' | 'formationVAD'>>;

export function computeMemoryEmotionalIntensity(
  memory: Partial<Pick<PurrMemory, 'emotionalValence' | 'formationVAD'>>,
): number {
  const valenceIntensity = Math.abs(clampSigned(memory.emotionalValence ?? 0, 0));
  const formationVAD = normalizeFormationVAD(memory.formationVAD);
  if (!formationVAD) return valenceIntensity;

  const vadIntensity = clampUnit(
    (Math.abs(formationVAD.arousal) * 0.7) + (Math.abs(formationVAD.valence) * 0.3),
    valenceIntensity,
  );
  return Math.max(valenceIntensity, vadIntensity);
}

export function getEmotionalIntensityPersistenceMultiplier(
  memory: Partial<Pick<PurrMemory, 'emotionalValence' | 'formationVAD'>>,
): number {
  const minMultiplier = Math.max(0.1, MEMORY_CONFIG.emotionalIntensityPersistenceMinMultiplier);
  const maxMultiplier = Math.max(
    minMultiplier,
    MEMORY_CONFIG.emotionalIntensityPersistenceMaxMultiplier,
  );
  const intensity = computeMemoryEmotionalIntensity(memory);
  return minMultiplier + ((maxMultiplier - minMultiplier) * intensity);
}

export function getMemoryDecayProfile(memory: MemoryDecayProfileInput): MemoryDecayProfile {
  const retentionClass = inferMemoryRetentionClass({
    type: memory.type,
    tags: memory.tags,
    retentionClass: memory.retentionClass,
  });
  const retentionHalflifeMultiplier = retentionClass === 'durable'
    ? MEMORY_CONFIG.durableHalflifeMultiplier
    : 1;
  const emotionalPersistenceMultiplier = getEmotionalIntensityPersistenceMultiplier(memory);
  const halflifeMultiplier = retentionHalflifeMultiplier * emotionalPersistenceMultiplier;

  if (retentionClass === 'durable') {
    return {
      retentionClass,
      salienceFloor: MEMORY_CONFIG.durableSalienceFloor,
      halflifeMultiplier,
    };
  }

  return {
    retentionClass,
    salienceFloor: MEMORY_CONFIG.salienceFloor,
    halflifeMultiplier,
  };
}
