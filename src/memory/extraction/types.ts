import type { ExtractedFact, MemoryType } from '../types.js';

export interface MemoryExtractorConfig {
  extractionInterval?: number;
  minImportance?: number;
  minConfidence?: number;
  minNovelty?: number;
  maxWrites?: number;
  telemetryEnabled?: boolean;
}

export interface MemoryExtractorDrainOptions {
  timeoutMs?: number;
}

export type ExtractionTriggerReason =
  | 'manual'
  | 'interval'
  | 'context_threshold'
  | 'interval_and_threshold'
  | 'pre_compaction'
  | 'crash_recovery';

export type ExtractionRejectionReason =
  | 'low_importance'
  | 'low_confidence'
  | 'low_novelty'
  | 'low_signal'
  | 'write_cap';

export type ProfileRefreshReason = 'memory_update' | 'interval' | 'memory_update_and_interval';

export interface ExtractionGateConfig {
  minImportance: number;
  minConfidence: number;
  minNovelty: number;
}

export interface FactAcceptanceDecision {
  accepted: boolean;
  reason?: ExtractionRejectionReason;
  novelty: number;
}

export interface ExtractionEndTelemetry {
  channelId: string;
  count: number;
  triggerReason: ExtractionTriggerReason;
  coveredUpToMessageId?: number;
  parsedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  writeCount: number;
  deduplicatedCount: number;
  supersededCount: number;
  rejectionBreakdown: Record<ExtractionRejectionReason, number>;
}

export interface ProfileSynthesisConfig {
  enabled: boolean;
  refreshIntervalMs: number;
  cooldownMs: number;
  minWrites: number;
  minImportance: number;
  minConfidence: number;
  minNovelty: number;
  sourceMemoryLimit: number;
  minSourceMemories: number;
}

export interface AcceptedFactWrite {
  memoryId: string;
  importance: number;
  confidence: number;
}

export interface AcceptedFactCandidate {
  fact: ExtractedFact;
  novelty: number;
  valueScore: number;
  index: number;
}

export interface EmotionalSignal {
  valence: number;
  confidence: number;
}

export interface ProfileSourceMemory {
  id: string;
  type: MemoryType;
  text: string;
  importance: number;
  confidence: number;
  salience: number;
}

export const DEFAULT_MIN_IMPORTANCE = 0.45;
export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const DEFAULT_MIN_NOVELTY = 0.35;
export const DEFAULT_MAX_WRITES = 2;

export const DEFAULT_PROFILE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_PROFILE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
export const DEFAULT_PROFILE_MIN_WRITES = 1;
export const DEFAULT_PROFILE_MIN_IMPORTANCE = 0.65;
export const DEFAULT_PROFILE_MIN_CONFIDENCE = 0.7;
export const DEFAULT_PROFILE_MIN_NOVELTY = 0.12;
export const DEFAULT_PROFILE_SOURCE_MEMORY_LIMIT = 16;
export const DEFAULT_PROFILE_MIN_SOURCE_MEMORIES = 2;

export const RECOVERY_CONTEXT_MESSAGE_LIMIT = 50;
export const TRANSCRIPT_EMOTIONAL_SIGNAL_LIMIT = 12;
