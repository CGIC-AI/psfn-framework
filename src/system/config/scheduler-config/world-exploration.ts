import { isRecord } from '../../../shared/utils/types.js';
import { toBoolean, toPositiveInteger } from './primitives.js';

/**
 * World exploration lane (S13, psfn-framework-07mw2): on its own schedule, and
 * only while the companion has a body on a world plane, an internal turn
 * invites it to look around and, if it likes, walk somewhere or greet someone.
 * Off by default: it costs model turns and moves a body other people can see.
 */
export interface WorldExplorationConfig {
  enabled: boolean;
  /** Minimum minutes between two exploration turns. */
  intervalMinutes: number;
  /** Hard cap per local day; the counter resets at the day boundary. */
  maxTurnsPerDay: number;
}

export const DEFAULT_WORLD_EXPLORATION_CONFIG: WorldExplorationConfig = {
  enabled: false,
  intervalMinutes: 45,
  maxTurnsPerDay: 12,
};

export function validateWorldExplorationConfig(
  raw: unknown,
  sourcePath: string,
): WorldExplorationConfig {
  if (raw === undefined) return { ...DEFAULT_WORLD_EXPLORATION_CONFIG };
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: worldExploration must be an object`);
  }
  return {
    enabled: raw.enabled === undefined
      ? DEFAULT_WORLD_EXPLORATION_CONFIG.enabled
      : toBoolean(raw.enabled, 'worldExploration.enabled'),
    intervalMinutes: raw.intervalMinutes === undefined
      ? DEFAULT_WORLD_EXPLORATION_CONFIG.intervalMinutes
      : toPositiveInteger(raw.intervalMinutes, 'worldExploration.intervalMinutes', 5),
    maxTurnsPerDay: raw.maxTurnsPerDay === undefined
      ? DEFAULT_WORLD_EXPLORATION_CONFIG.maxTurnsPerDay
      : toPositiveInteger(raw.maxTurnsPerDay, 'worldExploration.maxTurnsPerDay', 1),
  };
}
