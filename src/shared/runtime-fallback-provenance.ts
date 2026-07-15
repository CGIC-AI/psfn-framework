import type {
  RuntimeFallbackProvenance,
  RuntimeFallbackStrategy,
} from './contracts/runtime.js';
import { isRecord } from './utils/types.js';

const RUNTIME_FALLBACK_STRATEGIES = new Set<RuntimeFallbackStrategy>([
  'runtime_nonfabricating_notice',
  'runtime_datetime_contradiction_refusal',
]);

export function normalizeRuntimeFallbackProvenance(
  value: unknown,
  fieldName = 'runtimeFallbackProvenance',
): RuntimeFallbackProvenance {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${fieldName}.schemaVersion must be 1`);
  }
  if (value.authoredBy !== 'runtime') {
    throw new Error(`${fieldName}.authoredBy must be "runtime"`);
  }
  if (value.model !== 'runtime-fallback') {
    throw new Error(`${fieldName}.model must be "runtime-fallback"`);
  }
  if (
    typeof value.strategy !== 'string'
    || !RUNTIME_FALLBACK_STRATEGIES.has(value.strategy as RuntimeFallbackStrategy)
  ) {
    throw new Error(`${fieldName}.strategy is invalid`);
  }

  return {
    schemaVersion: 1,
    authoredBy: 'runtime',
    model: 'runtime-fallback',
    strategy: value.strategy as RuntimeFallbackStrategy,
  };
}
