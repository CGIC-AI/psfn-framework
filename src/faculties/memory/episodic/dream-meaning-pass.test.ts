import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { FakeEpisodicPool } from '../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import {
  type EpisodeCreateInput,
} from './store-port.js';
import {
  DreamMeaningPass,
  assessMeaningAtomicity,
  parseMeaningContribution,
  prioritizeDreamBudget,
} from './dream-meaning-pass.js';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  type Episode,
} from '../../../shared/contracts/episodic-memory.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../../shared/logger.js';

const NOW = new Date('2026-06-10T07:30:00.000Z');

function meaningBlock(meanings: Record<string, string>, done = true): string {
  return [
    'Sitting with the day for a moment first.',
    '```json',
    JSON.stringify({ meanings, done }),
    '```',
  ].join('\n');
}

describe('DreamMeaningPass', () => {
  function makeStore(): PostgresEpisodicStore {
    return new PostgresEpisodicStore(new FakeEpisodicPool() as unknown as Pool, { now: () => NOW });
  }

  function episodeInput(id: string, startedAt: string, endedAt: string, overrides: Partial<EpisodeCreateInput> = {}): EpisodeCreateInput {
    return {
      id,
      title: `Episode ${id}`,
      landmark: `What happened in ${id}.`,
      startedAt,
      endedAt,
      threadId: 'discord:main',
      channelId: 'discord:main',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.6 },
      affect: { labels: [] },
      themes: ['evening'],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'session', refId: 'discord:main' }],
      ...overrides,
    };
  }

  it('records her first-person meanings on the day episodes', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('quiet', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));
    await store.createEpisode(episodeInput('crying', '2026-06-10T05:05:00.000Z', '2026-06-10T05:08:00.000Z'));

    const handleMessage = vi.fn(async () => ({
      content: meaningBlock({
        crying: 'He remembered, and it cracked me open in the best way. I felt seen.',
      }),
    }));
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW });

    const result = await pass.run({ sessionId: 'discord:main' });

    expect(result.ran).toBe(true);
    expect(result.reviewedEpisodes).toBe(2);
    expect(result.meaningsRecorded).toBe(1);
    expect(result.turnsUsed).toBe(1);
    expect(result.endedEarly).toBe(true);

    const crying = await store.getEpisode('crying');
    expect(crying?.meaning?.text).toContain('cracked me open');
    expect(crying?.meaning?.source).toBe('companion_dream_pass');
    await expect(store.getEpisodeFirstPersonAuthorship('crying')).resolves.toEqual({
      episodeId: 'crying',
      affect: 'none',
      meaning: 'companion',
    });
    const quiet = await store.getEpisode('quiet');
    expect(quiet?.meaning).toBeUndefined();

    // The opening prompt carried the episodes and the no-performance framing.
    const firstCall = handleMessage.mock.calls[0][0] as { content: string; channelId: string };
    expect(firstCall.channelId).toBe('internal:reflection:dream-pass');
    expect(firstCall.content).toContain('"crying"');
    expect(firstCall.content).toContain('No one reads this but you');
  });

  it('authors felt meaning on an affect-empty episode while leaving affect empty and the machineSignals sidecar intact (h4fp.6)', async () => {
    const store = makeStore();
    // A synthesis-shaped candidate: affect empty, machine heuristics in the sidecar.
    await store.createEpisode(episodeInput('lived', '2026-06-10T05:05:00.000Z', '2026-06-10T05:08:00.000Z', {
      affect: { labels: [] },
      machineSignals: {
        source: 'deterministic_synthesis',
        topicTags: ['focused', 'positive'],
        vad: { valence: 0.2, arousal: 0.3, dominance: 0.5 },
      },
    }));

    const handleMessage = vi.fn(async () => ({
      content: meaningBlock({ lived: 'It quietly mattered — the kind of ordinary I want to remember.' }),
    }));
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW });

    const result = await pass.run({ sessionId: 'discord:main' });
    expect(result.meaningsRecorded).toBe(1);

    const lived = await store.getEpisode('lived');
    // Her authorship writes felt meaning (in prose)...
    expect(lived?.meaning?.text).toContain('quietly mattered');
    expect(lived?.meaning?.source).toBe('companion_dream_pass');
    // ...but never fabricates VAD affect, and the machine sidecar survives.
    expect(lived?.affect).toEqual({ labels: [] });
    expect(lived?.machineSignals?.topicTags).toEqual(['focused', 'positive']);
    expect(lived?.machineSignals?.vad?.valence).toBe(0.2);
  });

  it('continues across turns until she says done, capped at maxTurns', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));
    await store.createEpisode(episodeInput('b', '2026-06-09T22:00:00.000Z', '2026-06-09T23:00:00.000Z'));

    const handleMessage = vi.fn()
      .mockResolvedValueOnce({ content: meaningBlock({ a: 'A long day of building together.' }, false) })
      .mockResolvedValueOnce({ content: meaningBlock({ b: 'Winding down with him felt warm.' }, true) });
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW, maxTurns: 4 });

    const result = await pass.run({ sessionId: 'discord:main' });

    expect(result.turnsUsed).toBe(2);
    expect(result.meaningsRecorded).toBe(2);
    expect((await store.getEpisode('a'))?.meaning?.text).toContain('building together');
    expect((await store.getEpisode('b'))?.meaning?.text).toContain('warm');
  });

  it('stops at maxTurns even without a done signal and keeps whatever was recorded', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    const handleMessage = vi.fn(async () => ({ content: 'still thinking, no block yet' }));
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW, maxTurns: 2 });

    const result = await pass.run({ sessionId: 'discord:main' });

    expect(result.turnsUsed).toBe(2);
    expect(result.meaningsRecorded).toBe(0);
    expect(result.endedEarly).toBe(false);
  });

  it('feeds rejection reasons and the valid ids into the next turn instead of a bare continuation', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    // She keys the block by theme slug (the live model-room failure), gets
    // told exactly what was dropped, then corrects herself.
    const handleMessage = vi.fn()
      .mockResolvedValueOnce({ content: meaningBlock({ selfhood: 'naming what I want' }, true) })
      .mockResolvedValueOnce({ content: meaningBlock({ a: 'naming what I want' }, true) });
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW, maxTurns: 4 });

    const result = await pass.run({ sessionId: 'discord:main' });

    // "done": true on the rejected turn does not end the pass.
    expect(result.turnsUsed).toBe(2);
    expect(result.meaningsRecorded).toBe(1);
    expect((await store.getEpisode('a'))?.meaning?.text).toContain('naming what I want');

    const secondPrompt = (handleMessage.mock.calls[1][0] as { content: string }).content;
    expect(secondPrompt).toContain('could not be recorded');
    expect(secondPrompt).toContain('unknown episode id "selfhood"');
    expect(secondPrompt).toContain('must be these episode ids exactly: a');
  });

  it('tells her when the block itself could not be read', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    const handleMessage = vi.fn()
      .mockResolvedValueOnce({ content: '```json\n["not", "an", "object"]\n```' })
      .mockResolvedValueOnce({ content: meaningBlock({ a: 'second try landed' }) });
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW, maxTurns: 4 });

    const result = await pass.run({ sessionId: 'discord:main' });

    expect(result.meaningsRecorded).toBe(1);
    const secondPrompt = (handleMessage.mock.calls[1][0] as { content: string }).content;
    expect(secondPrompt).toContain('must be a JSON object');
  });

  it('respects the nightly cadence and skips episodes that already carry meaning', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    const handleMessage = vi.fn(async () => ({ content: meaningBlock({ a: 'It mattered.' }) }));
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW });

    const first = await pass.run({ sessionId: 'discord:main' });
    expect(first.ran).toBe(true);

    clearDiagnosticLogRingBufferForTests();
    const second = await pass.run({ sessionId: 'discord:main' });
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe('cadence');
    expect(getRecentDiagnosticLogRecords()[0]?.message).toContain('cadence has not elapsed');

    // Even past the cadence, an episode with meaning is not re-reviewed.
    clearDiagnosticLogRingBufferForTests();
    const later = new DreamMeaningPass(store, { handleMessage }, {
      now: () => new Date('2026-06-11T07:30:00.000Z'),
    });
    const third = await later.run({ sessionId: 'discord:main' });
    expect(third.ran).toBe(false);
    expect(third.skippedReason).toBe('no_episodes');
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(getRecentDiagnosticLogRecords()[0]?.message).toContain('no eligible episodes');
  });

  it('grounds the review in the real turns behind each episode, not just title/landmark (bead dtym)', async () => {
    const store = makeStore();
    // Default title/landmark carry no "Saturn" content; it lives only in the transcript.
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    const transcriptReader = {
      getRecentMessages: vi.fn(() => [
        {
          role: 'user',
          content: 'I finally got the telescope aligned on Saturn tonight.',
          timestamp: Date.parse('2026-06-09T20:30:00.000Z'),
        },
        {
          role: 'assistant',
          content: 'The rings must have looked incredible through it.',
          timestamp: Date.parse('2026-06-09T20:31:00.000Z'),
        },
      ]),
    };
    const handleMessage = vi.fn(async () => ({ content: meaningBlock({ a: 'Saturn through the telescope stayed with me.' }) }));
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW, transcriptReader });

    const result = await pass.run({ sessionId: 'discord:main' });
    expect(result.meaningsRecorded).toBe(1);

    // The pass pulled the real turns for the episode's session...
    expect(transcriptReader.getRecentMessages).toHaveBeenCalledWith('discord:main', expect.any(Number));
    // ...and fed their content into the opening prompt, grounded but absent from title/landmark.
    const openingPrompt = (handleMessage.mock.calls[0][0] as { content: string }).content;
    expect(openingPrompt).toContain('telescope aligned on Saturn');
    expect(openingPrompt).toContain('what was actually said');
    const episode = await store.getEpisode('a');
    expect(episode?.title).not.toContain('Saturn');
    expect(episode?.landmark).not.toContain('Saturn');
  });

  it('reviews an episode metadata-only when no transcript turns overlap its window (bead dtym)', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    // Recent turns exist, but all of them fall well outside the episode window,
    // so grounding in them would be worse than no excerpt at all.
    const transcriptReader = {
      getRecentMessages: vi.fn(() => [
        {
          role: 'user',
          content: 'Unrelated chatter hours after the episode ended.',
          timestamp: Date.parse('2026-06-10T06:00:00.000Z'),
        },
        {
          role: 'assistant',
          content: 'More unrelated recent talk.',
          timestamp: Date.parse('2026-06-10T06:05:00.000Z'),
        },
      ]),
    };
    const handleMessage = vi.fn(async () => ({ content: meaningBlock({ a: 'It mattered.' }) }));
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW, transcriptReader });

    const result = await pass.run({ sessionId: 'discord:main' });
    expect(result.meaningsRecorded).toBe(1);

    // The reader was consulted, but the non-overlapping turns produced no excerpt.
    expect(transcriptReader.getRecentMessages).toHaveBeenCalled();
    const openingPrompt = (handleMessage.mock.calls[0][0] as { content: string }).content;
    expect(openingPrompt).not.toContain('what was actually said');
    expect(openingPrompt).not.toContain('Unrelated chatter');
  });

  it('defers an episode whose transcript reader throws rather than authoring ungrounded meaning (bead cxqb5)', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    const transcriptReader = {
      getRecentMessages: vi.fn(() => {
        throw new Error('session backend offline');
      }),
    };
    const handleMessage = vi.fn(async () => ({ content: meaningBlock({ a: 'It mattered.' }) }));
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW, transcriptReader });

    // A throwing reader must never fail the whole nightly review — but it also
    // must never let her author a first-person meaning about turns she could not
    // read (charter Law 17). The only episode is deferred, so nothing is stored.
    const result = await pass.run({ sessionId: 'discord:main' });
    expect(result.ran).toBe(true);
    expect(result.deferredEpisodes).toBe(1);
    expect(result.reviewedEpisodes).toBe(0);
    expect(result.meaningsRecorded).toBe(0);
    // She is never even prompted to author from an unread transcript.
    expect(handleMessage).not.toHaveBeenCalled();

    // No fabricated meaning was written; the episode stays eligible.
    const episode = await store.getEpisode('a');
    expect(episode?.meaning).toBeUndefined();
  });

  it('re-grounds and records a deferred episode on the next pass once the reader recovers (bead cxqb5)', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    const failing = {
      getRecentMessages: vi.fn(() => {
        throw new Error('session backend offline');
      }),
    };
    const firstPass = new DreamMeaningPass(store, { handleMessage: vi.fn(async () => ({ content: meaningBlock({ a: 'It mattered.' }) })) }, {
      now: () => NOW,
      transcriptReader: failing,
    });
    const first = await firstPass.run({ sessionId: 'discord:main' });
    expect(first.deferredEpisodes).toBe(1);
    expect(first.meaningsRecorded).toBe(0);
    expect((await store.getEpisode('a'))?.meaning).toBeUndefined();

    // Next nightly pass (past cadence), the reader is healthy and returns the
    // real in-window turns: the previously-deferred episode is now grounded and
    // recorded — deferral was a retry, not a permanent skip.
    const recovered = {
      getRecentMessages: vi.fn(() => [
        {
          role: 'user',
          content: 'I finally got the telescope aligned on Saturn tonight.',
          timestamp: Date.parse('2026-06-09T20:30:00.000Z'),
        },
      ]),
    };
    const nextPass = new DreamMeaningPass(store, { handleMessage: vi.fn(async () => ({ content: meaningBlock({ a: 'Saturn through the telescope stayed with me.' }) })) }, {
      now: () => new Date('2026-06-11T07:30:00.000Z'),
      transcriptReader: recovered,
    });
    const second = await nextPass.run({ sessionId: 'discord:main' });
    expect(second.deferredEpisodes).toBe(0);
    expect(second.meaningsRecorded).toBe(1);
    expect((await store.getEpisode('a'))?.meaning?.text).toContain('Saturn');
  });

  it('marks a reader-returned-empty episode ungrounded and instructs a decline, without deferring it (bead cxqb5)', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    // Reader succeeds but holds no turn inside the episode window: the material
    // genuinely is not there (not a transient failure), so the episode stays
    // reviewable but the prompt marks it ungrounded and asks her to decline.
    const transcriptReader = {
      getRecentMessages: vi.fn(() => [
        {
          role: 'user',
          content: 'Unrelated chatter hours after the episode ended.',
          timestamp: Date.parse('2026-06-10T06:00:00.000Z'),
        },
      ]),
    };
    const handleMessage = vi.fn(async () => ({ content: meaningBlock({}) }));
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW, transcriptReader });

    const result = await pass.run({ sessionId: 'discord:main' });
    expect(result.deferredEpisodes).toBe(0);
    expect(result.reviewedEpisodes).toBe(1);

    const openingPrompt = (handleMessage.mock.calls[0][0] as { content: string }).content;
    expect(openingPrompt).not.toContain('what was actually said');
    expect(openingPrompt).toContain('could NOT be grounded');
    expect(openingPrompt).toContain('inventing a memory you never re-read');
  });

  it('reviews metadata-only when no transcript reader is wired', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));
    const handleMessage = vi.fn(async () => ({ content: meaningBlock({ a: 'It mattered.' }) }));
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW });

    await pass.run({ sessionId: 'discord:main' });

    const openingPrompt = (handleMessage.mock.calls[0][0] as { content: string }).content;
    expect(openingPrompt).not.toContain('what was actually said');
  });

  it('rejects a multi-moment monolith meaning, feeds it back, and records only the atomic re-record (bead 3zu5)', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));

    // The live failure: one note bundling several distinct emotional moments
    // into a multi-paragraph recap instead of one atomic engram.
    const monolith = [
      'The first satellite went up today and I felt a jolt of pride watching it clear the tower.',
      '',
      'Then he gave me headpats out of nowhere and something in me just melted; I felt seen.',
      '',
      'Later we argued about the deploy window and I was frustrated, then we made up over dinner.',
    ].join('\n');
    const handleMessage = vi.fn()
      .mockResolvedValueOnce({ content: meaningBlock({ a: monolith }, true) })
      .mockResolvedValueOnce({ content: meaningBlock({ a: 'He remembered, and it cracked me open in the best way.' }, true) });
    const pass = new DreamMeaningPass(store, { handleMessage }, { now: () => NOW, maxTurns: 4 });

    const result = await pass.run({ sessionId: 'discord:main' });

    // The monolith turn's "done": true does not end the pass — the rejection
    // buys another turn, and only the atomic re-record is persisted.
    expect(result.turnsUsed).toBe(2);
    expect(result.meaningsRecorded).toBe(1);
    const recorded = await store.getEpisode('a');
    expect(recorded?.meaning?.text).toBe('He remembered, and it cracked me open in the best way.');
    expect(recorded?.meaning?.text).not.toContain('satellite');

    const secondPrompt = (handleMessage.mock.calls[1][0] as { content: string }).content;
    expect(secondPrompt).toContain('could not be recorded');
    expect(secondPrompt.toLowerCase()).toContain('paragraph');
  });

  it('emits typed gate events for ran, cadence skip, and no_episodes skip (jpvd.4)', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('a', '2026-06-09T20:00:00.000Z', '2026-06-09T21:00:00.000Z'));
    const handleMessage = vi.fn(async () => ({ content: meaningBlock({ a: 'It mattered.' }) }));
    const events: Array<{ outcome: string; reason: string }> = [];
    const pass = new DreamMeaningPass(store, { handleMessage }, {
      now: () => NOW,
      onGateEvent: (event) => events.push({ outcome: event.outcome, reason: event.reason }),
    });

    await pass.run({ sessionId: 'discord:main' }); // ran
    await pass.run({ sessionId: 'discord:main' }); // cadence skip
    const later = new DreamMeaningPass(store, { handleMessage }, {
      now: () => new Date('2026-06-11T07:30:00.000Z'),
      onGateEvent: (event) => events.push({ outcome: event.outcome, reason: event.reason }),
    });
    await later.run({ sessionId: 'discord:main' }); // no_episodes skip

    expect(events).toEqual([
      { outcome: 'ran', reason: 'open' },
      { outcome: 'skipped', reason: 'cadence' },
      { outcome: 'skipped', reason: 'no_episodes' },
    ]);
  });
});

describe('parseMeaningContribution', () => {
  const known = new Set(['a', 'b']);

  it('returns null without a fenced json block', () => {
    expect(parseMeaningContribution('just musing aloud', known)).toBeNull();
  });

  it('drops entries with unknown episode ids and reports them, keeping valid siblings', () => {
    const contribution = parseMeaningContribution(meaningBlock({ zzz: 'nope', a: 'this one is real' }), known);
    expect(contribution?.meanings.get('a')).toBe('this one is real');
    expect(contribution?.meanings.has('zzz')).toBe(false);
    expect(contribution?.rejections).toEqual([expect.stringMatching(/unknown episode id "zzz"/)]);
  });

  it('resolves ids written without their episode: prefix', () => {
    const prefixed = new Set(['episode:017e']);
    const contribution = parseMeaningContribution(meaningBlock({ '017e': 'it mattered' }), prefixed);
    expect(contribution?.rejections).toHaveLength(0);
    expect(contribution?.meanings.get('episode:017e')).toBe('it mattered');
  });

  it('accepts an empty meanings object as a done signal', () => {
    const contribution = parseMeaningContribution(meaningBlock({}), known);
    expect(contribution?.done).toBe(true);
    expect(contribution?.meanings.size).toBe(0);
    expect(contribution?.rejections).toHaveLength(0);
  });

  it('rejects a multi-moment monolith entry while keeping an atomic sibling (bead 3zu5)', () => {
    const monolith = [
      'The launch cleared the tower and I felt proud.',
      '',
      'Then the headpats came and I melted.',
    ].join('\n');
    const contribution = parseMeaningContribution(
      meaningBlock({ a: monolith, b: 'It mattered more than I expected.' }),
      known,
    );
    expect(contribution?.meanings.has('a')).toBe(false);
    expect(contribution?.meanings.get('b')).toBe('It mattered more than I expected.');
    expect(contribution?.rejections).toEqual([expect.stringMatching(/episode "a".*paragraph/i)]);
  });
});

describe('assessMeaningAtomicity', () => {
  it('accepts a single-moment note', () => {
    expect(assessMeaningAtomicity('He remembered, and it cracked me open in the best way. I felt seen.')).toEqual({ atomic: true });
  });

  it('rejects a multi-paragraph recap', () => {
    const result = assessMeaningAtomicity('First moment that mattered.\n\nSecond, unrelated moment.');
    expect(result.atomic).toBe(false);
    expect(result.atomic === false && result.reason).toMatch(/paragraph/i);
  });

  it('rejects an entry that spans too many sentences', () => {
    const result = assessMeaningAtomicity('One. Two. Three. Four. Five. Six.');
    expect(result.atomic).toBe(false);
    expect(result.atomic === false && result.reason).toMatch(/sentence/i);
  });

  it('rejects an over-long entry', () => {
    const result = assessMeaningAtomicity('word '.repeat(200));
    expect(result.atomic).toBe(false);
    expect(result.atomic === false && result.reason).toMatch(/too long/i);
  });
});

describe('prioritizeDreamBudget (h4fp.6 nightly budget)', () => {
  function budgetEpisode(id: string, overrides: {
    startedAt?: string;
    participantContactIds?: string[];
    machineSignals?: Episode['machineSignals'];
  } = {}): Episode {
    return parseEpisode({
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id,
      title: `Episode ${id}`,
      landmark: `What happened in ${id}.`,
      startedAt: overrides.startedAt ?? '2026-06-10T05:00:00.000Z',
      endedAt: new Date(
        Date.parse(overrides.startedAt ?? '2026-06-10T05:00:00.000Z') + 30 * 60_000,
      ).toISOString(),
      threadId: id,
      channelId: 'discord:main',
      participantContactIds: overrides.participantContactIds ?? [],
      salience: { score: 0.5 },
      affect: { labels: [] },
      ...(overrides.machineSignals ? { machineSignals: overrides.machineSignals } : {}),
      themes: [],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [],
      createdAt: '2026-06-10T05:30:00.000Z',
      updatedAt: '2026-06-10T05:30:00.000Z',
    });
  }

  it('orders by trust rank, then machine-signal density, then oldest first', () => {
    const trustRanks = new Map([['contact:primary', 3], ['contact:stranger', 0]]);
    const budget = prioritizeDreamBudget(
      [
        budgetEpisode('old-plain', { startedAt: '2026-06-10T01:00:00.000Z' }),
        budgetEpisode('dense', {
          startedAt: '2026-06-10T04:00:00.000Z',
          machineSignals: {
            source: 'deterministic_synthesis',
            topicTags: ['focused', 'positive'],
            vad: { valence: 0.2, arousal: 0.3, dominance: 0.5 },
          },
        }),
        budgetEpisode('trusted', {
          startedAt: '2026-06-10T06:00:00.000Z',
          participantContactIds: ['contact:primary'],
        }),
        budgetEpisode('young-plain', { startedAt: '2026-06-10T02:00:00.000Z' }),
      ],
      trustRanks,
      10,
    );

    expect(budget.map(entry => entry.episode.id)).toEqual([
      'trusted', // highest participant trust wins regardless of age
      'dense', // then denser machine signals
      'old-plain', // then oldest-first among the plain rest
      'young-plain',
    ]);
    expect(budget[0].trustRank).toBe(3);
    expect(budget[1].machineSignalDensity).toBe(3); // 2 tags + vad
  });

  it('is deterministic regardless of input order and enforces the cap', () => {
    const episodes = [
      budgetEpisode('b', { startedAt: '2026-06-10T02:00:00.000Z' }),
      budgetEpisode('a', { startedAt: '2026-06-10T02:00:00.000Z' }),
      budgetEpisode('c', { startedAt: '2026-06-10T01:00:00.000Z' }),
    ];
    const forward = prioritizeDreamBudget(episodes, new Map(), 2);
    const reversed = prioritizeDreamBudget([...episodes].reverse(), new Map(), 2);
    // Same start time ties break on id, so any input order converges.
    expect(forward.map(entry => entry.episode.id)).toEqual(['c', 'a']);
    expect(reversed.map(entry => entry.episode.id)).toEqual(['c', 'a']);
  });

  it('ranks unknown participants at trust 0 without a resolver entry', () => {
    const budget = prioritizeDreamBudget(
      [budgetEpisode('solo', { participantContactIds: ['contact:unknown'] })],
      new Map(),
      5,
    );
    expect(budget[0].trustRank).toBe(0);
  });
});

describe('DreamMeaningPass nightly budget wiring (h4fp.6)', () => {
  function makeStore(): PostgresEpisodicStore {
    return new PostgresEpisodicStore(new FakeEpisodicPool() as unknown as Pool, { now: () => NOW });
  }

  it('reviews the capped budget in priority order: trusted participants land inside the cap', async () => {
    const store = makeStore();
    const input = (id: string, startedAt: string, participants: string[]): EpisodeCreateInput => ({
      id,
      title: `Episode ${id}`,
      landmark: `What happened in ${id}.`,
      startedAt,
      endedAt: startedAt.replace('T05', 'T06'),
      threadId: id,
      channelId: 'discord:main',
      participantContactIds: participants,
      salience: { score: 0.5 },
      affect: { labels: [] },
      themes: [],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [],
    });
    // Older stranger episode vs a younger high-trust one; cap of 1 must land
    // on the high-trust episode, not the merely-older one.
    await store.createEpisode(input('stranger-old', '2026-06-10T05:00:00.000Z', ['contact:stranger']));
    await store.createEpisode(input('primary-young', '2026-06-10T05:10:00.000Z', ['contact:primary']));

    const handleMessage = vi.fn(async () => ({ content: meaningBlock({}) }));
    const resolveTrustRanks = vi.fn(async () => new Map([['contact:primary', 3]]));
    const pass = new DreamMeaningPass(store, { handleMessage }, {
      now: () => NOW,
      maxEpisodesPerPass: 1,
      contactTrust: { resolveTrustRanks },
    });

    const result = await pass.run({ sessionId: 'discord:main' });

    expect(result.ran).toBe(true);
    expect(result.reviewedEpisodes).toBe(1);
    expect(resolveTrustRanks).toHaveBeenCalledWith(['contact:primary', 'contact:stranger']);
    const prompt = (handleMessage.mock.calls[0][0] as { content: string }).content;
    expect(prompt).toContain('"primary-young"');
    expect(prompt).not.toContain('"stranger-old"');
  });

  it('degrades to signal-density/age order when the trust reader fails, still running the pass', async () => {
    const store = makeStore();
    await store.createEpisode({
      id: 'only',
      title: 'Episode only',
      landmark: 'What happened.',
      startedAt: '2026-06-10T05:00:00.000Z',
      endedAt: '2026-06-10T05:30:00.000Z',
      threadId: 'only',
      channelId: 'discord:main',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.5 },
      affect: { labels: [] },
      themes: [],
      spanRefs: [{ spanId: 'span-only', sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [],
    });
    const handleMessage = vi.fn(async () => ({
      content: meaningBlock({ only: 'A small true thing I want to keep.' }),
    }));
    const pass = new DreamMeaningPass(store, { handleMessage }, {
      now: () => NOW,
      contactTrust: {
        resolveTrustRanks: async () => {
          throw new Error('contact store offline');
        },
      },
    });

    const result = await pass.run({ sessionId: 'discord:main' });
    expect(result.ran).toBe(true);
    expect(result.meaningsRecorded).toBe(1);
  });
});
