import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stageSmokeBuildContext } from './psfn-compose-smoke-context.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-smoke-context-test-'));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

describe('Compose smoke mode-normalized build context (1080c)', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('stages a umask-0027 working tree with world-readable modes, uncommitted edits included', () => {
    const checkout = temporaryRoot();
    git(checkout, 'init', '-q');
    mkdirSync(join(checkout, 'scripts/ops'), { recursive: true });
    writeFileSync(join(checkout, '.gitignore'), 'models/\n');
    writeFileSync(join(checkout, 'scripts/ops/prefetch.mjs'), 'committed\n');
    writeFileSync(join(checkout, 'scripts/ops/seed.sh'), '#!/bin/sh\n');
    writeFileSync(join(checkout, 'scripts/ops/deleted.mjs'), 'gone\n');
    git(checkout, 'add', '.');
    git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'seed');
    writeFileSync(join(checkout, 'scripts/ops/prefetch.mjs'), 'uncommitted edit\n');
    writeFileSync(join(checkout, 'scripts/ops/untracked.mjs'), 'new\n');
    rmSync(join(checkout, 'scripts/ops/deleted.mjs'));
    mkdirSync(join(checkout, 'models'));
    writeFileSync(join(checkout, 'models/weights.bin'), 'ignored');
    symlinkSync('prefetch.mjs', join(checkout, 'scripts/ops/link.mjs'));
    // What a umask-0027 checkout produces.
    chmodSync(join(checkout, 'scripts/ops/prefetch.mjs'), 0o640);
    chmodSync(join(checkout, 'scripts/ops/untracked.mjs'), 0o600);
    chmodSync(join(checkout, 'scripts/ops/seed.sh'), 0o750);
    chmodSync(join(checkout, 'scripts/ops'), 0o750);
    chmodSync(join(checkout, 'scripts'), 0o750);

    const { root, files } = stageSmokeBuildContext({ repoRoot: checkout, stageRoot: temporaryRoot() });

    expect(files).toBe(5);
    expect(mode(root)).toBe(0o755);
    expect(mode(join(root, 'scripts'))).toBe(0o755);
    expect(mode(join(root, 'scripts/ops'))).toBe(0o755);
    expect(mode(join(root, 'scripts/ops/prefetch.mjs'))).toBe(0o644);
    expect(mode(join(root, 'scripts/ops/untracked.mjs'))).toBe(0o644);
    expect(mode(join(root, 'scripts/ops/seed.sh'))).toBe(0o755);
    expect(readFileSync(join(root, 'scripts/ops/prefetch.mjs'), 'utf8')).toBe('uncommitted edit\n');
    expect(readlinkSync(join(root, 'scripts/ops/link.mjs'))).toBe('prefetch.mjs');
    expect(() => lstatSync(join(root, 'scripts/ops/deleted.mjs'))).toThrow();
    expect(() => lstatSync(join(root, 'models'))).toThrow();
  });

  it('is what smoke:docker builds and bind-mounts from when it brings the stack up', () => {
    const harness = readFileSync(join(repoRoot, 'scripts/smoke-docker.mjs'), 'utf8');
    expect(harness).toContain("import { stageSmokeBuildContext } from './ops/psfn-compose-smoke-context.mjs';");
    expect(harness).toMatch(/composeRoot = staged\.root;/u);
    expect(harness).toContain("compose(['up', '-d', '--build', '--wait'");
  });
});
