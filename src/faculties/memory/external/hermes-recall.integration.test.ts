import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPostgresContactStore } from '../../../core/contacts/postgres-adapter.js';
import type { PostTurnActionHandler } from '../../../core/agent/post-turn-action-runtime.js';
import {
  createDmConversationScope,
  createGroupConversationScope,
} from '../../../core/session/conversation-scope.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import {
  externalMemorySessionId,
  type ExternalMemoryBinding,
  type ExternalMemoryExecuteResult,
} from '../../../shared/contracts/external-memory.js';
import {
  resetRuntimeChannelEnvelopeLabels,
  setRuntimeChannelEnvelopeLabels,
} from '../../../system/trust/runtime-channel-labels.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type { IntakeScreeningInput } from '../../../core/cogsec/intake/screening.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import { createPostgresMemoryStoreFromPool } from '../postgres-store.js';
import { MemoryRetriever } from '../retrieval.js';
import type { PurrMemory } from '../types.js';
import { MemoryWriter } from '../writer.js';
import { ExternalMemoryIntakeStore } from './intake-store.js';
import { ExternalMemoryService } from './service.js';

/**
 * psfn-framework-1meuc: a Hermes `remember` note must be recalled by its own
 * bound contact in a later Hermes session through the real subject-authorized
 * Postgres store and the real retrieval path, while every other viewer and
 * room stays blocked. Only the embedding model, intake screening and the
 * deferred-action queue are stand-ins; the service, writer, retriever, memory
 * store, subject classification and contact store are the production ones,
 * wired as the agent wires them.
 */

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const BIKE = new Float32Array([1, 0, 0, 0]);
const TEA = new Float32Array([0, 1, 0, 0]);
const OTHER = new Float32Array([0, 0, 1, 0]);
const BIKE_QUERY = 'Where do I keep my bike and what is the lock reference?';

function embedText(text: string): Float32Array {
  const lower = text.toLowerCase();
  if (lower.includes('bike')) return BIKE;
  if (lower.includes('tea')) return TEA;
  return OTHER;
}

const embeddings: EmbeddingProviderPort = {
  dims: 4,
  embed: async text => embedText(text),
  embedBatch: async texts => texts.map(embedText),
};

let harness: PostgresTestHarness | undefined;
const pools: Pool[] = [];
const directories: string[] = [];

beforeAll(async () => {
  harness = await startPostgresTestHarness();
});

afterEach(() => {
  resetRuntimeChannelEnvelopeLabels();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

afterAll(async () => {
  for (const pool of pools.splice(0)) await pool.end();
  await harness?.stop();
});

async function stack() {
  if (!harness) throw new Error('Postgres harness is unavailable');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'hermes-recall-integration', allowExitOnIdle: true, max: 4,
  });
  pools.push(pool);
  const memoryStore = await createPostgresMemoryStoreFromPool(pool, 4);
  const contactStore = await createPostgresContactStore(database.databaseUrl, undefined, { pool });
  const morgan = await contactStore.upsert({
    displayName: 'Morgan', discordUserId: 'morgan-discord', trustLevel: 'trusted', relationshipType: 'friend',
  });
  const robin = await contactStore.upsert({
    displayName: 'Robin', discordUserId: 'robin-discord', trustLevel: 'trusted', relationshipType: 'friend',
  });
  await contactStore.recordChannelActivity(morgan.id, 'discord', 'discord:dm:morgan', 'private');

  const directory = mkdtempSync(join(tmpdir(), 'psfn-hermes-recall-'));
  directories.push(directory);
  const sessions = new SessionStore(join(directory, 'sessions'));
  const intakeDirectory = join(directory, 'intake');
  const quarantine = { isSessionRetiredOrQuarantined: () => false };
  // The agent's composition: a raw-store writer for background producers
  // (src/app/agent/main.ts memoryWriter) and a subject-enforcing retriever
  // over the raw store (wireMemoryRuntime).
  const writer = new MemoryWriter(memoryStore, embeddings, { companionId: COMPANION_ID });
  const retriever = new MemoryRetriever(
    memoryStore, embeddings, { retrievalThreshold: 0.5, telemetryEnabled: false, contextWindow: 32_000 },
    undefined, contactStore, null, null, quarantine, true,
  );

  const queued: InferredPostTurnAction[] = [];
  let handler: PostTurnActionHandler | undefined;
  const actions = {
    registerHandler: vi.fn((_kind: string, callback: PostTurnActionHandler) => {
      handler = callback;
      return () => undefined;
    }),
    getStatus: () => ({ persistence: { enabled: true } }),
    enqueue: vi.fn((action: InferredPostTurnAction) => { queued.push(action); return 'queued'; }),
  };
  const screen = vi.fn(async (text: string, input: IntakeScreeningInput) => ({
    effectiveText: text, mode: 'enforce', withheld: false,
    snapshot: { envelopeId: `envelope-${input.sourceMessageId}`, sourceClass: input.sourceClass,
      sourceRiskTier: 'untrusted', state: 'released', riskLabels: [],
      enforcementPosture: 'enforce', subject: { kind: 'body' } },
  }));
  const makeService = () => new ExternalMemoryService(fromAny({
    companionId: COMPANION_ID, companionName: 'Lyra',
    refreshChannelPolicy: () => setRuntimeChannelEnvelopeLabels({ 'api:hermes': { privacy: 'private' } }),
    intakeStore: new ExternalMemoryIntakeStore(intakeDirectory),
    sessions, contacts: contactStore, memoryStore, memoryProvider: retriever, writer,
    screening: { screen }, quarantine, actions, retryDelayMs: 100,
    completedReceiptRetentionMs: 60_000, searchLimit: 10, goals: () => '',
    extract: () => Promise.reject(new Error('ingest is not exercised here')),
  }));
  const service = makeService();
  const bindingFor = (contactId: string): ExternalMemoryBinding => ({
    companionId: COMPANION_ID, bodyId: 'workstation', contactId,
  });

  /** Accept a note and drain its deferred processing from top level (no request context). */
  async function remember(contactId: string, sessionId: string, text: string, target = service) {
    await target.execute({ binding: bindingFor(contactId), request: {
      operation: 'remember', sessionId, eventId: `event-${sessionId}`, text,
    } });
    while (queued.length > 0) {
      const outcome = await handler!(queued.shift()!);
      expect(outcome).toBeUndefined();
    }
  }

  async function context(contactId: string, sessionId: string, query = BIKE_QUERY): Promise<string> {
    const result: ExternalMemoryExecuteResult = await service.execute({ binding: bindingFor(contactId),
      request: { operation: 'context', sessionId, query } });
    return 'context' in result ? result.context : '';
  }

  async function search(contactId: string, sessionId: string, query = 'bike basement'): Promise<string[]> {
    const result: ExternalMemoryExecuteResult = await service.execute({ binding: bindingFor(contactId),
      request: { operation: 'search', sessionId, query, limit: 10 } });
    return 'memories' in result ? result.memories.map(memory => memory.text) : [];
  }

  async function storedByText(text: string): Promise<PurrMemory> {
    const rows = await pool.query<{ id: string }>('SELECT id FROM l2_memories WHERE text = $1', [text]);
    expect(rows.rows).toHaveLength(1);
    const memory = await memoryStore.getById(rows.rows[0]!.id);
    return memory!;
  }

  return {
    pool, memoryStore, contactStore, retriever, service, makeService, queued, sessions,
    morganId: morgan.id, robinId: robin.id, bindingFor, remember, context, search, storedByText,
    runQueued: async () => {
      while (queued.length > 0) expect(await handler!(queued.shift()!)).toBeUndefined();
    },
  };
}

type Stack = Awaited<ReturnType<typeof stack>>;

async function insertDirect(memoryStore: MemoryStorePort, memory: Partial<PurrMemory> & Pick<PurrMemory, 'id' | 'text'>) {
  await memoryStore.insertMemory({
    type: 'semantic', importance: 0.6, confidence: 0.6, emotionalValence: 0, salience: 0.6,
    sourceRef: `test:${memory.id}`, extractedAt: Date.now(), lastAccessed: Date.now(),
    accessCount: 0, tags: [], sensitivity: 'personal', consentFlags: {},
    ...memory,
  }, embedText(memory.text));
}

async function recallInRoom(
  h: Stack, channelId: string, scope: 'dm' | 'group', contactId: string,
): Promise<string> {
  return await h.retriever.retrieve(
    BIKE_QUERY, channelId, 'trusted', { isDirectMessage: scope === 'dm', privacyLevel: 'private' }, contactId,
    undefined, undefined, undefined, undefined, undefined, undefined,
    scope === 'dm'
      ? createDmConversationScope({ channelId, contact: { contactId } })
      : createGroupConversationScope({ channelId }),
  );
}

const MORGAN_NOTE = 'For later: my bike lock reference is K7-amber and the bike lives in the basement storage room.';
const ROBIN_NOTE = 'For later: Robin keeps a bike in the basement too; the lock reference is R2-cobalt.';

describe('Hermes remember notes across sessions of the bound contact (1meuc)', () => {
  it('recalls a note remembered in session A through context and search in a new session B', async () => {
    const h = await stack();
    await h.remember(h.morganId, 'session-a', MORGAN_NOTE);

    const stored = await h.storedByText(MORGAN_NOTE);
    expect(await h.memoryStore.getMemorySubjectClassification(stored.id)).toMatchObject({
      subjectClass: 'single_contact', subjectContactIds: [h.morganId],
    });
    expect(stored.provenance).toMatchObject({
      channelId: externalMemorySessionId(h.bindingFor(h.morganId), 'session-a'),
      toolName: 'psfn_memory_remember', actor: 'companion',
      triggerContactId: h.morganId, subjectContactId: h.morganId,
    });

    expect(await h.context(h.morganId, 'session-b')).toContain('K7-amber');
    expect(await h.search(h.morganId, 'session-b')).toContain(MORGAN_NOTE);
  });

  it('attributes a note recovered and processed by a restarted service', async () => {
    const h = await stack();
    await h.service.execute({ binding: h.bindingFor(h.morganId), request: {
      operation: 'remember', sessionId: 'session-a', eventId: 'event-restart', text: MORGAN_NOTE,
    } });
    h.queued.splice(0);
    const restarted = h.makeService();
    await restarted.recover();
    await h.runQueued();

    const stored = await h.storedByText(MORGAN_NOTE);
    expect(await h.memoryStore.getMemorySubjectClassification(stored.id)).toMatchObject({
      subjectClass: 'single_contact', subjectContactIds: [h.morganId],
    });
    expect(await h.context(h.morganId, 'session-b')).toContain('K7-amber');
  });

  it('keeps each contact\'s notes out of the other contact\'s sessions', async () => {
    const h = await stack();
    await h.remember(h.morganId, 'morgan-a', MORGAN_NOTE);
    await h.remember(h.robinId, 'robin-a', ROBIN_NOTE);

    const morganContext = await h.context(h.morganId, 'morgan-b');
    expect(morganContext).toContain('K7-amber');
    expect(morganContext).not.toContain('R2-cobalt');
    const morganSearch = await h.search(h.morganId, 'morgan-b');
    expect(morganSearch).toContain(MORGAN_NOTE);
    expect(morganSearch).not.toContain(ROBIN_NOTE);

    const robinContext = await h.context(h.robinId, 'robin-b');
    expect(robinContext).toContain('R2-cobalt');
    expect(robinContext).not.toContain('K7-amber');
    const robinSearch = await h.search(h.robinId, 'robin-b');
    expect(robinSearch).toContain(ROBIN_NOTE);
    expect(robinSearch).not.toContain(MORGAN_NOTE);
  });

  it('never supersedes or absorbs another contact\'s memory when a note is remembered', async () => {
    const h = await stack();
    const robinText = 'Robin keeps the bike in the garage.';
    await insertDirect(h.memoryStore, {
      id: 'robin-bike', text: robinText, contactId: h.robinId,
      provenance: { channelId: 'discord:dm:robin', subjectContactId: h.robinId },
    });
    // A current-state note at higher confidence is the writer's destructive
    // supersession shape; an identical text is its deduplication shape.
    await h.remember(h.morganId, 'session-a', 'My bike is now in the basement storage room.');
    await h.remember(h.morganId, 'session-c', robinText);

    const robin = await h.memoryStore.getById('robin-bike');
    expect(robin?.supersededBy).toBeUndefined();
    expect(robin?.accessCount).toBe(0);
    const morganCopy = await h.pool.query<{ id: string }>(
      'SELECT id FROM l2_memories WHERE text = $1 AND id <> $2', [robinText, 'robin-bike'],
    );
    expect(morganCopy.rows).toHaveLength(1);
    expect(await h.memoryStore.getMemorySubjectClassification(morganCopy.rows[0]!.id)).toMatchObject({
      subjectClass: 'single_contact', subjectContactIds: [h.morganId],
    });
  });

  it('keeps a Hermes note out of group rooms and the contact\'s non-Hermes rooms', async () => {
    const h = await stack();
    await h.remember(h.morganId, 'session-a', MORGAN_NOTE);

    expect(await recallInRoom(h, 'discord:dm:morgan', 'dm', h.morganId)).not.toContain('K7-amber');
    await h.contactStore.recordChannelActivity(h.morganId, 'discord', 'discord:group:garden', 'invite_only');
    expect(await recallInRoom(h, 'discord:group:garden', 'group', h.morganId)).not.toContain('K7-amber');
    // Sanity: the same retriever admits it in the contact's next Hermes session.
    expect(await recallInRoom(
      h, externalMemorySessionId(h.bindingFor(h.morganId), 'session-b'), 'dm', h.morganId,
    )).toContain('K7-amber');
  });

  it('keeps lookalike rooms and unattributed notes blocked in a Hermes session', async () => {
    const h = await stack();
    const sessionA = externalMemorySessionId(h.bindingFor(h.morganId), 'session-a');
    await insertDirect(h.memoryStore, {
      id: 'lookalike', text: 'Lookalike room says the bike moved to the shed.', contactId: h.morganId,
      provenance: { channelId: `api:other:${'a'.repeat(64)}`, subjectContactId: h.morganId },
    });
    // The shape a remember note had before attribution: trigger contact only.
    await insertDirect(h.memoryStore, {
      id: 'legacy-unattributed', text: 'Legacy note: the bike pump is behind the boiler.',
      sourceType: 'tool_write', sourceRef: 'external:hermes:legacy-receipt',
      provenance: { channelId: sessionA, sessionId: sessionA, actor: 'companion',
        toolName: 'psfn_memory_remember', triggerContactId: h.morganId },
    });
    expect(await h.memoryStore.getMemorySubjectClassification('legacy-unattributed'))
      .toMatchObject({ subjectClass: 'unattributed' });

    const recalled = await h.context(h.morganId, 'session-b');
    expect(recalled).not.toContain('shed');
    expect(recalled).not.toContain('boiler');
    // Explicit search is subject-scoped, not room-scoped: the contact's own
    // attributed rows are theirs, but an unattributed row never is.
    expect(await h.search(h.morganId, 'session-b', 'bike pump boiler'))
      .not.toContain('Legacy note: the bike pump is behind the boiler.');
  });
});
