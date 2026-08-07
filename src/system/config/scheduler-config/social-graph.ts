import { isRecord } from '../../../shared/utils/types.js';
import { toPositiveInteger } from './primitives.js';

/**
 * Social-graph builder worker tuning (E4.2). The worker proposes social-graph
 * edges from accumulated room evidence and only acts on memories past its
 * watermark. Its cadence is the shared `backgroundMaintenance.intervalMs`.
 * Optional block — conservative thresholds apply when absent.
 */
export interface SocialGraphBuilderCadenceConfig {
  /** Distinct co-presence windows required before an acquaintance is proposed. */
  coPresenceMinSessions: number;
  /** Fallback co-presence window size when a memory has no session id (minutes). */
  coPresenceWindowMinutes: number;
  /** Max memories scanned per run. */
  scanMemoryLimit: number;
}

export const DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE: SocialGraphBuilderCadenceConfig = {
  coPresenceMinSessions: 3,
  coPresenceWindowMinutes: 1440,
  scanMemoryLimit: 500,
};

export function validateSocialGraphBuilderConfig(
  raw: unknown,
  sourcePath: string,
): SocialGraphBuilderCadenceConfig {
  if (raw === undefined) {
    return { ...DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialGraphBuilder must be an object`);
  }
  if (raw.intervalMs !== undefined) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: socialGraphBuilder.intervalMs was removed; `
      + 'the worker now uses backgroundMaintenance.intervalMs with the other bundled operations',
    );
  }
  return {
    coPresenceMinSessions: toPositiveInteger(
      raw.coPresenceMinSessions ?? DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE.coPresenceMinSessions,
      'socialGraphBuilder.coPresenceMinSessions',
      1,
    ),
    coPresenceWindowMinutes: toPositiveInteger(
      raw.coPresenceWindowMinutes ?? DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE.coPresenceWindowMinutes,
      'socialGraphBuilder.coPresenceWindowMinutes',
      1,
    ),
    scanMemoryLimit: toPositiveInteger(
      raw.scanMemoryLimit ?? DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE.scanMemoryLimit,
      'socialGraphBuilder.scanMemoryLimit',
      1,
    ),
  };
}
