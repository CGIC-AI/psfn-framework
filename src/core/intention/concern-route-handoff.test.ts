import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { NorthStarStore } from '../../faculties/north-star/store.js';
import { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import { createConcernStorePort } from './concern-store-port.js';
import { ActiveConcernStore } from './concerns.js';
import { applyConcernCandidateReview, type ConcernCandidate } from './concern-candidates.js';
import { groomConcernSet } from './concern-grooming.js';
import {
  ConcernRouteDispatcher,
  type ConcernRouteHandler,
  type ConcernRouteRequest,
} from './concern-route-handoff.js';
import {
  createIntrospectionRouteHandler,
  createNorthStarRouteHandler,
} from './concern-route-adapters.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'concern-route-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRequest(overrides: Partial<ConcernRouteRequest> = {}): ConcernRouteRequest {
  return {
    target: 'introspection',
    source: 'candidate_review',
    title: 'Follow up on the migration plan',
    summary: 'Alex asked to revisit the migration rollback plan next week.',
    priority: 'medium',
    reason: 'belongs in a longer-horizon substrate',
    evidenceRefs: [
      { kind: 'message', ref: '42' },
      { kind: 'runtime', ref: 'source:x' },
    ],
    channelId: 'discord:group-1',
    contactId: 'contact-a',
    candidateId: 'cand-1',
    ...overrides,
  };
}

function makeConcernStore() {
  const db = new Database(':memory:');
  let counter = 0;
  return createConcernStorePort(new ActiveConcernStore(db, {
    now: () => new Date('2026-06-29T12:00:00.000Z'),
    idFactory: () => `concern-${++counter}`,
  }));
}

function makeCandidate(id: string, overrides: Partial<ConcernCandidate> = {}): ConcernCandidate {
  return {
    id,
    dedupeKey: `dedupe:${id}`,
    source: 'memory_extraction',
    title: `Check in on ${id}`,
    summary: `Alex asked for a follow up about ${id}.`,
    priorityHint: 'medium',
    followUpHint: 'possible_follow_up',
    channelId: 'discord:group-1',
    triggerReason: 'response_turn',
    sourceRef: `source:${id}`,
    sourceMessageIds: [1],
    conversationContext: [],
    relatedMemoryContext: [],
    evidenceRefs: [{ kind: 'message', ref: '1' }],
    createdAt: '2026-06-29T12:00:00.000Z',
    contactId: 'contact-a',
    ...overrides,
  };
}

describe('ConcernRouteDispatcher', () => {
  it('routes to a configured handler and emits intention.concern.routed', async () => {
    const eventBus = new EventBus();
    const routed: unknown[] = [];
    eventBus.on('intention.concern.routed', event => routed.push(event));
    const handler: ConcernRouteHandler = {
      substrate: 'test_substrate',
      route: vi.fn().mockReturnValue({
        disposition: 'routed',
        substrate: 'test_substrate',
        targetRef: 'ref-1',
        reason: 'stored',
      }),
    };
    const dispatcher = new ConcernRouteDispatcher({
      handlers: { introspection: handler },
      eventBus,
      now: () => new Date('2026-06-29T12:00:00.000Z'),
    });

    const outcome = await dispatcher.dispatch(makeRequest());

    expect(handler.route).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      disposition: 'routed',
      substrate: 'test_substrate',
      targetRef: 'ref-1',
      target: 'introspection',
      source: 'candidate_review',
      candidateId: 'cand-1',
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ target: 'introspection', substrate: 'test_substrate', targetRef: 'ref-1' });
  });

  it('fails closed with a blocked event when no handler is configured for the target', async () => {
    const eventBus = new EventBus();
    const blocked: unknown[] = [];
    eventBus.on('intention.concern.route_blocked', event => blocked.push(event));
    const dispatcher = new ConcernRouteDispatcher({ handlers: {}, eventBus });

    const outcome = await dispatcher.dispatch(makeRequest({ target: 'reminder' }));

    expect(outcome.disposition).toBe('blocked');
    expect(outcome.substrate).toBe('none');
    expect(outcome.reason).toContain('no handler for target reminder');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ target: 'reminder', substrate: 'none' });
  });

  it('fails closed (blocked, no rethrow) when a handler throws', async () => {
    const dispatcher = new ConcernRouteDispatcher({
      handlers: {
        introspection: {
          substrate: 'reflection_journal',
          route: () => { throw new Error('disk offline'); },
        },
      },
    });

    const outcome = await dispatcher.dispatch(makeRequest());
    expect(outcome.disposition).toBe('blocked');
    expect(outcome.substrate).toBe('reflection_journal');
    expect(outcome.reason).toContain('disk offline');
  });

  it('surfaces a handler-returned blocked result verbatim', async () => {
    const dispatcher = new ConcernRouteDispatcher({
      handlers: {
        north_star: {
          substrate: 'north_star',
          route: () => ({ disposition: 'blocked', substrate: 'north_star', reason: 'cap reached' }),
        },
      },
    });
    const outcome = await dispatcher.dispatch(makeRequest({ target: 'north_star' }));
    expect(outcome.disposition).toBe('blocked');
    expect(outcome.reason).toBe('cap reached');
  });
});

describe('north-star route adapter', () => {
  it('routes a concern into the north-star store as a disabled draft', async () => {
    const store = new NorthStarStore(join(makeTempDir(), 'north-star.json'));
    const handler = createNorthStarRouteHandler(store);

    const result = handler.route(makeRequest({ target: 'north_star' }));

    expect(result.disposition).toBe('routed');
    expect(result.substrate).toBe('north_star');
    expect(result.targetRef).toBeDefined();
    const items = store.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ enabled: false, scope: 'companion' });
  });

  it('fails closed when the north-star item cap is reached', async () => {
    const store = new NorthStarStore(join(makeTempDir(), 'north-star.json'));
    for (let i = 0; i < 3; i += 1) {
      store.create({ title: `existing ${i}`, content: `content ${i}`, enabled: true });
    }
    const handler = createNorthStarRouteHandler(store);
    const result = handler.route(makeRequest({ target: 'north_star' }));
    expect(result.disposition).toBe('blocked');
    expect(result.reason).toContain('north-star handoff failed');
  });
});

describe('introspection route adapter', () => {
  it('appends to the reflection journal with candidate/concern provenance', async () => {
    const journalPath = join(makeTempDir(), 'reflection.jsonl');
    const store = new ReflectionJournalStore(journalPath);
    const handler = createIntrospectionRouteHandler(store);

    const result = handler.route(makeRequest({ concernId: 'concern-9' }));

    expect(result.disposition).toBe('routed');
    expect(result.substrate).toBe('reflection_journal');
    const entries = store.listRecent({ limit: 5 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.substrateBoundary).toBe('intention.concern_route');
    expect(entries[0]?.substrateProvenanceRefs).toEqual(
      expect.arrayContaining(['message:42', 'candidate:cand-1', 'concern:concern-9', 'route-source:candidate_review']),
    );
    const raw = readFileSync(journalPath, 'utf-8').trim();
    expect(raw.length).toBeGreaterThan(0);
  });

  it('falls back to the system channel id when the request carries none', async () => {
    const store = new ReflectionJournalStore(join(makeTempDir(), 'reflection.jsonl'));
    const handler = createIntrospectionRouteHandler(store);
    const request = makeRequest();
    delete (request as { channelId?: string }).channelId;
    const result = handler.route(request);
    expect(result.disposition).toBe('routed');
    expect(store.listRecent({ limit: 1 })[0]?.channelId).toBe('system:intention');
  });
});

describe('applyConcernCandidateReview with route dispatcher', () => {
  it('reflects a routed handoff into the apply outcome', async () => {
    const concernStore = makeConcernStore();
    const dispatcher = new ConcernRouteDispatcher({
      handlers: {
        introspection: {
          substrate: 'reflection_journal',
          route: () => ({ disposition: 'routed', substrate: 'reflection_journal', targetRef: 'refl-1', reason: 'recorded' }),
        },
      },
    });
    const candidate = makeCandidate('a');

    const outcomes = await applyConcernCandidateReview({
      concernStore,
      candidates: [candidate],
      decisions: [{ candidateId: 'a', action: 'route', reason: 'longer horizon', routeTarget: 'introspection' }],
      routeDispatcher: dispatcher,
    });

    expect(outcomes[0]).toMatchObject({
      action: 'route',
      status: 'routed',
      routeTarget: 'introspection',
      routeSubstrate: 'reflection_journal',
      routeRef: 'refl-1',
    });
  });

  it('marks a route decision blocked when no handler exists for the target', async () => {
    const concernStore = makeConcernStore();
    const dispatcher = new ConcernRouteDispatcher({ handlers: {} });
    const candidate = makeCandidate('b');

    const outcomes = await applyConcernCandidateReview({
      concernStore,
      candidates: [candidate],
      decisions: [{ candidateId: 'b', action: 'route', reason: 'calendar item', routeTarget: 'reminder' }],
      routeDispatcher: dispatcher,
    });

    expect(outcomes[0]).toMatchObject({
      action: 'route',
      status: 'blocked',
      routeTarget: 'reminder',
      routeSubstrate: 'none',
    });
    expect(outcomes[0]?.reason).toContain('no handler for target reminder');
  });

  it('keeps the intake-only acknowledgement when no dispatcher is configured', async () => {
    const concernStore = makeConcernStore();
    const outcomes = await applyConcernCandidateReview({
      concernStore,
      candidates: [makeCandidate('c')],
      decisions: [{ candidateId: 'c', action: 'route', reason: 'noted', routeTarget: 'project' }],
    });
    expect(outcomes[0]).toMatchObject({ status: 'routed', routeTarget: 'project' });
    expect(outcomes[0]?.routeSubstrate).toBeUndefined();
  });
});

describe('groomConcernSet with route dispatcher', () => {
  it('routes cap-overflow retirements to a durable substrate and reports outcomes', async () => {
    const concernStore = makeConcernStore();
    const texts = [
      'Cardiology appointment logistics',
      'Database migration rollback checklist',
      'Voice latency regression follow up',
      'Hydration routine check after medication change',
      'Backup verification audit evidence',
    ];
    for (const [i, text] of texts.entries()) {
      await concernStore.create({
        text,
        priority: i === 0 ? 'high' : 'low',
        expiresAt: `2026-06-30T1${i}:00:00.000Z`,
      });
    }
    const store = new ReflectionJournalStore(join(makeTempDir(), 'reflection.jsonl'));
    const dispatcher = new ConcernRouteDispatcher({
      handlers: { introspection: createIntrospectionRouteHandler(store) },
    });

    const result = await groomConcernSet({
      concernStore,
      asOf: '2026-06-29T12:00:00.000Z',
      maxActiveConcerns: 3,
      routeDispatcher: dispatcher,
    });

    expect(result.capResolved).toHaveLength(2);
    expect(result.routeOutcomes).toHaveLength(2);
    expect(result.routeOutcomes.every(o => o.disposition === 'routed')).toBe(true);
    expect(result.routeOutcomes.every(o => o.source === 'grooming_cap_overflow')).toBe(true);
    expect(store.listRecent({ limit: 10 })).toHaveLength(2);
  });

  it('emits an explicit blocked-route result when the target has no handler', async () => {
    const concernStore = makeConcernStore();
    await concernStore.create({
      text: 'Soon-expired concern',
      createdAt: '2026-06-28T10:00:00.000Z',
      expiresAt: '2026-06-29T11:00:00.000Z',
    });
    const dispatcher = new ConcernRouteDispatcher({ handlers: {}, });

    const result = await groomConcernSet({
      concernStore,
      asOf: '2026-06-29T12:00:00.000Z',
      routeDispatcher: dispatcher,
      routeTarget: 'reminder',
    });

    expect(result.staleResolved).toHaveLength(1);
    expect(result.routeOutcomes).toHaveLength(1);
    expect(result.routeOutcomes[0]).toMatchObject({
      disposition: 'blocked',
      target: 'reminder',
      source: 'grooming_stale',
    });
  });

  it('produces no route outcomes when no dispatcher is configured', async () => {
    const concernStore = makeConcernStore();
    await concernStore.create({
      text: 'Soon-expired concern',
      createdAt: '2026-06-28T10:00:00.000Z',
      expiresAt: '2026-06-29T11:00:00.000Z',
    });
    const result = await groomConcernSet({
      concernStore,
      asOf: '2026-06-29T12:00:00.000Z',
    });
    expect(result.routeOutcomes).toEqual([]);
  });
});
