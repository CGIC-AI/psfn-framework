// ── Trust & Privacy Types ──
// Canonical definitions for the honne/tatemae privacy model.
// All trust-sensitive surfaces import from here — single source of truth.

export type TrustLevel = 'primary' | 'trusted' | 'regular' | 'public';

export type SensitivityLevel = 'public' | 'personal' | 'intimate' | 'confidential';

export type ChannelVisibility = 'private' | 'semi_private' | 'public' | 'broadcast';

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
