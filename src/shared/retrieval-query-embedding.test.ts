import { describe, expect, it, vi } from 'vitest';
import {
  createTurnRetrievalQueryEmbedding,
  type RetrievalQueryEmbeddingProvenance,
} from './retrieval-query-embedding.js';

const provenance: RetrievalQueryEmbeddingProvenance = {
  provider: 'test-provider',
  model: 'test-embedding-v1',
  dimensions: 3,
};

const expected = {
  turnId: 'turn-1',
  requestId: 'request-1',
  companionId: 'companion-a',
  channelId: 'api:test',
  canonicalContactId: 'contact-a',
  queryText: 'shared retrieval query',
  provenance,
};

describe('turn retrieval query embedding', () => {
  it('embeds once for concurrent consumers and gives each consumer an isolated vector', async () => {
    const embed = vi.fn(async () => new Float32Array([0.25, 0.5, 0.75]));
    const value = createTurnRetrievalQueryEmbedding({ ...expected, embed });

    const [memoryVector, wikiVector] = await Promise.all([
      value.resolve(expected),
      value.resolve(expected),
    ]);

    expect(embed).toHaveBeenCalledTimes(1);
    expect(Array.from(memoryVector)).toEqual([0.25, 0.5, 0.75]);
    expect(Array.from(wikiVector)).toEqual([0.25, 0.5, 0.75]);
    expect(memoryVector).not.toBe(wikiVector);
    memoryVector[0] = 99;
    expect(wikiVector[0]).toBe(0.25);
  });

  it.each([
    ['turn', { turnId: 'turn-2' }],
    ['request', { requestId: 'request-2' }],
    ['companion', { companionId: 'companion-b' }],
    ['channel', { channelId: 'api:other' }],
    ['contact', { canonicalContactId: 'contact-b' }],
    ['query', { queryText: 'different query' }],
    ['provider', { provenance: { ...provenance, provider: 'other-provider' } }],
    ['model', { provenance: { ...provenance, model: 'test-embedding-v2' } }],
    ['dimensions', { provenance: { ...provenance, dimensions: 4 } }],
  ])('rejects %s provenance leakage before embedding', async (_label, override) => {
    const embed = vi.fn(async () => new Float32Array([0.25, 0.5, 0.75]));
    const value = createTurnRetrievalQueryEmbedding({ ...expected, embed });

    await expect(value.resolve({ ...expected, ...override })).rejects.toThrow(
      'Turn retrieval query embedding provenance mismatch',
    );
    expect(embed).not.toHaveBeenCalled();
  });

  it('fails closed when the provider returns the wrong dimensions', async () => {
    const embed = vi.fn(async () => new Float32Array([0.25, 0.5]));
    const value = createTurnRetrievalQueryEmbedding({ ...expected, embed });

    await expect(value.resolve(expected)).rejects.toThrow(
      'Turn retrieval query embedding dimension mismatch: expected 3, got 2',
    );
  });
});
