// Quarantine-preserving episodic recall against real PostgreSQL
// (psfn-framework-ik47b.4, criterion 6). Every scenario is metamorphic: the
// result with quarantined episodes and arcs present plus the quarantine
// filter must equal the result from a control database that never held the
// quarantined material. That proves roots, members, arcs, score, matchedTerms
// and provenance are rebuilt from retained evidence only, while clean recall
// that does not depend on a quarantined relationship survives.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createPostgresPool, ensurePostgresSchema } from '../../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { EventBus, type EventMap } from '../../../shared/event-bus.js';
import { EPISODE_SEARCH_DOCUMENT_SCHEMA, EpisodeSemanticIndexer } from '../episodic/episode-index.js';
import { PostgresEpisodicStore } from '../episodic/postgres-store.js';
import type { EpisodeArcWriteInput, EpisodeCreateInput } from '../episodic/store-port.js';
import { createPostgresMemoryStoreFromPool } from '../postgres-store.js';
import { MemoryRetriever } from '../retrieval.js';
import { retrieveEpisodeDrilldown } from './episode-drilldown.js';
import { createHybridEpisodeSearch } from './episode-search.js';
import { collectEpisodicChainProvenanceRefs, searchEpisodicEpisodesLexically } from './episodic.js';
import { resolveEpisodicChains } from './episodic-resolution.js';
import type { EpisodicQuarantineWithheld } from './episodic-types.js';
import {
  filterQuarantinedEpisodicChains,
  type MemorySessionQuarantineFilter,
} from './session-quarantine.js';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const CHANNEL = 'discord:dm-quarantine';
const CLEAN_SESSION = 'discord:dm-quarantine';
const RETIRED_SESSION = 'discord:retired-session';
const EMBEDDING_MODEL = { provider: 'transformers', model: 'quarantine-integration' } as const;
const PROFILE = { documentSchema: EPISODE_SEARCH_DOCUMENT_SCHEMA, ...EMBEDDING_MODEL, dimensions: 3 };

const quarantine: MemorySessionQuarantineFilter = {
  isSessionRetiredOrQuarantined: sessionId => sessionId === RETIRED_SESSION,
};

const visibility = {
  channelId: CHANNEL,
  trustLevel: 'primary' as const,
  channelDisclosure: { channelVisibility: 'private' as const, broadcast: false },
  canonicalContactId: 'contact:alex',
};

function episode(id: string, title: string, options: { retired?: boolean; hour: number }): EpisodeCreateInput {
  const sessionId = options.retired ? RETIRED_SESSION : CLEAN_SESSION;
  const startedAt = `2026-07-${String(10 + options.hour).padStart(2, '0')}T10:00:00.000Z`;
  const endedAt = `2026-07-${String(10 + options.hour).padStart(2, '0')}T10:15:00.000Z`;
  return {
    id,
    threadId: `thread:${id}`,
    channelId: CHANNEL,
    title,
    landmark: `${title} landmark`,
    startedAt,
    endedAt,
    participantContactIds: ['contact:alex'],
    salience: { score: 0.7 },
    affect: { labels: [] },
    themes: ['quarantine-integration'],
    spanRefs: [{ spanId: `span:${id}`, channelId: CHANNEL, sessionId, startedAt, endedAt }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'session', refId: sessionId }],
  };
}

function arc(id: string, source: string, target: string, retired = false): EpisodeArcWriteInput {
  const sessionId = retired ? RETIRED_SESSION : CLEAN_SESSION;
  return {
    id,
    sourceEpisodeId: source,
    targetEpisodeId: target,
    arcKind: 'continuation',
    salience: 0.8,
    confidence: 0.85,
    themes: ['quarantine-integration'],
    spanRefs: [{ spanId: `span:${id}`, channelId: CHANNEL, sessionId }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'session', refId: sessionId }],
  };
}

// Clean material, present in both databases.
const CLEAN_EPISODES = [
  // Neighbors of a quarantined root.
  episode('ep-lamp-paint', 'Lighthouse paint colors', { hour: 1 }),
  episode('ep-lamp-lens', 'Lighthouse lens repair', { hour: 2 }),
  // Two clean episodes joined only by a quarantined arc.
  episode('ep-ferry-schedule', 'Harbor ferry schedule', { hour: 3 }),
  episode('ep-ferry-tickets', 'Harbor ferry tickets', { hour: 4 }),
  // A disconnected clean member.
  episode('ep-orchard-day', 'Orchard harvest day', { hour: 5 }),
  // A clean root with one clean leaf and one quarantined leaf.
  episode('ep-greenhouse-build', 'Greenhouse frame build', { hour: 6 }),
  episode('ep-greenhouse-glass', 'Greenhouse glass panes', { hour: 7 }),
];
const CLEAN_ARCS = [arc('arc-greenhouse-glass', 'ep-greenhouse-glass', 'ep-greenhouse-build')];

// Quarantined material, present only in the subject database.
const QUARANTINED_EPISODES = [
  episode('ep-lamp-root', 'Lighthouse restoration plan lighthouse restoration', { hour: 8, retired: true }),
  episode('ep-orchard-notes', 'Orchard harvest notes', { hour: 9, retired: true }),
  episode('ep-greenhouse-zeppelin', 'Greenhouse zeppelin sketch', { hour: 10, retired: true }),
];
const QUARANTINED_ARCS = [
  // Clean arcs incident to a quarantined root are removed with it.
  arc('arc-lamp-paint', 'ep-lamp-paint', 'ep-lamp-root'),
  arc('arc-lamp-lens', 'ep-lamp-lens', 'ep-lamp-root'),
  // A quarantined arc between two clean episodes.
  arc('arc-ferry-retired', 'ep-ferry-tickets', 'ep-ferry-schedule', true),
  // A clean arc to a quarantined leaf.
  arc('arc-greenhouse-zeppelin', 'ep-greenhouse-zeppelin', 'ep-greenhouse-build'),
];
const QUARANTINED_MARKERS = [
  ...QUARANTINED_EPISODES.map(entry => entry.id as string),
  ...QUARANTINED_ARCS.map(entry => entry.id as string),
  RETIRED_SESSION,
  'restoration',
  'zeppelin',
  'Orchard harvest notes',
];

/** Deterministic topic vectors so the semantic path ranks real candidates. */
const embedding: EmbeddingProviderPort = {
  dims: 3,
  embed: async (text) => {
    const lower = text.toLowerCase();
    if (lower.includes('lighthouse')) return new Float32Array([1, 0, 0]);
    if (lower.includes('harbor')) return new Float32Array([0, 1, 0]);
    return new Float32Array([0, 0, 1]);
  },
  embedBatch: async () => [],
};

let harness: PostgresTestHarness | null = null;
let subject: { pool: Pool; store: PostgresEpisodicStore } | null = null;
let control: { pool: Pool; store: PostgresEpisodicStore } | null = null;

async function openDatabase(
  episodes: readonly EpisodeCreateInput[],
  arcs: readonly EpisodeArcWriteInput[],
): Promise<{ pool: Pool; store: PostgresEpisodicStore }> {
  if (!harness) throw new Error('PostgreSQL integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-episodic-quarantine-recall-integration',
    allowExitOnIdle: true,
    max: 2,
  });
  await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
  const store = new PostgresEpisodicStore(pool, { now: () => NOW });
  for (const entry of episodes) await store.createEpisode(entry);
  for (const entry of arcs) await store.writeEpisodeArc(entry);
  const indexer = new EpisodeSemanticIndexer(store, embedding, { ...EMBEDDING_MODEL, now: () => NOW });
  await indexer.runBackfill({ limit: episodes.length });
  return { pool, store };
}

beforeAll(async () => {
  harness = await startPostgresTestHarness();
  subject = await openDatabase(
    [...CLEAN_EPISODES, ...QUARANTINED_EPISODES],
    [...CLEAN_ARCS, ...QUARANTINED_ARCS],
  );
  control = await openDatabase(CLEAN_EPISODES, CLEAN_ARCS);
}, 90_000);

afterAll(async () => {
  await subject?.pool.end();
  await control?.pool.end();
  await harness?.stop();
});

function stores(): { subjectStore: PostgresEpisodicStore; controlStore: PostgresEpisodicStore } {
  if (!subject || !control) throw new Error('quarantine recall databases are not available');
  return { subjectStore: subject.store, controlStore: control.store };
}

function expectNoQuarantinedMaterial(result: unknown): void {
  const serialized = JSON.stringify(result);
  for (const marker of QUARANTINED_MARKERS) {
    expect(serialized).not.toContain(marker);
  }
}

async function foregroundRecall(
  store: PostgresEpisodicStore,
  contextText: string,
  onQuarantineWithheld?: (withheld: EpisodicQuarantineWithheld) => void,
) {
  return resolveEpisodicChains({
    episodicStore: store,
    sessionQuarantineFilter: quarantine,
    request: {
      contextText,
      ...visibility,
      ...(onQuarantineWithheld ? { onQuarantineWithheld } : {}),
    },
    wrapError: error => (error instanceof Error ? error : new Error(String(error))),
  });
}

describe('episodic recall with quarantined roots and relationships (ik47b.4)', () => {
  it.each([
    ['a quarantined root with clean neighbors', 'lighthouse restoration', ['ep-lamp-lens', 'ep-lamp-paint']],
    ['quarantine on an arc only', 'harbor ferry', ['ep-ferry-schedule', 'ep-ferry-tickets']],
    ['disconnected members', 'orchard harvest', ['ep-orchard-day']],
    ['a clean root with one quarantined leaf', 'greenhouse zeppelin', ['ep-greenhouse-build', 'ep-greenhouse-glass']],
  ])('foreground recall: %s keeps only independently clean evidence', async (_name, query, cleanIds) => {
    const { subjectStore, controlStore } = stores();
    const withheld = new Set<string>();
    const chains = await foregroundRecall(subjectStore, query, entry => withheld.add(`${entry.kind}:${entry.id}`));
    const expected = await foregroundRecall(controlStore, query);

    expect(chains).toEqual(expected);
    // The clean recall a database without the quarantined material returns
    // is not suppressed by the removable poisoned neighbor.
    expect(chains.flatMap(chain => chain.episodes.map(entry => entry.id)).sort()).toEqual(cleanIds);
    expect(collectEpisodicChainProvenanceRefs(chains))
      .toEqual(collectEpisodicChainProvenanceRefs(expected));
    expectNoQuarantinedMaterial(chains);
    // Content-free withheld telemetry: kind and id only, never content, and
    // only for material that is actually quarantined.
    const quarantinedKeys = new Set([
      ...QUARANTINED_EPISODES.map(entry => `episode:${entry.id as string}`),
      ...QUARANTINED_ARCS.filter(entry => entry.provenanceRefs.some(ref => ref.refId === RETIRED_SESSION))
        .map(entry => `arc:${entry.id as string}`),
    ]);
    expect([...withheld].every(key => quarantinedKeys.has(key))).toBe(true);
    expect(withheld.size).toBeGreaterThan(0);
  });

  it('a quarantined root never reaches siblings through its own relationships', async () => {
    const { subjectStore } = stores();
    const chains = await foregroundRecall(subjectStore, 'lighthouse restoration');
    for (const chain of chains) {
      // Each clean neighbor is its own root; neither chain reaches the other
      // through the removed root.
      expect(chain.episodes.map(entry => entry.id)).toEqual([chain.rootEpisodeId]);
      expect(chain.arcs).toEqual([]);
    }
  });

  it('lexical search returns the same clean results as a database without the quarantined material', async () => {
    const { subjectStore, controlStore } = stores();
    for (const query of ['lighthouse restoration', 'harbor ferry', 'orchard harvest', 'greenhouse zeppelin']) {
      const search = (store: PostgresEpisodicStore) => searchEpisodicEpisodesLexically(store, {
        query,
        ...visibility,
        sessionQuarantineFilter: quarantine,
        includeChain: chain => filterQuarantinedEpisodicChains(quarantine, [chain]).length === 1,
      });
      const results = await search(subjectStore);
      expect(results).toEqual(await search(controlStore));
      expect(results.length).toBeGreaterThan(0);
      expectNoQuarantinedMaterial(results);
    }
  });

  it('hybrid semantic + lexical search drops the quarantined root from both modes', async () => {
    const { subjectStore, controlStore } = stores();
    const search = async (store: PostgresEpisodicStore, withheld?: Set<string>) => (
      await createHybridEpisodeSearch({ store, embeddingService: embedding, profile: PROFILE }).search({
        query: 'lighthouse restoration',
        ...visibility,
        sessionQuarantineFilter: quarantine,
        ...(withheld
          ? { onQuarantineWithheld: (entry: EpisodicQuarantineWithheld) => { withheld.add(`${entry.kind}:${entry.id}`); } }
          : {}),
      })
    );
    const withheld = new Set<string>();
    const response = await search(subjectStore, withheld);
    const expected = await search(controlStore);

    expect(response.modes.semantic.status).toBe('completed');
    expect(response.results.some(result => result.retrievalModes.includes('semantic'))).toBe(true);
    expect(response.results).toEqual(expected.results);
    expect(response.results.map(result => result.episode.id).sort()).toEqual(['ep-lamp-lens', 'ep-lamp-paint']);
    expectNoQuarantinedMaterial(response.results);
    expect(withheld).toEqual(new Set(['episode:ep-lamp-root']));
  });

  it('drilldown withholds a quarantined root and every quarantined relationship', async () => {
    const { subjectStore, controlStore } = stores();
    const sessionReader = { getRecent: () => [] };
    const drill = (store: PostgresEpisodicStore, episodeId: string) => retrieveEpisodeDrilldown(
      store,
      sessionReader,
      { episodeId, ...visibility, sessionQuarantineFilter: quarantine, siblingLimit: 10 },
    );

    await expect(drill(subjectStore, 'ep-lamp-root')).resolves.toBeNull();
    for (const episodeId of ['ep-lamp-paint', 'ep-ferry-schedule', 'ep-greenhouse-build']) {
      const result = await drill(subjectStore, episodeId);
      expect(result).toEqual(await drill(controlStore, episodeId));
      expectNoQuarantinedMaterial(result);
    }
    const greenhouse = await drill(subjectStore, 'ep-greenhouse-build');
    expect(greenhouse?.arcSiblings.map(sibling => sibling.episode.id)).toEqual(['ep-greenhouse-glass']);
    // A quarantined relationship never consumes a bounded sibling slot.
    for (const siblingLimit of [1, 2]) {
      const bounded = await retrieveEpisodeDrilldown(subjectStore, sessionReader, {
        episodeId: 'ep-greenhouse-build',
        ...visibility,
        sessionQuarantineFilter: quarantine,
        siblingLimit,
      });
      expect(bounded?.arcSiblings.map(sibling => sibling.episode.id)).toEqual(['ep-greenhouse-glass']);
    }
  });

  it('turn snapshots and retrieval telemetry count quarantined episodes as withheld', async () => {
    if (!subject) throw new Error('quarantine recall databases are not available');
    const telemetry: Array<EventMap['memory.retrieval']> = [];
    const eventBus = new EventBus();
    eventBus.on('memory.retrieval', payload => { telemetry.push(payload); });
    const retriever = new MemoryRetriever(
      await createPostgresMemoryStoreFromPool(subject.pool, embedding.dims),
      embedding,
      { retrievalLimit: 20 },
      eventBus,
      null,
      null,
      subject.store,
      quarantine,
    );

    const snapshot = await retriever.captureTurnMemorySnapshot('lighthouse restoration', CHANNEL, 'primary');
    expect(snapshot.episodicChains.flatMap(chain => chain.episodes.map(entry => entry.id)).sort())
      .toEqual(['ep-lamp-lens', 'ep-lamp-paint']);
    expectNoQuarantinedMaterial(snapshot.episodicChains);
    expect(snapshot.withheldSummary?.reasonCounts).toEqual({ 'session_quarantine.blocked': 1 });

    // The no-snapshot retrieval path reports the same withheld count.
    await retriever.retrieve('lighthouse restoration', CHANNEL, 'primary');
    expect(telemetry.at(-1)?.sessionQuarantineRejectedCount).toBe(1);
    expect(telemetry.at(-1)?.withheldReasonCounts).toEqual({ 'session_quarantine.blocked': 1 });
  });
});
