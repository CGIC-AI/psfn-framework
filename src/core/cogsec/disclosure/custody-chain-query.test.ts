// Contract proof for the custody chain query projection (psfn-framework-ccgdz.7):
// the manifest join, the explicit `unknown` degradation, the keyset cursor, and
// the content-free floor asserted over the WHOLE projected response rather than
// field by field.

import { describe, expect, it } from 'vitest';

import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
} from './decision.js';
import { buildContextSourceManifest } from './context-source-manifest.js';
import { custodySha256 } from './custody-identity.js';
import {
  buildCustodySnapshot,
  custodySnapshotRefForTurn,
  type CustodySnapshot,
} from './custody-snapshot.js';
import {
  decodeCustodyChainCursor,
  encodeCustodyChainCursor,
  projectEgressToSources,
  projectSourceToEgresses,
  type CustodyChainDeliveryList,
} from './custody-chain-query.js';
import {
  egressContentSha256,
  egressDeliveryDestination,
  egressDeliveryRef,
  validateEgressDeliveryRecord,
  type EgressDeliveryRecord,
} from './egress-delivery-record.js';
import { custodyIdentity } from './custody-identity.js';
import type { DisclosureLineage } from './contracts.js';

const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const NOW_MS = 1_800_000_000_000;
const RECEIPT_ID = 'rcpt_01JZ0000000000000000000001';
const ENVELOPE_ID = 'env_01JZ0000000000000000000001';
const SECRET_BODY = "my bank PIN is 4417\nsee /home/vega/private/notes.md";

const memorySource = {
  ref: 'memory:mem-7',
  sensitivity: 'personal' as const,
  permittedDestinations: [{ kind: 'public_room' as const, channelIds: ['discord:room-1'] }],
  classified: true,
};

const wikiSource = {
  ref: 'wiki:doc-3',
  sensitivity: 'public' as const,
  permittedDestinations: [],
  classified: true,
};

function lineageOf(sources: readonly (typeof memorySource)[]): DisclosureLineage {
  let folded = beginDisclosureAccumulation({
    generationContextRef: custodySnapshotRefForTurn(TURN_ID),
    classifierVersion: 'disclosure/v1',
    classifiedAt: new Date(NOW_MS).toISOString(),
  });
  for (const source of sources) folded = accumulateDisclosureSource(folded, source);
  return folded;
}

function snapshotOf(sources: readonly (typeof memorySource)[]): CustodySnapshot {
  return buildCustodySnapshot({
    lineage: lineageOf(sources),
    turnId: TURN_ID,
    requestId: 'msg-01936f2c4a1b',
  });
}

function manifestWithAdmission() {
  return buildContextSourceManifest({
    turnId: TURN_ID,
    blocks: [
      {
        id: 'memory-recall',
        layer: 'runtime',
        volatility: 'turn',
        producer: 'memory.activeContext',
        tokensEst: 42,
        renderedText: SECRET_BODY,
        sources: [{
          kind: 'memory',
          refId: 'memory:mem-7',
          receiptId: RECEIPT_ID,
          envelopeId: ENVELOPE_ID,
          contentSha256: custodySha256('admitted bytes'),
        }],
      },
      {
        id: 'memory-recall-continued',
        layer: 'runtime',
        volatility: 'turn',
        producer: 'memory.activeContext',
        tokensEst: 12,
        renderedText: 'more of the same memory',
        sources: [{ kind: 'memory', refId: 'memory:mem-7' }],
      },
    ],
  });
}

function deliveryOf(overrides: Partial<EgressDeliveryRecord> = {}): EgressDeliveryRecord {
  const attempt = overrides.attempt ?? custodyIdentity('tool-call-1');
  return validateEgressDeliveryRecord({
    schemaVersion: 1,
    deliveryRef: egressDeliveryRef(custodySnapshotRefForTurn(TURN_ID), attempt),
    generationContextRef: custodySnapshotRefForTurn(TURN_ID),
    turnId: TURN_ID,
    owner: { kind: 'companion', companionId: '3f2a1c88-5d4e-4a7b-9c3d-1e2f3a4b5c6d' },
    surface: 'tool_egress',
    disposition: 'released',
    enforcementPosture: 'enforce',
    attempt,
    contentSha256: egressContentSha256('hello room'),
    destination: egressDeliveryDestination({ kind: 'public_room', channelId: 'discord:room-1' }),
    outcome: 'auto_shareable',
    decisionAllowed: true,
    custodySnapshotRef: custodySnapshotRefForTurn(TURN_ID),
    sourceCount: 1,
    hasUnclassifiedSource: false,
    effectiveSensitivity: 'personal',
    recordedAtMs: NOW_MS,
    ...overrides,
  });
}

function deliveries(
  records: readonly EgressDeliveryRecord[],
  malformedCount = 0,
): CustodyChainDeliveryList {
  return { records, malformedCount };
}

describe('projectEgressToSources', () => {
  it('joins the manifest admission identity onto the snapshot source', () => {
    const view = projectEgressToSources({
      generationContextRef: custodySnapshotRefForTurn(TURN_ID),
      turnId: TURN_ID,
      snapshot: { status: 'present', record: snapshotOf([memorySource]) },
      manifest: { status: 'present', record: manifestWithAdmission() },
      deliveries: deliveries([deliveryOf()]),
    });
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]?.admission).toEqual({
      status: 'present',
      receiptId: RECEIPT_ID,
      envelopeId: ENVELOPE_ID,
      contentSha256: custodySha256('admitted bytes'),
    });
    // Rendered into two blocks; the second carried no identity and must not
    // erase the first block's proof.
    expect(view.sources[0]?.renderedBlockCount).toBe(2);
    expect(view.chainComplete).toBe(true);
    expect(view.unknownDimensions).toEqual([]);
  });

  it('reports a source the manifest never rendered as unknown, not as unadmitted', () => {
    const view = projectEgressToSources({
      generationContextRef: custodySnapshotRefForTurn(TURN_ID),
      turnId: TURN_ID,
      snapshot: { status: 'present', record: snapshotOf([memorySource, wikiSource]) },
      manifest: { status: 'present', record: manifestWithAdmission() },
      deliveries: deliveries([deliveryOf()]),
    });
    const wiki = view.sources.find(entry => entry.source.kind === 'wiki');
    expect(wiki?.admission).toEqual({ status: 'unknown' });
    expect(wiki?.renderedBlockCount).toBe(0);
    expect(view.unknownDimensions).toContain('source_admission_identity');
    expect(view.chainComplete).toBe(true);
  });

  it('degrades an absent snapshot to unknown rather than to zero sources', () => {
    const view = projectEgressToSources({
      generationContextRef: custodySnapshotRefForTurn(TURN_ID),
      turnId: TURN_ID,
      snapshot: { status: 'absent' },
      manifest: { status: 'absent' },
      deliveries: deliveries([]),
    });
    expect(view.sourceCount).toBe('unknown');
    expect(view.hasUnclassifiedSource).toBe('unknown');
    expect(view.classification).toBe('unknown');
    expect(view.effectiveSensitivity).toBe('unknown');
    expect(view.snapshotStatus).toBe('absent');
    expect(view.chainComplete).toBe(false);
    expect(view.unknownDimensions).toEqual([
      'custody_snapshot', 'context_manifest', 'egress_delivery',
    ]);
  });

  it('keeps a malformed record distinct from an absent one', () => {
    const view = projectEgressToSources({
      generationContextRef: custodySnapshotRefForTurn(TURN_ID),
      turnId: TURN_ID,
      snapshot: { status: 'malformed' },
      manifest: { status: 'malformed' },
      deliveries: deliveries([], 2),
    });
    expect(view.snapshotStatus).toBe('malformed');
    expect(view.manifestStatus).toBe('malformed');
    // No readable delivery but unreadable rows in range: the surface says the
    // egress cannot be read, never that no egress happened.
    expect(view.deliveryStatus).toBe('malformed');
    expect(view.malformedDeliveryCount).toBe(2);
    expect(view.chainComplete).toBe(false);
  });

  it('never calls a chain complete while one of its rows will not validate', () => {
    const view = projectEgressToSources({
      generationContextRef: custodySnapshotRefForTurn(TURN_ID),
      turnId: TURN_ID,
      snapshot: { status: 'present', record: snapshotOf([memorySource]) },
      manifest: { status: 'present', record: manifestWithAdmission() },
      deliveries: deliveries([deliveryOf()], 1),
    });
    expect(view.deliveryStatus).toBe('present');
    expect(view.chainComplete).toBe(false);
  });

  it('counts held deliveries separately from released ones', () => {
    const view = projectEgressToSources({
      generationContextRef: custodySnapshotRefForTurn(TURN_ID),
      turnId: TURN_ID,
      snapshot: { status: 'present', record: snapshotOf([memorySource]) },
      manifest: { status: 'present', record: manifestWithAdmission() },
      deliveries: deliveries([
        deliveryOf(),
        deliveryOf({
          attempt: custodyIdentity('tool-call-2'),
          disposition: 'held',
          holdReason: 'no_admitted_source',
          decisionAllowed: false,
          outcome: 'non_shareable',
        }),
      ]),
    });
    expect(view.deliveryCount).toBe(2);
    expect(view.heldDeliveryCount).toBe(1);
  });
});

describe('projectSourceToEgresses', () => {
  const source = custodyIdentity('memory:mem-7');

  it('buckets deliveries under the generation that admitted the source', () => {
    const view = projectSourceToEgresses({
      source,
      matches: [{
        generationContextRef: custodySnapshotRefForTurn(TURN_ID),
        turnId: TURN_ID,
        classifiedAtMs: NOW_MS,
        snapshot: { status: 'present', record: snapshotOf([memorySource]) },
      }],
      deliveries: deliveries([deliveryOf()]),
      limit: 25,
      hasMore: false,
    });
    expect(view.generationCount).toBe(1);
    expect(view.deliveryCount).toBe(1);
    expect(view.generations[0]?.deliveries).toHaveLength(1);
    expect(view.page).toEqual({ limit: 25, hasMore: false });
    expect(view.unknownDimensions).toEqual([]);
  });

  it('emits a keyset cursor only when another page exists', () => {
    const view = projectSourceToEgresses({
      source,
      matches: [{
        generationContextRef: custodySnapshotRefForTurn(TURN_ID),
        turnId: TURN_ID,
        classifiedAtMs: NOW_MS,
        snapshot: { status: 'malformed' },
      }],
      deliveries: deliveries([]),
      limit: 1,
      hasMore: true,
    });
    expect(view.page.nextCursor).toBe(encodeCustodyChainCursor(NOW_MS, TURN_ID));
    expect(view.generations[0]?.classification).toBe('unknown');
    expect(view.generations[0]?.classifiedAtMs).toBe('unknown');
    expect(view.unknownDimensions).toEqual(['custody_snapshot', 'egress_delivery']);
  });
});

describe('custody chain page cursor', () => {
  it('round-trips an instant and a turn id', () => {
    expect(decodeCustodyChainCursor(encodeCustodyChainCursor(NOW_MS, TURN_ID)))
      .toEqual({ classifiedAtMs: NOW_MS, turnId: TURN_ID });
  });

  it('refuses anything that is not the exact shape it emits', () => {
    for (const candidate of [
      '', ':abc', 'abc:def', '0:' + TURN_ID, `${String(NOW_MS)}:`,
      `${String(NOW_MS)}:has whitespace`, `${String(NOW_MS)}:${SECRET_BODY}`,
      `${String(Number.MAX_SAFE_INTEGER)}1:${TURN_ID}`,
    ]) {
      expect(decodeCustodyChainCursor(candidate)).toBeNull();
    }
  });
});

describe('custody chain query content-free discipline', () => {
  /**
   * Every leaf of a projected response must be a bounded identifier, a
   * lowercase-hex digest, a number, a boolean, or a closed-vocabulary word.
   * Asserted structurally rather than by listing fields, so a field added
   * later cannot quietly become a text channel.
   */
  // The `/` is admitted for one reason only: a compile-time classifier version
  // label (`disclosure/v1`), which the snapshot's own validator already bounds
  // to 64 characters of `[A-Za-z0-9_./-]`. No whitespace, quote, or newline is
  // admitted at all, and the explicit fragment assertions below still prove no
  // path or prose survives.
  const SAFE_LEAF = /^[A-Za-z0-9_:.@+#/-]{0,256}$/u;

  function assertContentFree(value: unknown, path: string): void {
    if (value === null || value === undefined) return;
    if (typeof value === 'number' || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      expect(SAFE_LEAF.test(value), `${path} = ${JSON.stringify(value)}`).toBe(true);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => { assertContentFree(entry, `${path}[${String(index)}]`); });
      return;
    }
    expect(typeof value, path).toBe('object');
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertContentFree(entry, `${path}.${key}`);
    }
  }

  it('lets no rendered text, path, or prose through either direction', () => {
    // A source whose ref, channel and rendered text are all message body.
    const poisoned = {
      ref: `wiki:${SECRET_BODY}`,
      sensitivity: 'confidential' as const,
      permittedDestinations: [],
      sourceChannelId: SECRET_BODY,
      classified: false,
    };
    const snapshot = buildCustodySnapshot({
      lineage: lineageOf([poisoned]),
      turnId: TURN_ID,
      requestId: SECRET_BODY,
    });
    const manifest = buildContextSourceManifest({
      turnId: TURN_ID,
      blocks: [{
        id: 'wiki-block',
        layer: 'runtime',
        volatility: 'turn',
        producer: 'wiki.retrieval',
        tokensEst: 99,
        renderedText: SECRET_BODY,
        sources: [{
          kind: 'wiki',
          refId: `wiki:${SECRET_BODY}`,
          receiptId: SECRET_BODY,
          envelopeId: SECRET_BODY,
          contentSha256: SECRET_BODY,
        }],
      }],
    });
    const egressView = projectEgressToSources({
      generationContextRef: custodySnapshotRefForTurn(TURN_ID),
      turnId: TURN_ID,
      snapshot: { status: 'present', record: snapshot },
      manifest: { status: 'present', record: manifest },
      deliveries: deliveries([deliveryOf()]),
    });
    const sourceView = projectSourceToEgresses({
      source: custodyIdentity(`wiki:${SECRET_BODY}`),
      matches: [{
        generationContextRef: custodySnapshotRefForTurn(TURN_ID),
        turnId: TURN_ID,
        classifiedAtMs: NOW_MS,
        snapshot: { status: 'present', record: snapshot },
      }],
      deliveries: deliveries([deliveryOf()]),
      limit: 25,
      hasMore: true,
    });

    for (const [name, view] of [
      ['egress_to_sources', egressView],
      ['source_to_egresses', sourceView],
    ] as const) {
      assertContentFree(view, name);
      const serialized = JSON.stringify(view);
      for (const fragment of ['bank PIN', '4417', '/home/vega/private', "don't share"]) {
        expect(serialized).not.toContain(fragment);
      }
    }

    // The identity survives as a join key — the point of the seam.
    expect(egressView.sources[0]?.source.ref.digest)
      .toBe(custodySha256(`wiki:${SECRET_BODY}`));
    expect(egressView.sources[0]?.source.ref.id).toBeUndefined();
    // A free-text admission field is DROPPED, degrading the source to unknown
    // rather than asserting a proof made of prose.
    expect(egressView.sources[0]?.admission).toEqual({ status: 'present' });
    expect(egressView.sources[0]?.source.classified).toBe(false);
  });
});
