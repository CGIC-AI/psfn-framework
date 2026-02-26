import type { SubstrateConfig } from '../../types.js';
import type {
  ExtractionGateConfig,
  MemoryExtractorConfig,
  ProfileSynthesisConfig,
} from './types.js';
import {
  DEFAULT_MAX_WRITES,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_IMPORTANCE,
  DEFAULT_MIN_NOVELTY,
  DEFAULT_PROFILE_MIN_CONFIDENCE,
  DEFAULT_PROFILE_MIN_IMPORTANCE,
  DEFAULT_PROFILE_MIN_NOVELTY,
  DEFAULT_PROFILE_MIN_SOURCE_MEMORIES,
  DEFAULT_PROFILE_MIN_WRITES,
  DEFAULT_PROFILE_REFRESH_COOLDOWN_MS,
  DEFAULT_PROFILE_REFRESH_INTERVAL_MS,
  DEFAULT_PROFILE_SOURCE_MEMORY_LIMIT,
} from './types.js';

export function clamp(val: number, min: number, max: number): number {
  if (Number.isNaN(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
}

export function normalizeMaxWrites(value: number | undefined, fallback: number): number {
  const candidate = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  if (!Number.isFinite(candidate)) return DEFAULT_MAX_WRITES;
  return Math.max(0, candidate);
}

export function resolveGateConfig(
  runtimeConfig: SubstrateConfig | null,
  configured: Pick<MemoryExtractorConfig, 'minImportance' | 'minConfidence' | 'minNovelty'>,
): ExtractionGateConfig {
  return {
    minImportance: clamp(runtimeConfig?.memoryExtractionMinImportance ?? configured.minImportance ?? DEFAULT_MIN_IMPORTANCE, 0, 1),
    minConfidence: clamp(runtimeConfig?.memoryExtractionMinConfidence ?? configured.minConfidence ?? DEFAULT_MIN_CONFIDENCE, 0, 1),
    minNovelty: clamp(runtimeConfig?.memoryExtractionMinNovelty ?? configured.minNovelty ?? DEFAULT_MIN_NOVELTY, 0, 1),
  };
}

export function resolveMaxWrites(
  runtimeConfig: SubstrateConfig | null,
  configuredMaxWrites: number,
): number {
  return normalizeMaxWrites(
    runtimeConfig?.memoryExtractionMaxWrites,
    configuredMaxWrites,
  );
}

export function resolveTelemetryEnabled(
  runtimeConfig: SubstrateConfig | null,
  configuredTelemetryEnabled: boolean,
): boolean {
  return runtimeConfig?.memoryExtractionTelemetryEnabled ?? configuredTelemetryEnabled;
}

export function resolveProfileConfig(runtimeConfig: SubstrateConfig | null): ProfileSynthesisConfig {
  return {
    enabled: runtimeConfig?.profileSynthesisEnabled ?? true,
    refreshIntervalMs: runtimeConfig?.profileSynthesisRefreshIntervalMs ?? DEFAULT_PROFILE_REFRESH_INTERVAL_MS,
    cooldownMs: runtimeConfig?.profileSynthesisCooldownMs ?? DEFAULT_PROFILE_REFRESH_COOLDOWN_MS,
    minWrites: runtimeConfig?.profileSynthesisMinWrites ?? DEFAULT_PROFILE_MIN_WRITES,
    minImportance: runtimeConfig?.profileSynthesisMinImportance ?? DEFAULT_PROFILE_MIN_IMPORTANCE,
    minConfidence: runtimeConfig?.profileSynthesisMinConfidence ?? DEFAULT_PROFILE_MIN_CONFIDENCE,
    minNovelty: runtimeConfig?.profileSynthesisMinNovelty ?? DEFAULT_PROFILE_MIN_NOVELTY,
    sourceMemoryLimit: runtimeConfig?.profileSynthesisSourceMemoryLimit ?? DEFAULT_PROFILE_SOURCE_MEMORY_LIMIT,
    minSourceMemories: runtimeConfig?.profileSynthesisMinSourceMemories ?? DEFAULT_PROFILE_MIN_SOURCE_MEMORIES,
  };
}
