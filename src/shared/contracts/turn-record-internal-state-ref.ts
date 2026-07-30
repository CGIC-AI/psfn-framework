export interface TurnRecordInternalStateSnapshotRefInput {
  trust: string;
  contact?: string;
  prompt?: string;
  memory?: string;
  session?: string;
  self?: string;
}

function component(
  field: keyof TurnRecordInternalStateSnapshotRefInput,
  value: string | undefined,
  required = false,
): string {
  if (value === undefined) {
    if (required) {
      throw new Error(`TurnRecord internal-state snapshot component "${field}" is required`);
    }
    return 'none';
  }
  const normalized = value.trim();
  if (!normalized || normalized === 'none' || normalized.includes('|')) {
    throw new Error(`TurnRecord internal-state snapshot component "${field}" is ambiguous`);
  }
  return normalized;
}

/**
 * Canonical composite binding persisted on a TurnRecord.
 *
 * Background payloads intentionally carry only the `self` snapshot ref. Keep
 * construction and extraction in one contract module so producers and
 * consumers cannot silently drift onto different representations.
 */
export function buildTurnRecordInternalStateSnapshotRef(
  input: TurnRecordInternalStateSnapshotRefInput,
): string {
  return [
    `trust:${component('trust', input.trust, true)}`,
    `contact:${component('contact', input.contact)}`,
    `prompt:${component('prompt', input.prompt)}`,
    `memory:${component('memory', input.memory)}`,
    `session:${component('session', input.session)}`,
    `self:${component('self', input.self)}`,
  ].join('|');
}

/**
 * Extract the bare self-model snapshot ref from the canonical TurnRecord
 * composite. Malformed, reordered, or absent-self refs fail closed.
 */
export function extractTurnRecordSelfSnapshotRef(
  compositeRef: string | undefined,
): string | null {
  if (!compositeRef) return null;
  const components = compositeRef.split('|');
  const expectedPrefixes = [
    'trust:',
    'contact:',
    'prompt:',
    'memory:',
    'session:',
    'self:',
  ] as const;
  if (components.length !== expectedPrefixes.length) return null;
  for (let index = 0; index < expectedPrefixes.length; index += 1) {
    const value = components[index]!;
    const prefix = expectedPrefixes[index]!;
    if (!value.startsWith(prefix) || value.length === prefix.length) return null;
  }
  const selfRef = components[components.length - 1]!.slice('self:'.length);
  return selfRef === 'none' ? null : selfRef;
}
