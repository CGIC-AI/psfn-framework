import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EpisodicStore } from './store.js';
import {
  type EpisodeCreateInput,
} from './store-port.js';
import { DreamMeaningPass, parseMeaningContribution } from './dream-meaning-pass.js';

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
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeStore(): EpisodicStore {
    db = new Database(':memory:');
    return new EpisodicStore(db, { now: () => NOW });
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
      affect: { labels: ['positive'] },
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
    const quiet = await store.getEpisode('quiet');
    expect(quiet?.meaning).toBeUndefined();

    // The opening prompt carried the episodes and the no-performance framing.
    const firstCall = handleMessage.mock.calls[0][0] as { content: string; channelId: string };
    expect(firstCall.channelId).toBe('internal:reflection:dream-pass');
    expect(firstCall.content).toContain('"crying"');
    expect(firstCall.content).toContain('No one reads this but you');
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

    const second = await pass.run({ sessionId: 'discord:main' });
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe('cadence');

    // Even past the cadence, an episode with meaning is not re-reviewed.
    const later = new DreamMeaningPass(store, { handleMessage }, {
      now: () => new Date('2026-06-11T07:30:00.000Z'),
    });
    const third = await later.run({ sessionId: 'discord:main' });
    expect(third.ran).toBe(false);
    expect(third.skippedReason).toBe('no_episodes');
    expect(handleMessage).toHaveBeenCalledTimes(1);
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
});
