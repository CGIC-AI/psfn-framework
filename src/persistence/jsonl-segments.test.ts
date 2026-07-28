import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonlLineAtOrAfterAsync } from './jsonl-segments.js';

describe('bounded JSONL segment reads', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('rejects an oversized partial row before seeking to its newline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-jsonl-partial-row-'));
    roots.push(root);
    const path = join(root, 'journal.jsonl');
    writeFileSync(path, `${'x'.repeat(4_096)}\n{"id":2}\n`, 'utf8');
    const stats = {
      bytesRead: 0,
      readCalls: 0,
      filesRead: 0,
      maxRetainedLineBytes: 0,
      eventLoopYields: 0,
    };

    await expect(readJsonlLineAtOrAfterAsync(path, 1, {
      chunkBytes: 128,
      maxLineBytes: 1_024,
      stats,
    })).rejects.toMatchObject({
      code: 'EOVERFLOW',
      message: expect.stringContaining('refusing to truncate or retain it'),
    });

    expect(stats.eventLoopYields).toBeGreaterThan(0);
    expect(stats.maxRetainedLineBytes).toBe(0);
    expect(stats.bytesRead).toBeLessThanOrEqual(1 + 1_024 + 128);
  });
});
