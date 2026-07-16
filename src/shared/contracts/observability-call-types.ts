export const OBSERVABILITY_CALL_TYPES = [
  'chat',
  'tool',
  'memory',
  'summary',
  'background',
  'scheduled',
] as const;

export type ObservabilityCallType = typeof OBSERVABILITY_CALL_TYPES[number];

const OBSERVABILITY_CALL_TYPE_SET: ReadonlySet<string> = new Set(OBSERVABILITY_CALL_TYPES);

export function isObservabilityCallType(value: unknown): value is ObservabilityCallType {
  return typeof value === 'string' && OBSERVABILITY_CALL_TYPE_SET.has(value);
}
