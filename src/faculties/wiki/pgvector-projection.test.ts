import { describe, expect, it } from 'vitest';
import {
  chunkWikiBody,
  computeWikiProjectionDrift,
  DEFAULT_WIKI_CHUNK_MAX_CHARS,
} from './pgvector-projection.js';

describe('chunkWikiBody', () => {
  it('splits on paragraph boundaries and preserves content order', () => {
    const body = 'First paragraph about gateways.\n\nSecond paragraph about the garden.\n\nThird one.';
    const chunks = chunkWikiBody(body);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.join(' ')).toContain('First paragraph');
    expect(chunks.join(' ')).toContain('Third one');
  });

  it('hard-splits an oversized single paragraph so no chunk exceeds the cap', () => {
    const giant = 'x'.repeat(DEFAULT_WIKI_CHUNK_MAX_CHARS * 3 + 17);
    const chunks = chunkWikiBody(giant, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it('returns an empty chunk list for a blank body', () => {
    expect(chunkWikiBody('   \n\n  ')).toEqual([]);
  });
});

describe('computeWikiProjectionDrift (repair decision)', () => {
  it('flags missing documents for re-embedding', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [
        { id: 'a', bodySha256: 'sha-a' },
        { id: 'b', bodySha256: 'sha-b' },
      ],
      projected: [{ documentId: 'a', bodySha256: 'sha-a' }],
    });
    expect(drift.toReembed).toEqual(['b']);
    expect(drift.toDelete).toEqual([]);
  });

  it('detects checksum drift and schedules a re-embed of the changed document', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [{ id: 'a', bodySha256: 'sha-a-v2' }],
      // projection still holds the old checksum for the same document id
      projected: [{ documentId: 'a', bodySha256: 'sha-a-v1' }],
    });
    expect(drift.toReembed).toEqual(['a']);
    expect(drift.toDelete).toEqual([]);
  });

  it('treats a document with mixed projected checksums as stale', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [{ id: 'a', bodySha256: 'sha-a' }],
      projected: [
        { documentId: 'a', bodySha256: 'sha-a' },
        { documentId: 'a', bodySha256: 'sha-a-old' },
      ],
    });
    expect(drift.toReembed).toEqual(['a']);
  });

  it('marks orphaned projected documents for deletion', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [{ id: 'a', bodySha256: 'sha-a' }],
      projected: [
        { documentId: 'a', bodySha256: 'sha-a' },
        { documentId: 'gone', bodySha256: 'sha-gone' },
      ],
    });
    expect(drift.toReembed).toEqual([]);
    expect(drift.toDelete).toEqual(['gone']);
  });

  it('reports a clean projection as no-op', () => {
    const drift = computeWikiProjectionDrift({
      canonical: [
        { id: 'a', bodySha256: 'sha-a' },
        { id: 'b', bodySha256: 'sha-b' },
      ],
      projected: [
        { documentId: 'a', bodySha256: 'sha-a' },
        { documentId: 'b', bodySha256: 'sha-b' },
      ],
    });
    expect(drift.toReembed).toEqual([]);
    expect(drift.toDelete).toEqual([]);
  });
});
