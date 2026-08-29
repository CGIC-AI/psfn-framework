import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fromAny } from '@total-typescript/shoehorn';
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
          withTurnRecordEligibilityFences: async (_keys: readonly unknown[], operation: () => Promise<unknown>) => operation(),
        },
        conversationalActivityWorkset: {
          enumerate: vi.fn(async () => []),
          claim: vi.fn(async () => null),
          resumeClaim: vi.fn(async () => null),
          checkpoint: vi.fn(async () => undefined),
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

  it('pins the transcript projection to the configured companion schema and topology role', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-schema-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    const composition = await composeSessionRuntimeAsync({
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
        postgresSchema: 'companion_alpha',
        postgresRole: 'companion_alpha_runtime',
        multiCompanion: true,
        companionId: 'companion-alpha',
        companionFleet: {
          companions: [{
            companionId: 'companion-alpha',
            postgresSchema: 'companion_alpha',
            postgresRole: 'companion_alpha_runtime',
          }],
        },
      }),
      automataRetentionCompanionId: 'companion-test',
    });

    expect(createDefaultPostgresSessionAdapters).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn_test',
      expect.objectContaining({
        sessionsDir: resolveSessionsDir(companionDataDir),
        schema: 'companion_alpha',
        role: 'companion_alpha_runtime',
      }),
    );
    expect(composition.conversationalActivityWorkset).toBeDefined();
  });

  it('rejects a sibling transcript tenant before opening session adapters', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-sibling-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeSessionRuntimeAsync({
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
        postgresSchema: 'companion_beta',
        postgresRole: 'companion_beta_runtime',
        multiCompanion: true,
        companionId: 'companion-alpha',
        companionFleet: {
          companions: [
            {
              companionId: 'companion-alpha',
              postgresSchema: 'companion_alpha',
              postgresRole: 'companion_alpha_runtime',
            },
            {
              companionId: 'companion-beta',
              postgresSchema: 'companion_beta',
              postgresRole: 'companion_beta_runtime',
            },
          ],
        },
      }),
      automataRetentionCompanionId: 'companion-alpha',
    })).rejects.toThrow('does not match the exact companion tenant authority');

    expect(createDefaultPostgresSessionAdapters).not.toHaveBeenCalled();
  });

  it('does not create the legacy sqlite search projection in postgres composition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-postgres-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');
    const sessionsDir = resolveSessionsDir(companionDataDir);

    const composition = await composeSessionRuntimeAsync({
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      }),
      automataRetentionCompanionId: 'companion-test',
    });

    expect(existsSync(join(sessionsDir, 'session-search.sqlite'))).toBe(false);
    await expect(composition.sessionManager.searchByKeywords('anything', 5)).resolves.toEqual([]);
  });

  it('fails closed when session composition is not configured for postgres', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-missing-backend-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeSessionRuntimeAsync({
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
      }),
    })).rejects.toThrow('requires config.persistenceBackend=postgres');
  });

  it('fails closed for postgres composition without postgresDatabaseUrl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-postgres-missing-url-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeSessionRuntimeAsync({
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
      }),
    })).rejects.toThrow('requires config.postgresDatabaseUrl');
  });

  it('fails closed without an authoritative Automata retention companion identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-missing-companion-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeSessionRuntimeAsync({
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      }),
    })).rejects.toThrow('requires an Automata retention companionId');
    expect(createDefaultPostgresSessionAdapters).not.toHaveBeenCalled();
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
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      }),
      automataRetentionCompanionId: 'companion-test',
    })).rejects.toThrow('requires a TurnRecord eligibility fence');
  });

  it('accepts an explicit database credential alongside secret-sanitized core config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-explicit-postgres-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    const composition = await composeSessionRuntimeAsync({
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
      }),
      postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      automataRetentionCompanionId: 'companion-test',
    });

    await expect(composition.sessionManager.searchByKeywords('anything', 5)).resolves.toEqual([]);
  });

  it('filters merged continuity through the exact channels.json registry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-continuity-registry-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');
    const composition = await composeSessionRuntimeAsync({
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
      }),
      postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      automataRetentionCompanionId: 'companion-test',
      enableContinuity: true,
      continuityChannelIds: ['discord:configured-room'],
    });
    // Continuity content only renders when it resolves against a live L0
    // journal row, so seed through the manager (which stamps sourceEntryId)
    // rather than appending unresolvable rows to the raw store.
    expect(composition.sessionManager.recordUserMessage(
      'discord:configured-room',
      'Configured room entry',
      'contact-1',
      'Contact',
      true,
      'contact-1',
    )).not.toBeNull();
    expect(composition.sessionManager.recordUserMessage(
      'api:head-pat-smoke',
      'Smoke entry',
      'contact-1',
      'Contact',
      true,
      'contact-1',
    )).not.toBeNull();

    expect(composition.sessionManager.crossChannelContinuity.getMerged({
      canonicalUserId: 'contact-1',
      fallbackUserIds: [],
      limit: 10,
      channelId: 'api:current',
    }).map(entry => entry.content)).toEqual(['Configured room entry']);
  });

  it('fails closed when continuity is enabled without a channels.json registry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-session-composition-continuity-missing-registry-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeSessionRuntimeAsync({
      config: fromAny({
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
      }),
      postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      automataRetentionCompanionId: 'companion-test',
      enableContinuity: true,
    })).rejects.toThrow('requires configured channels.json channel ids');
  });

  it('composes postgres memory store without creating a legacy sqlite database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-memory-composition-postgres-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');
    const databaseUrl = 'postgres://postgres:secret@localhost:5432/psfn_test';

    await composeMemoryStoreAsync(fromAny({
      companionDataDir,
      dataDir: companionDataDir,
      persistenceBackend: 'postgres',
      postgresDatabaseUrl: databaseUrl,
      postgresSchema: 'companion_alpha',
      postgresRole: 'companion_alpha_runtime',
      multiCompanion: true,
      companionId: 'companion-alpha',
      companionFleet: {
        companions: [{
          companionId: 'companion-alpha',
          postgresSchema: 'companion_alpha',
          postgresRole: 'companion_alpha_runtime',
        }],
      },
    }), 1536);

    expect(existsSync(join(companionDataDir, 'state', 'companion.db'))).toBe(false);
    expect(postgresStoreMocks.createPostgresMemoryStore).toHaveBeenCalledTimes(1);
    const [actualUrl, actualDims, actualOptions] = postgresStoreMocks.createPostgresMemoryStore.mock.calls[0];
    expect(actualUrl).toBe(databaseUrl);
    expect(actualDims).toBe(1536);
    expect(actualOptions).toMatchObject({
      notesDir: join(companionDataDir, 'state', 'notes'),
      scratchpadMirrorPath: join(companionDataDir, 'state', 'notes', 'scratchpad.json'),
      schema: 'companion_alpha',
      role: 'companion_alpha_runtime',
    });
  });

  it('rejects a sibling memory tenant before opening the store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-memory-composition-sibling-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeMemoryStoreAsync(fromAny({
      companionDataDir,
      dataDir: companionDataDir,
      persistenceBackend: 'postgres',
      postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      postgresSchema: 'companion_beta',
      postgresRole: 'companion_beta_runtime',
      multiCompanion: true,
      companionId: 'companion-alpha',
      companionFleet: {
        companions: [
          {
            companionId: 'companion-alpha',
            postgresSchema: 'companion_alpha',
            postgresRole: 'companion_alpha_runtime',
          },
          {
            companionId: 'companion-beta',
            postgresSchema: 'companion_beta',
            postgresRole: 'companion_beta_runtime',
          },
        ],
      },
    }), 1536)).rejects.toThrow('does not match the exact companion tenant authority');

    expect(postgresStoreMocks.createPostgresMemoryStore).not.toHaveBeenCalled();
  });

  it('fails closed for postgres memory composition without postgresDatabaseUrl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-memory-composition-missing-url-'));
    dirs.push(root);
    const companionDataDir = join(root, 'companion-data');

    await expect(composeMemoryStoreAsync(fromAny({
      companionDataDir,
      dataDir: companionDataDir,
      persistenceBackend: 'postgres',
    }), 1536)).rejects.toThrow('requires config.postgresDatabaseUrl');
  });
});
