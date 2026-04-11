import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGitRepoRoot } from './repo-root.js';

function initGitRepo(path: string): void {
  execFileSync('git', ['init'], { cwd: path, stdio: 'ignore' });
}

describe('resolveGitRepoRoot', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop();
      if (!target) continue;
      rmSync(target, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanupPaths.push(dir);
    return dir;
  }

  it('auto-detects repository top-level from a nested gateway codebase root', () => {
    const repoRoot = makeTempDir('psfn-git-root-auto-');
    initGitRepo(repoRoot);
    const nestedCodebaseRoot = join(repoRoot, 'apps', 'gateway');
    mkdirSync(nestedCodebaseRoot, { recursive: true });

    const resolvedRoot = resolveGitRepoRoot({
      codebaseRoot: nestedCodebaseRoot,
    });

    expect(resolvedRoot).toBe(resolve(repoRoot));
  });

  it('accepts configured GIT_REPO_ROOT when it points at repository top-level', () => {
    const repoRoot = makeTempDir('psfn-git-root-configured-');
    initGitRepo(repoRoot);
    const nestedCodebaseRoot = join(repoRoot, 'apps', 'gateway');
    mkdirSync(nestedCodebaseRoot, { recursive: true });

    const resolvedRoot = resolveGitRepoRoot({
      codebaseRoot: nestedCodebaseRoot,
      configuredGitRepoRoot: '../..',
    });

    expect(resolvedRoot).toBe(resolve(repoRoot));
  });

  it('fails closed when configured GIT_REPO_ROOT is not a git worktree', () => {
    const codebaseRoot = makeTempDir('psfn-git-root-codebase-');
    const nonRepoRoot = makeTempDir('psfn-git-root-nonrepo-');

    expect(() => resolveGitRepoRoot({
      codebaseRoot,
      configuredGitRepoRoot: nonRepoRoot,
    })).toThrow(/not a git worktree/i);
  });

  it('fails closed when codebase root is not a git worktree and no override is provided', () => {
    const codebaseRoot = makeTempDir('psfn-git-root-codebase-only-');

    expect(() => resolveGitRepoRoot({
      codebaseRoot,
    })).toThrow(/not a git worktree/i);
  });

  it('fails closed when configured GIT_REPO_ROOT is inside the repo but not the top-level', () => {
    const repoRoot = makeTempDir('psfn-git-root-not-top-');
    initGitRepo(repoRoot);
    const nested = join(repoRoot, 'nested');
    mkdirSync(nested, { recursive: true });

    expect(() => resolveGitRepoRoot({
      codebaseRoot: repoRoot,
      configuredGitRepoRoot: nested,
    })).toThrow(/must point at the repository top-level/i);
  });
});
