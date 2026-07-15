import { describe, expect, it } from 'vitest';
import {
  MAX_MODEL_USAGE_METADATA_BYTES,
  boundModelUsageMetadata,
} from './model-usage-metadata.js';

describe('boundModelUsageMetadata', () => {
  it('bounds oversized raw provider evidence and records explicit truncation', () => {
    const bounded = boundModelUsageMetadata({
      routeKind: 'configured_litellm_proxy',
      rawUsage: {
        payload: 'x'.repeat(100_000),
        nested: Array.from({ length: 200 }, (_, index) => ({ index, value: `value-${index}` })),
      },
    });
    const encoded = JSON.stringify(bounded);

    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(MAX_MODEL_USAGE_METADATA_BYTES);
    expect(bounded.routeKind).toBe('configured_litellm_proxy');
    expect(bounded._accountingMetadata).toMatchObject({
      truncated: true,
      originalBytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((bounded.rawUsage as { payload: string }).payload.length).toBeLessThan(100_000);
  });

  it('enforces the byte ceiling even when many top-level fields are oversized', () => {
    const bounded = boundModelUsageMetadata(Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`field${index}`, 'x'.repeat(10_000)]),
    ));

    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8'))
      .toBeLessThanOrEqual(MAX_MODEL_USAGE_METADATA_BYTES);
    expect(bounded._accountingMetadata).toMatchObject({ truncated: true });
  });
});
