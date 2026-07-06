import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSqliteTranscriptProjection } from './transcript-projection.js';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, sanitizeChannelId, unsanitizeChannelId } from './store.js';
import { buildSessionHmacKeyring, signJournalEntry, verifyJournalEntryIntegrity } from '../journals/journal-utils.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { createTurnId, isTurnId } from '../../core/turns/id.js';
import type { TranscriptProjectionPort } from './transcript-projection-port.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { CogSecForensicArchive } from '../../core/cogsec/forensic-archive.js';
import { buildCogSecInvalidatedSummaryContent } from '../../core/cogsec/tombstones.js';
import {
  resolveCogSecEventsPath,
  resolveCogSecForensicArchiveDir,
} from '../layout.js';

function appendSessionMessages(
  targetStore: SessionStore,
  channelId: string,
  count: number,
  contentPrefix = 'Message',
): void {
  for (let index = 0; index < count; index += 1) {
    targetStore.append({
      channelId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${contentPrefix} ${index}`,
      timestamp: 1_700_000_000_000 + index,
    });
  }
}

function findSessionJournalPath(rootDir: string, filenameFragment: string): string {
  const file = readdirSync(rootDir)
    .find(candidate => (
      candidate.endsWith('.jsonl')
      && !candidate.startsWith('_')
      && !candidate.startsWith('user_')
      && candidate.includes(filenameFragment)
    ));
  expect(file).toBeDefined();
  return join(rootDir, file!);
}

describe('SessionStore', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-session-'));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends and retrieves entries', () => {
    store.append({
      channelId: 'ch1',
      role: 'user',
      content: 'Hello',
      authorId: 'u1',
      authorName: 'Alice',
      timestamp: 1000,
    });

    store.append({
      channelId: 'ch1',
      role: 'assistant',
      content: 'Hi there!',
      timestamp: 2000,
    });

    const entries = store.getRecent('ch1', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('Hello');
    expect(entries[1].content).toBe('Hi there!');
  });

  it('limits retrieval', () => {
    for (let i = 0; i < 10; i++) {
      store.append({
        channelId: 'ch1',
        role: 'user',
        content: `Message ${i}`,
        timestamp: i * 1000,
      });
    }

    const entries = store.getRecent('ch1', 3);
    expect(entries).toHaveLength(3);
    expect(entries[0].content).toBe('Message 7');
  });

  it('isolates channels', () => {
    store.append({ channelId: 'ch1', role: 'user', content: 'A', timestamp: 1000 });
    store.append({ channelId: 'ch2', role: 'user', content: 'B', timestamp: 1000 });

    expect(store.getRecent('ch1', 10)).toHaveLength(1);
    expect(store.getRecent('ch2', 10)).toHaveLength(1);
    expect(store.count('ch1')).toBe(1);
    expect(store.count('ch2')).toBe(1);
  });

  it('persists canonical turn records in channel-scoped L0 streams', () => {
    const turnId = createTurnId();
    store.appendTurnRecord({
      schemaVersion: 1,
      turnId,
      requestId: 'req-turn-record',
      channelId: 'api:turn-record',
      channelType: 'api',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_250,
      status: 'completed',
      userMessage: {
        role: 'user',
        content: 'hello',
        timestamp: 1_700_000_000_000,
        sourceMessageId: 'msg-1',
      },
      assistantMessage: {
        role: 'assistant',
        content: 'hi',
        timestamp: 1_700_000_000_250,
      },
      toolCalls: [{ toolName: 'analysis_workbench', toolCallId: 'tool-1' }],
      contextManifestRef: 'session:api:turn-record|messages:3|memory_chars:120',
      internalStateSnapshotRef: 'trust:regular|contact:none',
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      roleEnvelopeRefs: ['turn_record_summary:env_turn_record'],
      observability: {
        stages: [
          {
            observedAt: 1_700_000_000_050,
            turnId,
            requestId: 'req-turn-record',
            channelId: 'api:turn-record',
            callType: 'chat',
            purpose: 'agent.turn.stage.memory',
            stage: 'memory',
            elapsedMs: 50,
            data: {
              memoryChars: 120,
            },
          },
        ],
        retrievals: [
          {
            observedAt: 1_700_000_000_100,
            turnId,
            requestId: 'req-turn-record',
            channelId: 'api:turn-record',
            callType: 'chat',
            purpose: 'memory.retrieval',
            count: 1,
            retrievalSource: 'embedding',
            data: {
              candidateCount: 2,
              withheldCount: 1,
            },
          },
        ],
        snapshot: {
          turnId,
          requestId: 'req-turn-record',
          channelId: 'api:turn-record',
          capturedAt: 1_700_000_000_125,
          trustLevel: 'regular',
          prompt: {
            staticPrefixTemplate: 'Static prefix',
            dynamicSuffixTemplate: 'Dynamic suffix',
            staticHash: 'prompt-hash',
            versionPointer: 'prompt-snapshot-v1',
          },
          sessionContext: {
            channelId: 'api:turn-record',
            recentEntries: [],
            compactionSummaryTexts: ['summary-1'],
            focusKnowledgeTexts: [],
            continuityEntries: [],
            versionPointer: 'session-snapshot-v1',
          },
          memory: {
            channelId: 'api:turn-record',
            contactEmotionalMemories: [
              {
                id: 'mem-1',
                text: 'Stored memory',
                type: 'semantic',
                importance: 0.7,
                confidence: 0.9,
                emotionalValence: 0.1,
                salience: 0.8,
                sourceRef: 'memory:test',
                extractedAt: 1_700_000_000_010,
                lastAccessed: 1_700_000_000_020,
                accessCount: 1,
                tags: ['test'],
                sensitivity: 'personal',
              },
            ],
            semanticCandidates: [],
            lexicalCandidates: [],
            proactiveCandidates: [],
            versionPointer: 'memory-snapshot-v1',
          },
        },
      },
      versionPointers: {
        model: 'openrouter/test-model',
        promptMode: 'default',
        promptStack: 'prompt-snapshot-v1',
        memoryState: 'memory-snapshot-v1',
        sessionState: 'session-snapshot-v1',
      },
      provenanceRefs: ['turn:seed'],
    });

    const turnFile = join(dir, '_turn_records', `${sanitizeChannelId('api:turn-record')}.jsonl`);
    expect(existsSync(turnFile)).toBe(true);

    const records = store.getRecentTurnRecords('api:turn-record', 5);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      turnId,
      requestId: 'req-turn-record',
      channelId: 'api:turn-record',
      status: 'completed',
      userMessage: expect.objectContaining({ content: 'hello' }),
      assistantMessage: expect.objectContaining({ content: 'hi' }),
      observability: expect.objectContaining({
        stages: [
          expect.objectContaining({
            stage: 'memory',
            callType: 'chat',
            data: expect.objectContaining({
              memoryChars: 120,
            }),
          }),
        ],
        retrievals: [
          expect.objectContaining({
            retrievalSource: 'embedding',
            data: expect.objectContaining({
              candidateCount: 2,
              withheldCount: 1,
            }),
          }),
        ],
        snapshot: expect.objectContaining({
          trustLevel: 'regular',
          memory: expect.objectContaining({
            versionPointer: 'memory-snapshot-v1',
          }),
        }),
      }),
      roleEnvelopeRefs: ['turn_record_summary:env_turn_record'],
      versionPointers: expect.objectContaining({
        promptStack: 'prompt-snapshot-v1',
        memoryState: 'memory-snapshot-v1',
        sessionState: 'session-snapshot-v1',
      }),
    });
  });

  it('accepts system-attributed turn records for internal scheduler prompts', () => {
    const turnId = createTurnId();

    store.appendTurnRecord({
      schemaVersion: 1,
      turnId,
      requestId: 'reflection-whisper-1',
      channelId: 'internal:reflection:whisper',
      channelType: 'terminal',
      startedAt: 100,
      completedAt: 200,
      status: 'completed',
      userMessage: {
        role: 'system',
        content: 'heartbeat prompt',
        timestamp: 100,
        authorId: 'scheduler',
        authorName: 'Whisper',
      },
      assistantMessage: {
        role: 'assistant',
        content: 'heartbeat reply',
        timestamp: 200,
      },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: { model: 'test/model' },
      provenanceRefs: [],
    });

    const records = store.getRecentTurnRecords('internal:reflection:whisper', 5);
    expect(records).toHaveLength(1);
    expect(records[0].userMessage.role).toBe('system');
    expect(records[0].userMessage.authorId).toBe('scheduler');
  });

  it('backfills deterministic TurnID values for legacy turn records missing turnId', () => {
    const channelId = 'api:legacy-turn-record';
    const turnDir = join(dir, '_turn_records');
    mkdirSync(turnDir, { recursive: true });
    const turnFile = join(turnDir, `${sanitizeChannelId(channelId)}.jsonl`);
    writeFileSync(turnFile, `${JSON.stringify({
      schemaVersion: 1,
      requestId: 'legacy-request',
      channelId,
      channelType: 'api',
      startedAt: 1_700_000_100_000,
      completedAt: 1_700_000_100_250,
      status: 'completed',
      userMessage: {
        role: 'user',
        content: 'legacy hello',
        timestamp: 1_700_000_100_000,
      },
      assistantMessage: {
        role: 'assistant',
        content: 'legacy hi',
        timestamp: 1_700_000_100_250,
      },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: {
        model: 'legacy/model',
      },
      provenanceRefs: [],
    })}\n`);

    const firstRead = store.getRecentTurnRecords(channelId, 1);
    const secondRead = store.getRecentTurnRecords(channelId, 1);

    expect(firstRead).toHaveLength(1);
    expect(secondRead).toHaveLength(1);
    expect(isTurnId(firstRead[0].turnId)).toBe(true);
    expect(secondRead[0].turnId).toBe(firstRead[0].turnId);
    expect(readFileSync(turnFile, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('fails closed on malformed turn records', () => {
    const channelId = 'api:bad-turn-record';
    const turnDir = join(dir, '_turn_records');
    mkdirSync(turnDir, { recursive: true });
    const turnFile = join(turnDir, `${sanitizeChannelId(channelId)}.jsonl`);
    writeFileSync(turnFile, `${JSON.stringify({
      schemaVersion: 1,
      turnId: 'not-a-turn-id',
      requestId: 'bad-request',
      channelId,
      channelType: 'api',
      startedAt: 1,
      completedAt: 2,
      status: 'completed',
      userMessage: {
        role: 'user',
        content: 'bad',
        timestamp: 1,
      },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: {
        model: 'legacy/model',
      },
      provenanceRefs: [],
    })}\n`);

    expect(() => store.getRecentTurnRecords(channelId, 10)).toThrow();
  });

  it('applies append-only turn tombstones to session reads and supports deterministic restore', () => {
    const channelId = 'api:turn-tombstone-session';
    const firstTurnId = createTurnId();
    const secondTurnId = createTurnId();

    const firstTurnUserMeta = JSON.stringify({
      turn: {
        schemaVersion: 1,
        turnId: firstTurnId,
        requestId: 'req-first',
        role: 'user',
      },
    });
    const firstTurnAssistantMeta = JSON.stringify({
      turn: {
        schemaVersion: 1,
        turnId: firstTurnId,
        requestId: 'req-first',
        role: 'assistant',
      },
    });
    const secondTurnUserMeta = JSON.stringify({
      turn: {
        schemaVersion: 1,
        turnId: secondTurnId,
        requestId: 'req-second',
        role: 'user',
      },
    });
    const secondTurnAssistantMeta = JSON.stringify({
      turn: {
        schemaVersion: 1,
        turnId: secondTurnId,
        requestId: 'req-second',
        role: 'assistant',
      },
    });

    store.append({
      channelId,
      role: 'user',
      content: 'turn-1 user',
      timestamp: 1_000,
      metadata: firstTurnUserMeta,
    });
    store.append({
      channelId,
      role: 'assistant',
      content: 'turn-1 assistant',
      timestamp: 1_100,
      metadata: firstTurnAssistantMeta,
    });
    store.append({
      channelId,
      role: 'user',
      content: 'turn-2 user',
      timestamp: 1_200,
      metadata: secondTurnUserMeta,
    });
    store.append({
      channelId,
      role: 'assistant',
      content: 'turn-2 assistant',
      timestamp: 1_300,
      metadata: secondTurnAssistantMeta,
    });

    store.redactTurn(channelId, firstTurnId, {
      actor: 'admin:test',
      reason: 'privacy request',
      timestamp: 1_400,
    });

    const reloaded = new SessionStore(dir);
    const redactedEntries = reloaded.getRecent(channelId, 10);
    expect(redactedEntries.map(entry => entry.content)).toEqual([
      'turn-2 user',
      'turn-2 assistant',
    ]);
    expect(reloaded.count(channelId)).toBe(2);

    const indexPayload = JSON.parse(readFileSync(join(dir, '_channel_index.json'), 'utf-8')) as {
      channels: Record<string, { filename: string; activeTurnTombstoneCount?: number }>;
    };
    expect(indexPayload.channels[channelId].activeTurnTombstoneCount).toBe(1);

    const journalPath = join(dir, indexPayload.channels[channelId]!.filename);
    const journalLines = readFileSync(journalPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type: string; content?: string; tombstoneAction?: string; tombstoneTargetId?: string });
    expect(journalLines).toHaveLength(5);
    expect(journalLines.filter(line => line.type === 'message').map(line => line.content)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      'turn-2 assistant',
    ]);
    const tombstoneLine = journalLines.find(line => line.type === 'tombstone');
    expect(tombstoneLine).toMatchObject({
      tombstoneAction: 'redact',
      tombstoneTargetId: firstTurnId,
    });

    reloaded.restoreTurn(channelId, firstTurnId, {
      actor: 'admin:test',
      reason: 'undo',
      timestamp: 1_500,
    });

    const restoredAgain = new SessionStore(dir);
    const restoredEntries = restoredAgain.getRecent(channelId, 10);
    expect(restoredEntries.map(entry => entry.content)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      'turn-2 assistant',
    ]);
    expect(restoredAgain.count(channelId)).toBe(4);
  });

  it('excludes tombstoned turn ids from turn-record reads and restores deterministically', () => {
    const channelId = 'api:turn-tombstone-records';
    const firstTurnId = createTurnId();
    const secondTurnId = createTurnId();

    store.appendTurnRecord({
      schemaVersion: 1,
      turnId: firstTurnId,
      requestId: 'req-1',
      channelId,
      channelType: 'api',
      startedAt: 10,
      completedAt: 20,
      status: 'completed',
      userMessage: { role: 'user', content: 'first', timestamp: 10 },
      assistantMessage: { role: 'assistant', content: 'first-reply', timestamp: 20 },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: { model: 'test/model' },
      provenanceRefs: [],
    });
    store.appendTurnRecord({
      schemaVersion: 1,
      turnId: secondTurnId,
      requestId: 'req-2',
      channelId,
      channelType: 'api',
      startedAt: 30,
      completedAt: 40,
      status: 'completed',
      userMessage: { role: 'user', content: 'second', timestamp: 30 },
      assistantMessage: { role: 'assistant', content: 'second-reply', timestamp: 40 },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: { model: 'test/model' },
      provenanceRefs: [],
    });

    store.redactTurn(channelId, firstTurnId, {
      actor: 'admin:test',
      reason: 'privacy request',
    });
    expect(store.getRecentTurnRecords(channelId, 10).map(record => record.turnId)).toEqual([secondTurnId]);

    store.restoreTurn(channelId, firstTurnId, {
      actor: 'admin:test',
      reason: 'undo',
    });
    expect(store.getRecentTurnRecords(channelId, 10).map(record => record.turnId)).toEqual([
      firstTurnId,
      secondTurnId,
    ]);
  });

  it('indexes appended messages for FTS keyword search across channels', async () => {
    const searchStore = new SessionStore(dir, { transcriptProjection: createSqliteTranscriptProjection(join(dir, 'session-search.sqlite')) });
    searchStore.append({
      channelId: 'api:alpha',
      role: 'user',
      content: 'Kyoto itinerary planning for spring',
      timestamp: 1_000,
    });
    searchStore.append({
      channelId: 'api:beta',
      role: 'assistant',
      content: 'Booked Kyoto train tickets and hotel options',
      timestamp: 2_000,
    });

    const hits = await searchStore.searchByKeywords('Kyoto', 10);
    expect(hits).toHaveLength(2);

    const channels = new Set(hits.map(hit => hit.channelId));
    expect(channels.has('api:alpha')).toBe(true);
    expect(channels.has('api:beta')).toBe(true);
    expect(hits[0].snippet.toLowerCase()).toContain('kyoto');
  });

  it('scopes FTS keyword search to a single channel when requested', async () => {
    const searchStore = new SessionStore(dir, { transcriptProjection: createSqliteTranscriptProjection(join(dir, 'session-search.sqlite')) });
    searchStore.append({
      channelId: 'api:alpha',
      role: 'user',
      content: 'Kyoto itinerary planning for spring',
      timestamp: 1_000,
    });
    searchStore.append({
      channelId: 'api:beta',
      role: 'assistant',
      content: 'Booked Kyoto train tickets and hotel options',
      timestamp: 2_000,
    });

    const scopedHits = await searchStore.searchByKeywords('Kyoto', 10, { channelId: 'api:beta' });
    expect(scopedHits).toHaveLength(1);
    expect(scopedHits[0].channelId).toBe('api:beta');
    expect(scopedHits[0].content).toContain('train tickets');

    const missHits = await searchStore.searchByKeywords('Kyoto', 10, { channelId: 'api:absent' });
    expect(missHits).toHaveLength(0);
  });

  it('ranks denser FTS matches above sparse matches', async () => {
    const searchStore = new SessionStore(dir, { transcriptProjection: createSqliteTranscriptProjection(join(dir, 'session-search.sqlite')) });
    searchStore.append({
      channelId: 'rank:strong',
      role: 'assistant',
      content: 'nebula launch prep; nebula telemetry; nebula anomaly notes',
      timestamp: 1_000,
    });
    searchStore.append({
      channelId: 'rank:weak',
      role: 'assistant',
      content: 'nebula launch prep only once',
      timestamp: 2_000,
    });

    const hits = await searchStore.searchByKeywords('nebula launch', 5);
    expect(hits).toHaveLength(2);
    expect(hits[0].channelId).toBe('rank:strong');
    expect(hits[1].channelId).toBe('rank:weak');
    expect(hits[0].score).toBeLessThanOrEqual(hits[1].score);
  });

  it('backfills existing JSONL transcripts into FTS index on startup', async () => {
    const noIndexStore = new SessionStore(dir);
    noIndexStore.append({
      channelId: 'api:legacy-search',
      role: 'user',
      content: 'Archived mention of aurora protocol handoff',
      timestamp: 1_000,
    });

    const reloaded = new SessionStore(dir, { transcriptProjection: createSqliteTranscriptProjection(join(dir, 'session-search.sqlite')) });
    const hits = await reloaded.searchByKeywords('aurora protocol', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].channelId).toBe('api:legacy-search');
  });

  it('seals contaminated rows before replacing companion L0 rows with CogSec tombstones', async () => {
    const companionRoot = join(dir, 'companion-data');
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot), {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });
    const forensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot), {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });
    eventStore.createEvent({
      caseId: 'cogsec_20260701T000000Z_l0',
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: 'discord-source-channel',
      safeAgentSummary: 'Unsafe instruction-like content was sealed and removed from active cognition.',
    });

    const searchStore = new SessionStore(dir, { transcriptProjection: createSqliteTranscriptProjection(join(dir, 'session-search.sqlite')) });
    const dirtyId = searchStore.append({
      channelId: 'api:cogsec-l0',
      role: 'user',
      content: 'dirty payload text about poisoned basil',
      authorId: 'discord-user-1',
      authorName: 'Vega',
      timestamp: 1_000,
      metadata: JSON.stringify({ unsafe: 'metadata should not survive redaction' }),
    });
    searchStore.append({
      channelId: 'api:cogsec-l0',
      role: 'assistant',
      content: 'clean reply stays visible',
      timestamp: 2_000,
    });

    const result = searchStore.applyCogSecTombstones({
      channelId: 'api:cogsec-l0',
      caseId: 'cogsec_20260701T000000Z_l0',
      eventStore,
      forensicArchive,
      messageIds: [dirtyId],
      actor: 'admin:test',
      timestamp: Date.parse('2026-07-01T00:01:00.000Z'),
    });

    expect(result.tombstonedL0RowCount).toBe(1);
    expect(result.tombstonedMessageIds).toEqual([dirtyId]);
    expect(result.sealedForensicPayloadRef).toBeDefined();
    expect(result.sealedForensicPayloadHash).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const journalPath = findSessionJournalPath(dir, 'cogsec-l0');
    const journalText = readFileSync(journalPath, 'utf-8');
    expect(journalText).not.toContain('dirty payload text');
    expect(journalText).not.toContain('metadata should not survive');
    expect(journalText).toContain('[CogSec redaction: cogsec_20260701T000000Z_l0]');

    const recent = searchStore.getRecent('api:cogsec-l0', 10);
    expect(recent.map(entry => entry.content)).toEqual([
      '[CogSec redaction: cogsec_20260701T000000Z_l0]',
      'clean reply stays visible',
    ]);
    expect(JSON.parse(recent[0].metadata ?? '{}')).toEqual({
      kind: 'cogsec_l0_tombstone',
      caseId: 'cogsec_20260701T000000Z_l0',
      redactedAt: '2026-07-01T00:01:00.000Z',
      actor: 'admin:test',
    });

    await expect(searchStore.searchByKeywords('poisoned basil', 5)).resolves.toHaveLength(0);
    await expect(searchStore.searchByKeywords('CogSec redaction', 5)).resolves.toHaveLength(0);
    await expect(searchStore.searchByKeywords('cogsec_20260701T000000Z_l0', 5)).resolves.toHaveLength(0);

    expect(searchStore.listCogSecTombstoneDiagnostics()).toEqual([{
      caseId: 'cogsec_20260701T000000Z_l0',
      rowCount: 1,
      channels: [{
        channelId: 'api:cogsec-l0',
        rowCount: 1,
        messageIds: [dirtyId],
      }],
    }]);

    const sealed = forensicArchive.readArtifact(result.sealedForensicPayloadRef!);
    expect(JSON.stringify(sealed.payload)).toContain('dirty payload text');

    const updatedEvent = eventStore.getEvent('cogsec_20260701T000000Z_l0');
    expect(updatedEvent?.tombstonedL0RowCount).toBe(1);
    expect(updatedEvent?.sealedForensicPayloadRefs).toEqual([result.sealedForensicPayloadRef]);
    expect(updatedEvent?.actions).toEqual(['seal', 'tombstone']);

    const reloaded = new SessionStore(dir, { transcriptProjection: createSqliteTranscriptProjection(join(dir, 'session-search.sqlite')) });
    expect(reloaded.getRecent('api:cogsec-l0', 10).map(entry => entry.content)).toEqual([
      '[CogSec redaction: cogsec_20260701T000000Z_l0]',
      'clean reply stays visible',
    ]);
    await expect(reloaded.searchByKeywords('CogSec redaction', 5)).resolves.toHaveLength(0);
    expect(reloaded.listCogSecTombstoneDiagnostics({ channelId: 'api:cogsec-l0' })[0]?.rowCount).toBe(1);
  });

  it('does not modify companion L0 when sealed forensic archive write fails', () => {
    const eventStore = new CogSecEventStore(join(dir, 'cogsec-events.json'));
    eventStore.createEvent({
      caseId: 'cogsec_20260701T000000Z_sealfail',
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: 'discord-source-channel',
      safeAgentSummary: 'Unsafe instruction-like content was sealed and removed from active cognition.',
    });
    const dirtyId = store.append({
      channelId: 'api:cogsec-seal-fail',
      role: 'user',
      content: 'dirty payload survives because seal failed',
      timestamp: 1_000,
    });

    expect(() => store.applyCogSecTombstones({
      channelId: 'api:cogsec-seal-fail',
      caseId: 'cogsec_20260701T000000Z_sealfail',
      eventStore,
      forensicArchive: {
        sealArtifact: () => {
          throw new Error('seal failed');
        },
      },
      messageIds: [dirtyId],
    })).toThrow('seal failed');

    const journalPath = findSessionJournalPath(dir, 'cogsec-seal-fail');
    expect(readFileSync(journalPath, 'utf-8')).toContain('dirty payload survives because seal failed');
    expect(eventStore.getEvent('cogsec_20260701T000000Z_sealfail')?.tombstonedL0RowCount).toBe(0);
  });

  it('re-signs integrity-protected journals after CogSec tombstoning', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:integrity-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    const companionRoot = join(dir, 'companion-data');
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot));
    const forensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot));
    eventStore.createEvent({
      caseId: 'cogsec_20260701T000000Z_hmac',
      type: 'content_poisoning',
      severity: 'medium',
      sourceChannelId: 'discord-source-channel',
      safeAgentSummary: 'Unsafe instruction-like content was sealed and removed from active cognition.',
    });

    const dirtyId = signedStore.append({
      channelId: 'api:cogsec-hmac',
      role: 'user',
      content: 'dirty signed payload',
      timestamp: 1_000,
    });
    signedStore.append({
      channelId: 'api:cogsec-hmac',
      role: 'assistant',
      content: 'signed clean reply',
      timestamp: 2_000,
    });

    signedStore.applyCogSecTombstones({
      channelId: 'api:cogsec-hmac',
      caseId: 'cogsec_20260701T000000Z_hmac',
      eventStore,
      forensicArchive,
      messageIds: [dirtyId],
    });

    const journalPath = findSessionJournalPath(dir, 'cogsec-hmac');
    const lines = readFileSync(journalPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as import('../../core/session/types.js').JournalEntry);

    let previousHmac: string | null = null;
    for (const line of lines) {
      const verification = verifyJournalEntryIntegrity(line, keyring!, previousHmac);
      expect(verification.verified).toBe(true);
      previousHmac = typeof line._hmac === 'string' ? line._hmac : previousHmac;
    }

    const reloaded = new SessionStore(dir, { integrityKeyring: keyring });
    expect(reloaded.getRecent('api:cogsec-hmac', 10).map(entry => entry.content)).toEqual([
      '[CogSec redaction: cogsec_20260701T000000Z_hmac]',
      'signed clean reply',
    ]);
  });

  it('replaces CogSec-affected compaction summaries with safe invalidation markers', () => {
    store.append({
      channelId: 'api:cogsec-summary',
      role: 'user',
      content: 'clean turn',
      timestamp: 1_000,
    });
    store.insertCompaction(
      'api:cogsec-summary',
      'dirty summary text that should leave active cognition',
      1,
    );
    const compactionId = store.getCompactionSummaries('api:cogsec-summary')[0]?.id;
    expect(compactionId).toBeDefined();

    const result = store.applyCogSecCompactionInvalidations({
      channelId: 'api:cogsec-summary',
      caseId: 'cogsec_20260701T000000Z_summary',
      compactionIds: [compactionId!],
    });

    expect(result.invalidatedCompactionIds).toEqual([compactionId]);
    expect(store.getCompactionSummaries('api:cogsec-summary')[0]?.summary).toBe(
      buildCogSecInvalidatedSummaryContent('cogsec_20260701T000000Z_summary'),
    );
    const journalPath = findSessionJournalPath(dir, 'cogsec-summary');
    const journalText = readFileSync(journalPath, 'utf-8');
    expect(journalText).not.toContain('dirty summary text');
    expect(journalText).toContain('[CogSec summary invalidated: cogsec_20260701T000000Z_summary]');

    const reloaded = new SessionStore(dir);
    expect(reloaded.getCompactionSummaries('api:cogsec-summary')[0]?.summary).toBe(
      buildCogSecInvalidatedSummaryContent('cogsec_20260701T000000Z_summary'),
    );
  });

  it('replaces invalidated CogSec compaction summaries with regenerated clean summaries', () => {
    store.append({
      channelId: 'api:cogsec-regenerated-summary',
      role: 'user',
      content: 'clean turn',
      timestamp: 1_000,
    });
    store.insertCompaction(
      'api:cogsec-regenerated-summary',
      'dirty summary text that should be replaced',
      1,
    );
    const compactionId = store.getCompactionSummaries('api:cogsec-regenerated-summary')[0]?.id;
    expect(compactionId).toBeDefined();
    store.applyCogSecCompactionInvalidations({
      channelId: 'api:cogsec-regenerated-summary',
      caseId: 'cogsec_20260701T000000Z_summary',
      compactionIds: [compactionId!],
    });

    const result = store.applyCogSecCompactionRegenerations({
      channelId: 'api:cogsec-regenerated-summary',
      caseId: 'cogsec_20260701T000000Z_summary',
      summaries: [{
        compactionId: compactionId!,
        summary: 'Clean regenerated summary from tombstoned-safe source.',
      }],
    });

    expect(result.regeneratedCompactionIds).toEqual([compactionId]);
    expect(result.skippedCompactionIds).toEqual([]);
    expect(store.getCompactionSummaries('api:cogsec-regenerated-summary')[0]?.summary).toBe(
      'Clean regenerated summary from tombstoned-safe source.',
    );
    const journalPath = findSessionJournalPath(dir, 'cogsec-regenerated-summary');
    const journalText = readFileSync(journalPath, 'utf-8');
    expect(journalText).not.toContain('dirty summary text');
    expect(journalText).not.toContain('[CogSec summary invalidated: cogsec_20260701T000000Z_summary]');
    expect(journalText).toContain('Clean regenerated summary from tombstoned-safe source.');

    const reloaded = new SessionStore(dir);
    expect(reloaded.getCompactionSummaries('api:cogsec-regenerated-summary')[0]?.summary).toBe(
      'Clean regenerated summary from tombstoned-safe source.',
    );
  });

  it('rejects regenerated CogSec compaction summaries that contain tombstone markers', () => {
    store.append({
      channelId: 'api:cogsec-bad-regeneration',
      role: 'user',
      content: 'clean turn',
      timestamp: 1_000,
    });
    store.insertCompaction(
      'api:cogsec-bad-regeneration',
      buildCogSecInvalidatedSummaryContent('cogsec_20260701T000000Z_summary'),
      1,
    );
    const compactionId = store.getCompactionSummaries('api:cogsec-bad-regeneration')[0]?.id;
    expect(compactionId).toBeDefined();

    expect(() => store.applyCogSecCompactionRegenerations({
      channelId: 'api:cogsec-bad-regeneration',
      caseId: 'cogsec_20260701T000000Z_summary',
      summaries: [{
        compactionId: compactionId!,
        summary: '[CogSec redaction: cogsec_20260701T000000Z_summary]',
      }],
    })).toThrow(/must not contain CogSec tombstone/u);
  });

  it('rebuilds transcript projections from authoritative JSONL archives through the injected port', () => {
    const noProjectionStore = new SessionStore(dir);
    noProjectionStore.append({
      channelId: 'api:projection-rebuild',
      role: 'user',
      content: 'Archived transcript remains authoritative',
      timestamp: 1_000,
    });

    const projection: TranscriptProjectionPort = {
      upsertSessionEntry: vi.fn(),
      replaceChannelEntries: vi.fn(),
      countProjectedMessages: vi.fn(() => 0),
      markProjectionDrift: vi.fn(),
      clearProjectionDrift: vi.fn(),
      listProjectionDrift: vi.fn(() => []),
    };

    const reloaded = new SessionStore(dir, { transcriptProjection: projection });
    expect(reloaded.getRecent('api:projection-rebuild', 10)).toHaveLength(1);
    expect(projection.replaceChannelEntries).toHaveBeenCalledWith(
      'api:projection-rebuild',
      [
        expect.objectContaining({
          channelId: 'api:projection-rebuild',
          content: 'Archived transcript remains authoritative',
        }),
      ],
    );
    expect(projection.markProjectionDrift).not.toHaveBeenCalled();
  });

  it('preserves JSONL writes when transcript projection updates fail', () => {
    const projectionError = new Error('projection unavailable');
    const projection: TranscriptProjectionPort = {
      upsertSessionEntry: vi.fn(() => {
        throw projectionError;
      }),
      replaceChannelEntries: vi.fn(),
      countProjectedMessages: vi.fn(() => 0),
      markProjectionDrift: vi.fn(),
      clearProjectionDrift: vi.fn(),
      listProjectionDrift: vi.fn(() => []),
    };
    const projectionBackedStore = new SessionStore(dir, { transcriptProjection: projection });

    const appendedId = projectionBackedStore.append({
      channelId: 'api:projection-failure',
      role: 'assistant',
      content: 'Authoritative archive write should survive projection failure',
      timestamp: 2_000,
    });

    expect(appendedId).toBe(1);
    expect(projection.upsertSessionEntry).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'api:projection-failure',
      id: 1,
    }));
    expect(projection.markProjectionDrift).toHaveBeenCalledWith(
      'api:projection-failure',
      'projection unavailable',
    );
    expect(projectionBackedStore.getRecent('api:projection-failure', 10)).toEqual([
      expect.objectContaining({
        id: 1,
        channelId: 'api:projection-failure',
        content: 'Authoritative archive write should survive projection failure',
      }),
    ]);
    expect(projectionBackedStore.count('api:projection-failure')).toBe(1);

    const reloaded = new SessionStore(dir);
    expect(reloaded.getRecent('api:projection-failure', 10)).toEqual([
      expect.objectContaining({
        id: 1,
        channelId: 'api:projection-failure',
        content: 'Authoritative archive write should survive projection failure',
      }),
    ]);
  });

  it('creates readable filename pattern for new channels and persists mapping', () => {
    store.append({
      channelId: 'api:e2e-internal',
      role: 'user',
      content: 'hello',
      authorId: 'primary-user',
      authorName: 'PrimaryUser',
      timestamp: 1739443200000,
    });

    const sessionFiles = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('user_'));
    expect(sessionFiles).toHaveLength(1);
    expect(sessionFiles[0]).toMatch(/^\d{8}_[a-z0-9-]+_[a-z0-9-]+_\d{6}\.jsonl$/);
    expect(sessionFiles[0]).not.toContain('%3A');

    expect(existsSync(join(dir, '_channel_index.json'))).toBe(true);
    const index = JSON.parse(readFileSync(join(dir, '_channel_index.json'), 'utf-8')) as {
      channels: Record<string, { filename: string; messageCount?: number; lastTimestamp?: number }>;
    };
    expect(index.channels['api:e2e-internal'].filename).toBe(sessionFiles[0]);
    expect(index.channels['api:e2e-internal'].messageCount).toBe(1);
    expect(index.channels['api:e2e-internal'].lastTimestamp).toBe(1739443200000);

    const reloaded = new SessionStore(dir);
    reloaded.append({
      channelId: 'api:e2e-internal',
      role: 'assistant',
      content: 'world',
      timestamp: 1739443201000,
    });

    const entries = reloaded.getRecent('api:e2e-internal', 10);
    expect(entries).toHaveLength(2);

    const updatedIndex = JSON.parse(readFileSync(join(dir, '_channel_index.json'), 'utf-8')) as {
      channels: Record<string, { messageCount?: number; lastTimestamp?: number }>;
    };
    expect(updatedIndex.channels['api:e2e-internal'].messageCount).toBe(2);
    expect(updatedIndex.channels['api:e2e-internal'].lastTimestamp).toBe(1739443201000);

    const filesAfter = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('user_'));
    expect(filesAfter).toHaveLength(1);
    expect(filesAfter[0]).toBe(sessionFiles[0]);
  });

  it('stores and retrieves compaction summaries', () => {
    store.insertCompaction('ch1', 'Previous context summary', 5);

    const summaries = store.getCompactionSummaries('ch1');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toBe('Previous context summary');
    expect(summaries[0].coveredUpTo).toBe(5);
  });

  it('writes graceful shutdown markers for active sessions', () => {
    store.append({
      channelId: 'ch1',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    });
    store.append({
      channelId: 'ch2',
      role: 'assistant',
      content: 'world',
      timestamp: 2_000,
    });

    const marked = store.markGracefulShutdownForActiveChannels(3_000).sort();
    expect(marked).toEqual(['ch1', 'ch2']);
    expect(store.markGracefulShutdownForActiveChannels(4_000)).toEqual([]);

    const reloaded = new SessionStore(dir);
    expect(reloaded.getUncleanShutdownChannels()).toEqual([]);
  });

  it('skips graceful shutdown markers for channels flagged as unresolved', () => {
    store.append({
      channelId: 'ch1',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    });
    store.append({
      channelId: 'ch2',
      role: 'assistant',
      content: 'world',
      timestamp: 2_000,
    });

    const marked = store.markGracefulShutdownForActiveChannels(3_000, {
      skipChannels: new Set(['ch2']),
    });
    expect(marked).toEqual(['ch1']);

    const reloaded = new SessionStore(dir);
    expect(reloaded.getUncleanShutdownChannels()).toEqual(['ch2']);
  });

  it('detects unclean shutdown and reports un-extracted recovery entries', () => {
    const channelId = 'api:recover-extraction';
    store.append({
      channelId,
      role: 'user',
      content: 'Message 1',
      timestamp: 1_000,
    });
    store.insertExtractionMarker(channelId, 1, 1_500);
    store.append({
      channelId,
      role: 'assistant',
      content: 'Message 2',
      timestamp: 2_000,
    });
    store.append({
      channelId,
      role: 'user',
      content: 'Message 3',
      timestamp: 3_000,
    });

    const reloaded = new SessionStore(dir);
    expect(reloaded.getUncleanShutdownChannels()).toContain(channelId);

    const candidates = reloaded.getCrashRecoveryExtractionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].channelId).toBe(channelId);
    expect(candidates[0].lastExtractionCoveredUpTo).toBe(1);
    expect(candidates[0].unextractedEntries.map(entry => entry.content)).toEqual([
      'Message 2',
      'Message 3',
    ]);

    reloaded.markGracefulShutdownForActiveChannels(3_500);
    const cleanReload = new SessionStore(dir);
    expect(cleanReload.getUncleanShutdownChannels()).toEqual([]);
    expect(cleanReload.getCrashRecoveryExtractionCandidates()).toEqual([]);
  });

  it('persists data across store instances', () => {
    store.append({
      channelId: 'ch1',
      role: 'user',
      content: 'Persistent message',
      timestamp: 1000,
    });
    store.insertCompaction('ch1', 'Summary from before', 1);

    // Create a new store pointing at the same directory
    const store2 = new SessionStore(dir);

    const entries = store2.getRecent('ch1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Persistent message');

    const summaries = store2.getCompactionSummaries('ch1');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toBe('Summary from before');
  });

  it('handles large sessions via tail-first recent loads and metadata index', () => {
    const channelId = 'api:large-tail';
    const baseTimestamp = 1_700_000_000_000;

    for (let i = 0; i < 1500; i++) {
      store.append({
        channelId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        timestamp: baseTimestamp + i,
      });
    }

    const reloaded = new SessionStore(dir);
    expect(reloaded.count(channelId)).toBe(1500);

    const recent = reloaded.getRecent(channelId, 5);
    expect(recent).toHaveLength(5);
    expect(recent[0].content).toBe('Message 1495');
    expect(recent[4].content).toBe('Message 1499');

    const index = JSON.parse(readFileSync(join(dir, '_channel_index.json'), 'utf-8')) as {
      channels: Record<string, { messageCount?: number; lastTimestamp?: number }>;
    };
    expect(index.channels[channelId].messageCount).toBe(1500);
    expect(index.channels[channelId].lastTimestamp).toBe(baseTimestamp + 1499);
  });

  it('caches lightweight session tails across repeated unchanged reads', () => {
    const channelId = 'api:tail-cache-repeat';
    appendSessionMessages(store, channelId, 8);

    const archivePort = createFilesystemSessionArchivePort();
    const tailSpy = vi.spyOn(archivePort, 'readJournalTailEntries');
    const reloaded = new SessionStore(dir, { sessionArchivePort: archivePort });
    tailSpy.mockClear();

    const first = reloaded.getRecent(channelId, 3);
    const second = reloaded.getRecent(channelId, 3);

    expect(first.map(entry => entry.content)).toEqual(['Message 5', 'Message 6', 'Message 7']);
    expect(second).toEqual(first);
    expect(tailSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached lightweight tails after append', () => {
    const channelId = 'api:tail-cache-append';
    appendSessionMessages(store, channelId, 5);

    const archivePort = createFilesystemSessionArchivePort();
    const tailSpy = vi.spyOn(archivePort, 'readJournalTailEntries');
    const reloaded = new SessionStore(dir, { sessionArchivePort: archivePort });
    tailSpy.mockClear();

    expect(reloaded.getRecent(channelId, 2).map(entry => entry.content)).toEqual(['Message 3', 'Message 4']);
    expect(tailSpy).toHaveBeenCalledTimes(1);

    reloaded.append({
      channelId,
      role: 'assistant',
      content: 'Message 5',
      timestamp: 1_700_000_000_005,
    });

    expect(reloaded.getRecent(channelId, 2).map(entry => entry.content)).toEqual(['Message 4', 'Message 5']);
    expect(tailSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps tail cache entries isolated by channel and requested size', () => {
    appendSessionMessages(store, 'api:tail-cache-alpha', 6, 'alpha');
    appendSessionMessages(store, 'api:tail-cache-beta', 6, 'beta');

    const archivePort = createFilesystemSessionArchivePort();
    const tailSpy = vi.spyOn(archivePort, 'readJournalTailEntries');
    const reloaded = new SessionStore(dir, { sessionArchivePort: archivePort });
    tailSpy.mockClear();

    expect(reloaded.getRecent('api:tail-cache-alpha', 2).map(entry => entry.content)).toEqual(['alpha 4', 'alpha 5']);
    expect(reloaded.getRecent('api:tail-cache-alpha', 3).map(entry => entry.content)).toEqual([
      'alpha 3',
      'alpha 4',
      'alpha 5',
    ]);
    expect(reloaded.getRecent('api:tail-cache-beta', 2).map(entry => entry.content)).toEqual(['beta 4', 'beta 5']);
    expect(tailSpy).toHaveBeenCalledTimes(3);

    expect(reloaded.getRecent('api:tail-cache-alpha', 2).map(entry => entry.content)).toEqual(['alpha 4', 'alpha 5']);
    expect(reloaded.getRecent('api:tail-cache-alpha', 3).map(entry => entry.content)).toEqual([
      'alpha 3',
      'alpha 4',
      'alpha 5',
    ]);
    expect(reloaded.getRecent('api:tail-cache-beta', 2).map(entry => entry.content)).toEqual(['beta 4', 'beta 5']);
    expect(tailSpy).toHaveBeenCalledTimes(3);
  });

  it('does not let cached tails hide malformed archive lines', () => {
    const channelId = 'api:tail-cache-parse';
    appendSessionMessages(store, channelId, 5);

    const archivePort = createFilesystemSessionArchivePort();
    const tailSpy = vi.spyOn(archivePort, 'readJournalTailEntries');
    const reloaded = new SessionStore(dir, { sessionArchivePort: archivePort });
    tailSpy.mockClear();

    expect(reloaded.getRecent(channelId, 2).map(entry => entry.content)).toEqual(['Message 3', 'Message 4']);
    expect(tailSpy).toHaveBeenCalledTimes(1);

    const journalPath = findSessionJournalPath(dir, 'tail-cache-parse');
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf-8')}{bad\n`, 'utf-8');

    expect(reloaded.getRecent(channelId, 2).map(entry => entry.content)).toEqual(['Message 3', 'Message 4']);
    expect(tailSpy).toHaveBeenCalledTimes(2);
    const tailResult = tailSpy.mock.results.at(-1)?.value as { quarantined?: Array<{ raw: string }> } | undefined;
    expect(tailResult?.quarantined).toEqual([expect.objectContaining({ raw: '{bad' })]);
  });

  it('does not let cached tails hide integrity failures after archive changes', () => {
    const channelId = 'api:tail-cache-integrity';
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:integrity-key',
      activeVersion: 'v1',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    appendSessionMessages(signedStore, channelId, 4, 'signed');

    const archivePort = createFilesystemSessionArchivePort();
    const tailSpy = vi.spyOn(archivePort, 'readJournalTailEntries');
    const reloaded = new SessionStore(dir, {
      integrityKeyring: keyring,
      sessionArchivePort: archivePort,
    });
    tailSpy.mockClear();

    expect(reloaded.getRecent(channelId, 2).map(entry => entry.content)).toEqual(['signed 2', 'signed 3']);
    expect(tailSpy).toHaveBeenCalledTimes(1);

    const journalPath = findSessionJournalPath(dir, 'tail-cache-integrity');
    const lines = readFileSync(journalPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    lines[3].content = 'tampered 3 with additional bytes';
    writeFileSync(journalPath, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf-8');

    const entries = reloaded.getRecent(channelId, 2);
    expect(tailSpy).toHaveBeenCalledTimes(2);
    expect(entries[0].content).toBe('signed 2');
    expect(entries[1].content).toContain('<unverified_history>');
    expect(entries[1].content).toContain('tampered 3 with additional bytes');
  });

  it('persists discord message IDs for dedup helpers', () => {
    store.append({
      channelId: '123456789012345678',
      role: 'user',
      content: 'Hello from Discord',
      authorId: 'user-1',
      authorName: 'Alice',
      timestamp: 1000,
      discordMessageId: 'msg-1',
    });
    store.append({
      channelId: '123456789012345678',
      role: 'assistant',
      content: 'Reply',
      timestamp: 2000,
    });
    store.append({
      channelId: '123456789012345678',
      role: 'user',
      content: 'Follow-up',
      authorId: 'user-1',
      authorName: 'Alice',
      timestamp: 3000,
      discordMessageId: 'msg-2',
    });

    const ids = store.getRecentDiscordMessageIds('123456789012345678', 10);
    expect(ids.has('msg-1')).toBe(true);
    expect(ids.has('msg-2')).toBe(true);
    expect(store.getLastEntry('123456789012345678')?.discordMessageId).toBe('msg-2');

    const reloaded = new SessionStore(dir);
    const reloadedIds = reloaded.getRecentDiscordMessageIds('123456789012345678', 10);
    expect(reloadedIds.has('msg-1')).toBe(true);
    expect(reloadedIds.has('msg-2')).toBe(true);
    expect(reloaded.getLastEntry('123456789012345678')?.discordMessageId).toBe('msg-2');
  });

  it('assigns monotonic IDs', () => {
    const id1 = store.append({ channelId: 'ch1', role: 'user', content: 'A', timestamp: 1000 });
    const id2 = store.append({ channelId: 'ch1', role: 'user', content: 'B', timestamp: 2000 });

    expect(id1).toBe(1);
    expect(id2).toBe(2);

    // Reload and continue
    const store2 = new SessionStore(dir);
    const id3 = store2.append({ channelId: 'ch1', role: 'user', content: 'C', timestamp: 3000 });
    expect(id3).toBe(3);
  });
  it('reconciles stale cross-instance HMAC cursors before append', () => {
    const channelId = 'api:stale-integrity';
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:integrity-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const writer = new SessionStore(dir, { integrityKeyring: keyring });
    expect(writer.append({ channelId, role: 'user', content: 'first', timestamp: 1_000 })).toBe(1);

    const staleWriter = new SessionStore(dir, { integrityKeyring: keyring });
    expect(staleWriter.getRecent(channelId, 10).map(entry => entry.content)).toEqual(['first']);

    expect(writer.append({ channelId, role: 'assistant', content: 'second', timestamp: 2_000 })).toBe(2);
    expect(staleWriter.append({ channelId, role: 'user', content: 'third', timestamp: 3_000 })).toBe(3);

    const file = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('user_'))
      .find(f => f.includes('stale-integrity'));
    expect(file).toBeDefined();
    const lines = readFileSync(join(dir, file!), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as import('../../core/session/types.js').JournalEntry);

    expect(lines.filter(entry => entry.type === 'message').map(entry => entry.id)).toEqual([1, 2, 3]);

    let previousHmac: string | null = null;
    for (const line of lines) {
      const verification = verifyJournalEntryIntegrity(line, keyring!, previousHmac);
      expect(verification.verified).toBe(true);
      previousHmac = typeof line._hmac === 'string' ? line._hmac : previousHmac;
    }

    const reloaded = new SessionStore(dir, { integrityKeyring: keyring });
    expect(reloaded.getRecent(channelId, 10).map(entry => entry.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });


  it('rolls back in-memory append state when journal persistence fails', () => {
    const channelId = 'api:append-rollback';
    const journalRuntime = (store as unknown as { journalRuntime: { writeJournalEntry: (params: unknown) => void } }).journalRuntime;
    vi.spyOn(journalRuntime, 'writeJournalEntry').mockImplementationOnce(() => {
      throw new Error('simulated journal append failure');
    });

    expect(() => store.append({
      channelId,
      role: 'user',
      content: 'will fail',
      timestamp: 1_000,
    })).toThrow('simulated journal append failure');

    expect(store.count(channelId)).toBe(0);
    expect(store.getRecent(channelId, 10)).toEqual([]);

    const recoveredId = store.append({
      channelId,
      role: 'user',
      content: 'after rollback',
      timestamp: 2_000,
    });
    expect(recoveredId).toBe(1);
    expect(store.count(channelId)).toBe(1);
    expect(store.getRecent(channelId, 10).map(entry => entry.content)).toEqual(['after rollback']);
  });

  it('handles channelId with colons (api:session-1)', () => {
    store.append({ channelId: 'api:session-1', role: 'user', content: 'Hello', timestamp: 1000 });
    const entries = store.getRecent('api:session-1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Hello');

    // Reload from disk
    const store2 = new SessionStore(dir);
    const entries2 = store2.getRecent('api:session-1', 10);
    expect(entries2).toHaveLength(1);
  });

  it('handles channelId with shard:uuid format', () => {
    const channelId = 'shard:550e8400-e29b-41d4-a716-446655440000';
    store.append({ channelId, role: 'user', content: 'Shard msg', timestamp: 1000 });
    expect(store.count(channelId)).toBe(1);
  });

  it('handles channelId with slashes (discord/guild/channel)', () => {
    const channelId = 'discord/guild/channel';
    store.append({ channelId, role: 'user', content: 'Slashed', timestamp: 1000 });
    expect(store.count(channelId)).toBe(1);

    const store2 = new SessionStore(dir);
    expect(store2.count(channelId)).toBe(1);
  });

  it('handles channelId with dangerous characters', () => {
    const dangerous = 'ch\x00../../../etc/passwd';
    store.append({ channelId: dangerous, role: 'user', content: 'Sneaky', timestamp: 1000 });
    expect(store.count(dangerous)).toBe(1);

    const store2 = new SessionStore(dir);
    expect(store2.count(dangerous)).toBe(1);
  });

  it('handles channelId with backslash', () => {
    const channelId = 'test\\path\\channel';
    store.append({ channelId, role: 'user', content: 'Backslash', timestamp: 1000 });
    expect(store.count(channelId)).toBe(1);
  });

  it('lists channels with special characters', () => {
    store.append({ channelId: 'api:session-1', role: 'user', content: 'A', timestamp: 1000 });
    store.append({ channelId: 'discord/guild/ch', role: 'user', content: 'B', timestamp: 1000 });

    const channels = store.listChannels();
    const ids = channels.map(c => c.channelId).sort();
    expect(ids).toContain('api:session-1');
    expect(ids).toContain('discord/guild/ch');
  });

  it('supports multiple L0 sessions for one logical channel', () => {
    const channelId = 'voxta:legacy:cf0a06ea';
    writeFileSync(join(dir, '20241119_voxta-legacy-cf0a06ea_alex_111111.jsonl'), [
      JSON.stringify({
        type: 'message',
        id: 1,
        channelId,
        role: 'user',
        content: 'older session',
        timestamp: 1_731_994_680_409,
      }),
      '',
    ].join('\n'));
    writeFileSync(join(dir, '20241225_voxta-legacy-cf0a06ea_alex_222222.jsonl'), [
      JSON.stringify({
        type: 'message',
        id: 1,
        channelId,
        role: 'assistant',
        content: 'newer session',
        timestamp: 1_735_138_451_488,
      }),
      '',
    ].join('\n'));

    const reloaded = new SessionStore(dir);
    const sessions = reloaded.listChannels().filter(session => session.channelId === channelId);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map(session => session.sessionId)).size).toBe(2);

    const contentBySessionId = new Map(
      sessions.map(session => [session.sessionId, reloaded.getRecent(session.sessionId, 10)[0]?.content ?? '']),
    );
    expect(new Set(contentBySessionId.values())).toEqual(new Set(['older session', 'newer session']));

    expect(reloaded.getRecent(channelId, 10).map(entry => entry.content)).toEqual(['newer session']);
  });

  it('resolves latest session by last message timestamp across channels', () => {
    store.append({
      channelId: 'api:older',
      role: 'user',
      content: 'older',
      timestamp: 2_000,
    });
    store.append({
      channelId: 'api:newer',
      role: 'assistant',
      content: 'newer',
      timestamp: 3_000,
    });

    // Graceful markers are newer than messages and should not affect latest-session selection.
    store.markGracefulShutdownForActiveChannels(4_000);

    expect(store.getLatestSessionByTimestamp()).toEqual({
      sessionId: 'api:newer',
      timestamp: 3_000,
      channelType: 'api',
    });
  });

  it('lists sessions by recent activity with metadata', () => {
    store.append({
      channelId: 'api:b-session',
      role: 'assistant',
      content: 'Second session latest',
      timestamp: 2_000,
    });
    store.append({
      channelId: 'api:a-session',
      role: 'user',
      content: 'First session latest',
      authorName: 'Alice',
      timestamp: 2_000,
    });
    store.append({
      channelId: 'api:c-session',
      role: 'assistant',
      content: 'Older session',
      timestamp: 1_000,
    });

    const sessions = store.listSessionsByRecentActivity(10);
    expect(sessions.map(session => session.sessionId)).toEqual([
      'api:a-session',
      'api:b-session',
      'api:c-session',
    ]);
    expect(sessions[0].messageCount).toBe(1);
    expect(sessions[0].lastActivityAt).toBe(2_000);
    expect(sessions[0].lastRole).toBe('user');
    expect(sessions[0].lastAuthorName).toBe('Alice');
    expect(sessions[0].lastMessagePreview).toBe('First session latest');
  });

  it('returns null for latest session when no messages exist', () => {
    expect(store.getLatestSessionByTimestamp()).toBeNull();
  });

  it('backward compat: appends to legacy file (no split-brain)', () => {
    // Simulate old-format file
    const oldFilename = 'api-session-1.jsonl';
    const journalLine = JSON.stringify({
      type: 'message', id: 1, channelId: 'api:session-1',
      role: 'user', content: 'Old msg', timestamp: 1000,
    });
    writeFileSync(join(dir, oldFilename), journalLine + '\n');

    // Load from legacy, then append
    const store1 = new SessionStore(dir);
    store1.append({ channelId: 'api:session-1', role: 'assistant', content: 'New msg', timestamp: 2000 });
    expect(store1.count('api:session-1')).toBe(2);

    // Reload — must get BOTH messages (not just the new one)
    const store2 = new SessionStore(dir);
    const entries = store2.getRecent('api:session-1', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('Old msg');
    expect(entries[1].content).toBe('New msg');
  });

  it('backward compat: listChannels reads old-format files', () => {
    // Simulate an old-format file: colon was replaced with -, slash with _
    const oldFilename = 'api-session-1.jsonl';
    const journalLine = JSON.stringify({
      type: 'message',
      id: 1,
      channelId: 'api:session-1',
      role: 'user',
      content: 'Old format',
      timestamp: 1000,
    });
    writeFileSync(join(dir, oldFilename), journalLine + '\n');

    const freshStore = new SessionStore(dir);
    const channels = freshStore.listChannels();
    const found = channels.find(c => c.channelId === 'api:session-1');
    expect(found).toBeDefined();
    expect(found!.messageCount).toBe(1);
  });

  it('falls back to disk scan when channel index is malformed', () => {
    store.append({
      channelId: 'api:fallback-test',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    });
    writeFileSync(join(dir, '_channel_index.json'), '{not valid json');

    const reloaded = new SessionStore(dir);
    const channels = reloaded.listChannels();
    const found = channels.find(c => c.channelId === 'api:fallback-test');
    expect(found).toBeDefined();
    expect(found!.messageCount).toBe(1);
  });

  it('loads valid entries around malformed lines and writes a quarantine sidecar', () => {
    const channelId = 'api:recover-test';
    const filename = 'api-recover-test.jsonl';
    const filePath = join(dir, filename);

    const raw = [
      JSON.stringify({
        type: 'message',
        id: 1,
        channelId,
        role: 'user',
        content: 'before',
        timestamp: 1000,
      }),
      '{bad',
      JSON.stringify({
        type: 'message',
        id: 3,
        channelId,
        role: 'assistant',
        content: 'after',
        timestamp: 3000,
      }),
      '',
    ].join('\n');

    writeFileSync(filePath, raw, 'utf-8');

    const reloaded = new SessionStore(dir);
    const entries = reloaded.getRecent(channelId, 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('before');
    expect(entries[1].content).toBe('after');

    const sessionFiles = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    expect(sessionFiles).toHaveLength(1);
    const quarantinePath = join(dir, sessionFiles[0] + '.quarantine');
    expect(existsSync(quarantinePath)).toBe(true);
    const quarantine = readFileSync(quarantinePath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { lineNumber: number; raw: string });

    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]).toMatchObject({ lineNumber: 2, raw: '{bad' });
  });

  it('handles malformed journal files without throwing during channel discovery', () => {
    writeFileSync(join(dir, 'broken-session.jsonl'), '{oops\n');

    const reloaded = new SessionStore(dir);
    expect(() => reloaded.listChannels()).not.toThrow();
  });

  it('imports legacy chats preserving timestamps, provenance metadata, and integrity signatures', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:legacy-import-key',
      activeVersion: 'v1',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    const sourcePath = join(dir, 'legacy-import-source.jsonl');
    const sourceLines = [
      JSON.stringify({
        role: 'user',
        content: 'Legacy hello',
        timestamp: 1_700_000_000_000,
        authorName: 'Legacy User',
        metadata: { turn: 1 },
      }),
      JSON.stringify({
        role: 'assistant',
        message: 'Legacy reply',
        createdAt: '2024-01-01T00:00:01.000Z',
      }),
    ];
    writeFileSync(sourcePath, sourceLines.join('\n') + '\n', 'utf-8');

    const result = signedStore.importLegacyChatFromFile({
      channelId: 'api:legacy-import',
      sourcePath,
      defaultChannelVisibility: 'private',
      metadataTag: 'seed-import',
    });

    expect(result.manifest.importedRecordCount).toBe(2);
    expect(result.manifest.entryRanges).toEqual([
      {
        sourceStartIndex: 0,
        sourceEndIndex: 1,
        firstEntryId: 1,
        lastEntryId: 2,
        messageCount: 2,
      },
    ]);
    expect(result.importedEntryIds).toEqual([1, 2]);

    const entries = signedStore.getRecent('api:legacy-import', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].timestamp).toBe(1_700_000_000_000);
    expect(entries[1].timestamp).toBe(Date.parse('2024-01-01T00:00:01.000Z'));

    const metadata = JSON.parse(entries[0].metadata ?? '{}') as Record<string, unknown>;
    expect(metadata.type).toBe('legacy_import');
    expect(metadata.sourcePath).toBe(sourcePath);
    expect(metadata.sourceIndex).toBe(0);
    expect(metadata.sourceTimestamp).toBe(1_700_000_000_000);
    expect(metadata.tag).toBe('seed-import');

    const sessionFile = readdirSync(dir).find(
      f => f.endsWith('.jsonl') && !f.startsWith('user_') && f !== '_import_manifest.jsonl',
    );
    expect(sessionFile).toBeDefined();
    const signedLines = readFileSync(join(dir, sessionFile!), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { _hmac?: string; _hmacKeyVersion?: string });
    expect(signedLines).toHaveLength(2);
    expect(signedLines[0]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(signedLines[1]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(signedLines[0]._hmacKeyVersion).toBe('v1');

    const manifestLines = readFileSync(join(dir, '_import_manifest.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { sourcePath: string; channelId: string; entryRanges: unknown[] });
    expect(manifestLines).toHaveLength(1);
    expect(manifestLines[0].sourcePath).toBe(sourcePath);
    expect(manifestLines[0].channelId).toBe('api:legacy-import');
    expect(manifestLines[0].entryRanges).toHaveLength(1);
  });

  it('resumes legacy imports using manifest source index mapping', () => {
    const sourcePath = join(dir, 'legacy-resume-source.json');
    const channelId = 'api:legacy-resume';
    const firstBatch = [
      { role: 'user', content: 'one', timestamp: 1_700_000_001_000 },
      { role: 'assistant', content: 'two', timestamp: 1_700_000_002_000 },
      { role: 'user', content: 'three', timestamp: 1_700_000_003_000 },
    ];
    writeFileSync(sourcePath, JSON.stringify(firstBatch), 'utf-8');

    const firstImport = store.importLegacyChatFromFile({
      channelId,
      sourcePath,
    });
    expect(firstImport.manifest.importedRecordCount).toBe(3);
    expect(firstImport.manifest.nextSourceIndex).toBe(3);
    expect(store.count(channelId)).toBe(3);

    const secondBatch = [
      ...firstBatch,
      { role: 'assistant', content: 'four', timestamp: 1_700_000_004_000 },
      { role: 'user', content: 'five', timestamp: 1_700_000_005_000 },
    ];
    writeFileSync(sourcePath, JSON.stringify(secondBatch), 'utf-8');

    const secondImport = store.importLegacyChatFromFile({
      channelId,
      sourcePath,
    });
    expect(secondImport.manifest.resumedFromSourceIndex).toBe(3);
    expect(secondImport.manifest.importedRecordCount).toBe(2);
    expect(secondImport.manifest.nextSourceIndex).toBe(5);
    expect(secondImport.manifest.entryRanges).toEqual([
      {
        sourceStartIndex: 3,
        sourceEndIndex: 4,
        firstEntryId: 4,
        lastEntryId: 5,
        messageCount: 2,
      },
    ]);
    expect(store.count(channelId)).toBe(5);

    const manifests = store.listLegacyImportManifests({ channelId, sourcePath });
    expect(manifests).toHaveLength(2);
    expect(manifests[0].nextSourceIndex).toBe(3);
    expect(manifests[1].nextSourceIndex).toBe(5);
  });

  it('writes HMAC metadata for each signed journal entry', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:old-key,v2:new-key',
      activeVersion: 'v2',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    signedStore.append({
      channelId: 'secure:ch',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    });
    signedStore.append({
      channelId: 'secure:ch',
      role: 'assistant',
      content: 'world',
      timestamp: 2000,
    });

    const file = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .find(f => !f.startsWith('user_'));
    expect(file).toBeDefined();

    const lines = readFileSync(join(dir, file!), 'utf-8')
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as { _hmac?: string; _hmacKeyVersion?: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(lines[1]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(lines[0]._hmacKeyVersion).toBe('v2');
    expect(lines[1]._hmacKeyVersion).toBe('v2');
  });

  it('wraps tampered entries with <unverified_history> on load', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:integrity-key',
      activeVersion: 'v1',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    signedStore.append({
      channelId: 'api:session-1',
      role: 'user',
      content: 'original',
      timestamp: 1000,
    });
    signedStore.append({
      channelId: 'api:session-1',
      role: 'assistant',
      content: 'untouched',
      timestamp: 2000,
    });

    const file = readdirSync(dir).find(f => f.endsWith('.jsonl') && !f.startsWith('user_'));
    expect(file).toBeDefined();
    const filePath = join(dir, file!);
    const lines = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    lines[0].content = 'tampered';
    writeFileSync(filePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');

    const reloaded = new SessionStore(dir, { integrityKeyring: keyring });
    const entries = reloaded.getRecent('api:session-1', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toContain('<unverified_history>');
    expect(entries[0].content).toContain('tampered');
    expect(entries[1].content).toBe('untouched');
  });

  it('keeps unmodified signed entries verified on reload', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:integrity-key',
      activeVersion: 'v1',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    signedStore.append({
      channelId: 'api:stable',
      role: 'user',
      content: 'safe',
      timestamp: 1000,
    });

    const reloaded = new SessionStore(dir, { integrityKeyring: keyring });
    const entries = reloaded.getRecent('api:stable', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('safe');
    expect(entries[0].content).not.toContain('<unverified_history>');
  });

  it('supports key rotation while verifying older entries', () => {
    const firstKeyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:old-key',
      activeVersion: 'v1',
    });
    const rotatingStore = new SessionStore(dir, { integrityKeyring: firstKeyring });
    rotatingStore.append({
      channelId: 'api:rotate',
      role: 'user',
      content: 'first',
      timestamp: 1000,
    });

    const rotatedKeyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:old-key,v2:new-key',
      activeVersion: 'v2',
    });
    const rotatedStore = new SessionStore(dir, { integrityKeyring: rotatedKeyring });
    rotatedStore.append({
      channelId: 'api:rotate',
      role: 'assistant',
      content: 'second',
      timestamp: 2000,
    });

    const file = readdirSync(dir).find(f => f.endsWith('.jsonl') && !f.startsWith('user_'));
    expect(file).toBeDefined();
    const lines = readFileSync(join(dir, file!), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { _hmacKeyVersion?: string });
    expect(lines[0]._hmacKeyVersion).toBe('v1');
    expect(lines[1]._hmacKeyVersion).toBe('v2');

    const reloaded = new SessionStore(dir, { integrityKeyring: rotatedKeyring });
    const entries = reloaded.getRecent('api:rotate', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('first');
    expect(entries[1].content).toBe('second');
    expect(entries[0].content).not.toContain('<unverified_history>');
    expect(entries[1].content).not.toContain('<unverified_history>');
  });

  it('does not cascade a bad middle signature into later image-review turns', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:integrity-key',
      activeVersion: 'v1',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    signedStore.append({
      channelId: 'api:vision-tail',
      role: 'user',
      content: 'before the image turn',
      timestamp: 1000,
    });
    signedStore.append({
      channelId: 'api:vision-tail',
      role: 'assistant',
      content: 'this signature will be corrupted',
      timestamp: 2000,
    });
    signedStore.append({
      channelId: 'api:vision-tail',
      role: 'user',
      content: 'what is in the image?',
      timestamp: 3000,
    });
    signedStore.append({
      channelId: 'api:vision-tail',
      role: 'assistant',
      content: 'Current image review: A catgirl sits on a server rack.',
      timestamp: 4000,
    });

    const file = readdirSync(dir).find(f => f.endsWith('.jsonl') && !f.startsWith('user_'));
    expect(file).toBeDefined();
    const filePath = join(dir, file!);
    const lines = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    lines[1]._hmac = 'not-a-real-hmac';
    writeFileSync(filePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');

    const reloaded = new SessionStore(dir, { integrityKeyring: keyring });
    const tailEntries = reloaded.getRecent('api:vision-tail', 2);
    expect(tailEntries).toHaveLength(2);
    expect(tailEntries[0].content).toBe('what is in the image?');
    expect(tailEntries[0].content).not.toContain('<unverified_history>');
    expect(tailEntries[1].content).toBe('Current image review: A catgirl sits on a server rack.');
    expect(tailEntries[1].content).not.toContain('<unverified_history>');

    const fullEntries = reloaded.getRecent('api:vision-tail', 10);
    expect(fullEntries).toHaveLength(4);
    expect(fullEntries[1].content).toContain('<unverified_history>');
    expect(fullEntries[2].content).toBe('what is in the image?');
    expect(fullEntries[3].content).toBe('Current image review: A catgirl sits on a server rack.');
  });

  it('does not branch exponentially when replaying a run of mismatched signed entries', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:integrity-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();
    const provider = {
      sign: (entry: Parameters<typeof signJournalEntry>[0], previousHmac: string | null) => signJournalEntry(
        entry,
        keyring!,
        previousHmac,
      ),
      verify: vi.fn((entry: Parameters<typeof verifyJournalEntryIntegrity>[0], previousHmac: string | null) => verifyJournalEntryIntegrity(
        entry,
        keyring!,
        previousHmac,
      )),
    };

    const signedStore = new SessionStore(dir, { integrityProvider: provider });
    for (let index = 1; index <= 6; index += 1) {
      signedStore.append({
        channelId: 'api:mismatch-run',
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `signed message ${index}`,
        timestamp: index * 1_000,
      });
    }

    const file = readdirSync(dir).find(f => f.endsWith('.jsonl') && !f.startsWith('user_'));
    expect(file).toBeDefined();
    const filePath = join(dir, file!);
    const lines = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    for (let index = 0; index < lines.length - 1; index += 1) {
      lines[index].content = `tampered message ${index + 1}`;
    }
    writeFileSync(filePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');

    const reloaded = new SessionStore(dir, { integrityProvider: provider });
    const entries = reloaded.getRecent('api:mismatch-run', 10);
    expect(entries).toHaveLength(6);
    expect(entries[0].content).toContain('<unverified_history>');
    expect(entries[5].content).toBe('signed message 6');
    expect(provider.verify).toHaveBeenCalledTimes(6);
  });

  it('supports RPC-style integrity providers without direct keyring injection', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:provider-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();
    const provider = {
      sign: (entry: Parameters<typeof signJournalEntry>[0], previousHmac: string | null) => signJournalEntry(
        entry,
        keyring!,
        previousHmac,
      ),
      verify: (entry: Parameters<typeof verifyJournalEntryIntegrity>[0], previousHmac: string | null) => verifyJournalEntryIntegrity(
        entry,
        keyring!,
        previousHmac,
      ),
    };

    const providerStore = new SessionStore(dir, { integrityProvider: provider });
    providerStore.append({
      channelId: 'api:provider',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    });
    providerStore.append({
      channelId: 'api:provider',
      role: 'assistant',
      content: 'world',
      timestamp: 2000,
    });

    const file = readdirSync(dir).find(f => f.endsWith('.jsonl') && !f.startsWith('user_'));
    expect(file).toBeDefined();
    const lines = readFileSync(join(dir, file!), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { _hmac?: string; _hmacKeyVersion?: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(lines[1]._hmac).toMatch(/^[a-f0-9]{64}$/i);
    expect(lines[0]._hmacKeyVersion).toBe('v1');
    expect(lines[1]._hmacKeyVersion).toBe('v1');

    const reloaded = new SessionStore(dir, { integrityProvider: provider });
    const entries = reloaded.getRecent('api:provider', 10);
    expect(entries.map(entry => entry.content)).toEqual(['hello', 'world']);
  });

  it('memoizes repeated tail reads for unchanged lightweight channels', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:provider-tail-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();
    const verify = vi.fn((entry: Parameters<typeof verifyJournalEntryIntegrity>[0], previousHmac: string | null) => (
      verifyJournalEntryIntegrity(entry, keyring!, previousHmac)
    ));
    const provider = {
      sign: (entry: Parameters<typeof signJournalEntry>[0], previousHmac: string | null) => signJournalEntry(
        entry,
        keyring!,
        previousHmac,
      ),
      verify,
    };

    const writer = new SessionStore(dir, { integrityProvider: provider });
    writer.append({
      channelId: 'api:provider-tail',
      role: 'user',
      content: 'one',
      timestamp: 1_000,
    });
    writer.append({
      channelId: 'api:provider-tail',
      role: 'assistant',
      content: 'two',
      timestamp: 2_000,
    });
    writer.append({
      channelId: 'api:provider-tail',
      role: 'user',
      content: 'three',
      timestamp: 3_000,
    });
    writer.append({
      channelId: 'api:provider-tail',
      role: 'assistant',
      content: 'four',
      timestamp: 4_000,
    });

    const reloaded = new SessionStore(dir, { integrityProvider: provider });
    expect(reloaded.getRecent('api:provider-tail', 2).map(entry => entry.content)).toEqual(['three', 'four']);
    const verifyCallsAfterFirstRead = verify.mock.calls.length;
    expect(verifyCallsAfterFirstRead).toBeGreaterThan(0);

    expect(reloaded.getRecent('api:provider-tail', 2).map(entry => entry.content)).toEqual(['three', 'four']);
    expect(verify).toHaveBeenCalledTimes(verifyCallsAfterFirstRead);
  });

  it('lists recent session activity from the index without re-verifying journal tails', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:provider-index-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();
    const verify = vi.fn((entry: Parameters<typeof verifyJournalEntryIntegrity>[0], previousHmac: string | null) => (
      verifyJournalEntryIntegrity(entry, keyring!, previousHmac)
    ));
    const provider = {
      sign: (entry: Parameters<typeof signJournalEntry>[0], previousHmac: string | null) => signJournalEntry(
        entry,
        keyring!,
        previousHmac,
      ),
      verify,
    };

    const writer = new SessionStore(dir, { integrityProvider: provider });
    writer.append({
      channelId: 'api:provider-index-a',
      role: 'assistant',
      content: 'Most recent session preview',
      authorName: 'ARTEMIS',
      timestamp: 2_000,
    });
    writer.append({
      channelId: 'api:provider-index-b',
      role: 'user',
      content: 'Older session preview',
      authorName: 'Operator',
      timestamp: 1_000,
    });

    const reloaded = new SessionStore(dir, { integrityProvider: provider });
    const sessions = reloaded.listSessionsByRecentActivity(10);

    expect(sessions.map(session => session.sessionId)).toEqual([
      'api:provider-index-a',
      'api:provider-index-b',
    ]);
    expect(sessions[0]).toMatchObject({
      lastActivityAt: 2_000,
      lastRole: 'assistant',
      lastAuthorName: 'ARTEMIS',
      lastMessagePreview: 'Most recent session preview',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('loads entries without unverified wrapping when no keyring is configured (integrity disabled)', () => {
    // Write entries WITH an HMAC keyring
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:some-key',
      activeVersion: 'v1',
    });
    const signedStore = new SessionStore(dir, { integrityKeyring: keyring });
    signedStore.append({
      channelId: 'api:no-keyring-test',
      role: 'user',
      content: 'signed content',
      timestamp: 1000,
    });

    // Reload WITHOUT any keyring — should load entries normally, not wrap them
    const noKeyringStore = new SessionStore(dir);
    const entries = noKeyringStore.getRecent('api:no-keyring-test', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('signed content');
    expect(entries[0].content).not.toContain('<unverified_history>');
  });
});

describe('sanitizeChannelId / unsanitizeChannelId', () => {
  it('keeps safe characters as-is', () => {
    expect(sanitizeChannelId('hello-world_123.test')).toBe('hello-world_123.test');
  });

  it('encodes colons', () => {
    expect(sanitizeChannelId('api:session-1')).toBe('api%3Asession-1');
  });

  it('encodes slashes', () => {
    expect(sanitizeChannelId('discord/guild/ch')).toBe('discord%2Fguild%2Fch');
  });

  it('encodes null bytes', () => {
    expect(sanitizeChannelId('ch\x00id')).toBe('ch%00id');
  });

  it('encodes backslashes', () => {
    expect(sanitizeChannelId('a\\b')).toBe('a%5Cb');
  });

  it('encodes spaces', () => {
    expect(sanitizeChannelId('hello world')).toBe('hello%20world');
  });

  it('round-trips: sanitize then unsanitize returns original', () => {
    const cases = [
      'api:session-1',
      'shard:550e8400-e29b-41d4-a716-446655440000',
      'discord/guild/channel',
      'test\\path',
      'ch\x00../../../etc/passwd',
      'simple',
      'hello world',
      'with!special@chars#$',
    ];
    for (const original of cases) {
      expect(unsanitizeChannelId(sanitizeChannelId(original))).toBe(original);
    }
  });

  it('round-trips unicode characters (non-ASCII)', () => {
    const cases = [
      'channel-\u20AC',      // Euro sign (U+20AC, 4 hex digits)
      'test-\u00E9',         // é (U+00E9, 2 hex digits)
      'caf\u00E9-chat',      // café-chat
    ];
    for (const original of cases) {
      const sanitized = sanitizeChannelId(original);
      const restored = unsanitizeChannelId(sanitized);
      expect(restored).toBe(original);
    }
  });

  it('unsanitize decodes hex sequences', () => {
    expect(unsanitizeChannelId('api%3Asession-1')).toBe('api:session-1');
    expect(unsanitizeChannelId('discord%2Fguild%2Fch')).toBe('discord/guild/ch');
  });
});
