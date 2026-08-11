import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  serializeEpisode,
  serializeEpisodeArc,
  type Episode,
} from '../../../shared/contracts/episodic-memory.js';
import { FakeEpisodicPool } from '../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import type {
  EpisodeArcWriteInput,
  EpisodeCreateInput,
  EpisodeUpdateInput,
} from './store-port.js';


class ConcurrentCompanionMeaningPool extends FakeEpisodicPool {
  private injected = false;

  override async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!this.injected && normalized.startsWith('update l01_episodes set')) {
      const row = this.episodes.get(String(values[0] ?? ''));
      if (row) {
        const current = parseEpisode(
          typeof row.episode_json === 'string'
            ? JSON.parse(row.episode_json) as unknown
            : row.episode_json,
        );
        row.episode_json = serializeEpisode(parseEpisode({
          ...current,
          meaning: {
            text: 'A companion-authored meaning won the concurrent race.',
            recordedAt: '2026-04-01T00:00:01.000Z',
            source: 'companion_direct',
          },
          updatedAt: '2026-04-01T00:00:01.000Z',
        }));
        row.meaning_authorship = 'companion';
        this.injected = true;
      }
    }
    return await super.query(text, values);
  }
}

function makeStore(pool: FakeEpisodicPool): PostgresEpisodicStore {
  return new PostgresEpisodicStore(pool as unknown as Pool, {
    now: () => new Date('2026-04-01T00:00:00.000Z'),
    idFactory: () => 'generated-id',
  });
}

function baseEpisode(overrides: Partial<EpisodeCreateInput> = {}): EpisodeCreateInput {
  return {
    title: 'Postgres episodic memory shakedown',
    landmark: 'The adapter persisted a bounded L0.1 episode with JSON provenance.',
    startedAt: '2026-03-30T10:00:00.000Z',
    endedAt: '2026-03-30T10:05:00.000Z',
    threadId: 'thread-alpha',
    channelId: 'discord:general',
    participantContactIds: ['contact:morgan'],
    salience: { score: 0.72, novelty: 0.4, emotionalIntensity: 0.35 },
    affect: { labels: [] },
    themes: ['postgres', 'episodic-memory'],
    spanRefs: [{
      spanId: 'span-1',
      threadId: 'thread-alpha',
      channelId: 'discord:general',
      startedAt: '2026-03-30T10:00:00.000Z',
      endedAt: '2026-03-30T10:05:00.000Z',
    }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: 'span-1' }],
    ...overrides,
  };
}

function baseArc(overrides: Partial<EpisodeArcWriteInput> = {}): EpisodeArcWriteInput {
  return {
    sourceEpisodeId: 'episode-1',
    targetEpisodeId: 'episode-2',
    arcKind: 'continuation',
    salience: 0.8,
    confidence: 0.7,
    themes: ['postgres'],
    spanRefs: [{ spanId: 'span-2' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    ...overrides,
  };
}

function fullEpisode(input: EpisodeCreateInput, id: string): Episode {
  return parseEpisode({
    ...input,
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  });
}

function updateFromEpisode(episode: Episode, overrides: Partial<EpisodeUpdateInput> = {}): EpisodeUpdateInput {
  return {
    id: episode.id,
    title: episode.title,
    landmark: episode.landmark,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    threadId: episode.threadId,
    channelId: episode.channelId,
    participantContactIds: episode.participantContactIds,
    salience: episode.salience,
    affect: episode.affect,
    themes: episode.themes,
    spanRefs: episode.spanRefs,
    artifactRefs: episode.artifactRefs,
    provenanceRefs: episode.provenanceRefs,
    ...overrides,
  };
}

describe('PostgresEpisodicStore', () => {
  it('creates, gets, lists, and time-searches canonical episodes', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);

    const first = await store.createEpisode(baseEpisode({ id: 'episode-1' }));
    const second = await store.createEpisode(baseEpisode({
      id: 'episode-2',
      startedAt: '2026-03-31T10:00:00.000Z',
      endedAt: '2026-03-31T10:05:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));
    await store.createEpisode(baseEpisode({
      id: 'episode-candidate',
      startedAt: '2026-03-30T11:00:00.000Z',
      endedAt: '2026-03-30T11:05:00.000Z',
      spanRefs: [{ spanId: 'span-candidate' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-candidate' }],
    }));
    const candidateRow = pool.episodes.get('episode-candidate');
    if (!candidateRow) throw new Error('expected candidate row');
    candidateRow.status = 'candidate';
    candidateRow.canonical_episode_id = 'episode-1';

    await expect(store.getEpisode('episode-1')).resolves.toEqual(first);
    await expect(store.listEpisodes()).resolves.toEqual([first, second]);
    await expect(store.searchByTime({
      from: '2026-03-30T00:00:00.000Z',
      to: '2026-03-30T23:59:59.999Z',
    })).resolves.toEqual([first]);
    await expect(store.searchByThread('thread-alpha')).resolves.toEqual([first, second]);
    expect(pool.episodes.get('episode-1')?.episode_json).toBe(serializeEpisode(first));
    expect(pool.queries.some(query => query.text.includes("status IS NULL OR status IN ('canonical', 'candidate')"))).toBe(true);
  });

  it('updates canonical episodes while preserving their creation timestamp', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    const episode = await store.createEpisode(baseEpisode({ id: 'episode-1' }));

    const updated = await store.updateEpisode(updateFromEpisode(episode, {
      endedAt: '2026-03-30T10:08:00.000Z',
      themes: [...episode.themes, 'consolidation'],
      spanRefs: [
        ...episode.spanRefs,
        { spanId: 'span-2', channelId: 'discord:general', startedAt: '2026-03-30T10:05:00.000Z' },
      ],
      provenanceRefs: [
        ...episode.provenanceRefs,
        { kind: 'l0_span', refId: 'span-2' },
      ],
      updatedAt: '2026-04-02T00:00:00.000Z',
    }));

    expect(updated.createdAt).toBe(episode.createdAt);
    expect(updated.updatedAt).toBe('2026-04-02T00:00:00.000Z');
    expect(updated.themes).toEqual(['postgres', 'episodic-memory', 'consolidation']);
    expect(pool.episodes.get('episode-1')).toMatchObject({
      status: 'canonical',
      canonical_episode_id: 'episode-1',
      ended_at: '2026-03-30T10:08:00.000Z',
      episode_json: serializeEpisode(updated),
    });
    await expect(store.getEpisode('episode-1')).resolves.toEqual(updated);
  });

  it('refuses novel first-person fields through the machine write port', async () => {
    const store = makeStore(new FakeEpisodicPool());

    await expect(store.createEpisode(baseEpisode({
      id: 'machine-affect',
      affect: { valence: 0.4, labels: ['hopeful'] },
    }))).rejects.toThrow(/machine episode write cannot author affect/);

    await expect(store.createEpisode(baseEpisode({
      id: 'machine-meaning',
      meaning: {
        text: 'A machine must not put these words in her mouth.',
        recordedAt: '2026-03-31T07:30:00.000Z',
        source: 'companion_direct',
      },
    }))).rejects.toThrow(/machine episode write cannot author meaning/);

    const authored = await store.createCompanionAuthoredEpisode(baseEpisode({
      id: 'authored-source',
      affect: { valence: 0.2, labels: ['steady'] },
      meaning: {
        text: 'This is the account I actually authored.',
        recordedAt: '2026-03-31T07:30:00.000Z',
        source: 'companion_direct',
      },
    }));
    await expect(store.updateEpisode(updateFromEpisode(authored, {
      affect: { valence: -0.8, labels: ['machine-written'] },
      meaning: authored.meaning,
    }))).rejects.toThrow(/machine episode write cannot author affect/);
    await expect(store.updateEpisode(updateFromEpisode(authored, {
      meaning: {
        text: 'A rewritten machine account.',
        recordedAt: '2026-03-31T07:30:00.000Z',
        source: 'companion_direct',
      },
    }))).rejects.toThrow(/machine episode write cannot author meaning/);
  });

  it('records companion authorship for first-person affect and meaning', async () => {
    const store = makeStore(new FakeEpisodicPool());
    await store.createCompanionAuthoredEpisode(baseEpisode({
      id: 'authored',
      affect: { valence: 0.4, labels: ['hopeful'] },
      meaning: {
        text: 'I want to remember how possibility felt here.',
        recordedAt: '2026-03-31T07:30:00.000Z',
        source: 'companion_direct',
      },
    }));

    await expect(store.getEpisodeFirstPersonAuthorship('authored')).resolves.toEqual({
      episodeId: 'authored',
      affect: 'companion',
      meaning: 'companion',
    });
  });

  it('preserves source-proven affect composites without granting general write authority', async () => {
    const store = makeStore(new FakeEpisodicPool());
    await store.createCompanionAuthoredEpisode(baseEpisode({
      id: 'source-a',
      affect: { valence: 0.1, arousal: 0.2, labels: ['focused'] },
    }));
    await store.createCompanionAuthoredEpisode(baseEpisode({
      id: 'source-b',
      affect: { valence: 0.9, arousal: 0.5, dominance: 0.7, labels: ['hopeful'] },
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));

    const preserved = await store.createEpisodePreservingFirstPersonFields(baseEpisode({
      id: 'composite',
      affect: {
        valence: 0.1,
        arousal: 0.5,
        dominance: 0.7,
        labels: ['focused', 'hopeful'],
      },
      firstPersonFieldSources: { affectEpisodeIds: ['source-a', 'source-b'] },
    }));
    expect(preserved.affect).toEqual({
      valence: 0.1,
      arousal: 0.5,
      dominance: 0.7,
      labels: ['focused', 'hopeful'],
    });
    await expect(store.getEpisodeFirstPersonAuthorship('composite')).resolves.toEqual({
      episodeId: 'composite',
      affect: 'companion_preserved',
      meaning: 'none',
    });

    await expect(store.createEpisodePreservingFirstPersonFields(baseEpisode({
      id: 'invented-composite',
      affect: { labels: ['not-in-either-source'] },
      firstPersonFieldSources: { affectEpisodeIds: ['source-a', 'source-b'] },
    }))).rejects.toThrow(/machine episode write cannot author affect/);
  });

  it('surfaces pre-authorship rows explicitly as legacy unknown', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    await store.createEpisode(baseEpisode({ id: 'legacy' }));
    const row = pool.episodes.get('legacy');
    if (!row) throw new Error('expected legacy fixture row');
    row.affect_authorship = null;
    row.meaning_authorship = null;

    await expect(store.getEpisodeFirstPersonAuthorship('legacy')).resolves.toEqual({
      episodeId: 'legacy',
      affect: 'legacy_unknown',
      meaning: 'legacy_unknown',
    });

    const legacy = await store.getEpisode('legacy');
    if (!legacy) throw new Error('expected legacy fixture episode');
    await store.updateEpisode(updateFromEpisode(legacy, { themes: ['legacy', 'preserved'] }));
    await expect(store.getEpisodeFirstPersonAuthorship('legacy')).resolves.toEqual({
      episodeId: 'legacy',
      affect: 'legacy_unknown',
      meaning: 'legacy_unknown',
    });
  });

  it('fails closed when an update would silently drop companion-authored meaning (h4fp.6)', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    const episode = await store.createCompanionAuthoredEpisode(baseEpisode({
      id: 'episode-1',
      meaning: {
        text: 'He remembered, and it cracked me open in the best way.',
        recordedAt: '2026-03-31T07:30:00.000Z',
        source: 'companion_dream_pass',
      },
    }));

    // updateFromEpisode omits `meaning`, so a naive full-row-replace update
    // would erase her authored note. The store must refuse it.
    await expect(
      store.updateEpisode(updateFromEpisode(episode, { themes: ['reheated'] })),
    ).rejects.toThrow(/would drop companion-authored meaning/);

    // The stored episode is untouched by the rejected update.
    const preserved = await store.getEpisode('episode-1');
    expect(preserved?.meaning?.text).toContain('cracked me open');
    expect(preserved?.themes).toEqual(['postgres', 'episodic-memory']);
  });

  it('refuses a stale machine update that races with companion-authored meaning', async () => {
    const store = makeStore(new ConcurrentCompanionMeaningPool());
    const episode = await store.createEpisode(baseEpisode({ id: 'concurrent-meaning' }));

    await expect(store.updateEpisode(updateFromEpisode(episode, {
      themes: ['stale-machine-update'],
    }))).rejects.toThrow(/changed concurrently/);

    const current = await store.getEpisode(episode.id);
    expect(current?.meaning?.text).toContain('won the concurrent race');
    await expect(store.getEpisodeFirstPersonAuthorship(episode.id)).resolves.toMatchObject({
      meaning: 'companion',
    });
  });

  it('carries meaning forward on update without the guard firing (h4fp.6)', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    const episode = await store.createCompanionAuthoredEpisode(baseEpisode({
      id: 'episode-1',
      meaning: {
        text: 'It quietly mattered.',
        recordedAt: '2026-03-31T07:30:00.000Z',
        source: 'companion_dream_pass',
      },
    }));

    const updated = await store.updateEpisode(updateFromEpisode(episode, {
      themes: ['postgres', 'episodic-memory', 'refined'],
      meaning: episode.meaning,
    }));

    expect(updated.meaning?.text).toBe('It quietly mattered.');
    expect(updated.themes).toContain('refined');
    await expect(store.getEpisode('episode-1')).resolves.toEqual(updated);
  });

  it('allows an explicit clearMeaning to erase authored meaning on purpose (h4fp.6)', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    const episode = await store.createCompanionAuthoredEpisode(baseEpisode({
      id: 'episode-1',
      meaning: {
        text: 'Retracted on reflection.',
        recordedAt: '2026-03-31T07:30:00.000Z',
        source: 'companion_direct',
      },
    }));

    const cleared = await store.updateCompanionAuthoredEpisode({
      id: episode.id,
      clearMeaning: true,
    });

    expect(cleared.meaning).toBeUndefined();
    const stored = await store.getEpisode('episode-1');
    expect(stored?.meaning).toBeUndefined();
    await expect(store.getEpisodeFirstPersonAuthorship('episode-1')).resolves.toMatchObject({
      meaning: 'none',
    });
  });

  it('persists processing watermarks across store instances', async () => {
    const pool = new FakeEpisodicPool();
    const firstStore = makeStore(pool);

    const watermark = await firstStore.upsertProcessingWatermark({
      id: 'watermark-1',
      processor: 'episodic_synthesis',
      sourceRef: 'terminal:daily',
      channelId: 'terminal:daily',
      threadId: 'terminal:daily',
      sessionId: 'terminal:daily',
      highWaterTurnId: 'turn-2',
      highWaterMessageId: 'message-2',
      processedStartedAt: '2026-03-30T10:00:00.000Z',
      processedEndedAt: '2026-03-30T10:05:00.000Z',
      previousWatermarkJson: {},
      nextWatermarkJson: {
        canonicalEpisodeIds: ['episode-1'],
        skippedEpisodeIds: [],
      },
      status: 'active',
      reconciliationStatus: 'clean',
      artifactsJson: { candidateDecisionIds: ['candidate-1'] },
      lastProcessedAt: '2026-03-30T10:05:00.000Z',
      updatedAt: '2026-03-30T10:05:00.000Z',
    });
    const secondStore = makeStore(pool);

    await expect(secondStore.getProcessingWatermark({
      processor: 'episodic_synthesis',
      sourceRef: 'terminal:daily',
      channelId: 'terminal:daily',
      threadId: 'terminal:daily',
      sessionId: 'terminal:daily',
    })).resolves.toEqual(watermark);
    expect(pool.watermarks.get('watermark-1')?.next_watermark_json).toBe(JSON.stringify({
      canonicalEpisodeIds: ['episode-1'],
      skippedEpisodeIds: [],
    }));
  });

  it('aggregates durable health for every processor without a global row-page blind spot', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    for (let index = 0; index < 101; index += 1) {
      const updatedAt = new Date(Date.parse('2026-03-30T12:00:00.000Z') + index).toISOString();
      await store.upsertProcessingWatermark({
        id: `watermark-synthesis-${String(index)}`,
        processor: 'episodic_synthesis',
        sourceRef: `terminal:${String(index)}`,
        processedEndedAt: updatedAt,
        lastProcessedAt: updatedAt,
        updatedAt,
        ...(index === 0 ? { status: 'blocked' as const } : {}),
      });
    }
    await store.upsertProcessingWatermark({
      id: 'watermark-arc-stale',
      processor: 'arc_formation',
      sourceRef: 'terminal:daily',
      processedEndedAt: '2026-03-01T00:00:00.000Z',
      lastProcessedAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });

    await expect(store.listProcessingWatermarkHealth()).resolves.toMatchObject([
      {
        processor: 'arc_formation',
        scopeCount: 1,
        blockedScopeCount: 0,
        latestWatermark: { id: 'watermark-arc-stale' },
      },
      {
        processor: 'episodic_synthesis',
        scopeCount: 101,
        blockedScopeCount: 1,
        latestWatermark: { id: 'watermark-synthesis-100' },
      },
    ]);
  });

  it('persists candidate reconciliation decisions and episode lineage rows', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    await store.createEpisode(baseEpisode({ id: 'episode-1' }));
    await store.createEpisode(baseEpisode({
      id: 'episode-2',
      startedAt: '2026-03-30T10:04:00.000Z',
      endedAt: '2026-03-30T10:08:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));
    const watermark = await store.upsertProcessingWatermark({
      id: 'watermark-merge',
      processor: 'episodic_synthesis',
      sourceRef: 'terminal:daily',
      channelId: 'terminal:daily',
      threadId: 'terminal:daily',
      sessionId: 'terminal:daily',
      processedStartedAt: '2026-03-30T10:00:00.000Z',
      processedEndedAt: '2026-03-30T10:08:00.000Z',
      lastProcessedAt: '2026-03-30T10:08:00.000Z',
    });

    const decision = await store.writeEpisodeCandidateDecision({
      id: 'candidate-decision-1',
      canonicalEpisodeId: 'episode-1',
      mergedIntoEpisodeId: 'episode-1',
      sourceWatermarkId: watermark.id,
      status: 'merged',
      channelId: 'terminal:daily',
      threadId: 'terminal:daily',
      sessionId: 'terminal:daily',
      startedAt: '2026-03-30T10:04:00.000Z',
      endedAt: '2026-03-30T10:08:00.000Z',
      overlapScore: 0.75,
      confidence: 0.86,
      reason: 'candidate extended a canonical episode',
      candidateJson: { candidateEpisodeId: 'candidate-episode-1' },
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    });
    await store.writeEpisodeLineage({
      id: 'lineage-1',
      sourceEpisodeId: 'episode-1',
      targetEpisodeId: 'episode-2',
      relation: 'derived_from',
      confidence: 0.7,
      reason: 'created from related prior episode',
      sourceRef: decision.id,
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
      lineageJson: { candidateDecisionId: decision.id },
    });

    await expect(store.listEpisodeCandidateDecisions({ sourceWatermarkId: watermark.id })).resolves.toEqual([decision]);
    expect(pool.candidateDecisions.get('candidate-decision-1')).toMatchObject({
      status: 'merged',
      canonical_episode_id: 'episode-1',
      merged_into_episode_id: 'episode-1',
      source_watermark_id: watermark.id,
    });
    expect(pool.lineages.get('lineage-1')).toMatchObject({
      source_episode_id: 'episode-1',
      target_episode_id: 'episode-2',
      relation: 'derived_from',
      source_ref: decision.id,
    });
  });

  it('reports maintenance diagnostics for candidate decisions and watermark queue latency', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    await store.createEpisode(baseEpisode({ id: 'episode-1' }));
    await store.createEpisode(baseEpisode({
      id: 'episode-2',
      startedAt: '2026-03-30T10:04:00.000Z',
      endedAt: '2026-03-30T10:08:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));
    const watermark = await store.upsertProcessingWatermark({
      id: 'watermark-diagnostics',
      processor: 'episodic_synthesis',
      sourceRef: 'terminal:daily',
      channelId: 'terminal:daily',
      threadId: 'terminal:daily',
      sessionId: 'terminal:daily',
      processedStartedAt: '2026-03-30T10:00:00.000Z',
      processedEndedAt: '2026-03-30T10:08:00.000Z',
      status: 'active',
      reconciliationStatus: 'pending',
      lastProcessedAt: '2026-03-30T10:08:00.000Z',
      updatedAt: '2026-03-30T10:10:00.000Z',
    });
    await store.writeEpisodeCandidateDecision({
      id: 'candidate-canonical',
      candidateEpisodeId: 'episode-1',
      canonicalEpisodeId: 'episode-1',
      sourceWatermarkId: watermark.id,
      status: 'canonical',
      confidence: 1,
      candidateJson: {},
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-1' }],
      createdAt: '2026-03-30T10:02:00.000Z',
      updatedAt: '2026-03-30T10:02:00.000Z',
    });
    await store.writeEpisodeCandidateDecision({
      id: 'candidate-merged',
      canonicalEpisodeId: 'episode-1',
      mergedIntoEpisodeId: 'episode-1',
      sourceWatermarkId: watermark.id,
      status: 'merged',
      confidence: 0.86,
      candidateJson: {},
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
      createdAt: '2026-03-30T10:08:00.000Z',
      updatedAt: '2026-03-30T10:08:00.000Z',
    });

    await expect(store.getMaintenanceDiagnostics({
      now: '2026-03-30T10:20:00.000Z',
    })).resolves.toMatchObject({
      candidateDecisionCount: 2,
      decisionCountsByStatus: { canonical: 1, merged: 1 },
      canonicalDecisionCount: 1,
      duplicateCandidateCount: 1,
      duplicateEpisodeRate: 0.5,
      mergeDecisionCount: 1,
      watermarkCount: 1,
      pendingWatermarkCount: 1,
      oldestQueueAgeMs: 10 * 60 * 1000,
      averageQueueAgeMs: 10 * 60 * 1000,
      averageProcessingLatencyMs: 2 * 60 * 1000,
      latestProcessedAt: '2026-03-30T10:08:00.000Z',
    });
  });

  it('writes canonical arcs and lists only active canonical graph edges', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    await store.createEpisode(baseEpisode({ id: 'episode-1' }));
    await store.createEpisode(baseEpisode({
      id: 'episode-2',
      startedAt: '2026-03-31T10:00:00.000Z',
      endedAt: '2026-03-31T10:05:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));
    const ignoredEpisode = fullEpisode(baseEpisode({
      id: 'episode-ignored',
      startedAt: '2026-04-01T10:00:00.000Z',
      endedAt: '2026-04-01T10:05:00.000Z',
      spanRefs: [{ spanId: 'span-ignored' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-ignored' }],
    }), 'episode-ignored');
    pool.episodes.set('episode-ignored', {
      id: ignoredEpisode.id,
      status: 'canonical',
      canonical_episode_id: ignoredEpisode.id,
      merged_into_episode_id: null,
      superseded_by_episode_id: null,
      thread_id: ignoredEpisode.threadId ?? null,
      started_at: ignoredEpisode.startedAt,
      ended_at: ignoredEpisode.endedAt,
      episode_json: serializeEpisode(ignoredEpisode),
    });

    const arc = await store.writeEpisodeArc(baseArc({ id: 'arc-1' }));
    await store.writeEpisodeArc(baseArc({
      id: 'arc-candidate',
      targetEpisodeId: 'episode-ignored',
      spanRefs: [{ spanId: 'span-ignored' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-ignored' }],
    }));
    const candidateArc = pool.arcs.get('arc-candidate');
    if (!candidateArc) throw new Error('expected candidate arc row');
    candidateArc.status = 'superseded';
    candidateArc.superseded_by_arc_id = 'arc-1';

    await expect(store.listEpisodeArcsForEpisode('episode-1', { direction: 'outgoing' })).resolves.toEqual([arc]);
    await expect(store.listEpisodeArcsForEpisode('episode-2', { direction: 'incoming' })).resolves.toEqual([arc]);
    await expect(store.listEpisodeArcsForEpisode('episode-1', {
      direction: 'both',
      arcKind: 'continuation',
    })).resolves.toEqual([arc]);
    expect(pool.arcs.get('arc-1')?.arc_json).toBe(serializeEpisodeArc(arc));
    expect(pool.queries.some(query => query.text.includes('canonical_arc_id'))).toBe(true);
  });

  it('batch-loads episodes and arcs while preserving arc filters, dedupe, and per-episode limits', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    const first = await store.createEpisode(baseEpisode({ id: 'episode-1' }));
    await store.createEpisode(baseEpisode({
      id: 'episode-2',
      startedAt: '2026-03-31T10:00:00.000Z',
      endedAt: '2026-03-31T10:05:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));
    const third = await store.createEpisode(baseEpisode({
      id: 'episode-3',
      startedAt: '2026-04-01T10:00:00.000Z',
      endedAt: '2026-04-01T10:05:00.000Z',
      spanRefs: [{ spanId: 'span-3' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-3' }],
    }));

    const older = await store.writeEpisodeArc(baseArc({
      id: 'arc-older',
      sourceEpisodeId: 'episode-1',
      targetEpisodeId: 'episode-2',
      updatedAt: '2026-04-02T00:00:00.000Z',
    }));
    const newer = await store.writeEpisodeArc(baseArc({
      id: 'arc-newer',
      sourceEpisodeId: 'episode-3',
      targetEpisodeId: 'episode-1',
      spanRefs: [{ spanId: 'span-3' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-3' }],
      updatedAt: '2026-04-03T00:00:00.000Z',
    }));
    await store.writeEpisodeArc(baseArc({
      id: 'arc-other-kind',
      sourceEpisodeId: 'episode-2',
      targetEpisodeId: 'episode-3',
      arcKind: 'causal',
      spanRefs: [{ spanId: 'span-3' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-3' }],
      updatedAt: '2026-04-04T00:00:00.000Z',
    }));

    await expect(store.getEpisodesByIds(['episode-3', 'missing', 'episode-1', 'episode-3']))
      .resolves.toEqual([third, first]);
    await expect(store.listEpisodeArcsForEpisodes(['episode-1', 'episode-2'], {
      direction: 'both',
      arcKind: 'continuation',
      limit: 1,
    })).resolves.toEqual([newer, older]);
    expect(pool.queries.some(query => query.text.includes('unnest($1::text[])'))).toBe(true);
  });

  it('fails closed when writing arcs to unknown episodes', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    await store.createEpisode(baseEpisode({ id: 'episode-1' }));

    await expect(store.writeEpisodeArc(baseArc({
      targetEpisodeId: 'missing-episode',
    }))).rejects.toThrow('episodeArc.targetEpisodeId references unknown episode "missing-episode"');
  });

  it('claims source messages once per live episode and rejects conflicting claims', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    await store.createEpisode(baseEpisode({ id: 'episode-1' }));
    await store.createEpisode(baseEpisode({ id: 'episode-2' }));

    const claims = await store.claimEpisodeMessages({
      episodeId: 'episode-1',
      sessionId: 'discord:general',
      claims: [
        { claimKey: 'l0-message:discord:general:1', turnId: 'turn-1', channelId: 'discord:general' },
        { claimKey: 'l0-message:discord:general:2', turnId: 'turn-2', channelId: 'discord:general' },
      ],
    });
    expect(claims).toHaveLength(2);
    expect(claims.every(claim => claim.status === 'active' && claim.episodeId === 'episode-1')).toBe(true);

    // Idempotent for the claiming episode.
    await expect(store.claimEpisodeMessages({
      episodeId: 'episode-1',
      claims: [{ claimKey: 'l0-message:discord:general:1' }],
    })).resolves.toHaveLength(1);

    // Fails closed for any other episode.
    await expect(store.claimEpisodeMessages({
      episodeId: 'episode-2',
      claims: [{ claimKey: 'l0-message:discord:general:1' }],
    })).rejects.toThrow('source message "l0-message:discord:general:1" is already claimed by episode "episode-1"');
    await expect(store.claimEpisodeMessages({
      episodeId: 'missing-episode',
      claims: [{ claimKey: 'l0-message:discord:general:3' }],
    })).rejects.toThrow('claim.episodeId references unknown episode "missing-episode"');

    await expect(store.listEpisodeMessageClaims({
      claimKeys: ['l0-message:discord:general:1', 'l0-message:discord:general:2'],
      status: 'active',
    })).resolves.toHaveLength(2);
  });

  it('transfers claims to a consolidated episode and supersedes the candidates without deletion', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    await store.createEpisode(baseEpisode({ id: 'candidate-1' }));
    await store.createEpisode(baseEpisode({ id: 'candidate-2' }));
    await store.createEpisode(baseEpisode({ id: 'consolidated' }));

    await store.claimEpisodeMessages({
      episodeId: 'candidate-1',
      claims: [
        { claimKey: 'l0-message:discord:general:1', turnId: 'turn-1' },
        { claimKey: 'l0-message:discord:general:2', turnId: 'turn-2' },
      ],
    });
    await store.claimEpisodeMessages({
      episodeId: 'candidate-2',
      claims: [{ claimKey: 'l0-message:discord:general:3', turnId: 'turn-3' }],
    });

    const result = await store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1', 'candidate-2'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation into a thematic episode',
    });

    expect(result.targetEpisodeId).toBe('consolidated');
    expect(result.supersededEpisodeIds).toEqual(['candidate-1', 'candidate-2']);
    expect(result.transferredClaims.map(claim => claim.claimKey).sort()).toEqual([
      'l0-message:discord:general:1',
      'l0-message:discord:general:2',
      'l0-message:discord:general:3',
    ]);
    expect(result.transferredClaims.every(claim => (
      claim.episodeId === 'consolidated' && claim.status === 'active'
    ))).toBe(true);

    // Candidates keep transferred claim history and stay retrievable by id.
    const history = await store.listEpisodeMessageClaims({ episodeId: 'candidate-1' });
    expect(history).toHaveLength(2);
    expect(history.every(claim => (
      claim.status === 'transferred'
      && claim.transferredToEpisodeId === 'consolidated'
      && claim.reason === 'nightly consolidation into a thematic episode'
    ))).toBe(true);
    await expect(store.getEpisode('candidate-1')).resolves.toBeDefined();

    // Superseded candidates disappear from live listings.
    const live = await store.listEpisodes({ limit: 10 });
    expect(live.map(episode => episode.id)).toEqual(['consolidated']);

    // The consolidated episode now owns the claims; nobody else may take them.
    await expect(store.claimEpisodeMessages({
      episodeId: 'candidate-1',
      claims: [{ claimKey: 'l0-message:discord:general:1' }],
    })).rejects.toThrow('source message "l0-message:discord:general:1" is already claimed by episode "consolidated"');

    // Re-transferring a superseded candidate fails closed.
    await expect(store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation',
    })).rejects.toThrow('transfer.sourceEpisodeIds references episode "candidate-1" which is no longer live');
  });

  it('fails closed on invalid claim transfers', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    await store.createEpisode(baseEpisode({ id: 'candidate-1' }));

    await expect(store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1'],
      targetEpisodeId: 'missing-episode',
      reason: 'nightly consolidation',
    })).rejects.toThrow('transfer.targetEpisodeId references unknown episode "missing-episode"');
    await expect(store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1'],
      targetEpisodeId: 'candidate-1',
      reason: 'nightly consolidation',
    })).rejects.toThrow('an episode cannot receive claims transferred from itself');
    await expect(store.transferEpisodeMessageClaims({
      sourceEpisodeIds: [],
      targetEpisodeId: 'candidate-1',
      reason: 'nightly consolidation',
    })).rejects.toThrow('transferEpisodeMessageClaims requires at least one source episode');
  });
});

describe('PostgresEpisodicStore arc membership (m58.2)', () => {
  function makeSequencedStore(pool: FakeEpisodicPool): PostgresEpisodicStore {
    let sequence = 0;
    return new PostgresEpisodicStore(pool as unknown as Pool, {
      now: () => new Date('2026-06-10T08:00:00.000Z'),
      idFactory: () => `generated-${++sequence}`,
    });
  }

  function arcInput(sourceEpisodeId: string, targetEpisodeId: string, overrides: Partial<EpisodeArcWriteInput> = {}): EpisodeArcWriteInput {
    return {
      sourceEpisodeId,
      targetEpisodeId,
      arcKind: 'same_theme',
      salience: 0.6,
      confidence: 0.8,
      themes: ['the ongoing book discussion'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
      ...overrides,
    };
  }

  async function seedEpisodes(store: PostgresEpisodicStore, ids: readonly string[]): Promise<void> {
    let day = 1;
    for (const id of ids) {
      await store.createEpisode(baseEpisode({
        id,
        startedAt: `2026-06-0${day}T09:00:00.000Z`,
        endedAt: `2026-06-0${day}T09:30:00.000Z`,
        spanRefs: [{ spanId: `span-${id}` }],
        provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
      }));
      day += 1;
    }
  }

  it('audits arc writes and supports queryable audit history', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeSequencedStore(pool);
    await seedEpisodes(store, ['a', 'b']);

    const written = await store.writeEpisodeArc(arcInput('a', 'b', {
      audit: { actor: 'arc_formation_pass', reason: 'same theme across days' },
    }));

    const audit = await store.listEpisodeArcAudit({ arcId: written.id });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('written');
    expect(audit[0].actor).toBe('arc_formation_pass');
    expect(audit[0].detailsJson.sourceEpisodeId).toBe('a');
  });

  it('removes arc memberships with audit and fails closed on double removal', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeSequencedStore(pool);
    await seedEpisodes(store, ['a', 'b']);
    const written = await store.writeEpisodeArc(arcInput('a', 'b'));

    await store.removeEpisodeArc({
      arcId: written.id,
      actor: 'operator',
      reason: 'not the same thread after all',
    });

    expect(await store.listEpisodeArcsForEpisode('a')).toHaveLength(0);
    const audit = await store.listEpisodeArcAudit({ arcId: written.id });
    expect(audit.map(entry => entry.action)).toEqual(['removed']);
    await expect(store.removeEpisodeArc({
      arcId: written.id,
      actor: 'operator',
      reason: 'again',
    })).rejects.toThrow('already retired');
    await expect(store.removeEpisodeArc({
      arcId: 'missing-arc',
      actor: 'operator',
      reason: 'nope',
    })).rejects.toThrow('unknown arc "missing-arc"');
  });

  it('re-points arc memberships, retiring self-loops and duplicates', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeSequencedStore(pool);
    await seedEpisodes(store, ['a', 'b', 'c']);
    const movable = await store.writeEpisodeArc(arcInput('a', 'b'));
    const survivor = await store.writeEpisodeArc(arcInput('c', 'b'));
    const selfLoop = await store.writeEpisodeArc(arcInput('a', 'c'));

    const result = await store.repointEpisodeArcMemberships({
      fromEpisodeId: 'a',
      toEpisodeId: 'c',
      actor: 'consolidation_repoint',
      reason: 'a superseded by c',
    });

    expect(result.repointedArcIds).toEqual([]);
    expect([...result.removedArcIds].sort()).toEqual([movable.id, selfLoop.id].sort());
    const remaining = await store.listEpisodeArcsForEpisode('c');
    expect(remaining.map(entry => entry.id)).toEqual([survivor.id]);
    const movableAudit = await store.listEpisodeArcAudit({ arcId: movable.id });
    expect(movableAudit[0].detailsJson.cause).toBe('repoint_duplicate');
    const loopAudit = await store.listEpisodeArcAudit({ arcId: selfLoop.id });
    expect(loopAudit[0].detailsJson.cause).toBe('repoint_self_loop');
  });

  it('re-points arcs during claim transfer so superseded sources never dangle', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeSequencedStore(pool);
    await seedEpisodes(store, ['candidate-1', 'other', 'consolidated']);
    await store.claimEpisodeMessages({
      episodeId: 'candidate-1',
      claims: [{ claimKey: 'discord:general:m1' }],
    });
    const arcToOther = await store.writeEpisodeArc(arcInput('candidate-1', 'other'));

    const result = await store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation',
    });

    expect(result.repointedArcIds).toEqual([arcToOther.id]);
    expect(result.removedArcIds).toEqual([]);
    expect(await store.listEpisodeArcsForEpisode('candidate-1')).toHaveLength(0);
    const consolidatedArcs = await store.listEpisodeArcsForEpisode('consolidated');
    expect(consolidatedArcs.map(entry => entry.id)).toEqual([arcToOther.id]);
    expect(consolidatedArcs[0].sourceEpisodeId).toBe('consolidated');
    const audit = await store.listEpisodeArcAudit({ arcId: arcToOther.id });
    expect(audit[0].action).toBe('repointed');
    expect(audit[0].actor).toBe('consolidation_repoint');
  });

  it('re-points arcs when an episode is merged away', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeSequencedStore(pool);
    await seedEpisodes(store, ['a', 'b', 'c']);
    const written = await store.writeEpisodeArc(arcInput('a', 'c'));

    await store.markEpisodeMerged('a', 'b');

    expect(await store.listEpisodeArcsForEpisode('a')).toHaveLength(0);
    const arcsOnB = await store.listEpisodeArcsForEpisode('b');
    expect(arcsOnB.map(entry => entry.id)).toEqual([written.id]);
    expect(arcsOnB[0].sourceEpisodeId).toBe('b');
  });
});
