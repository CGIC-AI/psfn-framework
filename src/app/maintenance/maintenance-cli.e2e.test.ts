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
import { buildMessageJournalEntry } from '../../persistence/journals/journal-utils.js';
import { runSchedulerOwnerMigrationCli } from './migrate-scheduler-owner.js';
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
