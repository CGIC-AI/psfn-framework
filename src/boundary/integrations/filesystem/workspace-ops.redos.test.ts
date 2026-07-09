import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeSearchRegex,
  searchWorkspaceFiles,
  SearchBudgetExceededError,
  UnsafeSearchRegexError,
} from './workspace-ops.js';

describe('assertSafeSearchRegex (nw90 static ReDoS lint)', () => {
  it('rejects the classic nested-unbounded-quantifier signatures', () => {
    for (const pattern of ['(a+)+$', '(a+)+', '(a*)*', '(a+)*', '(a*)+', '((a+))+', '(\\w+)*', '(\\d+)+x']) {
      expect(() => assertSafeSearchRegex(pattern), pattern).toThrow(UnsafeSearchRegexError);
    }
  });

  it('leaves ordinary search patterns untouched', () => {
    for (const pattern of ['foo.*bar', '\\w+', '(abc)+', 'a{1,3}', '(foo|bar)+', 'colou?r', '\\+{2,4}', '[+*]+', 'a\\+b']) {
      expect(() => assertSafeSearchRegex(pattern), pattern).not.toThrow();
    }
  });

  it('rejects patterns longer than the hard cap', () => {
    expect(() => assertSafeSearchRegex('a'.repeat(2_000))).toThrow(UnsafeSearchRegexError);
  });
});

describe('searchWorkspaceFiles ReDoS containment (nw90)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'psfn-fs-search-'));
    // A long 'aaaa…b' line: the canonical catastrophic-backtracking input.
    await writeFile(join(root, 'evil.md'), `${'a'.repeat(50_000)}b\n`, 'utf-8');
    await writeFile(join(root, 'notes.md'), 'the quick brown fox\nsecond line has foobar in it\n', 'utf-8');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns an error quickly for a catastrophic pattern instead of hanging', async () => {
    const start = Date.now();
    await expect(
      searchWorkspaceFiles(root, { query: '(a+)+$', mode: 'regex', glob: '*.md' }),
    ).rejects.toThrow(UnsafeSearchRegexError);
    // If the pattern had actually been compiled and run against evil.md this
    // would take effectively forever; the static lint returns near-instantly.
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('still runs ordinary regex searches with normal semantics', async () => {
    const result = await searchWorkspaceFiles(root, {
      query: 'foo.*bar',
      mode: 'regex',
      glob: '*.md',
    });
    expect(result.mode).toBe('regex');
    expect(result.matches.some(match => match.path.endsWith('notes.md'))).toBe(true);
  });

  it('still runs ordinary literal searches', async () => {
    const result = await searchWorkspaceFiles(root, {
      query: 'quick brown',
      mode: 'literal',
      glob: '*.md',
    });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('aborts with a budget error when the wall-clock budget is exceeded', async () => {
    let call = 0;
    // First call (budget creation) sets the deadline; the next checkpoint jumps
    // well past it, so the very first per-file checkpoint trips the budget.
    const now = (): number => (call++ === 0 ? 0 : 10_000);
    await expect(
      searchWorkspaceFiles(root, { query: 'quick', mode: 'literal', glob: '*.md', now }),
    ).rejects.toThrow(SearchBudgetExceededError);
  });
});
