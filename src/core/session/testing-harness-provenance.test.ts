import { describe, expect, it } from 'vitest';
import {
  assertMemorySourceIsNotTestingHarness,
  buildSessionMetadataWithTestingHarnessProvenance,
  resolveSessionEntryTestingHarnessProvenance,
} from './testing-harness-provenance.js';

const provenance = {
  schemaVersion: 1 as const,
  kind: 'testing_harness' as const,
  runId: 'run-a',
  manifestId: 'manifest-a',
};

describe('testing-harness session provenance', () => {
  it('round-trips alongside unrelated metadata', () => {
    const metadata = buildSessionMetadataWithTestingHarnessProvenance(
      JSON.stringify({ existing: true }),
      provenance,
    );
    expect(JSON.parse(metadata)).toEqual({ existing: true, testingHarness: provenance });
    expect(resolveSessionEntryTestingHarnessProvenance({ metadata })).toEqual(provenance);
  });

  it('rejects test-only source entries at the derived-memory boundary', () => {
    const metadata = buildSessionMetadataWithTestingHarnessProvenance(undefined, provenance);
    expect(() => assertMemorySourceIsNotTestingHarness([{ metadata }]))
      .toThrow('not eligible for derived memory');
    expect(() => assertMemorySourceIsNotTestingHarness([{ metadata: undefined }])).not.toThrow();
  });
});
