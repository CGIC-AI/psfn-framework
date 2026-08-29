import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import {
  composeSessionRuntimeAsync,
  type SessionCompositionOptions,
} from '../../app/startup/composition/composition.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
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
    const composition = await composeSessionRuntimeAsync(
      fromPartial<SessionCompositionOptions>({
        config: fromPartial<SubstrateConfig>({
          companionDataDir,
          dataDir: companionDataDir,
          persistenceBackend: 'postgres',
          postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
        }),
        automataRetentionCompanionId: 'companion-test',
      }),
    );

    expect(existsSync(resolveInternalRoleEnvelopesDir(companionDataDir))).toBe(true);
    expect(composition.internalRoleEnvelopeLedger.getChannelLedgerPath('api:session-1')).toBe(
      resolveInternalRoleEnvelopeLedgerPath(companionDataDir, 'api:session-1'),
    );
    expect(composition.sessionManager.getInternalRoleEnvelopeLedger()).toBe(
      composition.internalRoleEnvelopeLedger,
    );
  });
});
