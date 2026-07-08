import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

  it('wires the default JSONL archive and turn records without creating a sqlite search projection', () => {
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
    expect(adapters.transcriptProjection).toBeNull();
    expect(adapters.transcriptSearch).toBeNull();
    expect(existsSync(join(sessionsDir, 'session-search.sqlite'))).toBe(false);

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

  it('keeps the legacy sqlite projection available only through explicit opt-in', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-sqlite-session-adapters-legacy-search-'));
    dirs.push(sessionsDir);
    const adapters = createDefaultSQLiteSessionAdapters(sessionsDir, { enableSearchIndex: true });

    adapters.transcriptProjection?.upsertSessionEntry({
      id: 1,
      channelId: 'api:legacy-session-stack',
      role: 'user',
      content: 'sqlite projection search needle',
      timestamp: 1_000,
    });

    const hits = adapters.transcriptSearch
      ? await adapters.transcriptSearch.searchByKeywords('projection needle')
      : [];
    expect(hits).toHaveLength(1);
    expect(hits[0].channelId).toBe('api:legacy-session-stack');
    expect(existsSync(join(sessionsDir, 'session-search.sqlite'))).toBe(true);
  });

  it('excludes CogSec tombstones from the sqlite transcript projection', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-sqlite-cogsec-projection-'));
    dirs.push(sessionsDir);
    const adapters = createDefaultSQLiteSessionAdapters(sessionsDir, { enableSearchIndex: true });
    expect(adapters.transcriptSearch).toBeDefined();
    expect(adapters.transcriptProjection).toBeDefined();
    const search = adapters.transcriptSearch!;
    const projection = adapters.transcriptProjection!;

    projection.upsertSessionEntry({
      id: 1,
      channelId: 'api:sqlite-cogsec',
      role: 'user',
      content: 'sqlite dirty search needle',
      timestamp: 1_000,
    });
    await expect(search.searchByKeywords('dirty needle')).resolves.toHaveLength(1);

    projection.upsertSessionEntry({
      id: 1,
      channelId: 'api:sqlite-cogsec',
      role: 'user',
      content: '[CogSec redaction: cogsec_20260701T000000Z_sqlite]',
      metadata: JSON.stringify({
        kind: 'cogsec_l0_tombstone',
        caseId: 'cogsec_20260701T000000Z_sqlite',
        redactedAt: '2026-07-01T00:00:00.000Z',
      }),
      timestamp: 1_000,
    });

    await expect(search.searchByKeywords('dirty needle')).resolves.toHaveLength(0);
    await expect(search.searchByKeywords('CogSec redaction')).resolves.toHaveLength(0);
    expect(projection.countProjectedMessages('api:sqlite-cogsec')).toBe(0);
  });
});
