import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectChangedLintPaths } from './lint-changed.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('collects committed, staged, unstaged, and untracked lintable files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'psfn-lint-changed-'));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.email', 'ci@example.invalid');
  git(cwd, 'config', 'user.name', 'CI Test');
  writeFileSync(join(cwd, 'seed.ts'), 'export {};\n');
  git(cwd, 'add', 'seed.ts');
  git(cwd, 'commit', '--quiet', '-m', 'seed');
  const base = git(cwd, 'rev-parse', 'HEAD');

  writeFileSync(join(cwd, 'committed.ts'), 'export {};\n');
  git(cwd, 'add', 'committed.ts');
  git(cwd, 'commit', '--quiet', '-m', 'committed');
  writeFileSync(join(cwd, 'staged.mjs'), 'export {};\n');
  git(cwd, 'add', 'staged.mjs');
  writeFileSync(join(cwd, 'seed.ts'), 'export const changed = true;\n');
  writeFileSync(join(cwd, 'untracked.tsx'), 'export {};\n');
  writeFileSync(join(cwd, 'ignored.md'), 'not lintable\n');

  assert.deepEqual(collectChangedLintPaths({ base, cwd }), [
    'committed.ts',
    'seed.ts',
    'staged.mjs',
    'untracked.tsx',
  ]);
});
