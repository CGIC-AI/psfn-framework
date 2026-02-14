// ── Trust & Privacy Types ──
// Canonical definitions for the honne/tatemae privacy model.
// All trust-sensitive surfaces import from here — single source of truth.

export type TrustLevel = 'primary' | 'trusted' | 'regular' | 'public';

export type SensitivityLevel = 'public' | 'personal' | 'intimate' | 'confidential';

export type ChannelVisibility = 'private' | 'semi_private' | 'public' | 'broadcast';

export interface ConsentFlags {
  allowRecall?: boolean;
  allowAbstraction?: boolean;
  deleteOnRequest?: boolean;
}

// ── Ordered constants ──

export const TRUST_LEVELS: readonly TrustLevel[] = ['primary', 'trusted', 'regular', 'public'];

export const SENSITIVITY_LEVELS: readonly SensitivityLevel[] = ['public', 'personal', 'intimate', 'confidential'];

export const VALID_SENSITIVITY_LEVELS: SensitivityLevel[] = ['public', 'personal', 'intimate', 'confidential'];

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
// regular:  public only
// public:   public only (tatemae — public face)

export const TRUST_CEILING: Record<TrustLevel, readonly SensitivityLevel[]> = {
  primary: ['public', 'personal', 'intimate', 'confidential'],
  trusted: ['public', 'personal'],
  regular: ['public'],
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

export function sensitivityOrd(level: SensitivityLevel): number {
  return SENSITIVITY_ORDER[level];
}
