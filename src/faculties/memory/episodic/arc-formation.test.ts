import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { FakeEpisodicPool } from '../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import {
  type EpisodeCreateInput,
} from './store-port.js';
import {
  EpisodeArcWeaver,
  parseProposedArcs,
  type ArcFormationOutcomeEvent,
} from './arc-formation.js';
import type { ThreadAssignmentEvent } from './thread-assignment.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../../shared/logger.js';

const NOW = new Date('2026-06-10T08:00:00.000Z');

function arcResponse(arcs: unknown[]): { content: string } {
  return { content: JSON.stringify({ arcs }) } as { content: string };
}

describe('EpisodeArcWeaver', () => {
  function makeStore(): PostgresEpisodicStore {
    return new PostgresEpisodicStore(new FakeEpisodicPool() as unknown as Pool, { now: () => NOW });
  }

  function episodeInput(
    id: string,
    startedAt: string,
    endedAt: string,
    overrides: Partial<EpisodeCreateInput> = {},
  ): EpisodeCreateInput {
    return {
      id,
      title: `Episode ${id}`,
      landmark: `Things happened during ${id}.`,
      startedAt,
      endedAt,
      threadId: 'discord:main',
      channelId: 'discord:main',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.6 },
      affect: { labels: ['neutral'] },
      themes: ['postgres', 'memory'],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'session', refId: 'discord:main' }],
      ...overrides,
    };
  }

  async function seedWeekOfEpisodes(store: PostgresEpisodicStore): Promise<void> {
    await store.createEpisode(episodeInput('day1', '2026-06-04T20:00:00.000Z', '2026-06-04T21:00:00.000Z'));
    await store.createEpisode(episodeInput('day2', '2026-06-06T20:00:00.000Z', '2026-06-06T21:00:00.000Z'));
    await store.createEpisode(episodeInput('day3', '2026-06-08T20:00:00.000Z', '2026-06-08T21:00:00.000Z'));
    await store.createEpisode(episodeInput('other', '2026-06-07T10:00:00.000Z', '2026-06-07T10:30:00.000Z', {
      themes: ['cooking'],
    }));
  }

  it('writes chained arcs for an LLM-approved story across days', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);

    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['day1', 'day2', 'day3'],
      kind: 'continuation',
      label: 'postgres memory cutover',
      confidence: 0.85,
      reason: 'the same project continues across three evenings',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });

    expect(result.ran).toBe(true);
    expect(result.proposedArcs).toBe(1);
    expect(result.writtenArcs).toBe(2);

    const day1Arcs = await store.listEpisodeArcsForEpisode('day1', { direction: 'outgoing' });
    expect(day1Arcs).toHaveLength(1);
    expect(day1Arcs[0].targetEpisodeId).toBe('day2');
    expect(day1Arcs[0].arcKind).toBe('continuation');
    expect(day1Arcs[0].themes).toEqual(['postgres memory cutover']);
    expect(day1Arcs[0].confidence).toBe(0.85);

    const day2Arcs = await store.listEpisodeArcsForEpisode('day2', { direction: 'outgoing' });
    expect(day2Arcs.map(arc => arc.targetEpisodeId)).toEqual(['day3']);
  });

  it('respects the pass cadence via its watermark', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);

    const complete = vi.fn(async () => arcResponse([]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const first = await weaver.run({ sessionId: 'discord:main' });
    clearDiagnosticLogRingBufferForTests();
    const second = await weaver.run({ sessionId: 'discord:main' });

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe('cadence');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(getRecentDiagnosticLogRecords()[0]?.message).toContain('cadence has not elapsed');
  });

  it('skips when there are not enough episodes to weave', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('only', '2026-06-08T20:00:00.000Z', '2026-06-08T21:00:00.000Z'));

    const complete = vi.fn(async () => arcResponse([]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('not_enough_episodes');
    expect(complete).not.toHaveBeenCalled();
    expect(getRecentDiagnosticLogRecords()[0]?.message).toContain('not enough canonical episodes');
  });

  it('rejects low-confidence proposals and survives invalid LLM output', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);

    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['day1', 'day2'],
      kind: 'same_theme',
      label: 'maybe related',
      confidence: 0.3,
      reason: 'weak hunch',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });
    expect(result.proposedArcs).toBe(1);
    expect(result.writtenArcs).toBe(0);
    expect(result.rejectedArcs).toBe(1);

    const invalidWeaver = new EpisodeArcWeaver(
      store,
      { complete: vi.fn(async () => ({ content: 'garbage' }) as { content: string }) },
      { now: () => NOW, passIntervalMs: 0 },
    );
    const invalidResult = await invalidWeaver.run({ sessionId: 'discord:main' });
    expect(invalidResult.ran).toBe(true);
    expect(invalidResult.proposedArcs).toBe(0);
    expect(invalidResult.writtenArcs).toBe(0);
  });

  it('writes valid proposals even when a sibling proposal references an unknown id', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);

    const complete = vi.fn(async () => arcResponse([
      {
        episode_ids: ['day1', 'not-a-real-episode'],
        kind: 'continuation',
        label: 'hallucinated thread',
        confidence: 0.9,
        reason: 'made up',
      },
      {
        episode_ids: ['day1', 'day2'],
        kind: 'continuation',
        label: 'postgres memory cutover',
        confidence: 0.85,
        reason: 'continues',
      },
    ]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });

    expect(result.proposedArcs).toBe(2);
    expect(result.rejectedArcs).toBe(1);
    expect(result.writtenArcs).toBe(1);
    const day1Arcs = await store.listEpisodeArcsForEpisode('day1', { direction: 'outgoing' });
    expect(day1Arcs.map(arc => arc.targetEpisodeId)).toEqual(['day2']);
  });

  it('links same-theme canonical episodes across non-adjacent days into one arc', async () => {
    const store = makeStore();
    // The book discussed on day 1 and again on day 3, with unrelated
    // episodes in between: the thread is about the book, not about a day.
    await store.createEpisode(episodeInput('book-monday', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z', {
      themes: ['the left hand of darkness', 'books'],
    }));
    await store.createEpisode(episodeInput('errands', '2026-06-02T10:00:00.000Z', '2026-06-02T10:30:00.000Z', {
      themes: ['groceries'],
    }));
    await store.createEpisode(episodeInput('weather', '2026-06-02T18:00:00.000Z', '2026-06-02T18:20:00.000Z', {
      themes: ['weather'],
    }));
    await store.createEpisode(episodeInput('book-wednesday', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z', {
      themes: ['the left hand of darkness', 'books'],
    }));

    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['book-monday', 'book-wednesday'],
      kind: 'same_theme',
      label: 'the ongoing left hand of darkness discussion',
      confidence: 0.9,
      reason: 'the same book discussion resumes two days later',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });

    expect(result.ran).toBe(true);
    expect(result.writtenArcs).toBe(1);
    const arcs = await store.listEpisodeArcsForEpisode('book-monday', { direction: 'outgoing' });
    expect(arcs).toHaveLength(1);
    expect(arcs[0].targetEpisodeId).toBe('book-wednesday');
    expect(arcs[0].arcKind).toBe('same_theme');
    expect(arcs[0].themes).toEqual(['the ongoing left hand of darkness discussion']);
    // The unrelated day-2 episodes stay out of the thread.
    expect(await store.listEpisodeArcsForEpisode('errands')).toHaveLength(0);
    expect(await store.listEpisodeArcsForEpisode('weather')).toHaveLength(0);

    // Arc writes carry arc-formation provenance in the audit trail.
    const audit = await store.listEpisodeArcAudit({ arcId: arcs[0].id });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('written');
    expect(audit[0].actor).toBe('arc_formation_pass');
    expect(audit[0].reason).toBe('the same book discussion resumes two days later');
  });

  it('materializes bounded topic threads: an arc unions two singleton threads (apq0)', async () => {
    const store = makeStore();
    // A multi-topic history: four canonical episodes, each seeded as its own
    // singleton topic thread (threadId = its own id, the apq0 default). Only
    // the two book episodes belong to one story.
    await store.createEpisode(episodeInput('ep-book-1', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z', {
      threadId: 'ep-book-1',
      themes: ['the left hand of darkness', 'books'],
    }));
    await store.createEpisode(episodeInput('ep-cooking', '2026-06-02T10:00:00.000Z', '2026-06-02T10:30:00.000Z', {
      threadId: 'ep-cooking',
      themes: ['cooking'],
    }));
    await store.createEpisode(episodeInput('ep-weather', '2026-06-02T18:00:00.000Z', '2026-06-02T18:20:00.000Z', {
      threadId: 'ep-weather',
      themes: ['weather'],
    }));
    await store.createEpisode(episodeInput('ep-book-2', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z', {
      threadId: 'ep-book-2',
      themes: ['the left hand of darkness', 'books'],
    }));

    const events: ThreadAssignmentEvent[] = [];
    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['ep-book-1', 'ep-book-2'],
      kind: 'same_theme',
      label: 'the ongoing left hand of darkness discussion',
      confidence: 0.9,
      reason: 'the same book discussion resumes two days later',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, {
      now: () => NOW,
      onThreadAssignment: event => events.push(event),
    });

    const result = await weaver.run({ sessionId: 'discord:main' });
    expect(result.writtenArcs).toBe(1);

    // The two book episodes now share one bounded topic thread, represented by
    // the min episode id. The unrelated episodes keep their own threads.
    const bookThread = await store.searchByThread('ep-book-1', { limit: 10 });
    expect(bookThread.map(episode => episode.id).sort()).toEqual(['ep-book-1', 'ep-book-2']);
    expect(await store.searchByThread('ep-book-2', { limit: 10 })).toEqual([]);
    expect((await store.searchByThread('ep-cooking', { limit: 10 })).map(e => e.id)).toEqual(['ep-cooking']);
    expect((await store.searchByThread('ep-weather', { limit: 10 })).map(e => e.id)).toEqual(['ep-weather']);
    expect(events).toEqual([{
      outcome: 'merged',
      winningThreadId: 'ep-book-1',
      losingThreadId: 'ep-book-2',
      updatedEpisodeCount: 1,
      timestamp: NOW.getTime(),
    }]);
  });

  it('a continuation chain resumes onto one thread across all its episodes (apq0)', async () => {
    const store = makeStore();
    // Three singleton-threaded episodes of one continuing effort, ids chosen
    // so the global minimum is the newest ('x-day3').
    await store.createEpisode(episodeInput('z-day1', '2026-06-04T20:00:00.000Z', '2026-06-04T21:00:00.000Z', {
      threadId: 'z-day1',
    }));
    await store.createEpisode(episodeInput('y-day2', '2026-06-06T20:00:00.000Z', '2026-06-06T21:00:00.000Z', {
      threadId: 'y-day2',
    }));
    await store.createEpisode(episodeInput('x-day3', '2026-06-08T20:00:00.000Z', '2026-06-08T21:00:00.000Z', {
      threadId: 'x-day3',
    }));
    // A fourth, unrelated episode so the pass clears MIN_EPISODES_FOR_PASS; it
    // stays out of the continuation proposal and keeps its own thread.
    await store.createEpisode(episodeInput('m-other', '2026-06-07T10:00:00.000Z', '2026-06-07T10:30:00.000Z', {
      threadId: 'm-other',
      themes: ['cooking'],
    }));

    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['z-day1', 'y-day2', 'x-day3'],
      kind: 'continuation',
      label: 'the postgres cutover effort',
      confidence: 0.88,
      reason: 'one effort progressing across three evenings',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });
    expect(result.writtenArcs).toBe(2);

    // All three converge on the global minimum id regardless of merge order.
    const thread = await store.searchByThread('x-day3', { limit: 10 });
    expect(thread.map(episode => episode.startedAt.slice(0, 10))).toEqual([
      '2026-06-04',
      '2026-06-06',
      '2026-06-08',
    ]);
    expect(await store.searchByThread('z-day1', { limit: 10 })).toEqual([]);
    expect(await store.searchByThread('y-day2', { limit: 10 })).toEqual([]);
  });

  it('extracts arc-linked members out of a legacy session mega-thread instead of no-oping inside it (apq0)', async () => {
    const store = makeStore();
    // All four episodes carry the pre-apq0 session-keyed thread 'discord:main'
    // (threadId equals the span sessionId — the per-channel mega-thread).
    await store.createEpisode(episodeInput('day1', '2026-06-04T20:00:00.000Z', '2026-06-04T21:00:00.000Z'));
    await store.createEpisode(episodeInput('day2', '2026-06-06T20:00:00.000Z', '2026-06-06T21:00:00.000Z'));
    await store.createEpisode(episodeInput('day3', '2026-06-08T20:00:00.000Z', '2026-06-08T21:00:00.000Z'));
    await store.createEpisode(episodeInput('day4', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    const events: ThreadAssignmentEvent[] = [];
    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['day1', 'day2'],
      kind: 'continuation',
      label: 'the postgres cutover effort',
      confidence: 0.85,
      reason: 'continues',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, {
      now: () => NOW,
      onThreadAssignment: event => events.push(event),
    });

    await weaver.run({ sessionId: 'discord:main' });

    // The arc-linked pair peeled off into a real topic thread; the uninvolved
    // members stay in the legacy bucket (h4fp.7 owns full historical repair).
    // Pre-fix this was a silent noop and the mega-thread kept accreting.
    const topic = await store.searchByThread('day1', { limit: 10 });
    expect(topic.map(episode => episode.id).sort()).toEqual(['day1', 'day2']);
    const legacy = await store.searchByThread('discord:main', { limit: 10 });
    expect(legacy.map(episode => episode.id).sort()).toEqual(['day3', 'day4']);
    expect(events.map(event => event.outcome)).toEqual([
      'legacy_session_thread_extracted',
      'legacy_session_thread_extracted',
      'merged',
    ]);
  });

  it('leaves threads untouched when linked episodes already share a topic thread (apq0 no-op)', async () => {
    const store = makeStore();
    // Both episodes already share the real topic thread 'day1'.
    await store.createEpisode(episodeInput('day1', '2026-06-04T20:00:00.000Z', '2026-06-04T21:00:00.000Z', { threadId: 'day1' }));
    await store.createEpisode(episodeInput('day2', '2026-06-06T20:00:00.000Z', '2026-06-06T21:00:00.000Z', { threadId: 'day1' }));
    await store.createEpisode(episodeInput('day3', '2026-06-08T20:00:00.000Z', '2026-06-08T21:00:00.000Z', { threadId: 'day3' }));
    await store.createEpisode(episodeInput('day4', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z', { threadId: 'day4' }));

    const events: ThreadAssignmentEvent[] = [];
    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['day1', 'day2'],
      kind: 'continuation',
      label: 'shared thread already',
      confidence: 0.85,
      reason: 'continues',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, {
      now: () => NOW,
      onThreadAssignment: event => events.push(event),
    });

    await weaver.run({ sessionId: 'discord:main' });

    const shared = await store.searchByThread('day1', { limit: 10 });
    expect(shared.map(episode => episode.id).sort()).toEqual(['day1', 'day2']);
    expect(events).toEqual([{
      outcome: 'noop',
      winningThreadId: 'day1',
      losingThreadId: 'day1',
      updatedEpisodeCount: 0,
      timestamp: NOW.getTime(),
    }]);
  });

  it('excludes candidate episodes from arc formation entirely', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);
    await store.createEpisode(episodeInput('cand-1', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z', {
      lifecycleStatus: 'candidate',
    }));
    await store.createEpisode(episodeInput('cand-2', '2026-06-09T21:30:00.000Z', '2026-06-09T22:00:00.000Z', {
      lifecycleStatus: 'candidate',
    }));

    const complete = vi.fn(async (request: { messages: Array<{ content: string }> }) => {
      // Candidates must never reach the judgment prompt: they may be
      // superseded by that night's consolidation pass.
      expect(request.messages[0].content).not.toContain('cand-1');
      expect(request.messages[0].content).not.toContain('cand-2');
      return arcResponse([{
        episode_ids: ['day1', 'cand-1'],
        kind: 'continuation',
        label: 'should be rejected',
        confidence: 0.9,
        reason: 'references a candidate',
      }]);
    });
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });

    expect(result.ran).toBe(true);
    expect(result.reviewedEpisodes).toBe(4);
    // A proposal referencing a candidate id is rejected as unknown.
    expect(result.rejectedArcs).toBe(1);
    expect(result.writtenArcs).toBe(0);
    expect(await store.listEpisodeArcsForEpisode('cand-1')).toHaveLength(0);
  });

  it('emits typed outcome events for rejected proposals and failed judgments', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);
    const events: ArcFormationOutcomeEvent[] = [];

    const complete = vi.fn(async () => arcResponse([
      {
        episode_ids: ['day1', 'not-a-real-episode'],
        kind: 'continuation',
        label: 'hallucinated thread',
        confidence: 0.9,
        reason: 'made up',
      },
      {
        episode_ids: ['day2', 'day3'],
        kind: 'same_theme',
        label: 'weak hunch',
        confidence: 0.2,
        reason: 'low confidence',
      },
    ]));
    const weaver = new EpisodeArcWeaver(store, { complete }, {
      now: () => NOW,
      onEvent: event => events.push(event),
    });
    await weaver.run({ sessionId: 'discord:main' });

    expect(events).toHaveLength(2);
    expect(events[0].outcome).toBe('proposal_rejected');
    expect(events[0].reason).toMatch(/unknown episode id "not-a-real-episode"/);
    expect(events[1].outcome).toBe('proposal_rejected');
    expect(events[1].reason).toMatch(/below the minConfidence floor/);
    expect(events[1].label).toBe('weak hunch');
    expect(events[1].confidence).toBe(0.2);

    const failureEvents: ArcFormationOutcomeEvent[] = [];
    const failingWeaver = new EpisodeArcWeaver(
      store,
      { complete: vi.fn(async () => ({ content: 'garbage' }) as { content: string }) },
      { now: () => NOW, passIntervalMs: 0, onEvent: event => failureEvents.push(event) },
    );
    await failingWeaver.run({ sessionId: 'discord:main' });

    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0].outcome).toBe('judgment_failed');
    expect(failureEvents[0].reason).toMatch(/no JSON object/);
  });

  it('does not duplicate arcs that already exist between two episodes', async () => {
    const store = makeStore();
    await seedWeekOfEpisodes(store);
    await store.writeEpisodeArc({
      sourceEpisodeId: 'day1',
      targetEpisodeId: 'day2',
      arcKind: 'same_theme',
      salience: 0.6,
      confidence: 0.6,
      themes: ['postgres'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });

    const complete = vi.fn(async () => arcResponse([{
      episode_ids: ['day1', 'day2', 'day3'],
      kind: 'continuation',
      label: 'postgres memory cutover',
      confidence: 0.9,
      reason: 'continues',
    }]));
    const weaver = new EpisodeArcWeaver(store, { complete }, { now: () => NOW });

    const result = await weaver.run({ sessionId: 'discord:main' });

    // day1->day2 already linked; only day2->day3 is new.
    expect(result.writtenArcs).toBe(1);
    const day2Outgoing = await store.listEpisodeArcsForEpisode('day2', { direction: 'outgoing' });
    expect(day2Outgoing.map(arc => arc.targetEpisodeId)).toEqual(['day3']);
  });

  it('replays thread assignment for a persisted arc without requiring an LLM re-proposal', async () => {
    const store = makeStore();
    const day1 = episodeInput(
      'day1',
      '2025-06-04T20:00:00.000Z',
      '2025-06-04T21:00:00.000Z',
    );
    const day2 = episodeInput(
      'day2',
      '2026-06-06T20:00:00.000Z',
      '2026-06-06T21:00:00.000Z',
    );
    delete day1.threadId;
    delete day2.threadId;
    await store.createEpisode(day1);
    await store.createEpisode(day2);
    await store.writeEpisodeArc({
      sourceEpisodeId: 'day1',
      targetEpisodeId: 'day2',
      arcKind: 'same_theme',
      salience: 0.6,
      confidence: 0.9,
      themes: ['postgres'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });
    const weaver = new EpisodeArcWeaver(
      store,
      { complete: vi.fn(async () => arcResponse([])) },
      { now: () => NOW },
    );

    const result = await weaver.run({ sessionId: 'discord:main' });

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('not_enough_episodes');
    expect(result.writtenArcs).toBe(0);
    expect((await store.getEpisode('day1'))?.threadId).toBe('day1');
    expect((await store.getEpisode('day2'))?.threadId).toBe('day1');
  });

  it('refreshes every moved member while reconciling a persisted arc chain', async () => {
    const store = makeStore();
    for (const [id, threadId, day] of [
      ['a', 'a', '01'],
      ['b', 'b', '02'],
      ['c', 'b', '03'],
      ['d', 'd', '04'],
    ] as const) {
      await store.createEpisode(episodeInput(
        id,
        `2025-06-${day}T20:00:00.000Z`,
        `2025-06-${day}T21:00:00.000Z`,
        { threadId },
      ));
    }
    await store.writeEpisodeArc({
      id: 'arc-1',
      sourceEpisodeId: 'a',
      targetEpisodeId: 'b',
      arcKind: 'same_theme',
      salience: 0.6,
      confidence: 0.9,
      themes: ['postgres'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });
    await store.writeEpisodeArc({
      id: 'arc-2',
      sourceEpisodeId: 'c',
      targetEpisodeId: 'd',
      arcKind: 'continuation',
      salience: 0.6,
      confidence: 0.9,
      themes: ['postgres'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });
    const weaver = new EpisodeArcWeaver(
      store,
      { complete: vi.fn(async () => arcResponse([])) },
      { now: () => NOW },
    );

    await weaver.run({ sessionId: 'discord:main' });

    for (const id of ['a', 'b', 'c', 'd']) {
      expect((await store.getEpisode(id))?.threadId).toBe('a');
    }
  });
});

describe('parseProposedArcs', () => {
  const known = new Set(['a', 'b', 'c']);

  it('drops proposals with unknown episode ids and reports the reason', () => {
    const result = parseProposedArcs(JSON.stringify({
      arcs: [{ episode_ids: ['a', 'zzz'], kind: 'continuation', label: 'x', confidence: 0.8 }],
    }), known);
    expect(result.proposals).toHaveLength(0);
    expect(result.rejectedProposals).toEqual([expect.stringMatching(/unknown episode id "zzz"/)]);
  });

  it('keeps valid proposals when a sibling proposal is invalid', () => {
    const result = parseProposedArcs(JSON.stringify({
      arcs: [
        { episode_ids: ['a', 'zzz'], kind: 'continuation', label: 'bad', confidence: 0.8 },
        { episode_ids: ['a', 'b'], kind: 'continuation', label: 'good', confidence: 0.8 },
      ],
    }), known);
    expect(result.proposals.map(proposal => proposal.label)).toEqual(['good']);
    expect(result.rejectedProposals).toHaveLength(1);
  });

  it('resolves ids the model echoed without their episode: prefix', () => {
    const prefixed = new Set(['episode:017e', 'episode:b9c5']);
    const result = parseProposedArcs(JSON.stringify({
      arcs: [{ episode_ids: ['017e', 'episode:b9c5'], kind: 'continuation', label: 'x', confidence: 0.8 }],
    }), prefixed);
    expect(result.rejectedProposals).toHaveLength(0);
    expect(result.proposals[0].episodeIds).toEqual(['episode:017e', 'episode:b9c5']);
  });

  it('rejects operator_defined as a machine arc kind', () => {
    const result = parseProposedArcs(JSON.stringify({
      arcs: [{ episode_ids: ['a', 'b'], kind: 'operator_defined', label: 'x', confidence: 0.8 }],
    }), known);
    expect(result.proposals).toHaveLength(0);
    expect(result.rejectedProposals).toEqual([expect.stringMatching(/not a valid machine arc kind/)]);
  });

  it('rejects single-episode arcs', () => {
    const result = parseProposedArcs(JSON.stringify({
      arcs: [{ episode_ids: ['a'], kind: 'continuation', label: 'x', confidence: 0.8 }],
    }), known);
    expect(result.proposals).toHaveLength(0);
    expect(result.rejectedProposals).toEqual([expect.stringMatching(/at least two/)]);
  });

  it('still fails closed when the response has no arcs array', () => {
    expect(() => parseProposedArcs(JSON.stringify({ nope: true }), known)).toThrow(/arcs array/);
  });
});
