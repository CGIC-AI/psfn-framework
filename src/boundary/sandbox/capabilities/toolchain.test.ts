import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readUtf8TextFilePage } from '../../integrations/filesystem/text-file-paging.js';
import type { SandboxFileRead } from '../../../shared/contracts/sandbox-analysis-contracts.js';
import { createToolchainCapabilities } from './toolchain.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('createToolchainCapabilities read_file', () => {
  it('reconstructs multi-page UTF-8 content with explicit cursors and makes page-zero retries visible', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-workbench-read-file-'));
    roots.push(root);
    const filePath = join(root, 'large.md');
    const expected = 'prefix🙂漢字 café e\u0301 — line\n'.repeat(2_500);
    writeFileSync(filePath, expected, 'utf8');

    const fileRead = vi.fn<SandboxFileRead>(
      async (_path, options) => readUtf8TextFilePage(
        filePath,
        options?.maxBytes ?? 20_000,
        options?.offsetBytes ?? 0,
      ),
    );
    const { read_file } = createToolchainCapabilities({
      gatewayCaps: {},
      fileRead,
    });

    const first = await read_file('large.md');
    const repeatedFirst = await read_file('large.md');
    expect(first).toEqual(repeatedFirst);
    expect(first).toMatchObject({
      offsetBytes: 0,
      eof: false,
      truncated: true,
    });
    expect('error' in first).toBe(false);
    if ('error' in first || first.nextOffsetBytes === null) {
      throw new Error('Expected a first page with a continuation cursor');
    }

    const pages = [first];
    let cursor: number | null = first.nextOffsetBytes;
    do {
      const page = await read_file('large.md', { offsetBytes: cursor });
      if ('error' in page) {
        throw new Error(page.error);
      }
      pages.push(page);
      cursor = page.nextOffsetBytes;
    } while (cursor !== null);

    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.map(page => page.content).join('')).toBe(expected);
    expect(pages.every(page => Buffer.byteLength(page.content, 'utf8') <= 20_000)).toBe(true);
    expect(
      pages
        .filter(page => !page.eof)
        .every(page => page.nextOffsetBytes !== null && page.nextOffsetBytes > page.offsetBytes),
    ).toBe(true);
    expect(pages.at(-1)).toMatchObject({
      eof: true,
      truncated: false,
      nextOffsetBytes: null,
    });
    expect(fileRead.mock.calls.map(([, options]) => options)).toEqual([
      { maxBytes: 20_000, offsetBytes: 0 },
      { maxBytes: 20_000, offsetBytes: 0 },
      ...pages.slice(1).map(page => ({
        maxBytes: 20_000,
        offsetBytes: page.offsetBytes,
      })),
    ]);
  });
});
