import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolSchema, TurnRecord } from '../../shared/contracts/runtime.js';
import type { TurnSnapshotRecord } from '../../core/turns/observability.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import { createFilesystemTurnRecordStorePort } from './turn-records.js';
import { createTurnRecordSharedStore } from './turn-record-shared-store.js';

function createTurnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
    requestId: 'req-psfn-amica',
    channelId: 'psfn-amica:test:pi5',
    channelType: 'psfn-amica',
    startedAt: 1_742_000_000_000,
    completedAt: 1_742_000_000_500,
    status: 'completed',
    userMessage: {
      role: 'user',
      content: 'hello',
      timestamp: 1_742_000_000_000,
      authorId: 'pi5',
      authorName: 'Pi5',
    },
    assistantMessage: {
      role: 'assistant',
      content: 'ok',
      timestamp: 1_742_000_000_500,
      authorId: 'companion',
      authorName: 'Companion',
    },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: {
      model: 'psfn',
    },
    provenanceRefs: [],
    ...overrides,
  };
}

describe('turn-records', () => {
  it('persists and reads psfn-amica turn records', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-psfn-amica-turn-records-'));
    const record = createTurnRecord();
    const turnRecordStore: TurnRecordStorePort = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    expect(turnRecordStore.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
  });

  it('round-trips a durable satellite/place location', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-location-'));
    const record = createTurnRecord({
      location: { placeId: 'living_room', satelliteId: 'pi-voice' },
    });
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    const read = turnRecordStore.readRecentTurnRecords(record.channelId, 5);
    expect(read).toEqual([record]);
    expect(read[0]?.location).toEqual({ placeId: 'living_room', satelliteId: 'pi-voice' });
  });

  it('omits location for turns that carried no place binding (legacy rows load fine)', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-nolocation-'));
    const record = createTurnRecord();
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    const read = turnRecordStore.readRecentTurnRecords(record.channelId, 5);
    expect(read).toEqual([record]);
    expect(read[0]).not.toHaveProperty('location');
  });
});

// ── Content-addressed tool definitions (bead hgw3.3) ──

function buildToolDefinitions(marker: string): ToolSchema[] {
  return [
    {
      name: `fixture_tool_${marker}`,
      description: `Fixture tool ${marker} description.`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Generic fixture query.' } },
        required: ['query'],
      },
    },
  ];
}

function buildSnapshotWithPlan(record: TurnRecord, toolDefinitions: ToolSchema[]): TurnSnapshotRecord {
  return {
    turnId: record.turnId,
    requestId: record.requestId,
    channelId: record.channelId,
    capturedAt: record.startedAt,
    trustLevel: 'regular',
    plan: {
      schemaVersion: 1,
      blocks: [],
      variables: {},
      messages: [],
      toolDefinitions,
      scope: { scopeKey: 'dm:fixture', kind: 'dm' },
    } as unknown as TurnSnapshotRecord['plan'],
  };
}

function createSnapshotTurnRecord(
  toolDefinitions: ToolSchema[],
  overrides: Partial<TurnRecord> = {},
): TurnRecord {
  const record = createTurnRecord(overrides);
  return {
    ...record,
    observability: {
      stages: [],
      retrievals: [],
      snapshot: buildSnapshotWithPlan(record, toolDefinitions),
    },
  };
}

function tooldefsDir(sessionsDir: string): string {
  return join(sessionsDir, '_turn_records', '_shared', 'tooldefs');
}

describe('turn-records content-addressed tool definitions (bead hgw3.3)', () => {
  it('persists toolDefinitionsRef with the defs in the sidecar and resolves transparently on read', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-'));
    const record = createSnapshotTurnRecord(buildToolDefinitions('alpha'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);

    store.appendTurnRecord(record);

    const rawLine = readFileSync(join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl'), 'utf-8');
    expect(rawLine).toContain('"toolDefinitionsRef"');
    expect(rawLine).not.toContain('fixture_tool_alpha');
    const sidecarFiles = readdirSync(tooldefsDir(sessionsDir));
    expect(sidecarFiles).toHaveLength(1);

    expect(store.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
  });

  it('stores identical tool-definition sets once and distinct sets separately', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-dedupe-'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    const sharedDefs = buildToolDefinitions('shared');

    store.appendTurnRecord(createSnapshotTurnRecord(sharedDefs, { requestId: 'req-1' }));
    store.appendTurnRecord(createSnapshotTurnRecord(sharedDefs, {
      requestId: 'req-2',
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4f',
    }));
    expect(readdirSync(tooldefsDir(sessionsDir))).toHaveLength(1);

    store.appendTurnRecord(createSnapshotTurnRecord(buildToolDefinitions('other'), {
      requestId: 'req-3',
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e50',
    }));
    expect(readdirSync(tooldefsDir(sessionsDir))).toHaveLength(2);
  });

  it('is write-once: an existing hash file is never rewritten, and hash mismatches fail loudly', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-once-'));
    const sharedStore = createTurnRecordSharedStore(join(sessionsDir, '_turn_records'));
    const defs = buildToolDefinitions('immutable');

    const hash = sharedStore.internToolDefinitions(defs);
    const path = join(tooldefsDir(sessionsDir), `${hash}.json`);
    const sentinel = JSON.stringify(buildToolDefinitions('tampered'));
    writeFileSync(path, sentinel, 'utf-8');

    // Interning the same set again skips the write (the file already exists).
    expect(sharedStore.internToolDefinitions(defs)).toBe(hash);
    expect(readFileSync(path, 'utf-8')).toBe(sentinel);

    // A fresh store hits the disk and fails closed on the content mismatch.
    const freshStore = createTurnRecordSharedStore(join(sessionsDir, '_turn_records'));
    expect(() => freshStore.resolveToolDefinitions(hash)).toThrow(/corrupt/);
  });

  it('fails loudly on a dangling toolDefinitionsRef', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-dangling-'));
    const record = createSnapshotTurnRecord(buildToolDefinitions('gone'));
    createFilesystemTurnRecordStorePort(sessionsDir).appendTurnRecord(record);

    const [sidecarFile] = readdirSync(tooldefsDir(sessionsDir));
    rmSync(join(tooldefsDir(sessionsDir), sidecarFile!));

    // Fresh port: no in-memory memoization of the interned set.
    const freshStore = createFilesystemTurnRecordStorePort(sessionsDir);
    expect(() => freshStore.readRecentTurnRecords(record.channelId, 5))
      .toThrow(/toolDefinitionsRef .* is dangling/);
  });

  it('rejects a record carrying both inline toolDefinitions and a ref', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-ambiguous-'));
    const record = createSnapshotTurnRecord(buildToolDefinitions('both'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    store.appendTurnRecord(record);

    const path = join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl');
    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const snapshot = (persisted.observability as Record<string, unknown>).snapshot as Record<string, unknown>;
    const plan = snapshot.plan as Record<string, unknown>;
    plan.toolDefinitions = buildToolDefinitions('both');
    writeFileSync(path, `${JSON.stringify(persisted)}\n`, 'utf-8');

    expect(() => createFilesystemTurnRecordStorePort(sessionsDir).readRecentTurnRecords(record.channelId, 5))
      .toThrow(/both inline toolDefinitions/);
  });

  it('reads old fat records (inline defs, wire messages, activeTools) exactly as written', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-fat-compat-'));
    const defs = buildToolDefinitions('fat');
    const record = createSnapshotTurnRecord(defs);
    const snapshot = record.observability!.snapshot! as TurnSnapshotRecord & Record<string, unknown>;
    snapshot.promptContext = {
      currentTurnInput: 'fixture input',
      providerObservability: {
        routeKind: 'registered_model',
        requestedProvider: 'fixture-provider',
        requestedModel: 'fixture-model',
        backendProvider: 'fixture-provider',
        backendModel: 'fixture-model',
        backendApi: 'anthropic-messages',
        systemRole: {
          transport: 'anthropic_system',
          supportsSystemRole: true,
          supportsDeveloperRole: false,
          usesOutOfBandSystemPrompt: false,
        },
        promptCaching: { configured: false, engaged: false },
        providerWireMessages: [
          { role: 'system', source: 'system_prompt', content: 'fixture system prompt' },
          { role: 'user', source: 'message', content: 'fixture input' },
        ],
      },
    };
    snapshot.toolContext = { activeTools: buildToolDefinitions('fat') };

    // Historical fat line: written directly, bypassing the slimming append.
    const path = join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl');
    mkdirSync(join(sessionsDir, '_turn_records'), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');

    const [readBack] = createFilesystemTurnRecordStorePort(sessionsDir).readRecentTurnRecords(record.channelId, 5);
    expect(readBack).toEqual(record);
    const readSnapshot = readBack!.observability!.snapshot!;
    expect(readSnapshot.promptContext?.providerObservability?.providerWireMessages).toHaveLength(2);
    expect(readSnapshot.toolContext?.activeTools?.[0]?.name).toBe('fixture_tool_fat');
    expect(readSnapshot.plan?.toolDefinitions[0]?.name).toBe('fixture_tool_fat');
  });
});
