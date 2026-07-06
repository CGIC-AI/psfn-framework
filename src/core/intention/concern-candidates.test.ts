import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../agent/contracts.js';
import { EventBus, type DeterministicGateEvent } from '../../shared/event-bus.js';
import { createConcernStorePort } from './concern-store-port.js';
import { ActiveConcernStore } from './sqlite-stores/active-concern-store.js';
import {
  ConcernCandidateQueue,
  ConcernCandidateReviewer,
  ConcernCandidateWorker,
  applyConcernCandidateReview,
  buildConcernCandidateReviewPrompt,
  deriveConcernCandidatesFromExtraction,
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
  const db = new Database(':memory:');
  let counter = 0;
  return createConcernStorePort(new ActiveConcernStore(db, {
    now: () => new Date('2026-06-29T12:00:00.000Z'),
    idFactory: () => `concern-${++counter}`,
  }));
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
    expect(prompt).toContain('conversationContext');
    expect(prompt).toContain('relatedMemoryContext');
    expect(prompt.toLowerCase()).not.toMatch(/\b(critical|must|urgent|constant-check)\b/);
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
      reason: 'active concern cap 7 reached; candidate kept out of active concerns',
    }]);
    expect(await concernStore.getActiveConcerns()).toHaveLength(7);
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
