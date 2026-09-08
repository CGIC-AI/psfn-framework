import { constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JournalOps } from './ops.js';

/**
 * Publication durability (psfn-framework-b695g follow-up).
 *
 * link(2)/rename(2) publish atomically but not durably: the new directory
 * entry can still be unflushed when the machine dies, so a crash can revert a
 * commit that already returned success. These tests observe the pinned parent
 * directory descriptor and prove its fsync happens after the publishing
 * syscall on both the create and the replace path.
 */
const { publishTrace, openMock, linkMock, renameMock } = vi.hoisted(() => ({
  publishTrace: [] as string[],
  openMock: vi.fn(),
  linkMock: vi.fn(),
  renameMock: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const flags = await import('node:fs');
  openMock.mockImplementation(async (
    path: Parameters<typeof actual.open>[0],
    openFlags?: Parameters<typeof actual.open>[1],
    mode?: Parameters<typeof actual.open>[2],
  ) => {
    const handle = await actual.open(path, openFlags, mode);
    if (
      typeof openFlags === 'number'
      && (openFlags & flags.constants.O_DIRECTORY) !== 0
    ) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        publishTrace.push('directory-sync');
        await sync();
      };
    }
    return handle;
  });
  linkMock.mockImplementation(async (from: string, to: string) => {
    publishTrace.push('link');
    await actual.link(from, to);
  });
  renameMock.mockImplementation(async (from: string, to: string) => {
    publishTrace.push('rename');
    await actual.rename(from, to);
  });
  return { ...actual, open: openMock, link: linkMock, rename: renameMock };
});

describe('journal mutation publication durability', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'journal-mutation-durability-'));
    publishTrace.length = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('fsyncs the pinned parent directory after the create path publishes with link(2)', async () => {
    const result = await new JournalOps(root).write('created.md', 'first durable note');

    expect(result.created).toBe(true);
    expect(readFileSync(join(root, 'created.md'), 'utf8')).toBe('first durable note\n');
    expect(publishTrace).toEqual(['link', 'directory-sync']);
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('fsyncs the pinned parent directory after the replace path publishes with rename(2)', async () => {
    writeFileSync(join(root, 'replaced.md'), 'original note\n', 'utf8');
    publishTrace.length = 0;

    const result = await new JournalOps(root).append('replaced.md', 'appended line');

    expect(result.created).toBe(false);
    expect(readFileSync(join(root, 'replaced.md'), 'utf8')).toContain('appended line');
    expect(publishTrace).toEqual(['rename', 'directory-sync']);
    expect(linkMock).not.toHaveBeenCalled();
  });

  it('fails the create commit and withdraws the entry when the directory fsync fails', async () => {
    const notePath = join(root, 'undurable.md');
    const openDirectory = openMock.getMockImplementation()!;
    openMock.mockImplementation(async (
      path: string,
      openFlags?: number,
      mode?: number,
    ) => {
      const handle = await openDirectory(path, openFlags, mode) as {
        sync: () => Promise<void>;
      };
      if (typeof openFlags === 'number' && (openFlags & constants.O_DIRECTORY) !== 0) {
        handle.sync = async () => {
          publishTrace.push('directory-sync');
          return Promise.reject(new Error('injected directory sync failure'));
        };
      }
      return handle;
    });

    await expect(new JournalOps(root).write('undurable.md', 'never durable')).rejects.toThrow(
      /injected directory sync failure/,
    );

    // The publication is withdrawn rather than left behind as a note the
    // caller was told had failed.
    expect(existsSync(notePath)).toBe(false);
    expect(publishTrace[0]).toBe('link');
    expect(publishTrace).toContain('directory-sync');
  });
});
