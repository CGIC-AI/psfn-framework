import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  bootstrapWorktree,
  dependencyMarkerPath,
  lockfileSha256,
} from './bootstrap-worktree.mjs';
import { markerPathFor } from '../prewarm-worktree.mjs';

function fixture(t, { attested = true } = {}) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'psfn-worktree-bootstrap-'));
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  const cacheDir = join(repositoryRoot, 'npm-cache');
  const projectName = 'psfn-bootstrap-fixture';
  writeFileSync(join(repositoryRoot, '.node-version'), '24.19.0\n');
  writeFileSync(join(repositoryRoot, 'package.json'), JSON.stringify({ name: projectName }));
  writeFileSync(join(repositoryRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const attest = () => {
    const lockfileHash = lockfileSha256(repositoryRoot);
    const markerPath = markerPathFor({ cacheDir, lockfileHash, projectName });
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      lockfileSha256: lockfileHash,
      projectName,
    })}\n`);
  };
  if (attested) attest();
  return { attest, cacheDir, repositoryRoot };
}

test('a fresh worktree receives an isolated offline lockfile install', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t);
  const calls = [];

  const result = bootstrapWorktree({
    repositoryRoot,
    cacheDir,
    nodeVersion: 'v24.19.0',
    runNpm(args) {
      calls.push(args);
      mkdirSync(join(repositoryRoot, 'node_modules'), { recursive: true });
    },
  });

  assert.equal(result, 'installed');
  assert.deepEqual(calls, [[
    'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', cacheDir, '--loglevel=error',
  ]]);
  assert.equal(
    readFileSync(dependencyMarkerPath(repositoryRoot), 'utf8'),
    `${lockfileSha256(repositoryRoot)}\n`,
  );
});

test('an exact lockfile marker makes repeated checkouts a no-op', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t);
  mkdirSync(join(repositoryRoot, 'node_modules'), { recursive: true });
  writeFileSync(dependencyMarkerPath(repositoryRoot), `${lockfileSha256(repositoryRoot)}\n`);
  let invoked = false;

  const result = bootstrapWorktree({
    repositoryRoot,
    cacheDir,
    nodeVersion: 'v24.19.0',
    runNpm() { invoked = true; },
  });

  assert.equal(result, 'ready');
  assert.equal(invoked, false);
});

test('bootstrap fails before npm when the executing Node is not the repository version', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t);
  let invoked = false;

  assert.throws(
    () => bootstrapWorktree({
      repositoryRoot,
      cacheDir,
      nodeVersion: 'v22.22.2',
      runNpm() { invoked = true; },
    }),
    /requires Node v24\.19\.0; bootstrap is running under v22\.22\.2/u,
  );
  assert.equal(invoked, false);
});

test('bootstrap refuses to attest an install that did not create node_modules', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t);

  assert.throws(
    () => bootstrapWorktree({
      repositoryRoot,
      cacheDir,
      nodeVersion: 'v24.19.0',
      runNpm() {},
    }),
    /npm ci completed without creating node_modules/u,
  );
});

test('bootstrap automatically prepares an unattested cache before installing', (t) => {
  const { attest, cacheDir, repositoryRoot } = fixture(t, { attested: false });
  const events = [];

  const result = bootstrapWorktree({
    repositoryRoot,
    cacheDir,
    nodeVersion: 'v24.19.0',
    prewarm() {
      events.push('prewarm');
      attest();
    },
    runNpm() {
      events.push('install');
      mkdirSync(join(repositoryRoot, 'node_modules'));
    },
  });

  assert.equal(result, 'installed');
  assert.deepEqual(events, ['prewarm', 'install']);
});

test('bootstrap refuses an install when cache preparation does not attest it', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t, { attested: false });
  let invoked = false;

  assert.throws(() => bootstrapWorktree({
    repositoryRoot,
    cacheDir,
    nodeVersion: 'v24.19.0',
    prewarm() {},
    runNpm() { invoked = true; },
  }), /did not create an attestation/u);
  assert.equal(invoked, false);
});
