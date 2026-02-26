import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMessageJournalEntry, quarantineSidecarPath } from './journal-utils.js';
import { runSessionRepairScan } from './repair.js';

describe('runSessionRepairScan', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('scans all JSONL files and reports corrupted lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-repair-'));
    dirs.push(dir);

    const cleanPath = join(dir, 'channel-clean.jsonl');
    writeFileSync(
      cleanPath,
      JSON.stringify(buildMessageJournalEntry(1, {
        channelId: 'api:clean',
        role: 'user',
        content: 'ok',
        timestamp: 1000,
      })) + '\n',
      'utf-8',
    );

    const brokenPath = join(dir, 'user_alice.jsonl');
    writeFileSync(
      brokenPath,
      [
        JSON.stringify(buildMessageJournalEntry(1, {
          channelId: 'user:alice',
          role: 'user',
          content: 'before',
          timestamp: 1000,
        })),
        '{bad',
        JSON.stringify(buildMessageJournalEntry(3, {
          channelId: 'user:alice',
          role: 'assistant',
          content: 'after',
          timestamp: 3000,
        })),
        '',
      ].join('\n'),
      'utf-8',
    );

    const report = runSessionRepairScan(dir);
    expect(report.scannedFiles).toBe(2);
    expect(report.loadedEntries).toBe(3);
    expect(report.quarantinedEntries).toBe(1);
    expect(report.filesWithCorruption).toHaveLength(1);
    expect(report.filesWithCorruption[0]).toMatchObject({
      filePath: brokenPath,
      channelId: 'user:alice',
      loadedEntries: 2,
      quarantinedEntries: 1,
    });

    const sidecarPath = quarantineSidecarPath(brokenPath);
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecarLines = readFileSync(sidecarPath, 'utf-8').trim().split('\n');
    expect(sidecarLines).toHaveLength(1);
    expect(JSON.parse(sidecarLines[0]).lineNumber).toBe(2);
  });

  it('returns empty totals when the session directory is missing', () => {
    const missingDir = join(tmpdir(), `psfn-session-repair-missing-${Date.now()}`);
    const report = runSessionRepairScan(missingDir);

    expect(report).toEqual({
      scannedFiles: 0,
      loadedEntries: 0,
      quarantinedEntries: 0,
      filesWithCorruption: [],
    });
  });
});
