// Content-free proof for the durable custody snapshot (psfn-framework-ccgdz.1).
// The load-bearing assertion is negative: no matter what a runtime ref, channel
// id, or request id contains, no body text can reach a stored field.

import { describe, expect, it } from 'vitest';

import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
} from './decision.js';
import { DISCLOSURE_CLASSIFIER_VERSION } from './generation-lineage.js';
import { custodySha256 } from './custody-identity.js';
import {
  buildCustodySnapshot,
  custodySnapshotContentDigest,
  custodySnapshotRefForTurn,
  validateCustodySnapshot,
} from './custody-snapshot.js';
import type { ToolResultCustodyEdge } from '../../../shared/contracts/tool-result-custody.js';
import type { DisclosureLineage, DisclosureSourceContribution } from './contracts.js';

const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const REQUEST_ID = 'msg-01936f2c4a1b';
const CLASSIFIED_AT = '2026-09-07T12:00:00.000Z';
const CLASSIFIED_AT_MS = Date.parse(CLASSIFIED_AT);

/** A message body a careless ref could smuggle: prose, a path, and a newline. */
const SECRET_BODY = "my bank PIN is 4417\nsee /home/vega/private/notes.md — don't share";

function lineageOf(sources: readonly DisclosureSourceContribution[]): DisclosureLineage {
  let lineage = beginDisclosureAccumulation({
    generationContextRef: custodySnapshotRefForTurn(TURN_ID),
    classifierVersion: DISCLOSURE_CLASSIFIER_VERSION,
    classifiedAt: CLASSIFIED_AT,
  });
  for (const source of sources) lineage = accumulateDisclosureSource(lineage, source);
  return lineage;
}

const sessionSource: DisclosureSourceContribution = {
  ref: 'session:dm:contact-42',
  sensitivity: 'personal',
  permittedDestinations: [{ kind: 'contact_dm', contactIds: ['contact-42'] }],
  subjectContactIds: ['contact-42'],
  sourceChannelId: 'discord:1234567890',
  classified: true,
};

describe('buildCustodySnapshot', () => {
  it('serializes a folded lineage under the lineage key without minting an id', () => {
    const snapshot = buildCustodySnapshot({
      lineage: lineageOf([sessionSource]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
    });
    expect(snapshot.generationContextRef).toBe(`turn:${TURN_ID}`);
    expect(snapshot.turnId).toBe(TURN_ID);
    expect(snapshot.classifiedAtMs).toBe(CLASSIFIED_AT_MS);
    expect(snapshot.sourceCount).toBe(1);
    expect(snapshot.hasUnclassifiedSource).toBe(false);
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]).toMatchObject({
      kind: 'session',
      sensitivity: 'personal',
      classified: true,
      permittedDestinationKinds: ['contact_dm'],
      subjectContactCount: 1,
    });
    expect(snapshot.sources[0]?.ref.id).toBe('session:dm:contact-42');
  });

  it('records a turn with no admitted source as exactly that, not as an absent record', () => {
    const snapshot = buildCustodySnapshot({
      lineage: lineageOf([]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
    });
    expect(snapshot.sourceCount).toBe(0);
    expect(snapshot.sources).toEqual([]);
    expect(validateCustodySnapshot(snapshot)).toEqual(snapshot);
  });

  it('refuses a lineage whose generation context is not this turn', () => {
    expect(() => buildCustodySnapshot({
      lineage: lineageOf([sessionSource]),
      turnId: '01936f2c-4a1b-7c3d-8e5f-ffffffffffff',
      requestId: REQUEST_ID,
    })).toThrow(/does not match turn/);
  });

  it('binds a tool-result edge to the exact lineage ref it was keyed by', () => {
    const edge: ToolResultCustodyEdge = {
      envelopeId: '01936f2c-0000-7000-8000-00000000aaaa',
      contentSha256: custodySha256('tool result the model saw'),
    };
    const snapshot = buildCustodySnapshot({
      lineage: lineageOf([sessionSource, {
        ref: 'tool:wiki_read:call_abc123',
        sensitivity: 'confidential',
        permittedDestinations: [],
        classified: true,
      }]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      toolResultEdges: new Map([['tool:wiki_read:call_abc123', edge]]),
    });
    const toolSource = snapshot.sources.find(source => source.kind === 'tool');
    expect(toolSource?.toolResult).toEqual(edge);
    // The edge never lands on a source it was not keyed to.
    expect(snapshot.sources.find(source => source.kind === 'session')?.toolResult)
      .toBeUndefined();
  });
});

describe('custody snapshot content-free discipline', () => {
  it('never stores an unsafe ref, channel id, or request id verbatim', () => {
    const snapshot = buildCustodySnapshot({
      lineage: lineageOf([{
        ref: `wiki:${SECRET_BODY}`,
        sensitivity: 'confidential',
        permittedDestinations: [],
        sourceChannelId: SECRET_BODY,
        classified: false,
      }]),
      turnId: TURN_ID,
      requestId: SECRET_BODY,
    });
    const serialized = JSON.stringify(snapshot);
    for (const fragment of ['bank PIN', '4417', '/home/vega/private', "don't share"]) {
      expect(serialized).not.toContain(fragment);
    }
    // The identity is still recorded — as a join key, not as content.
    expect(snapshot.sources[0]?.ref).toEqual({ digest: custodySha256(`wiki:${SECRET_BODY}`) });
    expect(snapshot.sources[0]?.ref.id).toBeUndefined();
    expect(snapshot.requestId).toEqual({ digest: custodySha256(SECRET_BODY) });
    expect(snapshot.sources[0]?.classified).toBe(false);
    expect(snapshot.hasUnclassifiedSource).toBe(true);
  });

  it('collapses an unknown ref prefix to the closed vocabulary rather than widening it', () => {
    const snapshot = buildCustodySnapshot({
      lineage: lineageOf([{
        ref: 'exfil-channel:something-new',
        sensitivity: 'public',
        permittedDestinations: [],
        classified: true,
      }]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
    });
    expect(snapshot.sources[0]?.kind).toBe('other');
  });

  it('rejects a bounded token that is not what its digest says it is', () => {
    const snapshot = buildCustodySnapshot({
      lineage: lineageOf([sessionSource]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
    });
    expect(() => validateCustodySnapshot({
      ...snapshot,
      requestId: { digest: custodySha256('other'), id: REQUEST_ID },
    })).toThrow(/does not match its digest/);
  });

  it('rejects a stored row whose ref id was rewritten into free text', () => {
    const snapshot = buildCustodySnapshot({
      lineage: lineageOf([sessionSource]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
    });
    expect(() => validateCustodySnapshot({
      ...snapshot,
      sources: [{
        ...snapshot.sources[0],
        ref: { digest: custodySha256(SECRET_BODY), id: SECRET_BODY },
      }],
    })).toThrow(/must be a bounded safe identifier/);
  });
});

describe('custodySnapshotContentDigest', () => {
  it('ignores the fold instant so a re-fold of the same context is not a divergence', () => {
    const first = buildCustodySnapshot({
      lineage: lineageOf([sessionSource]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
    });
    const replayed = buildCustodySnapshot({
      lineage: lineageOf([sessionSource]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      classifiedAtMs: CLASSIFIED_AT_MS + 60_000,
    });
    expect(replayed.classifiedAtMs).not.toBe(first.classifiedAtMs);
    expect(custodySnapshotContentDigest(replayed)).toBe(custodySnapshotContentDigest(first));
  });

  it('changes when the admitted source set changes', () => {
    const withOne = buildCustodySnapshot({
      lineage: lineageOf([sessionSource]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
    });
    const withTwo = buildCustodySnapshot({
      lineage: lineageOf([sessionSource, {
        ref: 'memory:mem-7',
        sensitivity: 'intimate',
        permittedDestinations: [],
        classified: true,
      }]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
    });
    expect(custodySnapshotContentDigest(withTwo))
      .not.toBe(custodySnapshotContentDigest(withOne));
  });
});
