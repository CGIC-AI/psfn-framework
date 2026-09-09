// ── The Garden shared-workspace listing is bounded by its page, not by the
// corpus (bead psfn-framework-2xt9c) ──
//
// The page was already bounded; the work behind it was not. Every request
// walked the whole artifact tree, spent a `stat` on every file, and sorted the
// lot before the page bound applied — so paging a large reviewed workspace
// multiplied that cost once per page instead of dividing it. These prove the
// walk now retains and stats one page's worth, and that the page contents are
// unchanged by the bound.
//
// `node:fs` is mocked as a pass-through with a counting `statSync`: the real
// store, the real filesystem, and a real count of the syscalls the listing
// spends.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const statCalls = { count: 0 };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      statCalls.count += 1;
      return actual.statSync(...args);
    },
  };
});

const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { createHash } = await import('node:crypto');
const { resolveCompanionFleetPaths } = await import('../../system/config/companions-config.js');
const {
  COMPANION_LIBRARY_MANIFEST_FILE,
  COMPANION_LIBRARY_SEED_VERSION,
  provisionFleetWorkspaces,
} = await import('./provisioning.js');
const { SharedCompanionWorkspaceStore } = await import('./shared-workspace-store.js');
const {
  SharedWorkspaceListingCursorStaleError,
  SharedWorkspaceListingWindow,
} = await import('./shared-workspace-bounds.js');

type CompanionsFleetConfig = Parameters<typeof resolveCompanionFleetPaths>[0];

const FLEET = {
  postgres: {
    sharedMigrationRole: 'shared_migration',
    sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_MIGRATION_DATABASE_URL' },
  },
  companions: [{
    companionId: '11111111-1111-4111-8111-111111111111',
    companionDataDir: 'companions/one',
    characterCardPath: 'companions/one/card.json',
    postgresSchema: 'companion_one',
    postgresRole: 'companion_one_runtime',
    postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_ONE_DATABASE_URL' },
  }],
} as CompanionsFleetConfig;

const roots: string[] = [];

function createStore(): InstanceType<typeof SharedCompanionWorkspaceStore> {
  const root = mkdtempSync(join(tmpdir(), 'psfn-shared-workspace-bound-'));
  const source = mkdtempSync(join(tmpdir(), 'psfn-shared-seed-bound-'));
  roots.push(root, source);
  writeFileSync(join(source, 'welcome.md'), 'welcome');
  writeFileSync(join(source, 'privacy-boundary-reference.md'), 'privacy');
  writeFileSync(join(source, COMPANION_LIBRARY_MANIFEST_FILE), JSON.stringify({
    schemaVersion: 1,
    bundleVersion: COMPANION_LIBRARY_SEED_VERSION,
    files: [
      { path: 'welcome.md', sha256: createHash('sha256').update('welcome').digest('hex') },
      {
        path: 'privacy-boundary-reference.md',
        sha256: createHash('sha256').update('privacy').digest('hex'),
      },
    ],
  }));
  const fleet = resolveCompanionFleetPaths(FLEET, root);
  provisionFleetWorkspaces(fleet, { companionLibrarySourceDir: source });
  return new SharedCompanionWorkspaceStore(fleet.sharedWorkspacePath);
}

function publish(
  store: InstanceType<typeof SharedCompanionWorkspaceStore>,
  artifactPath: string,
): void {
  const proposal = store.propose({
    artifactPath,
    content: `# ${artifactPath}\n`,
    mediaType: 'text/markdown',
    actor: { id: 'operator-a', role: 'proposer' },
    provenance: 'listing bound fixture',
  });
  store.recordCogSecDecision({
    reviewId: proposal.reviewId,
    reviewer: { id: 'operator-c', role: 'cogsec' },
    decision: 'approved',
  });
  store.review({
    reviewId: proposal.reviewId,
    reviewer: { id: 'operator-b', role: 'reviewer' },
    decision: 'approve',
  });
}

const CORPUS = [
  'a.md',
  'b.md',
  'c.md',
  'notes/one.md',
  'notes/two.md',
  'world/deep/three.md',
  'world/four.md',
];

describe('SharedCompanionWorkspaceStore listing bound', () => {
  beforeEach(() => {
    statCalls.count = 0;
  });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('serves the whole corpus in order across pages, with nested directories', () => {
    const store = createStore();
    for (const artifactPath of CORPUS) publish(store, artifactPath);

    const bounds = { pageSize: 2, pageBytes: 8_000_000 };
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { artifacts: Array<{ artifactPath: string }>; nextCursor: string | null } =
        store.listArtifacts({ bounds, ...(cursor === null ? {} : { cursor }) });
      expect(page.artifacts.length).toBeLessThanOrEqual(bounds.pageSize);
      collected.push(...page.artifacts.map(artifact => artifact.artifactPath));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    expect(collected).toEqual([...CORPUS].sort((left, right) => left.localeCompare(right)));
    expect(pages).toBe(4);
  });

  it('spends one page of stat calls on a corpus several pages long', () => {
    const store = createStore();
    for (const artifactPath of CORPUS) publish(store, artifactPath);

    statCalls.count = 0;
    const page = store.listArtifacts({ bounds: { pageSize: 2, pageBytes: 8_000_000 } });

    expect(page.artifacts).toHaveLength(2);
    // The whole-corpus walk stat'd every one of the seven artifacts to build a
    // two-artifact page. The bounded window stats only what the page can serve.
    expect(statCalls.count).toBeLessThanOrEqual(2);
  });

  it('reports a cursor whose artifact left the listing as stale, not as a fault', () => {
    const store = createStore();
    for (const artifactPath of CORPUS) publish(store, artifactPath);

    expect(() => store.listArtifacts({
      bounds: { pageSize: 2, pageBytes: 8_000_000 },
      cursor: 'zzz.md',
    })).toThrow(SharedWorkspaceListingCursorStaleError);
  });
});

describe('SharedWorkspaceListingWindow', () => {
  it('retains one page in order and never materializes an entry past it', () => {
    const materialized: string[] = [];
    const window = new SharedWorkspaceListingWindow<string>(3, undefined);
    // Deliberately offered out of order: a directory walk arrives in whatever
    // order the filesystem hands back, which is the reason the window exists.
    for (const key of ['d.md', 'a.md', 'g.md', 'b.md', 'f.md', 'c.md', 'e.md']) {
      window.offer(key, () => {
        materialized.push(key);
        return key;
      });
    }

    expect(window.entries()).toEqual(['a.md', 'b.md', 'c.md']);
    expect(window.truncated).toBe(true);
    // `e.md` and `f.md` arrived after the window had filled with smaller keys,
    // so they were never built at all — that is the syscall the listing saves.
    expect(materialized).not.toContain('e.md');
    expect(materialized).not.toContain('f.md');
    expect(window.cursorResolved).toBe(true);
  });

  it('resumes after the cursor and reports a listing it consumed entirely', () => {
    const window = new SharedWorkspaceListingWindow<string>(3, 'b.md');
    for (const key of ['a.md', 'b.md', 'c.md', 'd.md']) window.offer(key, () => key);

    expect(window.entries()).toEqual(['c.md', 'd.md']);
    expect(window.truncated).toBe(false);
    expect(window.cursorResolved).toBe(true);
    expect(() => { window.requireResolvedCursor(); }).not.toThrow();
  });

  it('fails closed when the enumeration never saw the cursor', () => {
    const window = new SharedWorkspaceListingWindow<string>(3, 'b.md');
    for (const key of ['a.md', 'c.md']) window.offer(key, () => key);

    expect(window.cursorResolved).toBe(false);
    expect(() => { window.requireResolvedCursor(); })
      .toThrow(SharedWorkspaceListingCursorStaleError);
  });
});
