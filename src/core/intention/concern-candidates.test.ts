import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../agent/contracts.js';
import { EventBus, type DeterministicGateEvent } from '../../shared/event-bus.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import {
  ConcernCandidateQueue,
  ConcernCandidateReviewer,
  ConcernCandidateWorker,
  applyConcernCandidateReview,
  buildConcernCandidateReviewPrompt,
  createAutomatedConcernRuntime,
  deriveConcernCandidatesFromExtraction,
  parseConcernCandidateReviewResponse,
  type ConcernCandidate,
} from './concern-candidates.js';

function makeCandidate(id: string): ConcernCandidate {
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
    conversationContext: [{
      id: 1,
      role: 'user',
      content: `Please check in about ${id} tomorrow.`,
      authorName: 'Alex',
      timestamp: 1,
    }],
    relatedMemoryContext: [{
      id: `mem-${id}`,
      type: 'semantic',
      text: `Related memory for ${id}`,
      importance: 0.7,
      confidence: 0.8,
      salience: 0.6,
      sourceRef: `memory:${id}`,
    }],
    evidenceRefs: [
      { kind: 'message', ref: '1' },
      { kind: 'runtime', ref: `source:${id}` },
    ],
    createdAt: '2026-06-29T12:00:00.000Z',
    turnId: `turn-${id}`,
    contactId: 'contact-a',
  };
}

function makeConcernStore() {
  let counter = 0;
  return createTestPostgresIntentionPorts({
    now: () => new Date('2026-06-29T12:00:00.000Z'),
    idFactory: () => `concern-${++counter}`,
  }).ports.concernStore;
}

const distinctConcernTexts = [
  'Confirm Tuesday cardiology appointment logistics.',
  'Review database migration rollback checklist.',
  'Check whether voice latency regression returned.',
  'Track hydration routine follow up after medication change.',
  'Revisit backup verification evidence after tonight.',
  'Clarify calendar scheduling conflict with Sam.',
  'Inspect avatar render pipeline failure notes.',
];

describe('automated concern candidates', () => {
  it('persists extracted candidates before returning resolvable output ids', async () => {
    const concernStore = makeConcernStore();
    const runtime = await createAutomatedConcernRuntime({
      eventBus: new EventBus(),
      llmProvider: { complete: vi.fn() } as unknown as LLMProviderPort,
      concernStore,
      now: () => new Date('2026-06-29T12:00:00.000Z'),
    });

    const ids = await runtime.extractionSink({
      channelId: 'discord:group-1',
      triggerReason: 'response_turn',
      canonicalContactId: 'contact-a',
      turnId: 'turn-durable',
      sourceRef: 'source:durable',
      recentEntries: [{
        id: 10,
        channelId: 'discord:group-1',
        role: 'user',
        content: 'Please check in tomorrow about the appointment.',
        timestamp: 100,
      }],
      acceptedFacts: [{
        text: 'Check in tomorrow about the appointment.',
        type: 'semantic',
        importance: 0.9,
        emotionalValence: 0,
        confidence: 0.9,
        tags: [],
      }],
      acceptedWrites: [],
      relatedMemories: [{
        id: 'memory-durable-context',
        type: 'semantic',
        text: 'The appointment is scheduled for tomorrow morning.',
        importance: 0.8,
        confidence: 0.9,
        salience: 0.7,
        sourceRef: 'memory:durable-context',
      }],
    });

    expect(ids).toEqual(['concern-1']);
    await expect(concernStore.getById('concern-1')).resolves.toMatchObject({
      id: 'concern-1',
      status: 'candidate',
      evidenceRefs: expect.arrayContaining([{ kind: 'turn', ref: 'turn-durable' }]),
    });
    await expect(concernStore.getActiveConcerns()).resolves.toEqual([]);
    const [beforeRestart] = runtime.queue.drainPending();
    expect(beforeRestart).toBeDefined();
    runtime.queue.requeue([beforeRestart!]);
    expect(await runtime.extractionSink({
      channelId: 'discord:group-1',
      triggerReason: 'response_turn',
      canonicalContactId: 'contact-a',
      turnId: 'turn-durable',
      sourceRef: 'source:durable',
      recentEntries: [{
        id: 10,
        channelId: 'discord:group-1',
        role: 'user',
        content: 'Please check in tomorrow about the appointment.',
        timestamp: 100,
      }],
      acceptedFacts: [{
        text: 'Check in tomorrow about the appointment.',
        type: 'semantic',
        importance: 0.9,
        emotionalValence: 0,
        confidence: 0.9,
        tags: [],
      }],
      acceptedWrites: [],
      relatedMemories: [{
        id: 'memory-durable-context',
        type: 'semantic',
        text: 'The appointment is scheduled for tomorrow morning.',
        importance: 0.8,
        confidence: 0.9,
        salience: 0.7,
        sourceRef: 'memory:durable-context',
      }],
    })).toEqual(['concern-1']);
    expect(runtime.queue.pendingCount()).toBe(1);
    runtime.dispose();

    const recoveredRuntime = await createAutomatedConcernRuntime({
      eventBus: new EventBus(),
      llmProvider: { complete: vi.fn() } as unknown as LLMProviderPort,
      concernStore,
      now: () => new Date('2026-06-29T12:01:00.000Z'),
    });
    const [candidate] = recoveredRuntime.queue.drainPending();
    expect(candidate).toMatchObject({ id: 'concern-1', durableConcernId: 'concern-1' });
    expect(buildConcernCandidateReviewPrompt([candidate!]))
      .toBe(buildConcernCandidateReviewPrompt([beforeRestart!]));
    await expect(applyConcernCandidateReview({
      concernStore,
      candidates: [candidate!],
      decisions: [{
        candidateId: candidate!.id,
        action: 'create',
        reason: 'keep the durable candidate',
      }],
    })).resolves.toEqual([expect.objectContaining({
      concernId: 'concern-1',
      status: 'created',
    })]);
    await expect(concernStore.getById('concern-1')).resolves.toMatchObject({ status: 'active' });
    recoveredRuntime.dispose();
  });

  it('persists a review candidate without consuming the active concern cap', async () => {
    const concernStore = makeConcernStore();
    for (const text of distinctConcernTexts) {
      await concernStore.create({ text, priority: 'low' });
    }
    const runtime = await createAutomatedConcernRuntime({
      eventBus: new EventBus(),
      llmProvider: { complete: vi.fn() } as unknown as LLMProviderPort,
      concernStore,
      now: () => new Date('2026-06-29T12:00:00.000Z'),
    });

    await expect(runtime.extractionSink({
      channelId: 'discord:group-1',
      triggerReason: 'response_turn',
      turnId: 'turn-over-cap',
      sourceRef: 'discord:group-1:extract|turn:turn-over-cap',
      recentEntries: [{
        id: 77,
        channelId: 'discord:group-1',
        role: 'user',
        content: 'Please remind me tomorrow to replace the furnace filter.',
        timestamp: 100,
      }],
      acceptedFacts: [{
        text: 'Remind the user tomorrow to replace the furnace filter.',
        type: 'semantic',
        importance: 0.9,
        emotionalValence: 0,
        confidence: 0.9,
        tags: [],
      }],
      acceptedWrites: [],
      relatedMemories: [],
    })).resolves.toEqual(['concern-8']);
    await expect(concernStore.getActiveConcerns()).resolves.toHaveLength(7);
    await expect(concernStore.getById('concern-8')).resolves.toMatchObject({ status: 'candidate' });
    runtime.dispose();
  });

  it('keeps unreviewed candidate evidence isolated from a similar active concern', async () => {
    const concernStore = makeConcernStore();
    const active = await concernStore.create({
      text: 'Check in tomorrow about the appointment.',
      priority: 'low',
      status: 'active',
      evidenceRefs: [{ kind: 'operator', ref: 'approved-active-evidence' }],
    });
    const runtime = await createAutomatedConcernRuntime({
      eventBus: new EventBus(),
      llmProvider: { complete: vi.fn() } as unknown as LLMProviderPort,
      concernStore,
      now: () => new Date('2026-06-29T12:00:00.000Z'),
    });

    const ids = await runtime.extractionSink({
      channelId: 'discord:group-1',
      triggerReason: 'response_turn',
      turnId: 'turn-isolated-candidate',
      sourceRef: 'source:isolated-candidate',
      recentEntries: [{
        id: 12,
        channelId: 'discord:group-1',
        role: 'user',
        content: 'Please check in tomorrow about the appointment.',
        timestamp: 100,
      }],
      acceptedFacts: [{
        text: 'Check in tomorrow about the appointment.',
        type: 'semantic',
        importance: 0.9,
        emotionalValence: 0,
        confidence: 0.9,
        tags: [],
      }],
      acceptedWrites: [],
      relatedMemories: [],
    });

    expect(ids).toEqual(['concern-2']);
    await expect(concernStore.getById('concern-2')).resolves.toMatchObject({ status: 'candidate' });
    await expect(concernStore.getById(active.id)).resolves.toMatchObject({
      priority: 'low',
      evidenceRefs: [{ kind: 'operator', ref: 'approved-active-evidence' }],
    });
    runtime.dispose();
  });

  it('rehydrates every durable candidate beyond one storage page', async () => {
    const concernStore = makeConcernStore();
    for (let index = 0; index < 201; index += 1) {
      const text = `Follow up uniqueword${index}`;
      await concernStore.create({
        text,
        status: 'candidate',
        priority: index % 2 === 0 ? 'high' : 'medium',
        evidenceRefs: [{ kind: 'runtime', ref: `candidate-page:${index}` }],
        candidateReviewSnapshot: {
          schemaVersion: 1,
          title: text,
          summary: text,
          followUpHint: 'possible_follow_up',
          channelId: 'api:candidate-page',
          triggerReason: 'response_turn',
          sourceRef: `source:candidate-page:${index}`,
          sourceMessageIds: [index + 1],
          conversationContext: [],
          relatedMemoryContext: [],
          turnId: `turn-candidate-page-${index}`,
        },
      });
    }

    const runtime = await createAutomatedConcernRuntime({
      eventBus: new EventBus(),
      llmProvider: { complete: vi.fn() } as unknown as LLMProviderPort,
      concernStore,
      now: () => new Date('2026-06-29T12:00:00.000Z'),
    });

    expect(runtime.queue.pendingCount()).toBe(201);
    runtime.dispose();
  });

  it('derives structured candidates from extraction with provenance and related context', () => {
    const candidates = deriveConcernCandidatesFromExtraction({
      now: () => new Date('2026-06-29T12:00:00.000Z'),
      idFactory: () => 'candidate-1',
      context: {
        channelId: 'discord:group-1',
        triggerReason: 'response_turn',
        canonicalContactId: 'contact-a',
        turnId: 'turn-1',
        sourceRef: 'source:extract-1',
        recentEntries: [
          {
            id: 10,
            channelId: 'discord:group-1',
            role: 'user',
            content: 'Can you check in with me tomorrow about the appointment?',
            authorName: 'Alex',
            timestamp: 100,
          },
        ],
        acceptedFacts: [{
          text: 'Alex asked for a check in tomorrow about the appointment.',
          type: 'semantic',
          importance: 0.9,
          emotionalValence: -0.2,
          confidence: 0.95,
          tags: ['appointment'],
          attribution: { sourceMessageIds: [10] },
        }],
        acceptedWrites: [{
          memoryId: 'mem-written-1',
          importance: 0.9,
          confidence: 0.95,
          contactId: 'contact-a',
        }],
        relatedMemories: [{
          id: 'mem-related-1',
          type: 'semantic',
          text: 'Alex has an appointment this week.',
          importance: 0.7,
          confidence: 0.8,
          emotionalValence: 0,
          salience: 0.5,
          sourceRef: 'memory:related',
          extractedAt: 1,
          lastAccessed: 1,
          accessCount: 0,
          tags: [],
          sensitivity: 'personal',
        }],
      },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: 'candidate-1',
      source: 'memory_extraction',
      priorityHint: 'high',
      followUpHint: 'possible_follow_up',
      channelId: 'discord:group-1',
      contactId: 'contact-a',
      turnId: 'turn-1',
      dueAt: '2026-06-30T12:00:00.000Z',
      sourceMessageIds: [10],
      evidenceRefs: [
        { kind: 'message', ref: '10' },
        { kind: 'turn', ref: 'turn-1' },
        { kind: 'runtime', ref: 'source:extract-1' },
      ],
    });
    expect(candidates[0]?.conversationContext[0]?.content).toContain('check in');
    expect(candidates[0]?.relatedMemoryContext[0]?.text).toContain('appointment');
  });

  it('builds a soft review prompt with source conversation and related memories', () => {
    const prompt = buildConcernCandidateReviewPrompt([makeCandidate('a')]);

    expect(prompt).toContain('Is there anything here we should follow up on soon?');
    expect(prompt).toContain('Selecting an open thread is separate from outbound delivery.');
    expect(prompt).toContain('targetOpenThreadId');
    expect(prompt).not.toContain('targetConcernId');
    expect(prompt).toContain('conversationContext');
    expect(prompt).toContain('relatedMemoryContext');
    expect(prompt.toLowerCase()).not.toMatch(/\b(concerns?|worr(?:y|ies|ied)|critical|must|urgent|constant-check)\b/);
  });

  it('maps the model-facing open-thread merge target to the internal decision field', () => {
    expect(parseConcernCandidateReviewResponse(JSON.stringify({
      decisions: [{
        candidateId: 'a',
        action: 'merge',
        reason: 'same thread',
        targetOpenThreadId: 'thread-1',
      }],
    }), [makeCandidate('a')])).toEqual([{
      candidateId: 'a',
      action: 'merge',
      reason: 'same thread',
      targetConcernId: 'thread-1',
    }]);
  });

  it('checks every few turns and spends no model call for empty or single-item pipes', () => {
    const complete = vi.fn<LLMProviderPort['complete']>();
    const queue = new ConcernCandidateQueue();
    const worker = new ConcernCandidateWorker({
      queue,
      reviewer: new ConcernCandidateReviewer({ complete } as unknown as LLMProviderPort),
      concernStore: makeConcernStore(),
      reviewTurnInterval: 2,
    });

    expect(worker.notifyTurnCompleted()).toBe(false);
    expect(worker.notifyTurnCompleted()).toBe(false);
    expect(worker.reviewPending()).toMatchObject({
      status: 'skipped',
      reason: 'insufficient_candidates',
    });
    queue.enqueueMany([makeCandidate('single')]);
    expect(worker.notifyTurnCompleted()).toBe(false);
    expect(worker.notifyTurnCompleted()).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('emits a typed concern-review gate event on skip and on run (jpvd.4)', () => {
    const eventBus = new EventBus();
    const events: DeterministicGateEvent[] = [];
    eventBus.on('intention.concern_candidate.gate', (event) => { events.push(event); });
    const queue = new ConcernCandidateQueue();
    const worker = new ConcernCandidateWorker({
      queue,
      reviewer: new ConcernCandidateReviewer({ complete: vi.fn() } as unknown as LLMProviderPort),
      concernStore: makeConcernStore(),
      eventBus,
      reviewTurnInterval: 1,
    });

    // One pending candidate => count gate closed, byte-identical decision.
    queue.enqueueMany([makeCandidate('solo')]);
    expect(worker.reviewPending()).toMatchObject({ status: 'skipped', reason: 'insufficient_candidates' });
    expect(events).toEqual([
      expect.objectContaining({
        lane: 'concern_candidate_review',
        outcome: 'skipped',
        reason: 'insufficient_candidates',
        inputs: { pendingCount: 1 },
      }),
    ]);

    // Two pending => gate opens, emits a 'ran' event.
    queue.enqueueMany([makeCandidate('second')]);
    expect(worker.reviewPending()).toMatchObject({ status: 'started' });
    expect(events[1]).toMatchObject({ outcome: 'ran', reason: 'open', inputs: { pendingCount: 2 } });
  });

  it('launches review asynchronously once the deterministic turn check sees more than one candidate', async () => {
    let resolveReview!: (value: { content: string }) => void;
    const complete = vi.fn<LLMProviderPort['complete']>().mockImplementation(() => (
      new Promise(resolve => {
        resolveReview = resolve;
      })
    ));
    const queue = new ConcernCandidateQueue();
    queue.enqueueMany([makeCandidate('a'), makeCandidate('b')]);
    const worker = new ConcernCandidateWorker({
      queue,
      reviewer: new ConcernCandidateReviewer({ complete } as unknown as LLMProviderPort),
      concernStore: makeConcernStore(),
      reviewTurnInterval: 2,
    });

    expect(worker.notifyTurnCompleted()).toBe(false);
    expect(worker.notifyTurnCompleted()).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount()).toBe(0);

    resolveReview({
      content: JSON.stringify({
        decisions: [
          { candidateId: 'a', action: 'create', reason: 'near-term follow-up' },
          { candidateId: 'b', action: 'reject', reason: 'not enough signal' },
        ],
      }),
    });
    const result = await worker.waitForInFlight();

    expect(result).toMatchObject({
      status: 'completed',
      reviewedCount: 2,
      outcomes: [
        { candidateId: 'a', status: 'created' },
        { candidateId: 'b', status: 'rejected' },
      ],
    });
  });

  it('blocks candidate approval before creating an eighth active concern', async () => {
    const concernStore = makeConcernStore();
    await concernStore.create({
      text: 'Follow up highprioritycandidatealpha',
      priority: 'high',
      status: 'candidate',
    });
    await concernStore.create({
      text: 'Follow up highprioritycandidatebeta',
      priority: 'high',
      status: 'candidate',
    });
    for (const [i, text] of distinctConcernTexts.entries()) {
      await concernStore.create({
        text,
        priority: i === 0 ? 'high' : 'low',
      });
    }

    const outcomes = await applyConcernCandidateReview({
      concernStore,
      candidates: [makeCandidate('overflow')],
      decisions: [{
        candidateId: 'overflow',
        action: 'create',
        reason: 'good candidate but cap is full',
      }],
      now: () => new Date('2026-06-29T12:00:00.000Z'),
    });

    expect(outcomes).toEqual([{
      candidateId: 'overflow',
      action: 'create',
      status: 'blocked',
      routeTarget: 'other',
      reason: 'open-thread cap 7 reached; candidate was not added',
    }]);
    expect(await concernStore.getActiveConcerns()).toHaveLength(7);
  });

  it('attaches applied outcomes when apply fails partway through a batch', async () => {
    const concernStore = makeConcernStore();
    let createCalls = 0;
    const flakyStore = {
      ...concernStore,
      create: (input: Parameters<typeof concernStore.create>[0]) => {
        createCalls += 1;
        if (createCalls === 2) {
          throw new Error('transient store failure');
        }
        return concernStore.create(input);
      },
    };

    const attempt = applyConcernCandidateReview({
      concernStore: flakyStore,
      candidates: [makeCandidate('a'), makeCandidate('b')],
      decisions: [
        { candidateId: 'a', action: 'create', reason: 'follow up soon' },
        { candidateId: 'b', action: 'create', reason: 'follow up soon' },
      ],
      now: () => new Date('2026-06-29T12:00:00.000Z'),
    });

    await expect(attempt).rejects.toMatchObject({
      name: 'ConcernCandidateApplyError',
      failedCandidateId: 'b',
      outcomes: [{ candidateId: 'a', status: 'created' }],
    });
    expect(await concernStore.getActiveConcerns()).toHaveLength(1);
  });

  it('requeues only unapplied candidates after a partial apply failure (no duplicate concerns on retry)', async () => {
    const concernStore = makeConcernStore();
    let createCalls = 0;
    const flakyStore = {
      ...concernStore,
      create: (input: Parameters<typeof concernStore.create>[0]) => {
        createCalls += 1;
        if (createCalls === 2) {
          throw new Error('transient store failure');
        }
        return concernStore.create(input);
      },
    };
    const complete = vi.fn<LLMProviderPort['complete']>().mockImplementation(async () => ({
      content: JSON.stringify({
        decisions: [
          { candidateId: 'a', action: 'create', reason: 'near-term follow-up' },
          { candidateId: 'b', action: 'create', reason: 'near-term follow-up' },
        ],
      }),
    }));
    const queue = new ConcernCandidateQueue();
    // Distinct texts so the store's similar-concern dedupe cannot mask a
    // duplicate create — the retry must not re-create candidate 'a'.
    queue.enqueueMany([
      {
        ...makeCandidate('a'),
        title: 'Confirm Tuesday cardiology appointment logistics',
        summary: 'Alex asked to confirm the cardiology appointment schedule.',
      },
      {
        ...makeCandidate('b'),
        title: 'Review database migration rollback checklist',
        summary: 'The rollback checklist needs a fresh review before Friday.',
      },
    ]);
    const worker = new ConcernCandidateWorker({
      queue,
      reviewer: new ConcernCandidateReviewer({ complete } as unknown as LLMProviderPort),
      concernStore: flakyStore,
    });

    expect(worker.reviewPending().status).toBe('started');
    await worker.waitForInFlight();

    // Candidate 'a' was applied before the failure: it must NOT be requeued.
    expect(queue.pendingCount()).toBe(1);
    expect(await concernStore.getActiveConcerns()).toHaveLength(1);

    // Retry drains only the unapplied candidate; queue gate needs >1 pending,
    // so add a filler candidate and let the retry apply 'b' exactly once.
    queue.enqueueMany([{
      ...makeCandidate('c'),
      title: 'Track hydration routine after medication change',
      summary: 'Hydration follow up requested after the medication change.',
    }]);
    complete.mockImplementation(async () => ({
      content: JSON.stringify({
        decisions: [
          { candidateId: 'b', action: 'create', reason: 'near-term follow-up' },
          { candidateId: 'c', action: 'reject', reason: 'not enough signal' },
        ],
      }),
    }));
    expect(worker.reviewPending().status).toBe('started');
    const retry = await worker.waitForInFlight();

    expect(retry).toMatchObject({ status: 'completed', reviewedCount: 2 });
    const active = await concernStore.getActiveConcerns();
    expect(active).toHaveLength(2);
    expect(active.filter(concern => concern.text.includes('cardiology'))).toHaveLength(1);
  });

  it('allows explicit merge decisions even when the active concern cap is full', async () => {
    const concernStore = makeConcernStore();
    let targetConcernId = '';
    for (const [i, text] of distinctConcernTexts.entries()) {
      const concern = await concernStore.create({
        text,
        priority: i === 0 ? 'high' : 'low',
      });
      if (i === 0) targetConcernId = concern.id;
    }

    const outcomes = await applyConcernCandidateReview({
      concernStore,
      candidates: [makeCandidate('mergeable')],
      decisions: [{
        candidateId: 'mergeable',
        action: 'merge',
        targetConcernId,
        reason: 'same short-term thread',
      }],
      now: () => new Date('2026-06-29T12:30:00.000Z'),
    });

    expect(outcomes).toEqual([{
      candidateId: 'mergeable',
      action: 'merge',
      status: 'merged',
      reason: 'same short-term thread',
      concernId: targetConcernId,
    }]);
    expect(await concernStore.getActiveConcerns()).toHaveLength(7);
    await expect(concernStore.getById(targetConcernId)).resolves.toMatchObject({
      evidenceRefs: expect.arrayContaining([
        { kind: 'runtime', ref: 'source:mergeable' },
      ]),
    });
  });
});
