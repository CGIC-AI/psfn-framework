import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchWorkspaceFiles } from './workspace-ops.js';

describe('fs.search compatibility and isolated evaluator lifecycle', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'psfn-search-contract-'));
    await writeFile(join(root, 'notes.txt'), 'before\nAlpha alpha alpha\nababa\ncat\ncat cat');
    await writeFile(join(root, 'literal.txt'), 'a.b aXb a.b');
    await writeFile(join(root, 'zero.txt'), 'aa');
    await writeFile(join(root, 'preview.txt'), `${'x'.repeat(600)}tail`);
    await writeFile(join(root, 'line.txt'), `${'x'.repeat(8_192)}beyond`);
    await writeFile(join(root, 'page.txt'), 'abcdabcdZZ');
    await writeFile(join(root, 'hostile.txt'), `${'a'.repeat(8_191)}!`);
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('keeps case-sensitive global matching, per-line anchors and context', async () => {
    const result = await searchWorkspaceFiles(root, {
      query: 'alpha', mode: 'regex', glob: 'notes.txt', contextLines: 1,
    });
    expect(result.matches).toEqual([
      { path: 'notes.txt', line: 2, column: 7, preview: 'before\nAlpha alpha alpha\nababa' },
      { path: 'notes.txt', line: 2, column: 13, preview: 'before\nAlpha alpha alpha\nababa' },
    ]);
    expect((await searchWorkspaceFiles(root, { query: '^cat$', mode: 'regex', glob: 'notes.txt' })).matches)
      .toEqual([{ path: 'notes.txt', line: 4, column: 1, preview: 'cat' }]);
    expect((await searchWorkspaceFiles(root, { query: 'Alpha.*cat', mode: 'regex', glob: 'notes.txt' })).matches)
      .toEqual([]);
  });

  it('preserves JavaScript lookbehind and backreferences', async () => {
    expect((await searchWorkspaceFiles(root, { query: '(?<=a)b', mode: 'regex', glob: 'notes.txt' })).matches)
      .toEqual([
        { path: 'notes.txt', line: 3, column: 2, preview: 'ababa' },
        { path: 'notes.txt', line: 3, column: 4, preview: 'ababa' },
      ]);
    expect((await searchWorkspaceFiles(root, { query: '(ab)\\1', mode: 'regex', glob: 'notes.txt' })).matches)
      .toEqual([{ path: 'notes.txt', line: 3, column: 1, preview: 'ababa' }]);
  });

  it('advances zero-length matches and applies the existing match limit', async () => {
    const result = await searchWorkspaceFiles(root, {
      query: '^|$', mode: 'regex', glob: 'zero.txt', maxMatches: 2,
    });
    expect(result.matches).toEqual([
      { path: 'zero.txt', line: 1, column: 1, preview: 'aa' },
      { path: 'zero.txt', line: 1, column: 3, preview: 'aa' },
    ]);
    expect(result.hitLimit).toBe(true);
  });

  it('preserves literal metacharacters and byte-page truncation in both modes', async () => {
    expect((await searchWorkspaceFiles(root, { query: 'a.b', glob: 'literal.txt' })).matches).toEqual([
      { path: 'literal.txt', line: 1, column: 1, preview: 'a.b aXb a.b' },
      { path: 'literal.txt', line: 1, column: 9, preview: 'a.b aXb a.b' },
    ]);
    for (const mode of ['literal', 'regex'] as const) {
      const result = await searchWorkspaceFiles(root, {
        query: 'abcd', glob: 'page.txt', mode, maxBytesPerFile: 8,
      });
      expect(result).toMatchObject({
        scannedFiles: 1, truncatedFiles: ['page.txt'], hitLimit: false,
        matches: [
          { path: 'page.txt', line: 1, column: 1, preview: 'abcdabcd' },
          { path: 'page.txt', line: 1, column: 5, preview: 'abcdabcd' },
        ],
      });
    }
  });

  it('preserves preview truncation and the 8192 UTF-16-unit line view', async () => {
    for (const mode of ['literal', 'regex'] as const) {
      expect((await searchWorkspaceFiles(root, { query: 'tail', glob: 'preview.txt', mode })).matches)
        .toEqual([{ path: 'preview.txt', line: 1, column: 601, preview: `${'x'.repeat(500)}\n... (truncated)` }]);
      expect((await searchWorkspaceFiles(root, { query: 'beyond', glob: 'line.txt', mode })).matches).toEqual([]);
    }
  });

  it('returns fixed errors for invalid and unsupported syntax without echoing patterns', async () => {
    for (const query of ['PRIVATE-CONTENT[', '(?i)PRIVATE-CONTENT']) {
      await expect(searchWorkspaceFiles(root, { query, mode: 'regex', glob: 'notes.txt' }))
        .rejects.toThrow(/^fs search regex is invalid$/u);
    }
    expect((await searchWorkspaceFiles(root, { query: 'cat', mode: 'regex', glob: 'notes.txt' })).matches)
      .toHaveLength(3);
  });

  it('rechecks quarantine after the final budget checkpoint yields', async () => {
    let screeningChecks = 0;
    let current = true;
    await expect(searchWorkspaceFiles(root, {
      query: 'cat', mode: 'regex', glob: 'notes.txt',
      now: () => {
        if (screeningChecks >= 2) queueMicrotask(() => { current = false; });
        return performance.now();
      },
      screenFileReads: candidates => ({
        readable: candidates.map(() => true),
        revisionIsCurrent: () => {
          screeningChecks += 1;
          return current;
        },
      }),
    })).rejects.toThrow(/quarantine state changed.*refusing stale results/u);
  });

  it('caps concurrent attacks, cleans caller aborts and immediately accepts a full healthy batch', async () => {
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const attacks = controllers.map(controller => searchWorkspaceFiles(root, {
      query: '^(a|aa)+$', mode: 'regex', glob: 'hostile.txt', signal: controller.signal,
    }));
    // Attach rejection observers before any cancellation can occur.
    const settled = Promise.allSettled(attacks);
    await new Promise(resolve => setTimeout(resolve, 100));
    await expect(searchWorkspaceFiles(root, { query: 'cat', mode: 'regex', glob: 'notes.txt' }))
      .rejects.toThrow(/^fs search regex resources unavailable$/u);
    for (const controller of controllers) controller.abort(new Error('PRIVATE-ABORT-REASON'));
    expect(await settled).toEqual(controllers.map(() => ({
      status: 'rejected', reason: expect.objectContaining({ name: 'SearchAbortedError', message: 'fs search aborted' }),
    })));
    const healthy = await Promise.all(controllers.map(() => searchWorkspaceFiles(root, {
      query: 'cat', mode: 'regex', glob: 'notes.txt',
    })));
    expect(healthy.map(result => result.matches.length)).toEqual([3, 3, 3, 3]);
    await expect(searchWorkspaceFiles(root, {
      query: 'cat', mode: 'regex', glob: 'notes.txt', signal: controllers[0]!.signal,
    })).rejects.toThrow(/^fs search aborted$/u);
  });

  it('survives repeated deadline attacks with every admission slot reusable', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(searchWorkspaceFiles(root, { query: '^(a|aa)+$', mode: 'regex', glob: 'hostile.txt' }))
        .rejects.toThrow(/^fs search budget exceeded: pattern took too long to evaluate and was aborted$/u);
      const healthy = await Promise.all(Array.from({ length: 4 }, () => searchWorkspaceFiles(root, {
        query: 'cat', mode: 'regex', glob: 'notes.txt',
      })));
      expect(healthy.map(result => result.matches.length)).toEqual([3, 3, 3, 3]);
    }
  });
});
