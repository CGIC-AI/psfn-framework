/**
 * Per-companion social pot: the shared fatigue-economy budget that funds group
 * participation and ICP continuation (adjudication S3.8, design bible §12.6).
 *
 * This module owns the pot's *shape* and its deterministic continuous
 * regeneration (the hourly `cap/24` tick that replaces the daily reset cliff).
 * The Postgres implementation of {@link SocialPotPort} (gateway-owned, shared
 * schema) is the durable authority so reboots lose nothing. Draw-cap
 * enforcement and ICP-priority ordering are layered on top of these primitives
 * by their own feature; the store here only provides the atomic
 * read/regenerate/draw operations they compose.
 */

/** Owner-file-supplied social-pot policy (charge-policy `fatigue.socialPot`). */
export interface SocialPotConfig {
  /** Full per-companion pot ceiling, in charge-policy units. */
  capUnits: number;
  /** Interval between continuous regeneration ticks (hourly). */
  regenerationTickMs: number;
  /** Units credited per regeneration tick (cap/24), clamped at capUnits. */
  regenerationUnitsPerTick: number;
}

export interface SocialPotSnapshot {
  companionId: string;
  /** Remaining pot units after any due regeneration has been applied. */
  balance: number;
  /** Configured ceiling in effect for this read. */
  cap: number;
  /** Timestamp of the last regeneration tick boundary the balance reflects. */
  lastRegenAtMs: number;
  /** Monotonic write counter for the row; every persisted change increments it. */
  revision: number;
}

export interface SocialPotReadInput {
  companionId: string;
  nowMs: number;
  config: SocialPotConfig;
}

export interface SocialPotDrawInput extends SocialPotReadInput {
  /** Requested draw amount (positive). Callers own the per-channel cap policy. */
  amount: number;
}

export type SocialPotDrawOutcome = 'drawn' | 'insufficient';

export interface SocialPotDrawResult {
  outcome: SocialPotDrawOutcome;
  /** Amount actually removed from the pot (0 when the balance is insufficient). */
  drawn: number;
  /** Snapshot after regeneration but before the draw. */
  before: SocialPotSnapshot;
  /** Snapshot after the draw (and persisted regeneration). */
  after: SocialPotSnapshot;
}

/**
 * Durable per-companion social-pot store. The pot is gateway-owned and
 * Postgres-backed; a companion never arbitrates a peer's budget.
 */
export interface SocialPotPort {
  /** Read the pot, persisting any regeneration due since the last write. */
  readPot(input: SocialPotReadInput): Promise<SocialPotSnapshot>;
  /**
   * Atomically regenerate then draw `amount`. When the regenerated balance is
   * below `amount` the pot is left funded (only regeneration persists) and the
   * outcome is `insufficient` — no partial draw.
   */
  draw(input: SocialPotDrawInput): Promise<SocialPotDrawResult>;
  close(): Promise<void>;
}

export interface SocialPotRegenerationResult {
  balance: number;
  lastRegenAtMs: number;
}

function assertFiniteNonNegative(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite number >= 0`);
  }
  return value;
}

function assertPositiveFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a finite number > 0`);
  }
  return value;
}

export function assertSocialPotConfig(config: SocialPotConfig): SocialPotConfig {
  const capUnits = assertPositiveFinite(config.capUnits, 'socialPot.capUnits');
  const regenerationTickMs = assertPositiveFinite(
    config.regenerationTickMs,
    'socialPot.regenerationTickMs',
  );
  if (!Number.isSafeInteger(regenerationTickMs)) {
    throw new Error('socialPot.regenerationTickMs must be a safe integer');
  }
  const regenerationUnitsPerTick = assertPositiveFinite(
    config.regenerationUnitsPerTick,
    'socialPot.regenerationUnitsPerTick',
  );
  if (regenerationUnitsPerTick > capUnits) {
    throw new Error(
      'socialPot.regenerationUnitsPerTick must be <= socialPot.capUnits',
    );
  }
  return { capUnits, regenerationTickMs, regenerationUnitsPerTick };
}

/**
 * Apply continuous regeneration deterministically.
 *
 * The pot accrues `regenerationUnitsPerTick` for every whole tick elapsed since
 * `lastRegenAtMs`, clamped at `capUnits`. Only whole ticks advance the
 * timestamp, so the sub-tick remainder carries forward and the schedule stays
 * stable across process restarts. A non-advancing clock never credits and never
 * moves the timestamp; a balance above the current cap (a lowered config) is
 * clamped down on the next read — the pot fails closed toward less spend.
 */
export function regenerateSocialPot(input: {
  balance: number;
  lastRegenAtMs: number;
  nowMs: number;
  config: SocialPotConfig;
}): SocialPotRegenerationResult {
  const cap = input.config.capUnits;
  assertPositiveFinite(cap, 'socialPot.capUnits');
  const tickMs = assertPositiveFinite(
    input.config.regenerationTickMs,
    'socialPot.regenerationTickMs',
  );
  const unitsPerTick = assertPositiveFinite(
    input.config.regenerationUnitsPerTick,
    'socialPot.regenerationUnitsPerTick',
  );
  const balance = assertFiniteNonNegative(input.balance, 'socialPot.balance');
  const lastRegenAtMs = assertFiniteNonNegative(
    input.lastRegenAtMs,
    'socialPot.lastRegenAtMs',
  );
  const nowMs = assertFiniteNonNegative(input.nowMs, 'socialPot.nowMs');

  const ticks = nowMs > lastRegenAtMs
    ? Math.floor((nowMs - lastRegenAtMs) / tickMs)
    : 0;
  const credited = ticks * unitsPerTick;
  return {
    balance: Math.min(cap, balance + credited),
    lastRegenAtMs: lastRegenAtMs + ticks * tickMs,
  };
}
