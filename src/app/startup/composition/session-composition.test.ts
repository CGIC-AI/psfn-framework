import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSessionsDir } from '../../../persistence/layout.js';
import { createDefaultPostgresSessionAdapters } from '../../../persistence/sessions/postgres-adapters.js';
import { composeMemoryStoreAsync, composeSessionRuntimeAsync } from './composition.js';

const postgresStoreMocks = vi.hoisted(() => ({
  createPostgresMemoryStore: vi.fn(async () => ({})),
}));

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
        turnRecordEligibilityFence: {
          withTurnRecordEligibilityFence: async (_key: unknown, operation: () => Promise<unknown>) => operation(),
        },
      };
    }),
  };
});

vi.mock('../../../faculties/memory/postgres-store.js', () => ({
  createPostgresMemoryStore: postgresStoreMocks.createPostgresMemoryStore,
}));

describe('session runtime composition transcript projection wiring', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
    postgresStoreMocks.createPostgresMemoryStore.mockClear();
    vi.mocked(createDefaultPostgresSessionAdapters).mockClear();
  });

  it('pins the transcript projection to the configured companion schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-schema-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await composeSessionRuntimeAsync({
      config: {
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
        postgresSchema: 'companion_alpha',
      } as any,
    });

    expect(createDefaultPostgresSessionAdapters).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn_test',
      expect.objectContaining({
        sessionsDir: resolveSessionsDir(companionDataDir),
        schema: 'companion_alpha',
      }),
    );
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

  it('fails closed when postgres session adapters omit the TurnRecord eligibility fence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-missing-turn-fence-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');
    const sessionsDir = resolveSessionsDir(companionDataDir);
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', { sessionsDir });
    vi.mocked(createDefaultPostgresSessionAdapters).mockResolvedValueOnce({
      ...adapters,
      turnRecordEligibilityFence: undefined,
    } as unknown as Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>);

    await expect(composeSessionRuntimeAsync({
      config: {
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      } as any,
    })).rejects.toThrow('requires a TurnRecord eligibility fence');
  });

  it('accepts an explicit database credential alongside secret-sanitized core config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-explicit-postgres-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    const composition = await composeSessionRuntimeAsync({
      config: {
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
      } as any,
      postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
    });

    await expect(composition.sessionManager.searchByKeywords('anything', 5)).resolves.toEqual([]);
  });

  it('composes postgres memory store without creating a legacy sqlite database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-memory-composition-postgres-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');
    const databaseUrl = 'postgres://postgres:secret@localhost:5432/psfn_test';

    await composeMemoryStoreAsync({
      companionDataDir,
      dataDir: companionDataDir,
      persistenceBackend: 'postgres',
      postgresDatabaseUrl: databaseUrl,
    } as any, 1536);

    expect(existsSync(join(companionDataDir, 'state', 'companion.db'))).toBe(false);
    expect(postgresStoreMocks.createPostgresMemoryStore).toHaveBeenCalledTimes(1);
    const [actualUrl, actualDims, actualOptions] = postgresStoreMocks.createPostgresMemoryStore.mock.calls[0];
    expect(actualUrl).toBe(databaseUrl);
    expect(actualDims).toBe(1536);
    expect(actualOptions).toMatchObject({
      notesDir: join(companionDataDir, 'state', 'notes'),
      scratchpadMirrorPath: join(companionDataDir, 'state', 'notes', 'scratchpad.json'),
    });
  });

  it('fails closed for postgres memory composition without postgresDatabaseUrl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-memory-composition-missing-url-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeMemoryStoreAsync({
      companionDataDir,
      dataDir: companionDataDir,
      persistenceBackend: 'postgres',
    } as any, 1536)).rejects.toThrow('requires config.postgresDatabaseUrl');
  });
});
