import type { SensitivityLevel, ConsentFlags } from '../trust/types.js';
// Re-export for convenience
export type { SensitivityLevel, ConsentFlags };
export { VALID_SENSITIVITY_LEVELS } from '../trust/types.js';

export type MemoryType = 'episodic' | 'semantic' | 'emotional' | 'procedural' | 'reflection' | 'relational';
export type MemoryRetentionClass = 'standard' | 'durable';

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

export const VALID_MEMORY_TYPES: MemoryType[] = [
  'episodic', 'semantic', 'emotional', 'procedural', 'reflection', 'relational',
];

export interface PurrMemory {
  id: string;
  text: string;
  type: MemoryType;
  importance: number;
  confidence: number;
  emotionalValence: number;
  salience: number;
  embedding?: Float32Array;
  sourceRef: string;
  extractedAt: number;
  lastAccessed: number;
  accessCount: number;
  supersededBy?: string;
  tags: string[];
  retentionClass?: MemoryRetentionClass;
  sensitivity: SensitivityLevel;    // default 'personal'
  consentFlags?: ConsentFlags;      // default {}
  contactId?: string;               // FK to contacts table (for relational memories)
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

// Decay half-lives in milliseconds
export const DECAY_HALFLIFE: Record<MemoryType, number> = {
  episodic:   7  * 24 * 60 * 60 * 1000,
  semantic:   30 * 24 * 60 * 60 * 1000,
  emotional:  14 * 24 * 60 * 60 * 1000,
  procedural: 90 * 24 * 60 * 60 * 1000,
  reflection: 60 * 24 * 60 * 60 * 1000,
  relational: 60 * 24 * 60 * 60 * 1000,
};

// Embedding similarity thresholds for dedup per type
export const DEDUP_THRESHOLD: Record<MemoryType, number> = {
  episodic:   0.92,
  semantic:   0.90,
  emotional:  0.88,
  procedural: 0.97,
  reflection: 0.85,
  relational: 0.90,
};

export const MEMORY_CONFIG = {
  extractionInterval: 5,
  maxRetrievalCount: 15,
  retrievalThreshold: 0.3,
  maintenanceIntervalMs: 60_000,
  salienceFloor: 0.05,
  durableSalienceFloor: 0.25,
  durableHalflifeMultiplier: 8,
  durableAutoImportanceThreshold: 0.75,
  contradictionThresholdOffset: 0.15,
  salienceBumpOnAccess: 0.05,
} as const;

export function normalizeMemoryTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag.length > 0) out.add(tag);
  }
  return Array.from(out);
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

export function getMemoryDecayProfile(memory: Pick<PurrMemory, 'type' | 'tags' | 'retentionClass'>): MemoryDecayProfile {
  const retentionClass = inferMemoryRetentionClass({
    type: memory.type,
    tags: memory.tags,
    retentionClass: memory.retentionClass,
  });

  if (retentionClass === 'durable') {
    return {
      retentionClass,
      salienceFloor: MEMORY_CONFIG.durableSalienceFloor,
      halflifeMultiplier: MEMORY_CONFIG.durableHalflifeMultiplier,
    };
  }

  return {
    retentionClass,
    salienceFloor: MEMORY_CONFIG.salienceFloor,
    halflifeMultiplier: 1,
  };
}
