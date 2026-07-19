import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSessionsDir } from '../../persistence/layout.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { isReadableSessionJournalFilename } from '../../persistence/sessions/store/channel-filenames.js';
import { runSessionFilenameMigrationCli } from './migrate-session-filenames.js';

describe('session filename migration CLI', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const scratchDir of scratchDirs) {
      rmSync(scratchDir, { force: true, recursive: true });
    }
    scratchDirs.length = 0;
  });

  it('prints command help without requiring a migration target', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runSessionFilenameMigrationCli(
      ['--help'],
      {
        exit: code => {
          throw new Error(`unexpected exit ${code}`);
        },
        logger: { error: vi.fn(), log },
      },
    );

    expect(result).toBeUndefined();
    expect(log.mock.calls.flat().join('\n')).toContain(
      'Usage: npm run migrate:session-filenames -- --data-dir <companion-data-dir> [OPTIONS]',
    );
  });

  it('migrates legacy filenames and is idempotent on a second run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-session-filename-migration-'));
    scratchDirs.push(dataDir);
    const sessionsDir = resolveSessionsDir(dataDir);
    mkdirSync(sessionsDir, { recursive: true });
    const legacyPath = join(sessionsDir, 'api-session-1.jsonl');
    writeFileSync(legacyPath, `${JSON.stringify({
      type: 'message',
      id: 1,
      channelId: 'api:session-1',
      role: 'user',
      content: 'legacy session',
      timestamp: 1_700_000_000_000,
    })}\n`, 'utf8');
    const logger = { error: vi.fn(), log: vi.fn() };
    const exit = (code: number): never => {
      throw new Error(`unexpected exit ${code}`);
    };

    const first = await runSessionFilenameMigrationCli(
      ['--data-dir', dataDir, '--apply'],
      { exit, logger },
    );

    expect(first).toMatchObject({
      legacyFilenames: ['api-session-1.jsonl'],
      migratedCount: 1,
      mode: 'apply',
      remainingLegacyCount: 0,
      sessionsDir,
    });
    expect(existsSync(legacyPath)).toBe(false);
    const migratedFilenames = readdirSync(sessionsDir).filter(isReadableSessionJournalFilename);
    expect(migratedFilenames).toHaveLength(1);
    const channelIndex = JSON.parse(
      readFileSync(join(sessionsDir, '_channel_index.json'), 'utf8'),
    ) as {
      channels: Record<string, { filename: string; filenames: string[] }>;
    };
    expect(channelIndex.channels).toEqual({
      'api:session-1': expect.objectContaining({
        filename: migratedFilenames[0],
        filenames: migratedFilenames,
      }),
    });

    const store = new SessionStore(sessionsDir);
    store.append({
      channelId: 'api:session-1',
      role: 'assistant',
      content: 'current session',
      timestamp: 1_700_000_001_000,
    });
    expect(store.count('api:session-1')).toBe(2);
    const reloaded = new SessionStore(sessionsDir);
    expect(reloaded.getRecent('api:session-1', 10).map(entry => entry.content)).toEqual([
      'legacy session',
      'current session',
    ]);
    expect(reloaded.listChannels()).toEqual([
      expect.objectContaining({
        channelId: 'api:session-1',
        messageCount: 2,
      }),
    ]);

    const second = await runSessionFilenameMigrationCli(
      ['--data-dir', dataDir, '--apply'],
      { exit, logger },
    );

    expect(second).toMatchObject({
      legacyFilenames: [],
      migratedCount: 0,
      mode: 'apply',
      remainingLegacyCount: 0,
      sessionsDir,
    });
  });

  it('defaults to a dry-run that leaves legacy filenames unchanged', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-session-filename-dry-run-'));
    scratchDirs.push(dataDir);
    const sessionsDir = resolveSessionsDir(dataDir);
    mkdirSync(sessionsDir, { recursive: true });
    const legacyPath = join(sessionsDir, 'api-dry-run.jsonl');
    writeFileSync(legacyPath, `${JSON.stringify({
      type: 'message',
      id: 1,
      channelId: 'api:dry-run',
      role: 'user',
      content: 'legacy session',
      timestamp: 1_700_000_000_000,
    })}\n`, 'utf8');

    const result = await runSessionFilenameMigrationCli(
      ['--data-dir', dataDir],
      {
        exit: code => {
          throw new Error(`unexpected exit ${code}`);
        },
        logger: { error: vi.fn(), log: vi.fn() },
      },
    );

    expect(result).toMatchObject({
      legacyFilenames: ['api-dry-run.jsonl'],
      migratedCount: 0,
      mode: 'dry-run',
      remainingLegacyCount: 1,
      sessionsDir,
    });
    expect(existsSync(legacyPath)).toBe(true);
  });
});
