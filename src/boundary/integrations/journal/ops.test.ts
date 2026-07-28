import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JOURNAL_IO_CONTRACT,
  JournalOps,
} from './ops.js';
import { withJournalMutationLock } from './mutation-coordinator.js';

const { renameMock } = vi.hoisted(() => ({
  renameMock: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameMock.mockImplementation(actual.rename);
  return { ...actual, rename: renameMock };
});

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

  it('atomically preserves every concurrent cross-instance append to large notes', async () => {
    const original = 'x'.repeat(2 * 1024 * 1024);
    const firstOps = new JournalOps(root);
    const secondOps = new JournalOps(root);
    let timerProgressed = false;
    const timer = delay(0).then(() => {
      timerProgressed = true;
    });

    for (let iteration = 0; iteration < 8; iteration += 1) {
      const noteName = `large-${String(iteration)}.md`;
      const path = join(root, noteName);
      const firstAppend = `first append ${String(iteration)}`;
      const secondAppend = `second append ${String(iteration)}`;
      writeFileSync(path, original, 'utf8');

      await Promise.all([
        firstOps.append(noteName, firstAppend),
        secondOps.append(noteName, secondAppend),
      ]);

      const persisted = readFileSync(path, 'utf8');
      expect(persisted.startsWith(`${original}\n`)).toBe(true);
      expect(persisted.split(firstAppend)).toHaveLength(2);
      expect(persisted.split(secondAppend)).toHaveLength(2);
    }
    const timerProgressedBeforeCompletion = timerProgressed;
    await timer;

    expect(timerProgressedBeforeCompletion).toBe(true);
    expect(readdirSync(root).filter(name => name.includes('journal-append'))).toEqual([]);
  });

  it('does not serialize mutations to unrelated paths or roots', async () => {
    const blockedPath = join(root, 'blocked.md');
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolvePromise) => {
      releaseBlocked = resolvePromise;
    });
    let blockedStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      blockedStarted = resolvePromise;
    });

    const first = withJournalMutationLock(blockedPath, async () => {
      blockedStarted();
      await blocked;
    });
    await started;

    let samePathStarted = false;
    const samePath = withJournalMutationLock(blockedPath, async () => {
      samePathStarted = true;
    });
    await Promise.all([
      withJournalMutationLock(join(root, 'other.md'), async () => undefined),
      withJournalMutationLock(
        join(dirname(root), `${basename(root)}-other`, 'blocked.md'),
        async () => undefined,
      ),
    ]);

    expect(samePathStarted).toBe(false);
    releaseBlocked();
    await Promise.all([first, samePath]);
    expect(samePathStarted).toBe(true);
  });

  it('preserves the original note and removes its temp file when commit fails', async () => {
    const path = join(root, 'failure.md');
    const original = 'original journal note\n';
    writeFileSync(path, original, 'utf8');
    renameMock.mockRejectedValueOnce(
      new Error('injected commit failure'),
    );

    await expect(new JournalOps(root).append('failure.md', 'lost append')).rejects.toThrow(
      /injected commit failure/,
    );

    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(root).filter(name => name.includes('journal-append'))).toEqual([]);
  });

  it('releases a shared mutation lock after a failed operation', async () => {
    const path = join(root, 'retry.md');

    await expect(withJournalMutationLock(path, async () => {
      throw new Error('injected mutation failure');
    })).rejects.toThrow(/injected mutation failure/);

    await expect(withJournalMutationLock(path, async () => 'retried')).resolves.toBe('retried');
  });
});
