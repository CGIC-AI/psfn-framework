import { describe, expect, it } from 'vitest';
import {
  buildContextSourceManifest,
  contextSourceManifestContentDigest,
  contextSourceManifestRefForTurn,
  validateContextSourceManifest,
} from './context-source-manifest.js';
import { custodySha256 } from './custody-identity.js';

const TURN_ID = '01JZ0000000000000000000001';
const ENVELOPE_ID = 'env_01JZ0000000000000000000001';
const RECEIPT_ID = 'rcpt_01JZ0000000000000000000001';
const WIKI_SHA = 'c'.repeat(64);

function block(overrides: Partial<Parameters<typeof buildContextSourceManifest>[0]['blocks'][number]> = {}) {
  return {
    id: 'memory.retrieval',
    layer: 'session',
    volatility: 'turn',
    producer: 'session.context-builder',
    tokensEst: 42,
    renderedText: 'the partner mentioned their surgery date is the 14th',
    ...overrides,
  };
}

describe('buildContextSourceManifest', () => {
  it('keys the manifest on the turn, exactly as the custody snapshot does', () => {
    const manifest = buildContextSourceManifest({ turnId: TURN_ID, blocks: [block()] });
    expect(manifest.generationContextRef).toBe(contextSourceManifestRefForTurn(TURN_ID));
    expect(manifest.generationContextRef).toBe(`turn:${TURN_ID}`);
  });

  it('records the block text only as a hash, never as text', () => {
    const rendered = 'the partner mentioned their surgery date is the 14th';
    const manifest = buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [block({ renderedText: rendered })],
    });
    expect(manifest.blocks[0]?.renderedTextSha256).toBe(custodySha256(rendered));
    expect(JSON.stringify(manifest)).not.toContain('surgery');
  });

  it('lists memory ids and their admission identity for the block that rendered them', () => {
    const manifest = buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [block({
        sources: [
          { kind: 'memory', refId: 'mem-1' },
          {
            kind: 'intake_envelope',
            refId: ENVELOPE_ID,
            envelopeId: ENVELOPE_ID,
            receiptId: RECEIPT_ID,
          },
        ],
      })],
    });
    expect(manifest.blocks[0]?.sources).toEqual([
      { kind: 'memory', ref: { digest: custodySha256('mem-1'), id: 'mem-1' } },
      {
        kind: 'intake_envelope',
        ref: { digest: custodySha256(ENVELOPE_ID), id: ENVELOPE_ID },
        envelopeId: ENVELOPE_ID,
        receiptId: RECEIPT_ID,
      },
    ]);
    expect(manifest.sourcedBlockCount).toBe(1);
    expect(manifest.sourceCount).toBe(2);
  });

  it('records an unsourced block rather than omitting it, so a gap stays visible', () => {
    const manifest = buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [
        block({ id: 'static_prefix', layer: 'prompt_stack', volatility: 'static' }),
        block({ sources: [{ kind: 'wiki', refId: 'doc-1', contentSha256: WIKI_SHA }] }),
      ],
    });
    expect(manifest.blocks).toHaveLength(2);
    expect(manifest.blocks[0]?.sources).toEqual([]);
    expect(manifest.sourcedBlockCount).toBe(1);
  });

  it('keeps only the digest when a producer or scope key could carry prose', () => {
    const proseScope = 'room where the partner said their password out loud';
    const manifest = buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [block({ scopeKey: proseScope })],
    });
    expect(manifest.blocks[0]?.scopeKey).toEqual({ digest: custodySha256(proseScope) });
    expect(JSON.stringify(manifest)).not.toContain('password');
  });

  it('drops a source whose ref is unusable rather than storing a malformed one', () => {
    const manifest = buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [block({
        sources: [
          { kind: 'memory', refId: '   ' },
          { kind: 'memory', refId: 'mem-2', contentSha256: 'NOT-A-HASH' },
        ],
      })],
    });
    expect(manifest.blocks[0]?.sources).toEqual([
      { kind: 'memory', ref: { digest: custodySha256('mem-2'), id: 'mem-2' } },
    ]);
  });

  it('refuses an unknown block layer instead of widening the stored vocabulary', () => {
    expect(() => buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [block({ layer: 'invented_layer' })],
    })).toThrow(/layer/);
  });
});

describe('validateContextSourceManifest', () => {
  it('round-trips a built manifest through JSON', () => {
    const manifest = buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [block({ sources: [{ kind: 'wiki', refId: 'doc-1', contentSha256: WIKI_SHA }] })],
    });
    const reparsed = validateContextSourceManifest(JSON.parse(JSON.stringify(manifest)));
    expect(reparsed).toEqual(manifest);
    expect(contextSourceManifestContentDigest(reparsed))
      .toBe(contextSourceManifestContentDigest(manifest));
  });

  it('refuses a row whose counts were edited away from its blocks', () => {
    const manifest = buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [block({ sources: [{ kind: 'memory', refId: 'mem-1' }] })],
    });
    expect(() => validateContextSourceManifest({ ...manifest, sourceCount: 9 }))
      .toThrow(/sourceCount/);
  });

  it('refuses a ref id whose digest was edited to point at other bytes', () => {
    const manifest = buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [block({ sources: [{ kind: 'memory', refId: 'mem-1' }] })],
    });
    const tampered = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tampered.blocks[0]!.sources[0] as any).ref.digest = custodySha256('mem-other');
    expect(() => validateContextSourceManifest(tampered)).toThrow(/does not match its digest/);
  });
});
