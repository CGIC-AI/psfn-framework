import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostgresContactStore } from '../../../core/contacts/postgres-adapter.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { SessionManager } from '../../../core/session/manager.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { MemoryExtractor, __test as extractionTestUtils } from '../extraction.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import { createPostgresMemoryStoreFromPool } from '../postgres-store.js';
import { inspectMemorySubjectClassificationCoverage } from '../postgres-store/subject-coverage.js';
import { DIRECT_BACKFILL_WATERMARK_VERSION } from './direct-backfill-lane.js';
import { GroupMemoryBackfillRunner } from './group-backfill.js';
import { GROUP_MEMORY_POLICY_VERSION, JsonGroupMemoryWatermarkStore } from './group-ranges.js';

// Real components: Postgres memory + contact stores, MemoryWriter (embedding
// dedupe), SessionStore journals, the JSON watermark store and the Garden
// backfill runner. Only the model is a deterministic stand-in: it reads the
// rendered `[message_id:N] Speaker: content` transcript and returns one fact
// for every message it recognizes, with structured source attribution.

const EMBEDDING_DIMS = 64;
const LOCAL_COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER_COMPANION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DM_CHANNEL_ID = 'discord:dm-morgan-fixture';
const COMPANION_DM_CHANNEL_ID = `companion-dm:${LOCAL_COMPANION_ID}:${PEER_COMPANION_ID}`;
const MORGAN_AUTHOR_ID = 'transport-morgan-fixture';

interface FactLine {
  content: string;
  fact: string;
}

const MORGAN_FACTS: FactLine[] = [
  { content: 'I keep two beehives on the roof of my building.', fact: 'Morgan keeps two beehives on the roof of their building.' },
  { content: 'My sister Robin is moving to Lisbon in spring.', fact: 'Morgan has a sister named Robin who is moving to Lisbon in spring.' },
  { content: 'I am allergic to hazelnuts, it is quite serious.', fact: 'Morgan has a serious hazelnut allergy.' },
  { content: 'I started learning the cello last month.', fact: 'Morgan started learning the cello recently.' },
];
const PEER_FACTS: FactLine[] = [
  { content: 'I have been mapping the old tram routes of the city for weeks.', fact: 'Vesper has been mapping the old tram routes of the city.' },
  { content: 'I prefer to be called Vesper rather than V.', fact: 'Vesper prefers to be called Vesper rather than V.' },
];
const FACTS_BY_CONTENT = new Map([...MORGAN_FACTS, ...PEER_FACTS].map(line => [line.content, line.fact]));

function textEmbedding(text: string): Float32Array {
  const digest = createHash('sha512').update(text).digest();
  return Float32Array.from({ length: EMBEDDING_DIMS }, (_unused, index) => (digest[index]! / 127.5) - 1);
}

const embeddingProvider = {
  kind: 'test-text-hash',
  dims: EMBEDDING_DIMS,
  embed: vi.fn(async (text: string) => textEmbedding(text)),
  embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(textEmbedding)),
};

/** The model stand-in: one fact per recognized message, attributed to its line. */
function createModel() {
  const promptedMessageIds: number[][] = [];
  const complete = vi.fn(async (request: { systemPrompt: string }) => {
    const ids: number[] = [];
    const facts: string[] = [];
    for (const match of request.systemPrompt.matchAll(/^\[message_id:(\d+)\] (?:.*?\] )?([^:\n]+): (.+)$/gm)) {
      const id = Number(match[1]);
      const speaker = match[2]!.trim();
      const fact = FACTS_BY_CONTENT.get(match[3]!.trim());
      ids.push(id);
      if (!fact) continue;
      facts.push(`<fact><text>${fact}</text><type>semantic</type><importance>0.85</importance>`
        + '<confidence>0.95</confidence><sensitivity>personal</sensitivity>'
        + `<source_message_ids>${id}</source_message_ids><source_speaker_name>${speaker}</source_speaker_name>`
        + `<subject_name>${speaker}</subject_name></fact>`);
    }
    promptedMessageIds.push(ids);
    return { content: `<response>${facts.join('')}</response>` };
  });
  return { complete, promptedMessageIds };
}

interface Runtime {
  pool: Pool;
  memoryStore: MemoryStorePort;
  contactStore: ContactStorePort;
  sessionStore: SessionStore;
  dataDir: string;
  watermarkPath: string;
  morganContactId: string;
  peerContactId: string;
}

let harness: PostgresTestHarness | undefined;
const pools: Pool[] = [];
const tempDirs: string[] = [];

beforeAll(async () => {
  harness = await startPostgresTestHarness();
});

afterEach(() => {
  extractionTestUtils.resetLastExtractionCount();
});

afterAll(async () => {
  for (const pool of pools.splice(0)) await pool.end();
  await harness?.stop();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function createRuntime(): Promise<Runtime> {
  const database = await harness!.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'direct-backfill-test', allowExitOnIdle: true, max: 6,
  });
  pools.push(pool);
  const memoryStore = await createPostgresMemoryStoreFromPool(pool, EMBEDDING_DIMS);
  const contactStore = await createPostgresContactStore(database.databaseUrl, undefined, { pool });
  const morgan = await contactStore.upsert({
    displayName: 'Morgan', trustLevel: 'regular', discordUserId: MORGAN_AUTHOR_ID,
  });
  const peer = await contactStore.upsert({ displayName: 'Vesper', trustLevel: 'regular' });
  await contactStore.linkChannelIdentity(peer.id, 'companion', PEER_COMPANION_ID);
  const directory = mkdtempSync(join(tmpdir(), 'psfn-direct-backfill-'));
  tempDirs.push(directory);
  return {
    pool,
    memoryStore,
    contactStore,
    sessionStore: new SessionStore(join(directory, 'sessions')),
    dataDir: directory,
    watermarkPath: join(directory, 'group-memory-watermarks.json'),
    morganContactId: morgan.id,
    peerContactId: peer.id,
  };
}

/** A month-old DM: filler turns with the factual messages spread across it. */
function seedMorganDm(store: SessionStore): void {
  const factAt = new Map([[3, MORGAN_FACTS[0]!], [17, MORGAN_FACTS[1]!], [33, MORGAN_FACTS[2]!], [52, MORGAN_FACTS[3]!]]);
  for (let turn = 1; turn <= 30; turn += 1) {
    const userIndex = turn * 2 - 1;
    const line = factAt.get(userIndex) ?? factAt.get(userIndex + 1);
    store.append({
      channelId: DM_CHANNEL_ID, role: 'user', authorId: MORGAN_AUTHOR_ID, authorName: 'Morgan',
      content: line?.content ?? `Today I walked along the canal and thought about chapter ${turn} of my novel draft.`,
      timestamp: 1_700_000_000_000 + turn * 60_000, channelVisibility: 'private',
    });
    store.append({
      channelId: DM_CHANNEL_ID, role: 'assistant', authorName: 'Lyra',
      content: `That sounds like a thoughtful afternoon, tell me more about chapter ${turn}.`,
      timestamp: 1_700_000_000_000 + turn * 60_000 + 1_000, channelVisibility: 'private',
    });
  }
}

function seedCompanionDm(store: SessionStore): void {
  PEER_FACTS.forEach((line, index) => {
    store.append({
      channelId: COMPANION_DM_CHANNEL_ID, role: 'user', authorId: PEER_COMPANION_ID, authorName: 'Vesper',
      content: line.content, timestamp: 1_700_100_000_000 + index * 60_000,
    });
    store.append({
      channelId: COMPANION_DM_CHANNEL_ID, role: 'assistant', authorName: 'Lyra',
      content: 'I would love to hear more about that next time we talk.',
      timestamp: 1_700_100_000_000 + index * 60_000 + 1_000,
    });
  });
}

function runtimeConfig(dataDir: string): SubstrateConfig {
  return {
    companionId: LOCAL_COMPANION_ID,
    characterName: 'Lyra',
    dataDir,
    companionDataDir: dataDir,
    primaryModel: 'invented-chat-model',
    primaryProvider: 'invented-provider',
    extractionModel: 'invented-extraction-model',
    extractionProvider: 'invented-provider',
    modelRoster: {
      chat: { provider: 'invented-provider', model: 'invented-chat-model', contextWindow: 128_000, maxTokens: 4_096 },
    },
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
  } as SubstrateConfig;
}

function createExtractor(runtime: Runtime, model: ReturnType<typeof createModel>, options: {
  formationVad?: boolean;
  concernSink?: ReturnType<typeof vi.fn>;
} = {}): MemoryExtractor {
  const config = runtimeConfig(runtime.dataDir);
  return new MemoryExtractor(
    { complete: model.complete } as never,
    new SessionManager(runtime.sessionStore, config),
    runtime.memoryStore,
    embeddingProvider as never,
    { emit: vi.fn(async () => undefined) } as never,
    config,
    null,
    runtime.sessionStore,
    runtime.contactStore,
    {
      ...(options.formationVad ? { getFormationVAD: () => ({ valence: -0.9, arousal: 0.9, dominance: 0.1 }) } : {}),
      ...(options.concernSink ? { emitConcernCandidates: options.concernSink as never } : {}),
    },
  );
}

function createRunner(runtime: Runtime, extractor: MemoryExtractor): GroupMemoryBackfillRunner {
  return new GroupMemoryBackfillRunner({
    sessionReader: runtime.sessionStore,
    watermarkStore: new JsonGroupMemoryWatermarkStore(runtime.watermarkPath),
    memoryExtractor: extractor,
    contactStore: runtime.contactStore,
    localCompanionId: LOCAL_COMPANION_ID,
    companionNames: ['Lyra'],
  });
}

async function activeMemoryRows(pool: Pool) {
  return (await pool.query<{
    id: string; text: string; contact_id: string | null; sensitivity: string;
    scope_ref_kind: string | null; scope_ref_id: string | null; scope_tags: unknown;
    provenance_json: Record<string, unknown>; formation_vad: unknown;
  }>(`
    SELECT id, text, contact_id, sensitivity, scope_ref_kind, scope_ref_id, scope_tags, provenance_json, formation_vad
    FROM l2_memories WHERE deleted_at IS NULL AND superseded_by IS NULL ORDER BY text
  `)).rows;
}

describe('direct-session memory backfill (psfn-framework-d5e0p.17)', () => {
  it('dry-runs exactly the rows it later extracts, applies idempotently, and resumes within its bounds', async () => {
    const runtime = await createRuntime();
    seedMorganDm(runtime.sessionStore);
    const model = createModel();
    const concernSink = vi.fn(async () => []);
    const extractor = createExtractor(runtime, model, { formationVad: true, concernSink });
    const extractSpy = vi.spyOn(extractor, 'extractDirectBackfillRange');
    const runner = createRunner(runtime, extractor);

    const dryRun = await runner.run(DM_CHANNEL_ID, { mode: 'dry_run' });
    expect(dryRun).toMatchObject({
      status: 'planned',
      target: { lane: 'direct', channelType: 'discord' },
      classification: { mode: 'direct', reason: 'topology_direct' },
      counterpartyContactId: runtime.morganContactId,
      plannedChunkCount: 2,
      plannedLlmCalls: 2,
    });
    const plannedIds = dryRun.chunks.flatMap(chunk => chunk.candidateSourceMessageIds);
    const conversationalIds = runtime.sessionStore.getEntriesInRange(DM_CHANNEL_ID, 1, 1_000)
      .filter(entry => entry.role === 'user' || entry.role === 'assistant')
      .map(entry => entry.id);
    expect(plannedIds).toEqual(conversationalIds);
    expect(dryRun.chunks.map(chunk => chunk.candidateSourceMessageIds.length)).toEqual([50, 10]);
    expect(model.complete).not.toHaveBeenCalled();
    expect(await activeMemoryRows(runtime.pool)).toEqual([]);

    // Bounded: one chunk per run, the second run resumes from the watermark.
    const first = await runner.run(DM_CHANNEL_ID, { mode: 'live', maxChunksPerRun: 1, maxLlmCallsPerRun: 1 });
    expect(first).toMatchObject({ status: 'completed', processedChunkCount: 1, hasDeferredBacklog: true });
    expect(first.chunks[0]!.extraction).toMatchObject({
      parsedCount: 3, acceptedCount: 2, writeCount: 2, writeCapSkippedCount: 1,
    });
    const second = await runner.run(DM_CHANNEL_ID, { mode: 'live', maxChunksPerRun: 1, maxLlmCallsPerRun: 1 });
    expect(second).toMatchObject({ status: 'completed', processedChunkCount: 1, hasDeferredBacklog: false });
    expect(second.chunks[0]!.spanStartMessageId).toBe(first.chunks[0]!.spanEndMessageId + 1);
    expect(second.chunks[0]!.extraction).toMatchObject({ parsedCount: 1, writeCount: 1 });

    // The ids the model saw are exactly the ids the dry run planned.
    expect(model.promptedMessageIds.flat()).toEqual(plannedIds);
    expect(extractSpy.mock.calls.flatMap(([call]) => call.recoveredEntries.map(entry => entry.id))).toEqual(plannedIds);

    const rows = await activeMemoryRows(runtime.pool);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.contact_id).toBe(runtime.morganContactId);
      expect(row.provenance_json).toMatchObject({ channelId: DM_CHANNEL_ID, reason: 'operator_backfill' });
      // Historical replay never stamps today's mood onto old messages.
      expect(row.formation_vad).toBeNull();
      const classification = await runtime.memoryStore.getMemorySubjectClassification(row.id);
      expect(classification).toMatchObject({
        status: 'current', subjectClass: 'single_contact', subjectContactIds: [runtime.morganContactId],
      });
    }
    expect(concernSink).not.toHaveBeenCalled();

    // Rerunning after completion plans nothing and calls no model.
    const callsBefore = model.complete.mock.calls.length;
    const rerun = await runner.run(DM_CHANNEL_ID, { mode: 'live' });
    expect(rerun).toMatchObject({ status: 'skipped', skipReason: 'no_unprocessed_entries', plannedChunkCount: 0 });
    expect(model.complete.mock.calls.length).toBe(callsBefore);

    // Forcing the whole range again rejects every fact already stored; the only
    // write is the fact the per-run write cap dropped the first time.
    const forced = await runner.run(DM_CHANNEL_ID, { mode: 'live', resume: false });
    expect(forced).toMatchObject({ status: 'completed', processedChunkCount: 2 });
    expect(forced.chunks.map(chunk => chunk.extraction?.writeCount)).toEqual([1, 0]);
    const afterForced = await activeMemoryRows(runtime.pool);
    expect(afterForced.map(row => row.text)).toEqual(MORGAN_FACTS.map(line => line.fact).sort());
    expect(afterForced.map(row => row.id)).toEqual(expect.arrayContaining(rows.map(row => row.id)));
    const again = await runner.run(DM_CHANNEL_ID, { mode: 'live', resume: false });
    expect(again.chunks.map(chunk => chunk.extraction?.writeCount)).toEqual([0, 0]);
    expect((await activeMemoryRows(runtime.pool)).map(row => row.id)).toEqual(afterForced.map(row => row.id));

    // The direct replay never touched the channel's group-memory watermark.
    const watermarks = new JsonGroupMemoryWatermarkStore(runtime.watermarkPath);
    expect(watermarks.get(DM_CHANNEL_ID, GROUP_MEMORY_POLICY_VERSION).coveredUpToMessageId).toBe(0);
    expect(watermarks.get(DM_CHANNEL_ID, DIRECT_BACKFILL_WATERMARK_VERSION).coveredUpToMessageId)
      .toBe(conversationalIds.at(-1));
    expect(await inspectMemorySubjectClassificationCoverage(runtime.pool))
      .toMatchObject({ missingCurrentClassificationCount: 0 });
  });

  it('attributes the same rows with the same privacy as the live direct-extraction path', async () => {
    const backfill = await createRuntime();
    const live = await createRuntime();
    seedMorganDm(backfill.sessionStore);
    seedMorganDm(live.sessionStore);
    const firstChunk = backfill.sessionStore.getEntriesInRange(DM_CHANNEL_ID, 1, 50);

    const backfillRun = await createRunner(backfill, createExtractor(backfill, createModel()))
      .run(DM_CHANNEL_ID, { mode: 'live', maxChunksPerRun: 1, maxLlmCallsPerRun: 1 });
    expect(backfillRun.status).toBe('completed');

    const liveConcerns = vi.fn(async () => []);
    const liveExtractor = createExtractor(live, createModel(), { concernSink: liveConcerns });
    await liveExtractor.maybeExtract(
      DM_CHANNEL_ID, live.morganContactId, undefined, undefined, undefined, undefined,
      live.sessionStore.getEntriesInRange(DM_CHANNEL_ID, 1, firstChunk.at(-1)!.id),
    );
    expect(liveConcerns).toHaveBeenCalled();

    const project = async (runtime: Runtime) => Promise.all((await activeMemoryRows(runtime.pool)).map(async (row) => {
      const classification = await runtime.memoryStore.getMemorySubjectClassification(row.id);
      const provenance = row.provenance_json;
      return {
        text: row.text,
        contactIsCounterparty: row.contact_id === runtime.morganContactId,
        sensitivity: row.sensitivity,
        scope: [row.scope_ref_kind, row.scope_ref_id, row.scope_tags],
        addressMode: provenance.addressMode,
        routingReason: provenance.routingReason,
        sourceMessageIds: provenance.sourceMessageIds,
        sourceIsCounterparty: provenance.sourceContactId === runtime.morganContactId,
        subjectIsCounterparty: provenance.subjectContactId === runtime.morganContactId,
        subjectClass: classification?.subjectClass,
        subjectContactsAreCounterparty: classification?.subjectContactIds.every(id => id === runtime.morganContactId),
        roomId: classification?.roomId,
        status: classification?.status,
      };
    }));
    const backfilled = await project(backfill);
    expect(backfilled).toHaveLength(2);
    expect(backfilled).toEqual(await project(live));
  });

  it('replays a companion-DM attributed to the peer companion contact', async () => {
    const runtime = await createRuntime();
    seedCompanionDm(runtime.sessionStore);
    const model = createModel();
    const runner = createRunner(runtime, createExtractor(runtime, model));

    const dryRun = await runner.run(COMPANION_DM_CHANNEL_ID, { mode: 'dry_run' });
    expect(dryRun).toMatchObject({
      status: 'planned',
      target: { lane: 'direct', channelType: 'companion' },
      classification: { mode: 'direct', reason: 'topology_direct' },
      counterpartyContactId: runtime.peerContactId,
      plannedChunkCount: 1,
    });

    const result = await runner.run(COMPANION_DM_CHANNEL_ID, { mode: 'live' });
    expect(result.chunks[0]!.extraction).toMatchObject({ parsedCount: 2, writeCount: 2 });
    const rows = await activeMemoryRows(runtime.pool);
    expect(rows.map(row => row.text)).toEqual([...PEER_FACTS.map(line => line.fact)].sort());
    for (const row of rows) {
      expect(row.contact_id).toBe(runtime.peerContactId);
      expect(row.provenance_json).toMatchObject({ channelId: COMPANION_DM_CHANNEL_ID, reason: 'operator_backfill' });
      expect(await runtime.memoryStore.getMemorySubjectClassification(row.id)).toMatchObject({
        status: 'current', subjectClass: 'single_contact', subjectContactIds: [runtime.peerContactId],
      });
    }
    expect(await runner.run(COMPANION_DM_CHANNEL_ID, { mode: 'live' }))
      .toMatchObject({ status: 'skipped', skipReason: 'no_unprocessed_entries' });
  });

  it('replays only the requested message range', async () => {
    const runtime = await createRuntime();
    seedMorganDm(runtime.sessionStore);
    const model = createModel();
    const runner = createRunner(runtime, createExtractor(runtime, model));
    const range = { startMessageId: 31, endMessageId: 40 };

    const dryRun = await runner.run(DM_CHANNEL_ID, { mode: 'dry_run', ...range });
    expect(dryRun.chunks.flatMap(chunk => chunk.candidateSourceMessageIds))
      .toEqual(Array.from({ length: 10 }, (_unused, index) => 31 + index));
    const live = await runner.run(DM_CHANNEL_ID, { mode: 'live', ...range });
    expect(live.chunks.map(chunk => chunk.extraction?.writeCount)).toEqual([1]);
    expect(model.promptedMessageIds).toEqual([dryRun.chunks[0]!.candidateSourceMessageIds]);
    expect((await activeMemoryRows(runtime.pool)).map(row => row.text)).toEqual([MORGAN_FACTS[2]!.fact]);
  });

  it('refuses to guess a counterparty it cannot resolve', async () => {
    const runtime = await createRuntime();
    const channelId = 'discord:dm-unknown-fixture';
    runtime.sessionStore.append({
      channelId, role: 'user', authorId: 'transport-stranger', authorName: 'Stranger',
      content: MORGAN_FACTS[0]!.content, timestamp: 1_700_000_000_000, channelVisibility: 'private',
    });
    const model = createModel();
    const result = await createRunner(runtime, createExtractor(runtime, model)).run(channelId, { mode: 'live' });
    expect(result).toMatchObject({ status: 'skipped', skipReason: 'direct_counterparty_unresolved', chunks: [] });
    expect(model.complete).not.toHaveBeenCalled();
    expect(await activeMemoryRows(runtime.pool)).toEqual([]);
  });
});
