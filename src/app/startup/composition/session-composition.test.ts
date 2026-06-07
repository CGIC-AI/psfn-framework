import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSessionsDir } from '../../../persistence/layout.js';
import { composeSessionRuntimeAsync } from './composition.js';

vi.mock('../../../persistence/sessions/postgres-adapters.js', async () => {
  const journalPort = await vi.importActual<typeof import('../../../persistence/journals/journal/port.js')>(
    '../../../persistence/journals/journal/port.js',
  );
  const turnRecords = await vi.importActual<typeof import('../../../persistence/sessions/turn-records.js')>(
    '../../../persistence/sessions/turn-records.js',
  );
  const createTranscriptProjection = () => ({
    upsertSessionEntry: vi.fn(),
    replaceChannelEntries: vi.fn(),
    countProjectedMessages: vi.fn(() => 0),
    markProjectionDrift: vi.fn(),
    clearProjectionDrift: vi.fn(),
    listProjectionDrift: vi.fn(() => []),
    flushPendingWrites: vi.fn(async () => undefined),
    searchByKeywords: vi.fn(async () => []),
  });

  return {
    createDefaultPostgresSessionAdapters: vi.fn(async (
      _databaseUrl: string,
      options: { sessionsDir: string },
    ) => {
      const transcriptProjection = createTranscriptProjection();
      return {
        sessionArchivePort: journalPort.createFilesystemSessionArchivePort(),
        transcriptProjection,
        transcriptSearch: transcriptProjection,
        turnRecordStore: turnRecords.createFilesystemTurnRecordStorePort(options.sessionsDir),
      };
    }),
  };
});

describe('session runtime composition transcript projection wiring', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('does not create the legacy sqlite search projection in postgres composition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-postgres-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');
    const sessionsDir = resolveSessionsDir(companionDataDir);

    const composition = await composeSessionRuntimeAsync({
      config: {
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      } as any,
    });

    expect(existsSync(join(sessionsDir, 'session-search.sqlite'))).toBe(false);
    await expect(composition.sessionManager.searchByKeywords('anything', 5)).resolves.toEqual([]);
  });

  it('fails closed when session composition is not configured for postgres', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-missing-backend-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeSessionRuntimeAsync({
      config: {
        companionDataDir,
        dataDir: companionDataDir,
      } as any,
    })).rejects.toThrow('requires config.persistenceBackend=postgres');
  });

  it('fails closed for postgres composition without postgresDatabaseUrl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-postgres-missing-url-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeSessionRuntimeAsync({
      config: {
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
      } as any,
    })).rejects.toThrow('requires config.postgresDatabaseUrl');
  });
});
