// ── Trust & Privacy Types ──
// Canonical definitions for the honne/tatemae privacy model.
// All trust-sensitive surfaces import from here — single source of truth.

import type { ChannelPrivacy } from './context-envelope.js';

export type TrustLevel = 'primary' | 'trusted' | 'regular' | 'public';
export type HighTierTrustLevel = Extract<TrustLevel, 'primary' | 'trusted'>;
export type LowTierTrustLevel = Extract<TrustLevel, 'regular' | 'public'>;
export type TrustMutationSource = 'manual' | 'behavior_drift' | 'autonomous';

export type SensitivityLevel = 'public' | 'personal' | 'intimate' | 'confidential';
export type HighIntimacySensitivityLevel = Extract<SensitivityLevel, 'intimate' | 'confidential'>;

// The transitional single-axis ChannelVisibility type was DELETED in E3.3.
// Channel disclosure context is the Context Envelope pair
// { channelPrivacy, broadcast } from ./context-envelope.ts
// (docs/context-envelope.md). Persisted records written before the split are
// decoded through decodeStoredChannelVisibility below.

export type ConsentRedactionBehavior = 'delete' | 'abstract';
export type MemoryRedactionOperation = 'auto' | 'delete' | 'abstract';

export interface ConsentFlags {
  allowRecall?: boolean;
  allowAbstraction?: boolean;
  deleteOnRequest?: boolean;
  redactionBehavior?: ConsentRedactionBehavior;
}

// ── Ordered constants ──

export const TRUST_LEVELS: readonly TrustLevel[] = ['primary', 'trusted', 'regular', 'public'];
export const HIGH_TIER_TRUST_LEVELS: readonly HighTierTrustLevel[] = ['primary', 'trusted'];
export const LOW_TIER_TRUST_LEVELS: readonly LowTierTrustLevel[] = ['regular', 'public'];
export const HIGH_INTIMACY_SENSITIVITY_LEVELS: readonly HighIntimacySensitivityLevel[] = ['intimate', 'confidential'];

export const SENSITIVITY_LEVELS: readonly SensitivityLevel[] = ['public', 'personal', 'intimate', 'confidential'];

export const VALID_SENSITIVITY_LEVELS: SensitivityLevel[] = ['public', 'personal', 'intimate', 'confidential'];
export const VALID_CONSENT_REDACTION_BEHAVIORS: ConsentRedactionBehavior[] = ['delete', 'abstract'];
export const VALID_MEMORY_REDACTION_OPERATIONS: MemoryRedactionOperation[] = ['auto', 'delete', 'abstract'];

// ── Numeric ordering (higher = more privileged / more sensitive) ──

const TRUST_ORDER: Record<TrustLevel, number> = {
  primary: 3,
  trusted: 2,
  regular: 1,
  public: 0,
};

const SENSITIVITY_ORDER: Record<SensitivityLevel, number> = {
  public: 0,
  personal: 1,
  intimate: 2,
  confidential: 3,
};

// ── Trust ceiling — which sensitivities are accessible at each trust level ──
// primary:  full access (honne — inner truth)
// trusted:  public + personal
// regular:  public + personal
// public:   public only (tatemae — public face)

export const TRUST_CEILING: Record<TrustLevel, readonly SensitivityLevel[]> = {
  primary: ['public', 'personal', 'intimate', 'confidential'],
  trusted: ['public', 'personal'],
  regular: ['public', 'personal'],
  public: ['public'],
};

// ── Comparison helpers ──

export function trustAtLeast(level: TrustLevel, minimum: TrustLevel): boolean {
  return TRUST_ORDER[level] >= TRUST_ORDER[minimum];
}

export function sensitivityAtMost(level: SensitivityLevel, maximum: SensitivityLevel): boolean {
  return SENSITIVITY_ORDER[level] <= SENSITIVITY_ORDER[maximum];
}

export function trustOrd(level: TrustLevel): number {
  return TRUST_ORDER[level];
}

export function isHighTierTrustLevel(level: TrustLevel): level is HighTierTrustLevel {
  return (HIGH_TIER_TRUST_LEVELS as readonly TrustLevel[]).includes(level);
}

export function isLowTierTrustLevel(level: TrustLevel): level is LowTierTrustLevel {
  return (LOW_TIER_TRUST_LEVELS as readonly TrustLevel[]).includes(level);
}

export function isHighIntimacySensitivityLevel(level: SensitivityLevel): level is HighIntimacySensitivityLevel {
  return (HIGH_INTIMACY_SENSITIVITY_LEVELS as readonly SensitivityLevel[]).includes(level);
}

/**
 * Decoder for PERSISTED channel-visibility values only (session provenance,
 * mirror metadata, transcript projections, contact rows, journal records
 * written before the E3.1 rename / E3.3 broadcast split). Maps the retired
 * stored vocabulary onto ChannelPrivacy per the documented migration map
 * (docs/context-envelope.md):
 *
 *   'semi_private' → 'invite_only'   (E3.1 rename)
 *   'broadcast'    → 'public'        (E3.3 split: broadcast is a flag whose
 *                                     disclosure ceiling IS the public row,
 *                                     so the privacy projection is lossless
 *                                     for every stored-data gate)
 *
 * This is the read-boundary decode rule, NOT an accepted input alias: config,
 * API, and model-facing surfaces reject the retired vocabulary outright, and
 * new writes stamp ChannelPrivacy values only.
 */
export function decodeStoredChannelVisibility(value: unknown): ChannelPrivacy | undefined {
  if (value === 'semi_private') return 'invite_only';
  if (value === 'broadcast') return 'public';
  if (value === 'private' || value === 'invite_only' || value === 'public') return value;
  return undefined;
}

export function sensitivityOrd(level: SensitivityLevel): number {
  return SENSITIVITY_ORDER[level];
}

function normalizeBehavior(value: unknown): ConsentRedactionBehavior | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'delete') return 'delete';
  if (normalized === 'abstract') return 'abstract';
  return undefined;
}

export function normalizeConsentFlags(input: unknown): ConsentFlags {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {};
  }

  const source = input as Record<string, unknown>;
  const normalized: ConsentFlags = {};

  if (typeof source.allowRecall === 'boolean') {
    normalized.allowRecall = source.allowRecall;
  }
  if (typeof source.allowAbstraction === 'boolean') {
    normalized.allowAbstraction = source.allowAbstraction;
  }
  if (typeof source.deleteOnRequest === 'boolean') {
    normalized.deleteOnRequest = source.deleteOnRequest;
  }

  const redactionBehavior = normalizeBehavior(source.redactionBehavior);
  if (redactionBehavior) {
    normalized.redactionBehavior = redactionBehavior;
  }

  return normalized;
}

export function resolveConsentRedactionBehavior(
  flags: ConsentFlags | undefined,
  requestedOperation: MemoryRedactionOperation = 'auto',
): ConsentRedactionBehavior {
  const normalized = normalizeConsentFlags(flags);

  if (requestedOperation === 'delete') return 'delete';
  if (requestedOperation === 'abstract') {
    return normalized.allowAbstraction === false ? 'delete' : 'abstract';
  }

  if (normalized.redactionBehavior) {
    if (normalized.redactionBehavior === 'abstract' && normalized.allowAbstraction === false) {
      return 'delete';
    }
    return normalized.redactionBehavior;
  }

  if (normalized.allowAbstraction === false) {
    return 'delete';
  }

  if (normalized.deleteOnRequest === true || normalized.allowRecall === false) {
    return 'abstract';
  }

  return 'delete';
}
