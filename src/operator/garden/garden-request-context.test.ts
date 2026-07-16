import { describe, expect, it, vi } from 'vitest';
import type {
  MemorySubjectAuthorizedQuery,
  MemoryStorePort,
} from '../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import { AdminMemoryDataService } from './services/memory-service.js';
import type { FleetGardenRequestContext } from './garden-request-context.js';

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
  overrides: Partial<Pick<FleetGardenRequestContext, 'action' | 'subjectRelation'>> = {},
): FleetGardenRequestContext {
  const authorization = Object.freeze({
    action: overrides.action ?? 'memory.read.self',
    baseRole: 'member' as const,
    resource: Object.freeze({ scope: 'personal_workspace' as const, area: 'memory' as const }),
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
    expiresAt: 2,
    actor: Object.freeze({
      kind: 'fleet_principal',
      principalId,
      provider: 'discord',
      providerSubjectId: `provider-${principalId}`,
      contactId,
      contactBindingId: `binding-${principalId}`,
      role: 'member',
      operatorGrantId: `grant-${principalId}`,
      sessionRecordId: `session-${principalId}`,
      sessionAssurance: 'oauth',
    }),
    action: overrides.action ?? 'memory.read.self',
    resource: Object.freeze({
      routeId: 'GET /api/admin/memory',
      scope: 'personal_workspace',
      area: 'memory',
      companionId: '11111111-1111-4111-8111-111111111111',
      pathParams: Object.freeze({}),
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
    const rawStore = { queryAuthorizedMemorySubjects } as unknown as MemoryStorePort;
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
    expect(queryAuthorizedMemorySubjects.mock.calls.map(([input]) => (
      input.authorization.viewerContactIds
    ))).toEqual(expect.arrayContaining([['contact-a'], ['contact-b']]));
    expect(Object.isFrozen(principalA)).toBe(true);
    expect(Object.isFrozen(principalA.actor)).toBe(true);
  });

  it('keeps strong JIT and non-subject relations fail closed', async () => {
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
});
