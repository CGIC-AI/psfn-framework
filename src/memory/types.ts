import type { SensitivityLevel, ConsentFlags } from '../trust/types.js';
// Re-export for convenience
export type { SensitivityLevel, ConsentFlags };
export { VALID_SENSITIVITY_LEVELS } from '../trust/types.js';

export type MemoryType = 'episodic' | 'semantic' | 'emotional' | 'procedural' | 'reflection';

export const VALID_MEMORY_TYPES: MemoryType[] = [
  'episodic', 'semantic', 'emotional', 'procedural', 'reflection',
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
  sensitivity: SensitivityLevel;    // default 'personal'
  consentFlags?: ConsentFlags;      // default {}
}

export interface ExtractedFact {
  text: string;
  type: MemoryType;
  importance: number;
  emotionalValence: number;
  confidence: number;
  tags: string[];
  sensitivity?: SensitivityLevel;
  consentFlags?: ConsentFlags;
}

// Decay half-lives in milliseconds
export const DECAY_HALFLIFE: Record<MemoryType, number> = {
  episodic:   7  * 24 * 60 * 60 * 1000,
  semantic:   30 * 24 * 60 * 60 * 1000,
  emotional:  14 * 24 * 60 * 60 * 1000,
  procedural: 90 * 24 * 60 * 60 * 1000,
  reflection: 60 * 24 * 60 * 60 * 1000,
};

// Embedding similarity thresholds for dedup per type
// Note: 'relational' threshold included for future-proofing (PSFN-hdy)
export const DEDUP_THRESHOLD: Record<MemoryType | 'relational', number> = {
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
  contradictionThresholdOffset: 0.15,
  salienceBumpOnAccess: 0.05,
} as const;
