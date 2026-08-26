import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  const addProject = (projectPath, name, projectAttested = true) => {
    const projectRoot = resolve(repositoryRoot, projectPath);
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name }));
    writeFileSync(join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const attestProject = () => {
      const lockfileHash = lockfileSha256(projectRoot);
      const markerPath = markerPathFor({ cacheDir, lockfileHash, projectName: name });
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, `${JSON.stringify({
        schemaVersion: 1,
        lockfileSha256: lockfileHash,
        projectName: name,
      })}\n`);
    };
    if (projectAttested) attestProject();
    return { attest: attestProject, projectRoot };
  };
  const { attest } = addProject('.', projectName, attested);
  return { addProject, attest, cacheDir, repositoryRoot };
}

function rootOnly(options) {
  return { ...options, projectPaths: ['.'] };
}

test('a fresh worktree receives an isolated offline lockfile install', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t);
  const calls = [];

  const result = bootstrapWorktree(rootOnly({
    repositoryRoot,
    cacheDir,
    nodeVersion: 'v24.19.0',
    runNpm(args) {
      calls.push(args);
      mkdirSync(join(repositoryRoot, 'node_modules'), { recursive: true });
    },
  }));

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

test('every lockfile-owned project receives its own isolated install', (t) => {
  const { addProject, cacheDir, repositoryRoot } = fixture(t);
  const nested = addProject('nested-ui', 'nested-ui-fixture');
  const installed = [];

  const result = bootstrapWorktree({
    repositoryRoot,
    cacheDir,
    nodeVersion: 'v24.19.0',
    projectPaths: ['.', 'nested-ui'],
    runNpm(_args, { repositoryRoot: projectRoot }) {
      installed.push(projectRoot);
      mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    },
  });

  assert.equal(result, 'installed');
  assert.deepEqual(installed, [repositoryRoot, nested.projectRoot]);
  assert.equal(
    readFileSync(dependencyMarkerPath(nested.projectRoot), 'utf8'),
    `${lockfileSha256(nested.projectRoot)}\n`,
  );
});

test('an exact lockfile marker makes repeated checkouts a no-op', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t);
  mkdirSync(join(repositoryRoot, 'node_modules'), { recursive: true });
  writeFileSync(dependencyMarkerPath(repositoryRoot), `${lockfileSha256(repositoryRoot)}\n`);
  let invoked = false;

  const result = bootstrapWorktree(rootOnly({
    repositoryRoot,
    cacheDir,
    nodeVersion: 'v24.19.0',
    runNpm() { invoked = true; },
  }));

  assert.equal(result, 'ready');
  assert.equal(invoked, false);
});

test('bootstrap fails before npm when the executing Node is not the repository version', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t);
  let invoked = false;

  assert.throws(
    () => bootstrapWorktree(rootOnly({
      repositoryRoot,
      cacheDir,
      nodeVersion: 'v22.22.2',
      runNpm() { invoked = true; },
    })),
    /requires Node v24\.19\.0; bootstrap is running under v22\.22\.2/u,
  );
  assert.equal(invoked, false);
});

test('bootstrap refuses to attest an install that did not create node_modules', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t);

  assert.throws(
    () => bootstrapWorktree(rootOnly({
      repositoryRoot,
      cacheDir,
      nodeVersion: 'v24.19.0',
      runNpm() {},
    })),
    /npm ci completed without creating node_modules/u,
  );
});

test('bootstrap automatically prepares an unattested cache before installing', (t) => {
  const { attest, cacheDir, repositoryRoot } = fixture(t, { attested: false });
  const events = [];

  const result = bootstrapWorktree(rootOnly({
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
  }));

  assert.equal(result, 'installed');
  assert.deepEqual(events, ['prewarm', 'install']);
});

test('bootstrap refuses an install when cache preparation does not attest it', (t) => {
  const { cacheDir, repositoryRoot } = fixture(t, { attested: false });
  let invoked = false;

  assert.throws(() => bootstrapWorktree(rootOnly({
    repositoryRoot,
    cacheDir,
    nodeVersion: 'v24.19.0',
    prewarm() {},
    runNpm() { invoked = true; },
  })), /did not create an attestation/u);
  assert.equal(invoked, false);
});
