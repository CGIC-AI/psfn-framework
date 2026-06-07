import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeSessionRuntimeAsync } from '../../app/startup/composition/composition.js';
import {
  resolveInternalRoleEnvelopeLedgerPath,
  resolveInternalRoleEnvelopesDir,
} from '../../persistence/layout.js';

vi.mock('../../persistence/sessions/postgres-adapters.js', async () => {
  const journalPort = await vi.importActual<typeof import('../../persistence/journals/journal/port.js')>(
    '../../persistence/journals/journal/port.js',
  );
  const turnRecords = await vi.importActual<typeof import('../../persistence/sessions/turn-records.js')>(
    '../../persistence/sessions/turn-records.js',
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

describe('internal role envelope runtime wiring', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'psfn-internal-role-runtime-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('wires the companion-data ledger into shared session runtime composition', async () => {
    const companionDataDir = join(rootDir, 'companion-data');
    const composition = await composeSessionRuntimeAsync({
      config: {
        companionDataDir,
        dataDir: companionDataDir,
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
      } as any,
    });

    expect(existsSync(resolveInternalRoleEnvelopesDir(companionDataDir))).toBe(true);
    expect(composition.internalRoleEnvelopeLedger.getChannelLedgerPath('api:session-1')).toBe(
      resolveInternalRoleEnvelopeLedgerPath(companionDataDir, 'api:session-1'),
    );
    expect(composition.sessionManager.getInternalRoleEnvelopeLedger()).toBe(
      composition.internalRoleEnvelopeLedger,
    );
  });
});
