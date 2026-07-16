import { createHash } from 'node:crypto';
import type { VerifiedFleetAuthLifecycleDecision } from './authority-lifecycle-types.js';

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function fleetAuthLifecycleDecisionFingerprint(
  decision: VerifiedFleetAuthLifecycleDecision,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(decision)))
    .digest('hex');
}
