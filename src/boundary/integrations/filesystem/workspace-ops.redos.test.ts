import { renameSync } from 'node:fs';
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

  it('refuses stale search results when quarantine changes after the batch verdict', async () => {
    await writeFile(join(root, 'held-after-screen.md'), 'MARKER-newly-held\n', 'utf-8');
    let revision = 'released';

    await expect(searchWorkspaceFiles(root, {
      query: 'MARKER-newly-held',
      mode: 'literal',
      glob: 'held-after-screen.md',
      screenFileReads: (candidates) => {
        // Deterministic sibling-process hold immediately after the batch
        // verdict. The first async checkpoint yields to this transition
        // before stat/read, and the revision gate invalidates the scan.
        queueMicrotask(() => { revision = 'held'; });
        return {
          readable: candidates.map(() => true),
          revisionIsCurrent: () => revision === 'released',
        };
      },
    })).rejects.toThrow(/quarantine state changed.*refusing stale results/iu);
  });

  it('refuses a verdict whose atomic revision is already stale when screening returns', async () => {
    await expect(searchWorkspaceFiles(root, {
      query: 'MARKER-newly-held',
      mode: 'literal',
      glob: 'held-after-screen.md',
      screenFileReads: (candidates) => {
        return {
          readable: candidates.map(() => true),
          revisionIsCurrent: () => false,
        };
      },
    })).rejects.toThrow(/quarantine state changed.*refusing stale results/iu);
  });

  it('refuses a pathname swapped to an already-held file after screening', async () => {
    const candidatePath = join(root, 'swap-candidate.md');
    const backupPath = join(root, 'swap-candidate.safe.md');
    const heldPath = join(root, 'swap-held.md');
    await writeFile(candidatePath, 'ordinary safe text\n', 'utf-8');
    await writeFile(heldPath, 'MARKER-already-held\n', 'utf-8');

    await expect(searchWorkspaceFiles(root, {
      query: 'MARKER-already-held',
      mode: 'literal',
      glob: 'swap-candidate.md',
      screenFileReads: (candidates) => {
        renameSync(candidatePath, backupPath);
        renameSync(heldPath, candidatePath);
        return {
          readable: candidates.map(() => true),
          revisionIsCurrent: () => true,
        };
      },
    })).rejects.toThrow(/candidate identity changed.*refusing read/iu);
  });
});
