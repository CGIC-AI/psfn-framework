import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedCompanionWorkspaceReader } from './shared-workspace-reader.js';
import {
  requireSharedWorkspaceListBounds,
  type SharedWorkspaceListBounds,
} from './shared-workspace-bounds.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedCorpus(bodies: readonly string[]): {
  root: string;
  expected: Array<{ artifactPath: string; revision: string }>;
} {
  const root = mkdtempSync(join(tmpdir(), 'psfn-shared-reader-bounds-'));
  roots.push(root);
  mkdirSync(join(root, 'artifacts', 'world'), { recursive: true });
  mkdirSync(join(root, 'reviews'), { recursive: true });
  mkdirSync(join(root, 'provenance', 'events'), { recursive: true });
  const expected: Array<{ artifactPath: string; revision: string }> = [];
  bodies.forEach((content, index) => {
    const artifactPath = `world/guide-${String(index).padStart(3, '0')}.md`;
    const revision = createHash('sha256').update(content).digest('hex');
    const reviewId = `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;
    writeFileSync(join(root, 'artifacts', artifactPath), content);
    writeFileSync(join(root, 'reviews', `${reviewId}.json`), JSON.stringify({
      reviewId,
      artifactPath,
      proposedRevision: revision,
      status: 'approved',
    }));
    writeFileSync(join(root, 'provenance', 'events', `${reviewId}.approved.json`), JSON.stringify({
      schemaVersion: 1,
      event: 'approved',
      at: '2026-07-13T00:00:00.000Z',
      reviewId,
      artifactPath,
      proposedRevision: revision,
    }));
    expected.push({ artifactPath, revision });
  });
  return { root, expected };
}

function drain(
  reader: SharedCompanionWorkspaceReader,
  bounds: SharedWorkspaceListBounds,
): { artifacts: Array<{ artifactPath: string; revision: string }>; pageSizes: number[] } {
  const artifacts: Array<{ artifactPath: string; revision: string }> = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  do {
    const page: ReturnType<SharedCompanionWorkspaceReader['listArtifacts']> = reader.listArtifacts(
      cursor === null ? { bounds } : { bounds, cursor },
    );
    pageSizes.push(page.artifacts.length);
    artifacts.push(...page.artifacts);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { artifacts, pageSizes };
}

describe('shared companion workspace reader bounds', () => {
  it('requires both listing bounds before a reviewed corpus can be served', () => {
    expect(() => requireSharedWorkspaceListBounds({ sharedWorkspaceListPageSize: 10 }))
      .toThrow(/sharedWorkspaceListPageBytes/);
    expect(() => requireSharedWorkspaceListBounds({ sharedWorkspaceListPageBytes: 1_000_000 }))
      .toThrow(/sharedWorkspaceListPageSize/);
    expect(() => requireSharedWorkspaceListBounds({
      sharedWorkspaceListPageSize: 0,
      sharedWorkspaceListPageBytes: 1_000_000,
    })).toThrow(/positive integer/);
    expect(requireSharedWorkspaceListBounds({
      sharedWorkspaceListPageSize: 25,
      sharedWorkspaceListPageBytes: 2_000_000,
    })).toEqual({ pageSize: 25, pageBytes: 2_000_000 });
  });

  it('pages a large reviewed corpus without changing the artifacts or their hashes', () => {
    const bodies = Array.from({ length: 200 }, (_unused, index) => `# guide ${index}\n`);
    const { root, expected } = seedCorpus(bodies);
    const reader = new SharedCompanionWorkspaceReader(root);

    const bounded = drain(reader, { pageSize: 25, pageBytes: 8_000_000 });
    const unbounded = reader.listArtifacts({
      bounds: { pageSize: bodies.length, pageBytes: 8_000_000 },
    });

    expect(bounded.pageSizes).toEqual(Array.from({ length: 8 }, () => 25));
    expect(bounded.pageSizes.every(size => size <= 25)).toBe(true);
    expect(bounded.artifacts).toEqual(expected);
    expect(unbounded.artifacts).toEqual(expected);
    expect(unbounded.nextCursor).toBeNull();
  });

  it('stops a page at the byte budget and still makes progress on one oversized artifact', () => {
    const large = `# large\n${'x'.repeat(50_000)}`;
    const { root, expected } = seedCorpus([large, large, large]);
    const reader = new SharedCompanionWorkspaceReader(root);

    // Budget admits one artifact per page; the count bound is deliberately wide
    // so the stop is provably the byte budget.
    const drained = drain(reader, { pageSize: 100, pageBytes: 60_000 });
    expect(drained.pageSizes).toEqual([1, 1, 1]);
    expect(drained.artifacts).toEqual(expected);

    // A single artifact larger than the whole budget must still be served, or
    // the listing would never advance past it.
    const tiny = drain(reader, { pageSize: 100, pageBytes: 1 });
    expect(tiny.pageSizes).toEqual([1, 1, 1]);
    expect(tiny.artifacts).toEqual(expected);
  });

  it('re-verifies every artifact it serves against its approved revision', () => {
    const { root } = seedCorpus(['# one\n', '# two\n', '# three\n']);
    const reader = new SharedCompanionWorkspaceReader(root);
    writeFileSync(join(root, 'artifacts', 'world', 'guide-002.md'), 'out of band mutation\n');

    // The mutated artifact sits on the last page: paging must not let it past.
    expect(() => drain(reader, { pageSize: 1, pageBytes: 8_000_000 }))
      .toThrow(/no longer matches its approved revision/);
    expect(() => reader.readArtifact('world/guide-002.md'))
      .toThrow(/no longer matches its approved revision/);
  });

  it('refuses a cursor the reviewed corpus no longer contains', () => {
    const { root } = seedCorpus(['# one\n', '# two\n']);
    const reader = new SharedCompanionWorkspaceReader(root);

    expect(() => reader.listArtifacts({
      bounds: { pageSize: 1, pageBytes: 8_000_000 },
      cursor: 'world/guide-404.md',
    })).toThrow(/restart the listing/);
  });

  it('rejects an approval whose review does not back it once that page is served', () => {
    const { root } = seedCorpus(['# one\n', '# two\n']);
    const reader = new SharedCompanionWorkspaceReader(root);
    rmSync(join(root, 'reviews', '00000001-1111-4111-8111-111111111111.json'));

    expect(() => reader.listArtifacts({ bounds: { pageSize: 10, pageBytes: 8_000_000 } }))
      .toThrow(/missing its review/);
  });
});
