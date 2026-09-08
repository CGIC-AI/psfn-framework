// Garden custody query service proof (psfn-framework-ccgdz.7): the query input
// is itself content-free, the companion boundary is enforced in the predicate
// handed to the reader rather than after the fact, and a long history returns
// one bounded page plus a cursor.

import { describe, expect, it } from 'vitest';

import type {
  CustodyChainDeliveryList,
  CustodyChainDeliveryReadPort,
  CustodyChainGenerationMatch,
  CustodyChainResolution,
  CustodyChainSnapshotReadPort,
} from '../../../core/cogsec/disclosure/custody-chain-query.js';
import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
} from '../../../core/cogsec/disclosure/decision.js';
import { custodyIdentity } from '../../../core/cogsec/disclosure/custody-identity.js';
import {
  buildCustodySnapshot,
  custodySnapshotRefForTurn,
  type CustodySnapshot,
} from '../../../core/cogsec/disclosure/custody-snapshot.js';
import {
  egressContentSha256,
  egressDeliveryRef,
  validateEgressDeliveryRecord,
  type EgressDeliveryRecord,
} from '../../../core/cogsec/disclosure/egress-delivery-record.js';
import type { ContextSourceManifest } from '../../../core/cogsec/disclosure/context-source-manifest.js';
import type { HealthEventOwner } from '../../../shared/contracts/health-event.js';
import type { GardenRequestContext } from '../garden-request-context.js';
import {
  CustodyQueryInputError,
  GardenCustodyQueryService,
} from './custody-query-service.js';

const COMPANION_ID = '3f2a1c88-5d4e-4a7b-9c3d-1e2f3a4b5c6d';
const OTHER_COMPANION_ID = '9b8a7c66-1d2e-4f3a-8b7c-6d5e4f3a2b1c';
const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const NOW_MS = 1_800_000_000_000;
const SECRET_BODY = "my bank PIN is 4417\nsee /home/vega/private/notes.md";

function snapshotFor(turnId: string): CustodySnapshot {
  let lineage = beginDisclosureAccumulation({
    generationContextRef: custodySnapshotRefForTurn(turnId),
    classifierVersion: 'disclosure/v1',
    classifiedAt: new Date(NOW_MS).toISOString(),
  });
  lineage = accumulateDisclosureSource(lineage, {
    ref: 'memory:mem-7',
    sensitivity: 'personal',
    permittedDestinations: [],
    classified: true,
  });
  return buildCustodySnapshot({ lineage, turnId, requestId: 'msg-1' });
}

function deliveryFor(
  turnId: string,
  owner: HealthEventOwner,
  attemptRef = 'tool-call-1',
): EgressDeliveryRecord {
  const attempt = custodyIdentity(attemptRef);
  return validateEgressDeliveryRecord({
    schemaVersion: 1,
    deliveryRef: egressDeliveryRef(custodySnapshotRefForTurn(turnId), attempt),
    generationContextRef: custodySnapshotRefForTurn(turnId),
    turnId,
    owner,
    surface: 'tool_egress',
    disposition: 'released',
    enforcementPosture: 'enforce',
    attempt,
    contentSha256: egressContentSha256('hello room'),
    outcome: 'auto_shareable',
    decisionAllowed: true,
    custodySnapshotRef: custodySnapshotRefForTurn(turnId),
    sourceCount: 1,
    hasUnclassifiedSource: false,
    effectiveSensitivity: 'personal',
    recordedAtMs: NOW_MS,
  });
}

interface RecordedOwnerFilter {
  readonly owner: HealthEventOwner;
  readonly generationContextRefs: readonly string[];
}

function stubReader(options: {
  snapshots?: ReadonlyMap<string, CustodyChainResolution<CustodySnapshot>>;
  matches?: readonly CustodyChainGenerationMatch[];
  deliveries?: readonly EgressDeliveryRecord[];
  resolvedDelivery?: CustodyChainResolution<EgressDeliveryRecord>;
  ownerFilters?: RecordedOwnerFilter[];
  pageRequests?: { limit: number; beforeTurnId?: string }[];
} = {}): CustodyChainSnapshotReadPort & CustodyChainDeliveryReadPort {
  return {
    resolveSnapshot: (ref) => Promise.resolve(
      options.snapshots?.get(ref) ?? { status: 'absent' },
    ),
    resolveContextManifest: (): Promise<CustodyChainResolution<ContextSourceManifest>> =>
      Promise.resolve({ status: 'absent' }),
    listGenerationsBySourceDigest: (input) => {
      options.pageRequests?.push({
        limit: input.limit,
        ...(input.beforeTurnId !== undefined ? { beforeTurnId: input.beforeTurnId } : {}),
      });
      return Promise.resolve((options.matches ?? []).slice(0, input.limit));
    },
    resolveDelivery: () => Promise.resolve(
      options.resolvedDelivery ?? { status: 'absent' },
    ),
    listDeliveriesForGenerations: (input): Promise<CustodyChainDeliveryList> => {
      options.ownerFilters?.push({
        owner: input.owner,
        generationContextRefs: input.generationContextRefs,
      });
      const records = (options.deliveries ?? []).filter(
        record => input.generationContextRefs.includes(record.generationContextRef),
      );
      return Promise.resolve({ records, malformedCount: 0 });
    },
  };
}

function serviceOver(
  reader: CustodyChainSnapshotReadPort & CustodyChainDeliveryReadPort,
  companionId: string | undefined = COMPANION_ID,
): GardenCustodyQueryService {
  return new GardenCustodyQueryService({
    snapshots: reader,
    deliveries: reader,
    companionId,
  });
}

function fleetContext(companionId: string | null): GardenRequestContext {
  return {
    kind: 'fleet_principal',
    resource: {
      routeId: 'GET /api/admin/custody/chain',
      scope: 'personal_workspace',
      area: 'cognitive_security',
      companionId,
      pathParams: {},
      query: {},
    },
  } as unknown as GardenRequestContext;
}

describe('GardenCustodyQueryService input discipline', () => {
  it('refuses a source reference that is not a bounded identifier', async () => {
    const service = serviceOver(stubReader());
    await expect(service.querySourceEgresses(
      new URLSearchParams({ sourceRef: SECRET_BODY }),
    )).rejects.toBeInstanceOf(CustodyQueryInputError);
  });

  it('refuses a turn id that is not a bounded identifier', async () => {
    const service = serviceOver(stubReader());
    await expect(service.queryEgressChain(
      new URLSearchParams({ turnId: SECRET_BODY }),
    )).rejects.toBeInstanceOf(CustodyQueryInputError);
  });

  it('requires exactly one addressing parameter in each direction', async () => {
    const service = serviceOver(stubReader());
    await expect(service.queryEgressChain(new URLSearchParams()))
      .rejects.toThrow(/exactly one of turnId or deliveryRef/u);
    await expect(service.queryEgressChain(new URLSearchParams({
      turnId: TURN_ID,
      deliveryRef: `turn:${TURN_ID}#${'a'.repeat(64)}`,
    }))).rejects.toThrow(/exactly one of turnId or deliveryRef/u);
    await expect(service.querySourceEgresses(new URLSearchParams()))
      .rejects.toThrow(/exactly one of sourceRef or sourceDigest/u);
  });

  it('refuses a repeated parameter rather than silently taking the first', async () => {
    const service = serviceOver(stubReader());
    const params = new URLSearchParams();
    params.append('turnId', TURN_ID);
    params.append('turnId', 'another-turn');
    await expect(service.queryEgressChain(params)).rejects.toThrow(/single value/u);
  });

  it('bounds the page size and refuses a cursor it did not mint', async () => {
    const service = serviceOver(stubReader());
    await expect(service.querySourceEgresses(
      new URLSearchParams({ sourceRef: 'memory:mem-7', limit: '1000' }),
    )).rejects.toThrow(/between 1 and 100/u);
    await expect(service.querySourceEgresses(
      new URLSearchParams({ sourceRef: 'memory:mem-7', cursor: SECRET_BODY }),
    )).rejects.toThrow(/page cursor/u);
  });

  it('hashes a bounded reference into the same digest the write side stored', async () => {
    const matches: CustodyChainGenerationMatch[] = [];
    const captured: { limit: number; beforeTurnId?: string }[] = [];
    const reader = stubReader({ matches, pageRequests: captured });
    let observedDigest = '';
    const wrapped: CustodyChainSnapshotReadPort & CustodyChainDeliveryReadPort = {
      ...reader,
      listGenerationsBySourceDigest: (input) => {
        observedDigest = input.sourceDigest;
        return reader.listGenerationsBySourceDigest(input);
      },
    };
    await serviceOver(wrapped).querySourceEgresses(
      new URLSearchParams({ sourceRef: 'memory:mem-7' }),
    );
    expect(observedDigest).toBe(custodyIdentity('memory:mem-7').digest);
  });
});

describe('GardenCustodyQueryService companion boundary', () => {
  it('asks the reader only for rows owned by its own companion', async () => {
    const ownerFilters: RecordedOwnerFilter[] = [];
    const service = serviceOver(stubReader({
      snapshots: new Map([[custodySnapshotRefForTurn(TURN_ID), {
        status: 'present' as const, record: snapshotFor(TURN_ID),
      }]]),
      deliveries: [deliveryFor(TURN_ID, { kind: 'companion', companionId: COMPANION_ID })],
      ownerFilters,
    }));
    const view = await service.queryEgressChain(new URLSearchParams({ turnId: TURN_ID }));
    expect(ownerFilters).toEqual([{
      owner: { kind: 'companion', companionId: COMPANION_ID },
      generationContextRefs: [custodySnapshotRefForTurn(TURN_ID)],
    }]);
    expect(view.deliveryCount).toBe(1);
  });

  it('refuses a delivery ref owned by another companion', async () => {
    const attempt = custodyIdentity('tool-call-1');
    const service = serviceOver(stubReader({
      resolvedDelivery: {
        status: 'present',
        record: deliveryFor(TURN_ID, {
          kind: 'companion', companionId: OTHER_COMPANION_ID,
        }),
      },
    }));
    await expect(service.queryEgressChain(new URLSearchParams({
      deliveryRef: egressDeliveryRef(custodySnapshotRefForTurn(TURN_ID), attempt),
    }))).rejects.toThrow(/not owned by this companion/u);
  });

  it('refuses a delivery ref whose record is absent (8nq3h)', async () => {
    const attempt = custodyIdentity('tool-call-1');
    // The stub's default resolution is `absent`; before 8nq3h this fell through
    // the ownership guard and answered from the client-supplied ref text.
    const service = serviceOver(stubReader());
    await expect(service.queryEgressChain(new URLSearchParams({
      deliveryRef: egressDeliveryRef(custodySnapshotRefForTurn(TURN_ID), attempt),
    }))).rejects.toThrow(/not owned by this companion/u);
  });

  it('refuses a delivery ref whose record is malformed (8nq3h)', async () => {
    const attempt = custodyIdentity('tool-call-1');
    const service = serviceOver(stubReader({
      resolvedDelivery: { status: 'malformed' },
    }));
    await expect(service.queryEgressChain(new URLSearchParams({
      deliveryRef: egressDeliveryRef(custodySnapshotRefForTurn(TURN_ID), attempt),
    }))).rejects.toThrow(/not owned by this companion/u);
  });

  it('answers an owned delivery ref from the stored record, not the ref text', async () => {
    const attempt = custodyIdentity('tool-call-1');
    const service = serviceOver(stubReader({
      resolvedDelivery: {
        status: 'present',
        record: deliveryFor(TURN_ID, { kind: 'companion', companionId: COMPANION_ID }),
      },
      snapshots: new Map([[custodySnapshotRefForTurn(TURN_ID), {
        status: 'present' as const, record: snapshotFor(TURN_ID),
      }]]),
    }));
    const view = await service.queryEgressChain(new URLSearchParams({
      deliveryRef: egressDeliveryRef(custodySnapshotRefForTurn(TURN_ID), attempt),
    }));
    expect(view.turnId).toBe(TURN_ID);
    expect(view.snapshotStatus).toBe('present');
  });

  it('refuses a fleet request that names a different companion', async () => {
    const service = serviceOver(stubReader());
    await expect(service.queryEgressChain(
      new URLSearchParams({ turnId: TURN_ID }),
      fleetContext(OTHER_COMPANION_ID),
    )).rejects.toThrow();
  });

  it('serves a fleet request that names its own companion', async () => {
    const service = serviceOver(stubReader());
    const view = await service.queryEgressChain(
      new URLSearchParams({ turnId: TURN_ID }),
      fleetContext(COMPANION_ID),
    );
    expect(view.turnId).toBe(TURN_ID);
    expect(view.snapshotStatus).toBe('absent');
  });
});

describe('GardenCustodyQueryService paging', () => {
  it('over-fetches by one to learn whether another page exists', async () => {
    const matches: CustodyChainGenerationMatch[] = Array.from(
      { length: 4 },
      (_unused, index): CustodyChainGenerationMatch => {
        const turnId = `${TURN_ID.slice(0, -1)}${String(index)}`;
        return {
          generationContextRef: custodySnapshotRefForTurn(turnId),
          turnId,
          classifiedAtMs: NOW_MS - index,
          snapshot: { status: 'present', record: snapshotFor(turnId) },
        };
      },
    );
    const pageRequests: { limit: number; beforeTurnId?: string }[] = [];
    const service = serviceOver(stubReader({ matches, pageRequests }));
    const view = await service.querySourceEgresses(
      new URLSearchParams({ sourceRef: 'memory:mem-7', limit: '2' }),
    );
    expect(pageRequests[0]?.limit).toBe(3);
    expect(view.generationCount).toBe(2);
    expect(view.page.hasMore).toBe(true);
    expect(view.page.nextCursor).toBeDefined();

    // The cursor the first page emitted is accepted verbatim on the next call.
    await service.querySourceEgresses(new URLSearchParams({
      sourceRef: 'memory:mem-7',
      limit: '2',
      cursor: view.page.nextCursor ?? '',
    }));
    expect(pageRequests[1]?.beforeTurnId).toBe(view.generations[1]?.turnId);
  });
});
