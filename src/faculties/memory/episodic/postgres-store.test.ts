import { describe, expect, it } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  serializeEpisode,
  serializeEpisodeArc,
  type Episode,
} from '../../../shared/contracts/episodic-memory.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import type { EpisodeArcWriteInput, EpisodeCreateInput, EpisodeUpdateInput } from './store.js';

interface StoredEpisodeRow {
  id: string;
  status: string | null;
  canonical_episode_id: string | null;
  merged_into_episode_id: string | null;
  superseded_by_episode_id: string | null;
  thread_id: string | null;
  started_at: string;
  ended_at: string;
  episode_json: unknown;
}

interface StoredArcRow {
  id: string;
  source_episode_id: string;
  target_episode_id: string;
  arc_kind: string;
  status: string | null;
  canonical_arc_id: string | null;
  merged_into_arc_id: string | null;
  superseded_by_arc_id: string | null;
  updated_at: string;
  arc_json: unknown;
}

interface StoredWatermarkRow {
  id: string;
  processor: string;
  source_ref: string;
  channel_id: string | null;
  thread_id: string | null;
  session_id: string | null;
  high_water_turn_id: string | null;
  high_water_message_id: string | null;
  processed_started_at: string | null;
  processed_ended_at: string | null;
  previous_watermark_json: unknown;
  next_watermark_json: unknown;
  status: string;
  reconciliation_status: string;
  artifacts_json: unknown;
  last_processed_at: string;
  updated_at: string;
}

interface StoredCandidateDecisionRow {
  id: string;
  candidate_episode_id: string | null;
  canonical_episode_id: string | null;
  merged_into_episode_id: string | null;
  superseded_by_episode_id: string | null;
  source_watermark_id: string | null;
  status: string;
  channel_id: string | null;
  thread_id: string | null;
  session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  overlap_score: number | null;
  confidence: number;
  reason: string | null;
  candidate_json: unknown;
  artifact_refs: unknown;
  provenance_refs: unknown;
  created_at: string;
  updated_at: string;
}

interface StoredEpisodeLineageRow {
  id: string;
  source_episode_id: string;
  target_episode_id: string;
  relation: string;
  confidence: number;
  reason: string | null;
  source_ref: string | null;
  provenance_refs: unknown;
  lineage_json: unknown;
  created_at: string;
}

function queryResult(rows: unknown[] = [], command = 'SELECT'): QueryResult {
  return {
    rows,
    command,
    rowCount: rows.length,
    oid: 0,
    fields: [],
  } as QueryResult;
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isActiveEpisode(row: StoredEpisodeRow): boolean {
  return (
    (row.status === null || row.status === 'canonical')
    && (row.canonical_episode_id === null || row.canonical_episode_id === row.id)
    && row.merged_into_episode_id === null
    && row.superseded_by_episode_id === null
  );
}

function isActiveArc(row: StoredArcRow): boolean {
  return (
    (row.status === null || row.status === 'canonical')
    && (row.canonical_arc_id === null || row.canonical_arc_id === row.id)
    && row.merged_into_arc_id === null
    && row.superseded_by_arc_id === null
  );
}

class FakeEpisodicPool {
  readonly episodes = new Map<string, StoredEpisodeRow>();
  readonly arcs = new Map<string, StoredArcRow>();
  readonly watermarks = new Map<string, StoredWatermarkRow>();
  readonly candidateDecisions = new Map<string, StoredCandidateDecisionRow>();
  readonly lineages = new Map<string, StoredEpisodeLineageRow>();
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    this.queries.push({ text, values });
    const normalized = normalizeSql(text);

    if (normalized.startsWith('insert into l01_episodes')) {
      const row: StoredEpisodeRow = {
        id: String(values[0] ?? ''),
        status: values[4] === null ? null : String(values[4] ?? ''),
        canonical_episode_id: values[5] === null ? null : String(values[5] ?? ''),
        merged_into_episode_id: values[6] === null ? null : String(values[6] ?? ''),
        superseded_by_episode_id: values[7] === null ? null : String(values[7] ?? ''),
        thread_id: values[8] === null ? null : String(values[8] ?? ''),
        started_at: String(values[10] ?? ''),
        ended_at: String(values[11] ?? ''),
        episode_json: values[21],
      };
      this.episodes.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('update l01_episodes set')) {
      const row = this.episodes.get(String(values[0] ?? ''));
      if (row) {
        row.status = values[4] === null ? null : String(values[4] ?? '');
        row.canonical_episode_id = values[5] === null ? null : String(values[5] ?? '');
        row.merged_into_episode_id = values[6] === null ? null : String(values[6] ?? '');
        row.superseded_by_episode_id = values[7] === null ? null : String(values[7] ?? '');
        row.thread_id = values[8] === null ? null : String(values[8] ?? '');
        row.started_at = String(values[10] ?? '');
        row.ended_at = String(values[11] ?? '');
        row.episode_json = values[21];
      }
      return queryResult([], 'UPDATE');
    }

    if (normalized.startsWith('insert into l01_episode_arcs')) {
      const row: StoredArcRow = {
        id: String(values[0] ?? ''),
        source_episode_id: String(values[2] ?? ''),
        target_episode_id: String(values[3] ?? ''),
        arc_kind: String(values[4] ?? ''),
        status: values[5] === null ? null : String(values[5] ?? ''),
        canonical_arc_id: values[6] === null ? null : String(values[6] ?? ''),
        merged_into_arc_id: values[7] === null ? null : String(values[7] ?? ''),
        superseded_by_arc_id: values[8] === null ? null : String(values[8] ?? ''),
        arc_json: values[15],
        updated_at: String(values[17] ?? ''),
      };
      this.arcs.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('insert into l01_processing_watermarks')) {
      const row: StoredWatermarkRow = {
        id: String(values[0] ?? ''),
        processor: String(values[1] ?? ''),
        channel_id: values[2] === null ? null : String(values[2] ?? ''),
        thread_id: values[3] === null ? null : String(values[3] ?? ''),
        session_id: values[4] === null ? null : String(values[4] ?? ''),
        source_ref: String(values[5] ?? ''),
        high_water_turn_id: values[6] === null ? null : String(values[6] ?? ''),
        high_water_message_id: values[7] === null ? null : String(values[7] ?? ''),
        processed_started_at: values[8] === null ? null : String(values[8] ?? ''),
        processed_ended_at: values[9] === null ? null : String(values[9] ?? ''),
        previous_watermark_json: values[10],
        next_watermark_json: values[11],
        status: String(values[12] ?? ''),
        reconciliation_status: String(values[13] ?? ''),
        artifacts_json: values[14],
        last_processed_at: String(values[15] ?? ''),
        updated_at: String(values[16] ?? ''),
      };
      this.watermarks.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('insert into l01_episode_candidates')) {
      const row: StoredCandidateDecisionRow = {
        id: String(values[0] ?? ''),
        candidate_episode_id: values[1] === null ? null : String(values[1] ?? ''),
        canonical_episode_id: values[2] === null ? null : String(values[2] ?? ''),
        merged_into_episode_id: values[3] === null ? null : String(values[3] ?? ''),
        superseded_by_episode_id: values[4] === null ? null : String(values[4] ?? ''),
        source_watermark_id: values[5] === null ? null : String(values[5] ?? ''),
        status: String(values[6] ?? ''),
        channel_id: values[7] === null ? null : String(values[7] ?? ''),
        thread_id: values[8] === null ? null : String(values[8] ?? ''),
        session_id: values[9] === null ? null : String(values[9] ?? ''),
        started_at: values[10] === null ? null : String(values[10] ?? ''),
        ended_at: values[11] === null ? null : String(values[11] ?? ''),
        overlap_score: values[12] === null ? null : Number(values[12]),
        confidence: Number(values[13] ?? 0),
        reason: values[14] === null ? null : String(values[14] ?? ''),
        candidate_json: values[15],
        artifact_refs: values[16],
        provenance_refs: values[17],
        created_at: String(values[18] ?? ''),
        updated_at: String(values[19] ?? ''),
      };
      this.candidateDecisions.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('insert into l01_episode_lineage')) {
      const row: StoredEpisodeLineageRow = {
        id: String(values[0] ?? ''),
        source_episode_id: String(values[1] ?? ''),
        target_episode_id: String(values[2] ?? ''),
        relation: String(values[3] ?? ''),
        confidence: Number(values[4] ?? 0),
        reason: values[5] === null ? null : String(values[5] ?? ''),
        source_ref: values[6] === null ? null : String(values[6] ?? ''),
        provenance_refs: values[7],
        lineage_json: values[8],
        created_at: String(values[9] ?? ''),
      };
      this.lineages.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('select id, episode_json from l01_episodes where id =')) {
      const row = this.episodes.get(String(values[0] ?? ''));
      return queryResult(row ? [{ id: row.id, episode_json: row.episode_json }] : []);
    }

    if (normalized.startsWith('select id from l01_episodes where id =')) {
      const row = this.episodes.get(String(values[0] ?? ''));
      return queryResult(row ? [{ id: row.id }] : []);
    }

    if (normalized.startsWith('select id, episode_json from l01_episodes')) {
      return queryResult(this.filterEpisodeRows(normalized, values));
    }

    if (normalized.startsWith('select id, arc_json from l01_episode_arcs')) {
      return queryResult(this.filterArcRows(normalized, values));
    }

    if (normalized.startsWith('select * from l01_processing_watermarks')) {
      return queryResult(this.filterWatermarkRows(values));
    }

    if (normalized.startsWith('select * from l01_episode_candidates')) {
      return queryResult(this.filterCandidateDecisionRows(normalized, values));
    }

    throw new Error(`Unhandled SQL in FakeEpisodicPool: ${text}`);
  }

  private filterEpisodeRows(normalized: string, values: readonly unknown[]): Array<Pick<StoredEpisodeRow, 'id' | 'episode_json'>> {
    let cursor = 0;
    let rows = [...this.episodes.values()].filter(isActiveEpisode);

    if (normalized.includes('thread_id =')) {
      const threadId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.thread_id === threadId);
    }
    if (normalized.includes('ended_at >=')) {
      const from = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.ended_at >= from);
    }
    if (normalized.includes('started_at <=')) {
      const to = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.started_at <= to);
    }

    const limit = Number(values[cursor++] ?? rows.length);
    const offset = Number(values[cursor++] ?? 0);
    return rows
      .sort((left, right) => (
        left.started_at.localeCompare(right.started_at)
        || left.id.localeCompare(right.id)
      ))
      .slice(offset, offset + limit)
      .map(row => ({ id: row.id, episode_json: row.episode_json }));
  }

  private filterArcRows(normalized: string, values: readonly unknown[]): Array<Pick<StoredArcRow, 'id' | 'arc_json'>> {
    let cursor = 0;
    let rows = [...this.arcs.values()].filter(isActiveArc);

    if (normalized.includes('(source_episode_id =')) {
      const sourceEpisodeId = String(values[cursor++] ?? '');
      const targetEpisodeId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.source_episode_id === sourceEpisodeId || row.target_episode_id === targetEpisodeId);
    } else if (normalized.includes('target_episode_id =')) {
      const episodeId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.target_episode_id === episodeId);
    } else if (normalized.includes('source_episode_id =')) {
      const episodeId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.source_episode_id === episodeId);
    }

    if (normalized.includes('arc_kind =')) {
      const arcKind = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.arc_kind === arcKind);
    }

    const limit = Number(values[cursor++] ?? rows.length);
    return rows
      .sort((left, right) => (
        right.updated_at.localeCompare(left.updated_at)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, limit)
      .map(row => ({ id: row.id, arc_json: row.arc_json }));
  }

  private filterWatermarkRows(values: readonly unknown[]): StoredWatermarkRow[] {
    const processor = String(values[0] ?? '');
    const sourceRef = String(values[1] ?? '');
    const channelId = String(values[2] ?? '');
    const threadId = String(values[3] ?? '');
    const sessionId = String(values[4] ?? '');
    return [...this.watermarks.values()].filter(row => (
      row.processor === processor
      && row.source_ref === sourceRef
      && (row.channel_id ?? '') === channelId
      && (row.thread_id ?? '') === threadId
      && (row.session_id ?? '') === sessionId
    ));
  }

  private filterCandidateDecisionRows(normalized: string, values: readonly unknown[]): StoredCandidateDecisionRow[] {
    let cursor = 0;
    let rows = [...this.candidateDecisions.values()];
    if (normalized.includes('source_watermark_id =')) {
      const sourceWatermarkId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.source_watermark_id === sourceWatermarkId);
    }
    if (normalized.includes('canonical_episode_id =')) {
      const canonicalEpisodeId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.canonical_episode_id === canonicalEpisodeId);
    }
    const limit = Number(values[cursor++] ?? rows.length);
    return rows
      .sort((left, right) => (
        left.created_at.localeCompare(right.created_at)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, limit);
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
    participantContactIds: ['contact:vega'],
    salience: { score: 0.72, novelty: 0.4, emotionalIntensity: 0.35 },
    affect: { valence: 0.2, arousal: 0.3, dominance: 0.5, labels: ['focused'] },
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
    expect(pool.queries.some(query => query.text.includes("status IS NULL OR status = 'canonical'"))).toBe(true);
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

  it('fails closed when writing arcs to unknown episodes', async () => {
    const pool = new FakeEpisodicPool();
    const store = makeStore(pool);
    await store.createEpisode(baseEpisode({ id: 'episode-1' }));

    await expect(store.writeEpisodeArc(baseArc({
      targetEpisodeId: 'missing-episode',
    }))).rejects.toThrow('episodeArc.targetEpisodeId references unknown episode "missing-episode"');
  });
});
