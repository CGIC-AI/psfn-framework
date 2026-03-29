import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { createDefaultSQLiteSessionAdapters } from './sqlite-adapters.js';

describe('sqlite session adapters', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('wires the default JSONL archive, sqlite projection/search, and turn records together', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-sqlite-session-adapters-'));
    dirs.push(sessionsDir);
    const adapters = createDefaultSQLiteSessionAdapters(sessionsDir);

    const imported = adapters.sessionArchivePort.writeImportedSession({
      sessionsDir,
      channelId: 'api:default-session-stack',
      seedTimestamp: 1_000,
      messages: [
        {
          role: 'user',
          content: 'default archive message one',
          timestamp: 1_000,
        },
        {
          role: 'assistant',
          content: 'default archive message two',
          timestamp: 2_000,
        },
      ],
    });

    const archive = adapters.sessionArchivePort.openArchive(
      'api:default-session-stack',
      imported.filePath,
    );
    expect(adapters.sessionArchivePort.readJournalFile(archive).entries).toHaveLength(2);

    adapters.transcriptProjection?.upsertSessionEntry({
      id: 1,
      channelId: 'api:default-session-stack',
      role: 'user',
      content: 'sqlite projection search needle',
      timestamp: 1_000,
    });
    const hits = adapters.transcriptProjection
      ? await adapters.transcriptProjection.searchByKeywords('projection needle')
      : [];
    expect(hits).toHaveLength(1);
    expect(hits[0].channelId).toBe('api:default-session-stack');

    const record: TurnRecord = {
      schemaVersion: 1,
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
      requestId: 'req-default-adapters',
      channelId: 'api:default-session-stack',
      channelType: 'api',
      startedAt: 1_000,
      completedAt: 1_250,
      status: 'completed',
      userMessage: {
        role: 'user',
        content: 'hello',
        timestamp: 1_000,
      },
      assistantMessage: {
        role: 'assistant',
        content: 'hi',
        timestamp: 1_250,
      },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: {
        model: 'mock',
      },
      provenanceRefs: [],
    };

    adapters.turnRecordStore.appendTurnRecord(record);
    expect(adapters.turnRecordStore.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
  });
});
