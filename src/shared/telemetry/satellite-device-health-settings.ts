import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

/**
 * Compiled fallback for the satellite heartbeat staleness bound. Physical
 * satellites beat less often than in-process shards, so this is deliberately
 * looser than the shard equivalent. The owner file wins whenever it sets a
 * value; this only covers a runtime that never configured one.
 */
const FALLBACK_SATELLITE_HEARTBEAT_STALE_AFTER_MS = 120_000;

/**
 * Resolves the operator-owned `satelliteHeartbeatStaleAfterMs` tuning value,
 * falling back to the compiled default only when the owner file left it unset.
 * Mirrors the shard heartbeat precedence: owner file first, compiled default
 * last, and never a silently different number in two places.
 */
export function resolveSatelliteHeartbeatStaleAfterMs(config: SubstrateConfig): number {
  const configured = config.satelliteHeartbeatStaleAfterMs;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : FALLBACK_SATELLITE_HEARTBEAT_STALE_AFTER_MS;
}
