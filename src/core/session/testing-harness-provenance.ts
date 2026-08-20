import type { TestingHarnessRunProvenance } from '../../shared/contracts/testing-harness.js';
import { normalizeTestingHarnessRunProvenance } from '../../shared/contracts/testing-harness.js';
import { isRecord } from '../../shared/utils/types.js';
import type { SessionEntry } from './types.js';

export const SESSION_METADATA_TESTING_HARNESS_KEY = 'testingHarness';

function parseEnvelope(metadata: string | undefined): Record<string, unknown> {
  if (!metadata) return {};
  let value: unknown;
  try {
    value = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing testing-harness provenance parsing');
  }
  if (!isRecord(value)) {
    throw new Error('Session metadata must be an object for testing-harness provenance parsing');
  }
  return value;
}

export function buildSessionMetadataWithTestingHarnessProvenance(
  metadata: string | undefined,
  provenance: TestingHarnessRunProvenance,
): string {
  return JSON.stringify({
    ...parseEnvelope(metadata),
    [SESSION_METADATA_TESTING_HARNESS_KEY]: normalizeTestingHarnessRunProvenance(provenance),
  });
}

export function resolveSessionEntryTestingHarnessProvenance(
  entry: Pick<SessionEntry, 'metadata'>,
): TestingHarnessRunProvenance | null {
  const raw = parseEnvelope(entry.metadata)[SESSION_METADATA_TESTING_HARNESS_KEY];
  return raw === undefined ? null : normalizeTestingHarnessRunProvenance(raw);
}

export function assertMemorySourceIsNotTestingHarness(
  entries: readonly Pick<SessionEntry, 'metadata'>[],
): void {
  if (entries.some(entry => resolveSessionEntryTestingHarnessProvenance(entry) !== null)) {
    throw new Error('Testing-harness session entries are not eligible for derived memory');
  }
}
