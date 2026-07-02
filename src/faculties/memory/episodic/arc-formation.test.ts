import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EpisodicStore, type EpisodeCreateInput } from './store.js';
import {
  EpisodeArcWeaver,
  parseProposedArcs,
  type ArcFormationOutcomeEvent,
} from './arc-formation.js';

const NOW = new Date('2026-06-10T08:00:00.000Z');

function arcResponse(arcs: unknown[]): { content: string } {
  return { content: JSON.stringify({ arcs }) } as { content: string };
}

describe('EpisodeArcWeaver', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeStore(): EpisodicStore {
    db = new Database(':memory:');
    return new EpisodicStore(db, { now: () => NOW });
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

  async function seedWeekOfEpisodes(store: EpisodicStore): Promise<void> {
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
    const second = await weaver.run({ sessionId: 'discord:main' });

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe('cadence');
    expect(complete).toHaveBeenCalledTimes(1);
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
