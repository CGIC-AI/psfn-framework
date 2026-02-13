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
}

export interface ExtractedFact {
  text: string;
  type: MemoryType;
  importance: number;
  emotionalValence: number;
  confidence: number;
  tags: string[];
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
export const DEDUP_THRESHOLD: Record<MemoryType, number> = {
  episodic:   0.92,
  semantic:   0.90,
  emotional:  0.88,
  procedural: 0.97,
  reflection: 0.85,
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
