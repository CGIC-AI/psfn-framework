import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  bootstrapWorktree,
  dependencyMarkerPath,
  lockfileSha256,
} from './bootstrap-worktree.mjs';

function fixture(t) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'psfn-worktree-bootstrap-'));
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  writeFileSync(join(repositoryRoot, '.node-version'), '24.19.0\n');
  writeFileSync(join(repositoryRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
  return repositoryRoot;
}

test('a fresh worktree receives an isolated offline lockfile install', (t) => {
  const repositoryRoot = fixture(t);
  const calls = [];

  const result = bootstrapWorktree({
    repositoryRoot,
    nodeVersion: 'v24.19.0',
    runNpm(args) {
      calls.push(args);
      mkdirSync(join(repositoryRoot, 'node_modules'), { recursive: true });
    },
  });

  assert.equal(result, 'installed');
  assert.deepEqual(calls, [[
    'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
  ]]);
  assert.equal(
    readFileSync(dependencyMarkerPath(repositoryRoot), 'utf8'),
    `${lockfileSha256(repositoryRoot)}\n`,
  );
});

test('an exact lockfile marker makes repeated checkouts a no-op', (t) => {
  const repositoryRoot = fixture(t);
  mkdirSync(join(repositoryRoot, 'node_modules'), { recursive: true });
  writeFileSync(dependencyMarkerPath(repositoryRoot), `${lockfileSha256(repositoryRoot)}\n`);
  let invoked = false;

  const result = bootstrapWorktree({
    repositoryRoot,
    nodeVersion: 'v24.19.0',
    runNpm() { invoked = true; },
  });

  assert.equal(result, 'ready');
  assert.equal(invoked, false);
});

test('bootstrap fails before npm when the executing Node is not the repository version', (t) => {
  const repositoryRoot = fixture(t);
  let invoked = false;

  assert.throws(
    () => bootstrapWorktree({
      repositoryRoot,
      nodeVersion: 'v22.22.2',
      runNpm() { invoked = true; },
    }),
    /requires Node v24\.19\.0; bootstrap is running under v22\.22\.2/u,
  );
  assert.equal(invoked, false);
});

test('bootstrap refuses to attest an install that did not create node_modules', (t) => {
  const repositoryRoot = fixture(t);

  assert.throws(
    () => bootstrapWorktree({
      repositoryRoot,
      nodeVersion: 'v24.19.0',
      runNpm() {},
    }),
    /npm ci completed without creating node_modules/u,
  );
});
