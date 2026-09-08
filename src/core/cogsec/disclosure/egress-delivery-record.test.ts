// Contract proof for the egress delivery record and the fail-closed provenance
// hold (psfn-framework-ccgdz.6): the hold rules, the composite key, and the
// content-free floor that makes "a hash is identity, never content" testable.

import { describe, expect, it } from 'vitest';

import {
  custodyIdentity,
  custodySha256,
} from './custody-snapshot.js';
import {
  destinationRequiresCustodyProof,
  egressContentSha256,
  egressDeliveryDestination,
  egressDeliveryRecordContentDigest,
  egressDeliveryRef,
  evaluateEgressCustodyHold,
  isCustodyDurabilityHoldReason,
  turnEgressCustodyProof,
  validateEgressDeliveryRecord,
  type EgressDeliveryRecord,
  type TurnEgressCustodyProof,
} from './egress-delivery-record.js';
import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
} from './decision.js';
import type { DisclosureLineage } from './contracts.js';

const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const NOW_MS = 1_800_000_000_000;
const SECRET_BODY = "my bank PIN is 4417\nsee /home/vega/private/notes.md";

function lineage(sources: Parameters<typeof accumulateDisclosureSource>[1][]): DisclosureLineage {
  let folded = beginDisclosureAccumulation({
    generationContextRef: `turn:${TURN_ID}`,
    classifierVersion: 'disclosure/v1',
    classifiedAt: new Date(NOW_MS).toISOString(),
  });
  for (const source of sources) folded = accumulateDisclosureSource(folded, source);
  return folded;
}

const provenSource = {
  ref: 'memory:mem-7',
  sensitivity: 'personal' as const,
  permittedDestinations: [{ kind: 'public_room' as const, channelIds: ['discord:room-1'] }],
  classified: true,
};

function recordOf(overrides: Partial<EgressDeliveryRecord> = {}): EgressDeliveryRecord {
  const attempt = overrides.attempt ?? custodyIdentity('tool-call-1');
  return validateEgressDeliveryRecord({
    schemaVersion: 1,
    generationContextRef: `turn:${TURN_ID}`,
    turnId: TURN_ID,
    owner: { kind: 'companion', companionId: '3f2a1c88-5d4e-4a7b-9c3d-1e2f3a4b5c6d' },
    surface: 'tool_egress',
    disposition: 'released',
    enforcementPosture: 'enforce',
    contentSha256: egressContentSha256('hello room'),
    destination: egressDeliveryDestination({ kind: 'public_room', channelId: 'discord:room-1' }),
    outcome: 'auto_shareable',
    decisionAllowed: true,
    custodySnapshotRef: `turn:${TURN_ID}`,
    sourceCount: 1,
    hasUnclassifiedSource: false,
    effectiveSensitivity: 'personal',
    recordedAtMs: NOW_MS,
    ...overrides,
    attempt,
    deliveryRef: egressDeliveryRef(`turn:${TURN_ID}`, attempt),
  });
}

describe('evaluateEgressCustodyHold', () => {
  const proven: TurnEgressCustodyProof = turnEgressCustodyProof(
    lineage([provenSource]),
    `turn:${TURN_ID}`,
  );

  it('requires no proof for the private sink or an underivable destination', () => {
    expect(destinationRequiresCustodyProof(null)).toBe(false);
    expect(destinationRequiresCustodyProof({ kind: 'companion_self' })).toBe(false);
    expect(evaluateEgressCustodyHold({ destination: null, proof: undefined })).toBeNull();
    expect(evaluateEgressCustodyHold({
      destination: { kind: 'companion_self' },
      proof: undefined,
    })).toBeNull();
  });

  it('releases an outward destination whose chain is complete', () => {
    expect(evaluateEgressCustodyHold({
      destination: { kind: 'public_room', channelId: 'discord:room-1' },
      proof: proven,
    })).toBeNull();
  });

  it('names each broken link in the chain distinctly', () => {
    const outward = { kind: 'public_room' as const, channelId: 'discord:room-1' };
    expect(evaluateEgressCustodyHold({ destination: outward, proof: undefined }))
      .toBe('lineage_missing');
    expect(evaluateEgressCustodyHold({
      destination: outward,
      proof: turnEgressCustodyProof(lineage([]), `turn:${TURN_ID}`),
    })).toBe('no_admitted_source');
    expect(evaluateEgressCustodyHold({
      destination: outward,
      proof: turnEgressCustodyProof(
        lineage([provenSource, { ...provenSource, ref: 'wiki:doc-3', classified: false }]),
        `turn:${TURN_ID}`,
      ),
    })).toBe('unclassified_source');
    // The fold succeeded but the durable write did not: proof exists in memory
    // and nowhere else, which is exactly what this bead refuses to release on.
    expect(evaluateEgressCustodyHold({
      destination: outward,
      proof: turnEgressCustodyProof(lineage([provenSource]), undefined),
    })).toBe('custody_snapshot_missing');
  });

  it('separates a fold that is still pending from one that produced no snapshot', () => {
    // A model-invoked egress runs INSIDE the turn, and the custody snapshot is
    // folded only after the tool loop returns — so "no ref yet" is the normal
    // in-turn state, not a broken chain. Only an in-turn caller may say so.
    const outward = { kind: 'public_room' as const, channelId: 'discord:room-1' };
    const unfolded = turnEgressCustodyProof(lineage([provenSource]), undefined);
    expect(evaluateEgressCustodyHold({ destination: outward, proof: unfolded }))
      .toBe('custody_snapshot_missing');
    expect(evaluateEgressCustodyHold({
      destination: outward,
      proof: unfolded,
      custodySnapshotPending: true,
    })).toBeNull();
  });

  it('relaxes nothing but durability when the fold is pending', () => {
    // The pending branch is deliberately LAST: every provenance condition the
    // disclosure layer already enforces still fires mid-turn.
    const outward = { kind: 'public_room' as const, channelId: 'discord:room-1' };
    expect(evaluateEgressCustodyHold({
      destination: outward,
      proof: undefined,
      custodySnapshotPending: true,
    })).toBe('lineage_missing');
    expect(evaluateEgressCustodyHold({
      destination: outward,
      proof: turnEgressCustodyProof(lineage([]), undefined),
      custodySnapshotPending: true,
    })).toBe('no_admitted_source');
    expect(evaluateEgressCustodyHold({
      destination: outward,
      proof: turnEgressCustodyProof(
        lineage([provenSource, { ...provenSource, ref: 'wiki:doc-3', classified: false }]),
        undefined,
      ),
      custodySnapshotPending: true,
    })).toBe('unclassified_source');
  });

  it('forces the proof requirement when the caller knows the egress is outward', () => {
    // An artifact share past its self/primary-contact return is outward by
    // audience even when the channel does not classify into a room kind.
    expect(evaluateEgressCustodyHold({
      destination: null,
      proof: undefined,
      requiresProof: true,
    })).toBe('lineage_missing');
  });

  it('marks only the custody-durability reasons as this bead\'s new enforcement', () => {
    expect(isCustodyDurabilityHoldReason('custody_snapshot_missing')).toBe(true);
    expect(isCustodyDurabilityHoldReason('custody_store_unavailable')).toBe(true);
    // Already denied unconditionally by assessDisclosure; never posture-relaxed.
    expect(isCustodyDurabilityHoldReason('no_admitted_source')).toBe(false);
    expect(isCustodyDurabilityHoldReason('unclassified_source')).toBe(false);
    expect(isCustodyDurabilityHoldReason('lineage_missing')).toBe(false);
  });
});

describe('EgressDeliveryRecord', () => {
  it('keys on existing identifiers only, and separates two egresses of one turn', () => {
    const first = recordOf();
    const second = recordOf({ attempt: custodyIdentity('tool-call-2') });
    expect(first.deliveryRef).toBe(`turn:${TURN_ID}#${custodySha256('tool-call-1')}`);
    expect(second.deliveryRef).not.toBe(first.deliveryRef);
    // Both still resolve to the same turn and the same custody snapshot.
    expect(second.generationContextRef).toBe(first.generationContextRef);
    expect(second.custodySnapshotRef).toBe(first.custodySnapshotRef);
  });

  it('treats a re-recorded attempt at a new instant as identical content', () => {
    expect(egressDeliveryRecordContentDigest(recordOf({ recordedAtMs: NOW_MS + 60_000 })))
      .toBe(egressDeliveryRecordContentDigest(recordOf()));
  });

  it('refuses a hold with no stated reason', () => {
    expect(() => recordOf({ disposition: 'held', decisionAllowed: false }))
      .toThrow(/holdReason is required when the disposition is held/u);
  });

  it('carries a pending fold as a typed state that resolves through its own turn', () => {
    const pending = recordOf({
      custodySnapshot: 'pending',
      custodySnapshotRef: undefined,
    });
    expect(pending.custodySnapshot).toBe('pending');
    expect(pending.custodySnapshotRef).toBeUndefined();
    // The row still names the generation whose snapshot will prove it.
    expect(pending.generationContextRef).toBe(`turn:${TURN_ID}`);
    expect(validateEgressDeliveryRecord(JSON.parse(JSON.stringify(pending)))).toEqual(pending);
  });

  it('refuses a row that both cites a written snapshot and claims a pending one', () => {
    expect(() => recordOf({ custodySnapshot: 'pending' }))
      .toThrow(/custodySnapshot must be absent/u);
  });

  it('refuses an unknown custody snapshot state', () => {
    expect(() => recordOf({
      custodySnapshotRef: undefined,
      custodySnapshot: 'folded' as never,
    })).toThrow(/custodySnapshot must be a known/u);
  });

  it('refuses a delivery that cites another turn\'s custody proof', () => {
    expect(() => recordOf({ custodySnapshotRef: 'turn:some-other-turn' }))
      .toThrow(/custodySnapshotRef must equal the generation context ref/u);
  });

  it('refuses a key that does not compose from the record\'s own identifiers', () => {
    expect(() => validateEgressDeliveryRecord({
      ...recordOf(),
      deliveryRef: `turn:${TURN_ID}#deadbeef`,
    })).toThrow(/deliveryRef must be/u);
  });

  it('carries no body text: every field is an id, hash, count, label, or instant', () => {
    // The record is built from bytes and refs that DO contain a secret; the
    // serialized row must contain none of it, in whole or in fragments.
    const record = recordOf({
      contentSha256: egressContentSha256(SECRET_BODY),
      attempt: custodyIdentity(SECRET_BODY),
      destination: egressDeliveryDestination({ kind: 'contact_dm', contactId: SECRET_BODY }),
      triggerEventRef: custodyIdentity(SECRET_BODY),
    });
    const serialized = JSON.stringify(record);
    for (const fragment of ['bank', 'PIN', '4417', 'notes.md', '/home/vega']) {
      expect(serialized).not.toContain(fragment);
    }
    // The digests are present and are the join keys.
    expect(serialized).toContain(custodySha256(SECRET_BODY));
    expect(record.attempt.id).toBeUndefined();
    expect(record.destination?.ref?.id).toBeUndefined();
  });

  it('retains a literal id only when it is a bounded safe token', () => {
    const record = recordOf({
      destination: egressDeliveryDestination({ kind: 'contact_dm', contactId: 'contact-42' }),
    });
    expect(record.destination?.ref?.id).toBe('contact-42');
    expect(record.destination?.ref?.digest).toBe(custodySha256('contact-42'));
  });

  it('re-validates on read, so an edited row is a load failure', () => {
    const tampered = { ...recordOf(), sourceCount: -1 };
    expect(() => validateEgressDeliveryRecord(tampered))
      .toThrow(/sourceCount must be a non-negative safe integer/u);
  });
});
