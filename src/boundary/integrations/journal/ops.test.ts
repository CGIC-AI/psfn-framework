import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JOURNAL_IO_CONTRACT,
  JournalOps,
} from './ops.js';

describe('JournalOps governed I/O', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'journal-ops-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a large UTF-8 note in byte-safe pages with explicit progress', async () => {
    const path = join(root, 'large.md');
    const original = `header\n${'🙂'.repeat(4_000)}\ntail\n`;
    writeFileSync(path, original, 'utf8');
    const ops = new JournalOps(root);

    const pages: string[] = [];
    let offsetBytes = 0;
    for (;;) {
      const page = await ops.read('large.md', { offsetBytes });
      pages.push(page.content);
      expect(Buffer.byteLength(page.content, 'utf8')).toBeLessThanOrEqual(
        JOURNAL_IO_CONTRACT.readPageBytes,
      );
      expect(page.content).not.toContain('\uFFFD');
      if (page.eof) {
        expect(page.nextOffsetBytes).toBeNull();
        break;
      }
      expect(page.truncated).toBe(true);
      expect(page.nextOffsetBytes).toBeGreaterThan(offsetBytes);
      offsetBytes = page.nextOffsetBytes!;
    }

    expect(pages.join('')).toBe(original);
  });

  it('rejects a stale or non-boundary read offset instead of returning damaged UTF-8', async () => {
    writeFileSync(join(root, 'emoji.md'), 'a🙂z', 'utf8');
    const ops = new JournalOps(root);

    await expect(ops.read('emoji.md', { offsetBytes: 2 })).rejects.toThrow(
      /not a UTF-8 character boundary/,
    );
    await expect(ops.read('emoji.md', { offsetBytes: 99 })).rejects.toThrow(
      /exceeds file size/,
    );
  });

  it('searches the complete contents of an allowed large note and yields to timers', async () => {
    const filler = 'a'.repeat(150_000);
    writeFileSync(join(root, 'large.md'), `${filler}\nNeedle Beyond Read Page\n`, 'utf8');
    writeFileSync(join(root, 'other.md'), `${'b'.repeat(32_000)}\n`, 'utf8');
    const ops = new JournalOps(root);
    let timerProgressed = false;
    const timer = delay(0).then(() => {
      timerProgressed = true;
    });

    const result = await ops.search('needle beyond read page');
    const timerProgressedBeforeCompletion = timerProgressed;
    await timer;

    expect(timerProgressedBeforeCompletion).toBe(true);
    expect(result).toMatchObject({
      complete: true,
      resultLimitReached: false,
      scannedFiles: 2,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.path).toBe('large.md');
  });

  it('fails before returning partial search results when one note exceeds the input bound', async () => {
    writeFileSync(join(root, 'first.md'), 'needle\n', 'utf8');
    writeFileSync(
      join(root, 'oversized.md'),
      Buffer.alloc(JOURNAL_IO_CONTRACT.searchMaxFileBytes + 1, 0x61),
    );
    const ops = new JournalOps(root);

    await expect(ops.search('needle')).rejects.toThrow(
      /Journal search bound exceeded.*read a known note with journal read paging/is,
    );
  });

  it('fails before materializing a corpus beyond the governed file count', async () => {
    for (let index = 0; index <= JOURNAL_IO_CONTRACT.searchMaxFiles; index += 1) {
      writeFileSync(join(root, `note-${String(index).padStart(3, '0')}.md`), 'small\n', 'utf8');
    }
    const ops = new JournalOps(root);

    await expect(ops.search('small')).rejects.toThrow(
      /Journal search bound exceeded.*Markdown files/s,
    );
    await expect(ops.list()).rejects.toThrow(
      /Journal list bound exceeded.*Markdown files/s,
    );
  });

  it('atomically appends to a large note without losing concurrent appends', async () => {
    const path = join(root, 'large.md');
    const original = 'x'.repeat(4 * 1024 * 1024);
    writeFileSync(path, original, 'utf8');
    const ops = new JournalOps(root);
    let timerProgressed = false;
    const timer = delay(0).then(() => {
      timerProgressed = true;
    });

    await Promise.all([
      ops.append('large.md', 'first append'),
      ops.append('large.md', 'second append'),
    ]);
    const timerProgressedBeforeCompletion = timerProgressed;
    await timer;

    const persisted = readFileSync(path, 'utf8');
    expect(timerProgressedBeforeCompletion).toBe(true);
    expect(persisted.startsWith(`${original}\n`)).toBe(true);
    expect(persisted.match(/first append/g)).toHaveLength(1);
    expect(persisted.match(/second append/g)).toHaveLength(1);
    expect(readdirSync(root).filter(name => name.includes('journal-append'))).toEqual([]);
  });
});
