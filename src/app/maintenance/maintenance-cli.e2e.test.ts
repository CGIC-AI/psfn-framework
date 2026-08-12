import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMessageJournalEntry,
  buildSessionHmacKeyring,
  signJournalEntry,
} from '../../persistence/journals/journal-utils.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { runIntakePolicyOwnerMigrationCli } from './migrate-intake-policy-owner.js';
import { runSchedulerOwnerMigrationCli } from './migrate-scheduler-owner.js';
import { runSessionIntegrityRepairCli } from './session-integrity-repair.js';
import { runSessionRepairCli } from './session-repair.js';

describe('maintenance CLI entrypoints', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const scratchDir of scratchDirs) {
      rmSync(scratchDir, { force: true, recursive: true });
    }
    scratchDirs.length = 0;
  });

  it('describes every supported intake-policy migration source and the v6 target', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runIntakePolicyOwnerMigrationCli(['--help']);

    expect(result).toBeUndefined();
    expect(log.mock.calls.flat().join('\n')).toContain(
      'Upgrades schema-v1/v2/v3/v4/v5 intake-policy.json owners to v6',
    );
  });

  it('runs the session repair CLI against a scratch data directory and preserves its report shape', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-maintenance-repair-cli-'));
    scratchDirs.push(dataDir);
    const sessionsDir = join(dataDir, 'sessions');
    mkdirSync(sessionsDir);
    writeFileSync(
      join(sessionsDir, 'api-clean.jsonl'),
      `${JSON.stringify(buildMessageJournalEntry(1, {
        channelId: 'api:clean',
        content: 'ok',
        role: 'user',
        timestamp: 1_000,
      }))}\n`,
      'utf8',
    );
    const log = vi.fn();

    const result = await runSessionRepairCli(
      ['--sessions-dir', sessionsDir],
      {
        bootstrap: async () => ({
          dataDir,
        }),
        exit: code => {
          throw new Error(`unexpected exit ${code}`);
        },
        logger: { error: vi.fn(), log },
      },
    );

    expect(result).toMatchObject({
      report: {
        filesWithCorruption: [],
        loadedEntries: 1,
        quarantinedEntries: 0,
        scannedFiles: 1,
      },
      sessionsDir,
    });
    expect(log.mock.calls).toEqual([
      [`Session repair scan: ${sessionsDir}`],
      ['Scanned 1 JSONL files'],
      ['No corruption found.'],
    ]);
  });

  it('carries exact background-work recovery targets through the compiled integrity CLI', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-maintenance-integrity-cli-'));
    scratchDirs.push(dataDir);
    const sessionsDir = join(dataDir, 'sessions');
    const backupDir = join(dataDir, 'repair-backups', 'targeted-run');
    mkdirSync(sessionsDir);
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:maintenance-integrity-key',
      activeVersion: 'v1',
    })!;
    const writeMalformed = (filename: string, channelId: string): string => {
      const entry = signJournalEntry(buildMessageJournalEntry(1, {
        channelId,
        content: `${channelId} retained history`,
        role: 'user',
        timestamp: 1_000,
      }), keyring, null);
      const raw = `${JSON.stringify(entry)}\n{not-json}\n`;
      writeFileSync(join(sessionsDir, filename), raw, 'utf8');
      return raw;
    };
    const selectedFilename = '20260807_api-cli-selected_user_000001.jsonl';
    const untouchedFilename = '20260807_api-cli-untouched_user_000002.jsonl';
    writeMalformed(selectedFilename, 'api:cli-selected');
    const untouchedBefore = writeMalformed(untouchedFilename, 'api:cli-untouched');
    const auditAppend = vi.fn();
    const log = vi.fn();

    const result = await runSessionIntegrityRepairCli([
      '--reason',
      'repair exact EBADMSG owner',
      '--channel',
      'api:cli-selected',
    ], {
      bootstrap: async () => ({
        backupDir,
        config: { dataDir } as SubstrateConfig,
        dataDir,
      }),
      createAudit: () => ({ append: auditAppend }),
      exit: code => {
        throw new Error(`unexpected exit ${code}`);
      },
      logger: { error: vi.fn(), log },
      resolveKeyring: () => keyring,
    });

    expect(result).toMatchObject({
      backupsDir: backupDir,
      journal: {
        scannedFiles: 1,
        modifiedFiles: 1,
        quarantinedRows: 1,
      },
    });
    expect(readFileSync(join(sessionsDir, selectedFilename), 'utf8'))
      .not.toContain('{not-json}');
    expect(readFileSync(join(sessionsDir, untouchedFilename), 'utf8'))
      .toBe(untouchedBefore);
    expect(auditAppend).toHaveBeenCalledWith(
      'session_integrity_repair',
      expect.objectContaining({
        outcome: 'completed',
        targetChannelIds: ['api:cli-selected'],
      }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('quarantinedRows=1'));
  });

  it('runs the scheduler migration CLI against a scratch data directory and preserves its JSON report shape', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-maintenance-migrate-cli-'));
    scratchDirs.push(dataDir);
    const fixturePath = fileURLToPath(new URL(
      '../../system/config/fixtures/scheduler.pre-bundled-owner.json',
      import.meta.url,
    ));
    writeFileSync(join(dataDir, 'scheduler.json'), readFileSync(fixturePath));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runSchedulerOwnerMigrationCli(['--data-dir', dataDir]);

    expect(result).toMatchObject({
      mode: 'dry-run',
      removedPaths: ['salienceDecayIntervalMs', 'socialGraphBuilder.intervalMs'],
      selectedFrom: 'salienceDecayIntervalMs',
      selectedIntervalMs: 3_600_000,
      status: 'planned',
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      mode: 'dry-run',
      selectedFrom: 'salienceDecayIntervalMs',
      status: 'planned',
    });
  });
});
