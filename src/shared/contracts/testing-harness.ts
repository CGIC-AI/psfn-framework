import { assertNoUnknownKeys, isRecord } from '../utils/types.js';

export interface TestingHarnessRunProvenance {
  schemaVersion: 1;
  kind: 'testing_harness';
  runId: string;
  manifestId: string;
}

export const TESTING_HARNESS_SESSION_CHANNEL_ID = 'api:testing-harness';
export const TESTING_HARNESS_RUN_ID_HEADER = 'x-testing-harness-run-id';
export const TESTING_HARNESS_MANIFEST_ID_HEADER = 'x-testing-harness-manifest-id';

const PROVENANCE_KEYS: readonly string[] = ['schemaVersion', 'kind', 'runId', 'manifestId'];
const CANONICAL_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u;

function normalizeIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Testing-harness ${field} must be a string`);
  }
  const normalized = value.trim();
  if (!CANONICAL_IDENTIFIER.test(normalized)) {
    throw new Error(`Testing-harness ${field} must be a canonical identifier`);
  }
  return normalized;
}

export function normalizeTestingHarnessRunProvenance(
  value: unknown,
): TestingHarnessRunProvenance {
  if (!isRecord(value)) throw new Error('Testing-harness provenance must be an object');
  assertNoUnknownKeys(value, PROVENANCE_KEYS, 'testingHarness', {
    errorPrefix: 'Testing-harness provenance',
  });
  if (value.schemaVersion !== 1 || value.kind !== 'testing_harness') {
    throw new Error('Testing-harness provenance contract is invalid');
  }
  return {
    schemaVersion: 1,
    kind: 'testing_harness',
    runId: normalizeIdentifier(value.runId, 'runId'),
    manifestId: normalizeIdentifier(value.manifestId, 'manifestId'),
  };
}
