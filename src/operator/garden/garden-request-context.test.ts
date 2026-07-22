import { describe, expect, it, vi } from 'vitest';
import type {
  MemorySubjectAdminQuery,
  MemorySubjectAdminResult,
  MemorySubjectAuthorizedQuery,
  MemoryStorePort,
} from '../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../faculties/memory/types.js';

const ADMIN_PRIVACY_ZERO = {
  activeMemoryCount: 0,
  highSensitivityCount: 0,
  consentGatedCount: 0,
  contactLinkedCount: 0,
  scopedCount: 0,
  preferenceCount: 0,
  durablePreferenceCount: 0,
  sensitivityCounts: {},
} as const;

function adminAggregateFromMemories(
  input: MemorySubjectAdminQuery,
  pageMemories: readonly (PurrMemory & { similarity: number })[],
): MemorySubjectAdminResult {
  switch (input.selector.kind) {
    case 'privacy_summary':
      return { kind: 'privacy_summary', privacySummary: { ...ADMIN_PRIVACY_ZERO } };
    case 'stats':
      return { kind: 'stats', stats: { total: 0, byType: {}, avgSalience: 0 } };
    default:
      return { kind: 'memories', memories: [...pageMemories], total: pageMemories.length };
  }
}
import { AdminMemoryDataService } from './services/memory-service.js';
import {
  gardenRequestServiceBoundaryDenial,
  type FleetGardenRequestContext,
} from './garden-request-context.js';
import type { MemorySubjectClassification } from '../../shared/contracts/memory-subject.js';

function memory(contactId: string): PurrMemory {
  return {
    id: `memory-${contactId}`,
    text: `safe memory for ${contactId}`,
    type: 'semantic',
    importance: 0.5,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: `test:${contactId}`,
    extractedAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    contactId,
    provenance: { subjectContactId: contactId },
  };
}

function context(
  principalId: string,
  contactId: string,
  overrides: Partial<Pick<FleetGardenRequestContext, 'action' | 'subjectRelation' | 'expiresAt'>> & {
    routeId?: string;
    area?: 'memory' | 'sessions';
    pathParams?: Readonly<Record<string, string>>;
    assurance?: FleetGardenRequestContext['actor']['sessionAssurance'];
    role?: FleetGardenRequestContext['actor']['role'];
  } = {},
): FleetGardenRequestContext {
  const area = overrides.area ?? 'memory';
  const authorization = Object.freeze({
    action: overrides.action ?? 'memory.read.self',
    baseRole: 'member' as const,
    resource: Object.freeze({ scope: 'personal_workspace' as const, area }),
    subjectRelation: overrides.subjectRelation ?? 'self_or_co_subject',
    requirements: Object.freeze({
      assurance: 'oauth' as const,
      confirmation: 'none' as const,
      approvals: Object.freeze([]),
    }),
    publicAccess: 'never' as const,
    recoveryAccess: 'forbidden' as const,
  });
  return Object.freeze({
    kind: 'fleet_principal',
    requestId: `${principalId === 'principal-a' ? 'aaaaaaaa' : 'bbbbbbbb'}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    decisionId: `${principalId === 'principal-a' ? 'cccccccc' : 'dddddddd'}-dddd-4ddd-8ddd-dddddddddddd`,
    authorizationEventId: `event-${principalId}`,
    resolvedAt: '2030-01-01T00:00:00.000Z',
    versions: Object.freeze({
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      sessionAuthnVersion: 1,
      sessionAuthzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    }),
    issuedAt: 1,
    expiresAt: overrides.expiresAt ?? 2,
    actor: Object.freeze({
      kind: 'fleet_principal',
      principalId,
      provider: 'discord',
      providerSubjectId: `provider-${principalId}`,
      contactId,
      contactBindingId: `binding-${principalId}`,
      role: overrides.role ?? 'member',
      operatorGrantId: `grant-${principalId}`,
      sessionRecordId: `session-${principalId}`,
      sessionAssurance: overrides.assurance ?? 'oauth',
    }),
    action: overrides.action ?? 'memory.read.self',
    resource: Object.freeze({
      routeId: overrides.routeId ?? 'GET /api/admin/memory',
      scope: 'personal_workspace',
      area,
      companionId: '11111111-1111-4111-8111-111111111111',
      pathParams: Object.freeze({ ...(overrides.pathParams ?? {}) }),
      query: Object.freeze({}),
    }),
    subjectRelation: overrides.subjectRelation ?? 'self_or_co_subject',
    authorization,
  });
}

describe('request-bound Garden principal isolation', () => {
  it('keeps parallel memory subjects exact without a mutable current-context seam', async () => {
    const queryAuthorizedMemorySubjects = vi.fn(async (input: MemorySubjectAuthorizedQuery) => {
      await new Promise(resolve => setImmediate(resolve));
      const contactId = input.authorization.viewerContactIds[0]!;
      const memories = [memory(contactId)];
      return { memories, total: memories.length };
    });
    const aggregateAuthorizedMemorySubjects = vi.fn(async (input: MemorySubjectAdminQuery) => {
      await new Promise(resolve => setImmediate(resolve));
      const contactId = input.authorization.viewerContactIds[0]!;
      return adminAggregateFromMemories(input, [{ ...memory(contactId), similarity: 1 }]);
    });
    const rawStore = {
      queryAuthorizedMemorySubjects,
      aggregateAuthorizedMemorySubjects,
    } as unknown as MemoryStorePort;
    rawStore.getMemorySubjectClassification = vi.fn(async memoryId => {
      const contactId = memoryId.replace(/^memory-/u, '');
      return {
        memoryId,
        subjectClass: 'single_contact',
        status: 'current',
        classifierVersion: 1,
        memoryRevision: 1,
        evidenceDigest: 'a'.repeat(64),
        evidence: ['explicit_subject_contact'],
        subjectContactIds: [contactId],
        reasonClass: 'explicit_subject_contact',
        classifiedAt: 1,
        updatedAt: 1,
      };
    });
    const service = new AdminMemoryDataService({
      memoryStore: rawStore,
      fleetMemoryStore: rawStore,
    });
    const principalA = context('principal-a', 'contact-a');
    const principalB = context('principal-b', 'contact-b');

    const [resultA, resultB] = await Promise.all([
      service.forRequest(principalA).listMemories(),
      service.forRequest(principalB).listMemories(),
    ]);

    expect(resultA.memories.map(item => item.contactId)).toEqual(['contact-a']);
    expect(resultB.memories.map(item => item.contactId)).toEqual(['contact-b']);
    // Admin listing now flows through the subject-authorized SQL aggregate (a27w.5).
    expect(aggregateAuthorizedMemorySubjects.mock.calls
      .filter(([input]) => input.selector.kind === 'admin_page')
      .map(([input]) => input.authorization.viewerContactIds))
      .toEqual(expect.arrayContaining([['contact-a'], ['contact-b']]));
    expect(Object.isFrozen(principalA)).toBe(true);
    expect(Object.isFrozen(principalA.actor)).toBe(true);
  });

  it('keeps strong JIT and non-subject relations fail closed', () => {
    const rawStore = {
      queryAuthorizedMemorySubjects: vi.fn(async () => ({ memories: [], total: 0 })),
    } as unknown as MemoryStorePort;
    const service = new AdminMemoryDataService({ memoryStore: rawStore, fleetMemoryStore: rawStore });
    const jit = context('principal-a', 'contact-a', { action: 'memory.jit.self', subjectRelation: 'self' });
    expect(() => service.forRequest(jit).elevateBodyAccess()).toThrow(/JIT is unavailable/u);
    expect(() => service.forRequest(context('principal-a', 'contact-a', {
      subjectRelation: 'current_companion',
    }))).toThrow(/exact request-local subject relation/u);
  });

  it('admits only subject-bound session routes to the session projection', () => {
    const subjectBoundList = context('principal-a', 'contact-a', {
      action: 'sessions.read', area: 'sessions',
      subjectRelation: 'self_or_co_subject',
      routeId: 'GET /api/admin/sessions',
    });
    expect(gardenRequestServiceBoundaryDenial(subjectBoundList)).toBeNull();

    const subjectBoundTurn = context('principal-a', 'contact-a', {
      action: 'sessions.read', area: 'sessions',
      subjectRelation: 'self_or_co_subject',
      routeId: 'GET /api/admin/sessions/:channelId/turns/:turnId',
      pathParams: { channelId: 'api:session-1', turnId: 'turn-1' },
    });
    expect(gardenRequestServiceBoundaryDenial(subjectBoundTurn)).toBeNull();

    // A projected route id without an explicit request-local subject relation
    // must never reach the session service.
    const wrongRelation = context('principal-a', 'contact-a', {
      action: 'sessions.read', area: 'sessions',
      subjectRelation: 'current_companion',
      routeId: 'GET /api/admin/sessions',
    });
    expect(gardenRequestServiceBoundaryDenial(wrongRelation)).toMatch(/subject-bound/u);

    // Route recovery, CogSec, and session-recovery surfaces stay fail closed.
    const routeRecovery = context('principal-a', 'contact-a', {
      action: 'sessions.read', area: 'sessions',
      subjectRelation: 'current_companion',
      routeId: 'GET /api/admin/session-routes',
    });
    expect(gardenRequestServiceBoundaryDenial(routeRecovery)).toMatch(/subject-bound/u);

    const cogsecApply = context('principal-a', 'contact-a', {
      action: 'sessions.repair', area: 'sessions',
      subjectRelation: 'self_or_co_subject',
      routeId: 'POST /api/admin/session-routes/cogsec/apply',
      assurance: 'webauthn_uv',
    });
    expect(gardenRequestServiceBoundaryDenial(cogsecApply)).toMatch(/subject-bound/u);

    const recoveryPage = context('principal-a', 'contact-a', {
      action: 'recovery.begin', area: 'sessions',
      subjectRelation: 'none',
      routeId: 'GET /session-recovery',
    });
    expect(gardenRequestServiceBoundaryDenial(recoveryPage)).toMatch(/subject-bound/u);
  });

  it('admits subject-authorized episodic routes while group memory stays denied', () => {
    const episodicRouteIds = [
      'GET /api/admin/episodic-memory/episodes',
      'GET /api/admin/episodic-memory/episodes/:id',
      'GET /api/admin/episodic-memory/episodes/:id/arcs',
      'GET /api/admin/episodic-memory/episodes/:id/provenance',
      'GET /api/admin/episodic-memory/threads',
      'GET /api/admin/episodic-memory/threads/:threadId',
      'GET /episodic-memory',
      'HEAD /episodic-memory',
    ];
    for (const routeId of episodicRouteIds) {
      expect(gardenRequestServiceBoundaryDenial(context('principal-a', 'contact-a', { routeId })))
        .toBeNull();
    }

    const undeclaredEpisodicRoute = context('principal-a', 'contact-a', {
      routeId: 'GET /api/admin/episodic-memory/future-unscoped-view',
    });
    expect(gardenRequestServiceBoundaryDenial(undeclaredEpisodicRoute))
      .toMatch(/subject-authorized/u);

    const episodicWithoutSubject = context('principal-a', 'contact-a', {
      subjectRelation: 'none',
      routeId: 'GET /api/admin/episodic-memory/episodes',
    });
    expect(gardenRequestServiceBoundaryDenial(episodicWithoutSubject))
      .toMatch(/subject-authorized/u);

    const groupMemory = context('principal-a', 'contact-a', {
      routeId: 'GET /api/admin/group-memory',
    });
    expect(gardenRequestServiceBoundaryDenial(groupMemory)).toMatch(/subject-authorized/u);

    const shardReview = context('principal-a', 'contact-a', {
      action: 'memory.manage',
      routeId: 'POST /api/admin/shards/:shardId/review',
      pathParams: { shardId: 'shard-1' },
      assurance: 'webauthn_uv',
    });
    expect(gardenRequestServiceBoundaryDenial(shardReview)).toMatch(/subject-authorized/u);
  });

  it('admits only the declared privacy break-glass memory routes to their gated service', () => {
    const confirm = context('principal-a', 'contact-a', {
      action: 'privacy.break_glass',
      subjectRelation: 'none',
      routeId: 'POST /api/admin/privacy-break-glass/memory/:id/confirm',
      pathParams: { id: 'memory-b' },
      assurance: 'break_glass',
      role: 'admin',
    });
    expect(gardenRequestServiceBoundaryDenial(confirm)).toBeNull();
    const undeclared = context('principal-a', 'contact-a', {
      action: 'privacy.break_glass',
      subjectRelation: 'none',
      routeId: 'POST /api/admin/privacy-break-glass/memory/:id/export',
      pathParams: { id: 'memory-b' },
      assurance: 'break_glass',
      role: 'admin',
    });
    expect(gardenRequestServiceBoundaryDenial(undeclared)).toMatch(/subject-authorized/u);
  });

  it('does not let an owner role bypass the routine subject SQL projection', async () => {
    const rawAdminList = vi.fn(() => {
      throw new Error('owner role must not reach the broad admin list');
    });
    const queryAuthorizedMemorySubjects = vi.fn(async () => ({ memories: [], total: 0 }));
    const aggregateAuthorizedMemorySubjects = vi.fn(async (input: MemorySubjectAdminQuery) => (
      adminAggregateFromMemories(input, [])
    ));
    const rawStore = {
      listAdminMemories: rawAdminList,
      queryAuthorizedMemorySubjects,
      aggregateAuthorizedMemorySubjects,
    } as unknown as MemoryStorePort;
    const service = new AdminMemoryDataService({ memoryStore: rawStore, fleetMemoryStore: rawStore });

    const result = await service.forRequest(context('principal-a', 'contact-a', { role: 'owner' }))
      .listMemories();

    expect(result.memories).toEqual([]);
    expect(result.pagination.total).toBe(0);
    // The owner-role listing is forced through the subject-authorized SQL aggregate
    // (a27w.5), never the raw admin list which would bypass the subject predicate.
    expect(aggregateAuthorizedMemorySubjects).toHaveBeenCalledWith(expect.objectContaining({
      authorization: expect.objectContaining({
        viewerContactIds: ['contact-a'],
        allowedSubjectClasses: ['single_contact'],
        allowedViewerRelations: ['self'],
      }),
      selector: expect.objectContaining({ kind: 'admin_page' }),
    }));
    expect(rawAdminList).not.toHaveBeenCalled();
  });

  it('fails closed across routine named-memory sensitivities for missing, stale, ambiguous, or non-subject projections', async () => {
    const sensitivities = ['public', 'personal', 'intimate', 'confidential'] as const;
    const memories = new Map(sensitivities.map(sensitivity => {
      const item = {
        ...memory('contact-a'),
        id: `memory-${sensitivity}`,
        sensitivity,
      };
      return [item.id, item] as const;
    }));
    const baseClassification = {
      subjectClass: 'single_contact' as const,
      status: 'current' as const,
      classifierVersion: 1,
      memoryRevision: 1,
      evidenceDigest: 'a'.repeat(64),
      evidence: ['explicit_subject_contact' as const],
      subjectContactIds: ['contact-a'],
      reasonClass: 'explicit_subject_contact',
      classifiedAt: 1,
      updatedAt: 1,
    };
    const classifications = new Map<string, MemorySubjectClassification>([
      ['memory-personal', {
        ...baseClassification,
        memoryId: 'memory-personal',
        classifierVersion: 2,
      }],
      ['memory-intimate', {
        ...baseClassification,
        memoryId: 'memory-intimate',
        subjectClass: 'ambiguous',
        reasonClass: 'contradictory_evidence',
      }],
      ['memory-confidential', {
        ...baseClassification,
        memoryId: 'memory-confidential',
        subjectContactIds: ['contact-other'],
      }],
    ]);
    const rawStore = {
      queryAuthorizedMemorySubjects: vi.fn(async (input: MemorySubjectAuthorizedQuery) => {
        const item = input.selector.kind === 'detail'
          ? memories.get(input.selector.memoryId)
          : undefined;
        return { memories: item ? [item] : [], total: item ? 1 : 0 };
      }),
      getMemorySubjectClassification: vi.fn(async memoryId => classifications.get(memoryId)),
    } as unknown as MemoryStorePort;
    const service = new AdminMemoryDataService({ memoryStore: rawStore, fleetMemoryStore: rawStore });
    const routine = service.forRequest(context('principal-a', 'contact-a'));

    for (const sensitivity of sensitivities) {
      await expect(routine.getMemoryDetail(`memory-${sensitivity}`))
        .rejects.toThrow(/subject projection|current proven single-contact subject/u);
    }
  });

  it('does not resolve links for a memory outside the signed subject', async () => {
    const getLinkedMemories = vi.fn(async () => [{
      id1: 'memory-contact-b',
      id2: 'memory-contact-c',
      linkType: 'supports',
    }]);
    const rawStore = {
      queryAuthorizedMemorySubjects: vi.fn(async (input: MemorySubjectAuthorizedQuery) => ({
        memories: input.selector.kind === 'detail' && input.selector.memoryId === 'memory-contact-a'
          ? [memory('contact-a')]
          : [],
        total: input.selector.kind === 'detail' && input.selector.memoryId === 'memory-contact-a'
          ? 1
          : 0,
      })),
      getLinkedMemories,
    } as unknown as MemoryStorePort;
    const service = new AdminMemoryDataService({ memoryStore: rawStore, fleetMemoryStore: rawStore });

    await expect(service.forRequest(context('principal-a', 'contact-a'))
      .getMemoryLinks('memory-contact-b')).resolves.toEqual([]);
    expect(getLinkedMemories).not.toHaveBeenCalled();
  });

  it('reveals one current intimate self memory only with the exact consumed UV JIT binding', async () => {
    const intimate = { ...memory('contact-a'), text: 'private body', sensitivity: 'intimate' as const };
    const classification: MemorySubjectClassification = {
      memoryId: intimate.id,
      subjectClass: 'single_contact',
      status: 'current',
      classifierVersion: 1,
      memoryRevision: 3,
      evidenceDigest: 'a'.repeat(64),
      evidence: ['explicit_subject_contact'],
      subjectContactIds: ['contact-a'],
      reasonClass: 'explicit_subject_contact',
      classifiedAt: 1,
      updatedAt: 2,
    };
    const queryAuthorizedMemorySubjects = vi.fn(async (input: MemorySubjectAuthorizedQuery) => {
      if (input.selector.kind !== 'detail' || input.selector.memoryId !== intimate.id
        || !input.authorization.viewerContactIds.includes('contact-a')
        || !input.authorization.allowedSubjectClasses.includes('single_contact')) {
        return { memories: [], total: 0 };
      }
      const grant = input.authorization.grantBindings.at(0);
      if (grant && (grant.memoryRevision !== classification.memoryRevision
        || grant.classifierVersion !== classification.classifierVersion
        || grant.evidenceDigest !== classification.evidenceDigest)) {
        return { memories: [], total: 0 };
      }
      return { memories: [intimate], total: 1 };
    });
    const rawStore = {
      queryAuthorizedMemorySubjects,
      getMemorySubjectClassification: vi.fn(async () => classification),
    } as unknown as MemoryStorePort;
    const service = new AdminMemoryDataService({ memoryStore: rawStore, fleetMemoryStore: rawStore });
    const routine = context('principal-a', 'contact-a');
    const detail = await service.forRequest(routine).getMemoryDetail(intimate.id);
    expect(detail?.memory).toMatchObject({
      bodyRedacted: true,
      subjectJitBinding: {
        memoryRevision: 3,
        classifierVersion: 1,
      },
    });
    expect(detail?.memory.text).not.toBe('private body');

    const binding = detail!.memory.subjectJitBinding!;
    const jit = context('principal-a', 'contact-a', {
      action: 'memory.jit.self',
      subjectRelation: 'self_or_co_subject',
      routeId: 'POST /api/admin/memory/:id/reveal',
      pathParams: { id: intimate.id },
      assurance: 'webauthn_uv',
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
    });
    await expect(service.forRequest(jit).revealMemory(intimate.id, {
      ...binding,
      purpose: 'Review my own memory',
    })).resolves.toMatchObject({ memory: { text: 'private body' } });

    await expect(service.forRequest(jit).revealMemory(intimate.id, {
      ...binding,
      memoryRevision: 2,
      purpose: 'Use a stale binding',
    })).resolves.toBeNull();
    await expect(service.forRequest(context('principal-other', 'contact-other', {
      action: 'memory.jit.self',
      subjectRelation: 'self_or_co_subject',
      routeId: 'POST /api/admin/memory/:id/reveal',
      pathParams: { id: intimate.id },
      assurance: 'webauthn_uv',
      role: 'owner',
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
    })).revealMemory(intimate.id, {
      ...binding,
      purpose: 'Owner attempts non-subject access',
    })).resolves.toBeNull();
  });
});
