import { describe, expect, it, vi } from 'vitest';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  parseEpisodeArc,
  type Episode,
  type EpisodeArc,
} from '../../../shared/contracts/episodic-memory.js';
import { AdminEpisodicMemoryDataService, type AdminEpisodicStore } from './episodic-memory-service.js';
import type { FleetGardenRequestContext } from '../garden-request-context.js';

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  const id = overrides.id ?? 'episode-alpha-1';
  const threadId = overrides.threadId ?? 'thread-alpha';
  return parseEpisode({
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id,
    title: `Episode ${id}`,
    landmark: `A bounded episodic landmark for ${id}.`,
    startedAt: '2026-04-01T10:00:00.000Z',
    endedAt: '2026-04-01T10:10:00.000Z',
    threadId,
    channelId: 'api:test',
    participantContactIds: ['contact:operator'],
    salience: { score: 0.7, novelty: 0.4, emotionalIntensity: 0.3 },
    affect: { valence: 0.2, arousal: 0.3, dominance: 0.5, labels: ['focused'] },
    themes: ['garden', threadId],
    spanRefs: [{ spanId: `span-${id}`, threadId, channelId: 'api:test' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  });
}

function makeArc(overrides: Partial<EpisodeArc> = {}): EpisodeArc {
  const id = overrides.id ?? 'arc-alpha';
  return parseEpisodeArc({
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id,
    sourceEpisodeId: 'episode-alpha-1',
    targetEpisodeId: 'episode-alpha-2',
    arcKind: 'continuation',
    salience: 0.8,
    confidence: 0.75,
    themes: ['garden'],
    spanRefs: [{ spanId: `span-${id}` }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  });
}

function compareArcRecency(left: EpisodeArc, right: EpisodeArc): number {
  if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
  return left.id.localeCompare(right.id);
}

function makeStore(episodes: readonly Episode[], arcs: readonly EpisodeArc[]) {
  const byEpisodeId = new Map(episodes.map(episode => [episode.id, episode]));
  const filterForEpisode = (
    episodeId: string,
    options: { direction?: 'incoming' | 'outgoing' | 'both'; arcKind?: string; limit?: number } = {},
  ): EpisodeArc[] => {
    const direction = options.direction ?? 'both';
    return arcs
      .filter((arc) => {
        if (direction === 'incoming') return arc.targetEpisodeId === episodeId;
        if (direction === 'outgoing') return arc.sourceEpisodeId === episodeId;
        return arc.sourceEpisodeId === episodeId || arc.targetEpisodeId === episodeId;
      })
      .filter(arc => options.arcKind === undefined || arc.arcKind === options.arcKind)
      .sort(compareArcRecency)
      .slice(0, options.limit ?? arcs.length);
  };
  const store = {
    getEpisode: vi.fn((id: string) => byEpisodeId.get(id)),
    getEpisodesByIds: vi.fn((ids: readonly string[]) => ids.flatMap((id) => {
      const episode = byEpisodeId.get(id);
      return episode ? [episode] : [];
    })),
    listEpisodeArcsForEpisode: vi.fn(filterForEpisode),
    listEpisodeArcsForEpisodes: vi.fn((
      ids: readonly string[],
      options: { direction?: 'incoming' | 'outgoing' | 'both'; arcKind?: string; limit?: number } = {},
    ) => {
      const byArcId = new Map<string, EpisodeArc>();
      for (const id of new Set(ids)) {
        for (const arc of filterForEpisode(id, options)) {
          byArcId.set(arc.id, arc);
        }
      }
      return [...byArcId.values()].sort(compareArcRecency);
    }),
    listEpisodes: vi.fn(() => [...episodes].sort((left, right) => (
      left.startedAt.localeCompare(right.startedAt)
      || left.id.localeCompare(right.id)
    ))),
    searchByThread: vi.fn((threadId: string) => episodes
      .filter(episode => episode.threadId === threadId)
      .sort((left, right) => (
        left.startedAt.localeCompare(right.startedAt)
        || left.id.localeCompare(right.id)
      ))),
    searchByTime: vi.fn((options: { from?: string; to?: string } = {}) => episodes.filter(episode => (
      (options.from === undefined || episode.endedAt >= options.from)
      && (options.to === undefined || episode.startedAt <= options.to)
    ))),
  } satisfies AdminEpisodicStore;
  return store;
}

describe('AdminEpisodicMemoryDataService', () => {
  it('builds thread summaries with one batched arc lookup across listed episodes', async () => {
    const alphaOne = makeEpisode({ id: 'episode-alpha-1', threadId: 'thread-alpha' });
    const alphaTwo = makeEpisode({
      id: 'episode-alpha-2',
      threadId: 'thread-alpha',
      startedAt: '2026-04-01T11:00:00.000Z',
      endedAt: '2026-04-01T11:10:00.000Z',
      themes: ['garden', 'thread-alpha', 'follow-up'],
    });
    const betaOne = makeEpisode({
      id: 'episode-beta-1',
      threadId: 'thread-beta',
      startedAt: '2026-04-02T10:00:00.000Z',
      endedAt: '2026-04-02T10:10:00.000Z',
      themes: ['garden', 'thread-beta'],
    });
    const alphaArc = makeArc({
      id: 'arc-alpha-internal',
      sourceEpisodeId: alphaOne.id,
      targetEpisodeId: alphaTwo.id,
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    const crossThreadArc = makeArc({
      id: 'arc-beta-alpha',
      sourceEpisodeId: betaOne.id,
      targetEpisodeId: alphaOne.id,
      updatedAt: '2026-04-04T00:00:00.000Z',
    });
    const store = makeStore([alphaOne, alphaTwo, betaOne], [alphaArc, crossThreadArc]);
    const service = new AdminEpisodicMemoryDataService(store);

    const result = await service.listThreads();

    expect(result.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: 'thread-alpha', episodeCount: 2, arcCount: 2 }),
      expect.objectContaining({ threadId: 'thread-beta', episodeCount: 1, arcCount: 1 }),
    ]));
    expect(store.listEpisodeArcsForEpisodes).toHaveBeenCalledTimes(1);
    expect(store.listEpisodeArcsForEpisodes).toHaveBeenCalledWith(
      ['episode-alpha-1', 'episode-alpha-2', 'episode-beta-1'],
      { direction: 'both', limit: 1000 },
    );
    expect(store.listEpisodeArcsForEpisode).not.toHaveBeenCalled();
  });

  it('builds thread detail related arc views with batched arcs and related episodes', async () => {
    const alphaOne = makeEpisode({ id: 'episode-alpha-1', threadId: 'thread-alpha' });
    const alphaTwo = makeEpisode({
      id: 'episode-alpha-2',
      threadId: 'thread-alpha',
      startedAt: '2026-04-01T11:00:00.000Z',
      endedAt: '2026-04-01T11:10:00.000Z',
    });
    const betaOne = makeEpisode({ id: 'episode-beta-1', threadId: 'thread-beta' });
    const alphaArc = makeArc({
      id: 'arc-alpha-internal',
      sourceEpisodeId: alphaOne.id,
      targetEpisodeId: alphaTwo.id,
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    const incomingArc = makeArc({
      id: 'arc-beta-alpha',
      sourceEpisodeId: betaOne.id,
      targetEpisodeId: alphaOne.id,
      updatedAt: '2026-04-04T00:00:00.000Z',
    });
    const store = makeStore([alphaOne, alphaTwo, betaOne], [alphaArc, incomingArc]);
    const service = new AdminEpisodicMemoryDataService(store);

    const result = await service.getThreadDetail('thread-alpha');

    expect(result?.arcs.map(arc => arc.id)).toEqual(['arc-beta-alpha', 'arc-alpha-internal']);
    expect(result?.relatedArcs).toEqual([
      expect.objectContaining({
        arc: expect.objectContaining({ id: 'arc-beta-alpha' }),
        direction: 'incoming',
        relatedEpisode: expect.objectContaining({ id: 'episode-beta-1' }),
      }),
      expect.objectContaining({
        arc: expect.objectContaining({ id: 'arc-alpha-internal' }),
        direction: 'outgoing',
        relatedEpisode: expect.objectContaining({ id: 'episode-alpha-2' }),
      }),
    ]);
    expect(store.listEpisodeArcsForEpisodes).toHaveBeenCalledTimes(1);
    expect(store.getEpisodesByIds).toHaveBeenCalledTimes(1);
    expect(store.getEpisodesByIds).toHaveBeenCalledWith(['episode-beta-1', 'episode-alpha-2']);
    expect(store.listEpisodeArcsForEpisode).not.toHaveBeenCalled();
    expect(store.getEpisode).not.toHaveBeenCalled();
  });

  it('builds related arc endpoint views without per-arc episode lookups', async () => {
    const alphaOne = makeEpisode({ id: 'episode-alpha-1', threadId: 'thread-alpha' });
    const alphaTwo = makeEpisode({ id: 'episode-alpha-2', threadId: 'thread-alpha' });
    const betaOne = makeEpisode({ id: 'episode-beta-1', threadId: 'thread-beta' });
    const outgoingArc = makeArc({
      id: 'arc-alpha-outgoing',
      sourceEpisodeId: alphaOne.id,
      targetEpisodeId: alphaTwo.id,
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    const incomingArc = makeArc({
      id: 'arc-beta-alpha',
      sourceEpisodeId: betaOne.id,
      targetEpisodeId: alphaOne.id,
      updatedAt: '2026-04-04T00:00:00.000Z',
    });
    const store = makeStore([alphaOne, alphaTwo, betaOne], [outgoingArc, incomingArc]);
    const service = new AdminEpisodicMemoryDataService(store);

    const result = await service.listEpisodeArcs('episode-alpha-1');

    expect(result?.relatedArcs).toEqual([
      expect.objectContaining({
        arc: expect.objectContaining({ id: 'arc-beta-alpha' }),
        direction: 'incoming',
        relatedEpisode: expect.objectContaining({ id: 'episode-beta-1' }),
      }),
      expect.objectContaining({
        arc: expect.objectContaining({ id: 'arc-alpha-outgoing' }),
        direction: 'outgoing',
        relatedEpisode: expect.objectContaining({ id: 'episode-alpha-2' }),
      }),
    ]);
    expect(store.getEpisode).toHaveBeenCalledTimes(1);
    expect(store.getEpisode).toHaveBeenCalledWith('episode-alpha-1');
    expect(store.listEpisodeArcsForEpisode).toHaveBeenCalledTimes(1);
    expect(store.getEpisodesByIds).toHaveBeenCalledTimes(1);
    expect(store.getEpisodesByIds).toHaveBeenCalledWith(['episode-beta-1', 'episode-alpha-2']);
  });
});

describe('subject-authorized episodic projection (88u3)', () => {
  function fleetMemoryContext(overrides: {
    contactId: string;
    subjectRelation?: FleetGardenRequestContext['subjectRelation'];
    routeId?: string;
    role?: FleetGardenRequestContext['actor']['role'];
    accessMode?: FleetGardenRequestContext['actor']['accessMode'];
    assurance?: FleetGardenRequestContext['actor']['sessionAssurance'];
  }): FleetGardenRequestContext {
    const subjectRelation = overrides.subjectRelation ?? 'self_or_co_subject';
    const authorization = Object.freeze({
      action: 'memory.read.self' as const,
      baseRole: 'member' as const,
      resource: Object.freeze({ scope: 'personal_workspace' as const, area: 'memory' as const }),
      subjectRelation,
      requirements: Object.freeze({
        assurance: overrides.assurance === 'escalated' ? 'escalated' as const : 'oauth' as const,
        confirmation: 'none' as const,
        approvals: Object.freeze([]),
      }),
      publicAccess: 'never' as const,
      recoveryAccess: 'forbidden' as const,
    });
    return Object.freeze({
      kind: 'fleet_principal' as const,
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      decisionId: 'cccccccc-dddd-4ddd-8ddd-dddddddddddd',
      authorizationEventId: 'event-principal-a',
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
        kind: 'fleet_principal' as const,
        principalId: 'principal-a',
        provider: 'discord' as const,
        providerSubjectId: 'provider-principal-a',
        contactId: overrides.contactId,
        contactBindingId: 'binding-principal-a',
        role: overrides.role ?? 'member',
        operatorGrantId: 'grant-principal-a',
        sessionRecordId: 'session-principal-a',
        sessionAssurance: overrides.assurance ?? 'oauth',
        accessMode: overrides.accessMode ?? 'multi_admin',
      }),
      action: 'memory.read.self' as const,
      resource: Object.freeze({
        routeId: overrides.routeId ?? 'GET /api/admin/episodic-memory/episodes',
        scope: 'personal_workspace' as const,
        area: 'memory' as const,
        companionId: '11111111-1111-4111-8111-111111111111',
        pathParams: Object.freeze({}),
        query: Object.freeze({}),
      }),
      subjectRelation,
      authorization,
    });
  }

  function makeSubjectEpisodes() {
    const own = makeEpisode({
      id: 'episode-own-1',
      threadId: 'thread-own',
      participantContactIds: ['contact-a'],
    });
    const shared = makeEpisode({
      id: 'episode-shared-1',
      threadId: 'thread-own',
      startedAt: '2026-04-01T11:00:00.000Z',
      endedAt: '2026-04-01T11:10:00.000Z',
      participantContactIds: ['contact-a', 'contact-b'],
    });
    const foreign = makeEpisode({
      id: 'episode-foreign-1',
      threadId: 'thread-foreign',
      startedAt: '2026-04-02T10:00:00.000Z',
      endedAt: '2026-04-02T10:10:00.000Z',
      participantContactIds: ['contact-b'],
    });
    const unattributed = makeEpisode({
      id: 'episode-unattributed-1',
      threadId: 'thread-unattributed',
      startedAt: '2026-04-03T10:00:00.000Z',
      endedAt: '2026-04-03T10:10:00.000Z',
      participantContactIds: [],
    });
    const ownArc = makeArc({
      id: 'arc-own',
      sourceEpisodeId: 'episode-own-1',
      targetEpisodeId: 'episode-shared-1',
    });
    const crossArc = makeArc({
      id: 'arc-cross',
      sourceEpisodeId: 'episode-own-1',
      targetEpisodeId: 'episode-foreign-1',
    });
    return { own, shared, foreign, unattributed, ownArc, crossArc };
  }

  it('lists only episodes whose explicit participants include the fleet subject', async () => {
    const { own, shared, foreign, unattributed, ownArc, crossArc } = makeSubjectEpisodes();
    const service = new AdminEpisodicMemoryDataService(
      makeStore([own, shared, foreign, unattributed], [ownArc, crossArc]),
    );

    const listed = await service.listEpisodes(undefined, fleetMemoryContext({ contactId: 'contact-a' }));
    expect(listed.episodes.map(episode => episode.id).sort())
      .toEqual(['episode-own-1', 'episode-shared-1']);
    expect(listed.pagination.total).toBe(2);
    expect(listed.withheldBySubjectAuthorizationCount).toBeUndefined();

    // Legacy operator context keeps the unpartitioned view.
    const legacy = await service.listEpisodes();
    expect(legacy.episodes).toHaveLength(4);
    expect(legacy.withheldBySubjectAuthorizationCount).toBe(0);
  });

  it('hides foreign and unattributed episodes across detail, provenance, arcs, and threads', async () => {
    const { own, shared, foreign, unattributed, ownArc, crossArc } = makeSubjectEpisodes();
    const service = new AdminEpisodicMemoryDataService(
      makeStore([own, shared, foreign, unattributed], [ownArc, crossArc]),
    );
    const context = fleetMemoryContext({ contactId: 'contact-a' });

    await expect(service.getEpisodeDetail('episode-foreign-1', context)).resolves.toBeNull();
    await expect(service.getEpisodeDetail('episode-unattributed-1', context)).resolves.toBeNull();
    await expect(service.getEpisodeProvenance('episode-foreign-1', context)).resolves.toBeNull();
    await expect(service.listEpisodeArcs('episode-foreign-1', undefined, context)).resolves.toBeNull();

    // Arcs from a visible episode only surface when BOTH endpoints are visible.
    const arcs = await service.listEpisodeArcs('episode-own-1', undefined, context);
    expect(arcs?.relatedArcs.map(view => view.arc.id)).toEqual(['arc-own']);

    const threads = await service.listThreads(undefined, context);
    expect(threads.threads.map(thread => thread.threadId)).toEqual(['thread-own']);
    await expect(service.getThreadDetail('thread-foreign', context)).resolves.toBeNull();

    const detail = await service.getEpisodeDetail('episode-own-1', context);
    expect(detail?.relatedArcs.map(view => view.arc.id)).toEqual(['arc-own']);
    expect(detail?.threadEpisodes.map(episode => episode.id))
      .toEqual(['episode-own-1', 'episode-shared-1']);
  });

  it('fails closed without an exact request-local subject relation', async () => {
    const { own, ownArc } = makeSubjectEpisodes();
    const service = new AdminEpisodicMemoryDataService(makeStore([own], [ownArc]));

    await expect(service.listEpisodes(undefined, fleetMemoryContext({
      contactId: 'contact-a',
      subjectRelation: 'current_companion',
    }))).rejects.toThrow(/exact request-local subject relation/u);
  });

  it.each(['owner', 'admin'] as const)(
    'D1 sole_admin %s sees every episode and receives no phantom withheld count',
    async (role) => {
      const { own, shared, foreign, unattributed, ownArc, crossArc } = makeSubjectEpisodes();
      const service = new AdminEpisodicMemoryDataService(
        makeStore([own, shared, foreign, unattributed], [ownArc, crossArc]),
      );
      const context = fleetMemoryContext({
        contactId: 'contact-a',
        role,
        accessMode: 'sole_admin',
      });

      const listed = await service.listEpisodes(undefined, context);
      expect(listed.episodes.map(episode => episode.id).sort()).toEqual([
        'episode-foreign-1',
        'episode-own-1',
        'episode-shared-1',
        'episode-unattributed-1',
      ]);
      expect(listed.withheldBySubjectAuthorizationCount).toBeUndefined();
      await expect(service.getEpisodeDetail(foreign.id, context))
        .resolves.toMatchObject({ episode: { id: foreign.id } });
      await expect(service.getEpisodeDetail(unattributed.id, context))
        .resolves.toMatchObject({ episode: { id: unattributed.id } });
      expect((await service.listEpisodeArcs(own.id, undefined, context))
        ?.relatedArcs.map(view => view.arc.id).sort()).toEqual(['arc-cross', 'arc-own']);
    },
  );

  it.each(['owner', 'admin'] as const)(
    'D1 multi_admin %s sees unassigned episodes but withholds other-human episodes until escalation',
    async (role) => {
      const { own, shared, foreign, unattributed, ownArc, crossArc } = makeSubjectEpisodes();
      const service = new AdminEpisodicMemoryDataService(
        makeStore([own, shared, foreign, unattributed], [ownArc, crossArc]),
      );
      const baseContext = {
        contactId: 'contact-a',
        role,
        accessMode: 'multi_admin' as const,
      };

      const listed = await service.listEpisodes(undefined, fleetMemoryContext(baseContext));
      expect(listed.episodes.map(episode => episode.id).sort()).toEqual([
        'episode-own-1',
        'episode-shared-1',
        'episode-unattributed-1',
      ]);
      expect(listed.withheldBySubjectAuthorizationCount)
        .toBe(role === 'owner' ? 1 : undefined);

      const escalatedContext = fleetMemoryContext({
        ...baseContext,
        assurance: 'escalated',
      });
      const escalated = await service.listEpisodes(undefined, escalatedContext);
      expect(escalated.episodes).toHaveLength(4);
      expect(escalated.withheldBySubjectAuthorizationCount).toBeUndefined();
      await expect(service.getEpisodeDetail(foreign.id, escalatedContext))
        .resolves.toMatchObject({ episode: { id: foreign.id } });
    },
  );

  it('reports only the episodes the same filtered multi_admin request would reveal after escalation', async () => {
    const { own, shared, foreign, unattributed, ownArc, crossArc } = makeSubjectEpisodes();
    const service = new AdminEpisodicMemoryDataService(
      makeStore([own, shared, foreign, unattributed], [ownArc, crossArc]),
    );
    const params = new URLSearchParams({
      threadId: 'thread-foreign',
      from: '2026-04-02T00:00:00.000Z',
      to: '2026-04-02T23:59:59.999Z',
    });
    const baseContext = {
      contactId: 'contact-a',
      role: 'owner' as const,
      accessMode: 'multi_admin' as const,
    };

    const listed = await service.listEpisodes(params, fleetMemoryContext(baseContext));
    const escalated = await service.listEpisodes(
      params,
      fleetMemoryContext({ ...baseContext, assurance: 'escalated' }),
    );
    expect(listed.episodes).toHaveLength(0);
    expect(listed.withheldBySubjectAuthorizationCount)
      .toBe(escalated.pagination.total - listed.pagination.total);
    expect(escalated.episodes.map(episode => episode.id)).toEqual([foreign.id]);
  });

  it.each(['member', 'guest'] as const)(
    'keeps %s visibility subject-scoped even in a sole_admin deployment topology',
    async (role) => {
      const { own, shared, foreign, unattributed, ownArc, crossArc } = makeSubjectEpisodes();
      const service = new AdminEpisodicMemoryDataService(
        makeStore([own, shared, foreign, unattributed], [ownArc, crossArc]),
      );
      const listed = await service.listEpisodes(undefined, fleetMemoryContext({
        contactId: 'contact-a',
        role,
        accessMode: 'sole_admin',
      }));

      expect(listed.episodes.map(episode => episode.id).sort())
        .toEqual(['episode-own-1', 'episode-shared-1']);
      expect(listed.withheldBySubjectAuthorizationCount).toBeUndefined();
    },
  );
});
