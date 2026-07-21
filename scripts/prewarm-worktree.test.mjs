import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  hashLockfile,
  markerPathFor,
  parseArguments,
  prewarmWorktree,
} from './prewarm-worktree.mjs';

function makeFixture(t, lockfile = { lockfileVersion: 3, packages: {} }) {
  const root = mkdtempSync(join(tmpdir(), 'psfn-prewarm-test-'));
  const repositoryRoot = join(root, 'repository');
  const cacheDir = join(root, 'npm-cache');
  const tempRoot = join(root, 'temp');
  mkdirSync(repositoryRoot);
  mkdirSync(cacheDir);
  mkdirSync(tempRoot);
  writeFileSync(
    join(repositoryRoot, 'package.json'),
    `${JSON.stringify({ name: 'fixture-project', version: '1.0.0' })}\n`,
  );
  writeFileSync(join(repositoryRoot, 'package-lock.json'), `${JSON.stringify(lockfile)}\n`);
  writeFileSync(join(repositoryRoot, '.npmrc'), 'audit=false\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { cacheDir, repositoryRoot, tempRoot };
}

function recorder(implementation = () => '') {
  const calls = [];
  const runNpm = (args, options) => {
    calls.push({ args, options });
    return implementation(args, options, calls.length);
  };
  return { calls, runNpm };
}

function silentLogger() {
  return { error() {}, log() {} };
}

function writeFixtureAttestation(fixture) {
  const lockfileHash = hashLockfile(
    readFileSync(join(fixture.repositoryRoot, 'package-lock.json')),
  );
  const markerPath = markerPathFor({
    cacheDir: fixture.cacheDir,
    lockfileHash,
    projectName: 'fixture-project',
  });
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify({
      schemaVersion: 1,
      projectName: 'fixture-project',
      lockfileSha256: lockfileHash,
      verifiedAt: '2000-01-01T00:00:00.000Z',
    })}\n`,
  );
  return markerPath;
}

test('hashes the exact lockfile bytes', () => {
  assert.equal(
    hashLockfile('same lockfile\n'),
    '8c6333030825cb3f7e390917ebbb79e61022b40204230d031259c5c3940535e8',
  );
  assert.notEqual(hashLockfile('same lockfile\n'), hashLockfile('same lockfile'));
});

test('keys attestations by project identity and lockfile hash', () => {
  const cacheDir = '/cache';
  const firstHash = 'a'.repeat(64);
  const secondHash = 'b'.repeat(64);

  assert.notEqual(
    markerPathFor({ cacheDir, lockfileHash: firstHash, projectName: 'one' }),
    markerPathFor({ cacheDir, lockfileHash: firstHash, projectName: 'two' }),
  );
  assert.notEqual(
    markerPathFor({ cacheDir, lockfileHash: firstHash, projectName: 'one' }),
    markerPathFor({ cacheDir, lockfileHash: secondHash, projectName: 'one' }),
  );
});

test('warms through npm, proves a clean offline install, then records the hash', (t) => {
  const fixture = makeFixture(t);
  const npm = recorder((_args, options) => {
    assert.equal(existsSync(join(options.cwd, 'package.json')), true);
    assert.equal(existsSync(join(options.cwd, 'package-lock.json')), true);
    assert.equal(readFileSync(join(options.cwd, '.npmrc'), 'utf8'), 'audit=false\n');
  });

  const result = prewarmWorktree({
    ...fixture,
    logger: silentLogger(),
    runNpm: npm.runNpm,
  });

  assert.equal(result.action, 'warmed');
  assert.equal(npm.calls.length, 2);
  assert.notEqual(npm.calls[0].options.cwd, fixture.repositoryRoot);
  assert.notEqual(npm.calls[1].options.cwd, fixture.repositoryRoot);
  assert.notEqual(npm.calls[0].options.cwd, npm.calls[1].options.cwd);
  assert.deepEqual(npm.calls[0].args, [
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    fixture.cacheDir,
  ]);
  assert.deepEqual(npm.calls[1].args, [
    'ci',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    fixture.cacheDir,
  ]);
  assert.equal(existsSync(result.markerPath), true);
  assert.equal(JSON.parse(readFileSync(result.markerPath, 'utf8')).lockfileSha256, result.lockfileHash);
  assert.deepEqual(readdirSync(fixture.tempRoot), []);
});

test('a changed lockfile uses a new key and rewarms instead of trusting stale state', (t) => {
  const fixture = makeFixture(t);
  const firstNpm = recorder();
  const first = prewarmWorktree({
    ...fixture,
    logger: silentLogger(),
    runNpm: firstNpm.runNpm,
  });
  writeFileSync(
    join(fixture.repositoryRoot, 'package-lock.json'),
    `${JSON.stringify({ lockfileVersion: 3, packages: { changed: {} } })}\n`,
  );
  const secondNpm = recorder();

  const second = prewarmWorktree({
    ...fixture,
    logger: silentLogger(),
    runNpm: secondNpm.runNpm,
  });

  assert.notEqual(second.lockfileHash, first.lockfileHash);
  assert.notEqual(second.markerPath, first.markerPath);
  assert.equal(second.action, 'warmed');
  assert.equal(secondNpm.calls.length, 2);
});

test('an existing attestation is still verified with a clean offline install', (t) => {
  const fixture = makeFixture(t);
  prewarmWorktree({ ...fixture, logger: silentLogger(), runNpm: recorder().runNpm });
  const npm = recorder();

  const result = prewarmWorktree({
    ...fixture,
    logger: silentLogger(),
    runNpm: npm.runNpm,
  });

  assert.equal(result.action, 'verified');
  assert.equal(npm.calls.length, 1);
  assert.equal(npm.calls[0].args.includes('--offline'), true);
});

test('a stale attested cache is rewarmed, reproved offline, and reattested', (t) => {
  const fixture = makeFixture(t);
  const markerPath = writeFixtureAttestation(fixture);
  const originalAttestation = readFileSync(markerPath, 'utf8');
  const npm = recorder((_args, _options, callNumber) => {
    if (callNumber === 1) throw new Error('cached tarball missing');
  });

  const result = prewarmWorktree({
    ...fixture,
    logger: silentLogger(),
    runNpm: npm.runNpm,
  });

  assert.equal(result.action, 'warmed');
  assert.deepEqual(
    npm.calls.map((call) => call.args.includes('--offline')),
    [true, false, true],
  );
  assert.notEqual(readFileSync(markerPath, 'utf8'), originalAttestation);
  assert.equal(JSON.parse(readFileSync(markerPath, 'utf8')).lockfileSha256, result.lockfileHash);
  assert.deepEqual(readdirSync(fixture.tempRoot), []);
});

test('a failed stale-cache rewarm exits without rewriting the attestation', (t) => {
  const fixture = makeFixture(t);
  const markerPath = writeFixtureAttestation(fixture);
  const originalAttestation = readFileSync(markerPath, 'utf8');
  const npm = recorder((_args, _options, callNumber) => {
    throw new Error(callNumber === 1 ? 'cached tarball missing' : 'registry unavailable');
  });

  assert.throws(
    () =>
      prewarmWorktree({
        ...fixture,
        logger: silentLogger(),
        runNpm: npm.runNpm,
      }),
    /registry unavailable/u,
  );
  assert.deepEqual(
    npm.calls.map((call) => call.args.includes('--offline')),
    [true, false],
  );
  assert.equal(readFileSync(markerPath, 'utf8'), originalAttestation);
  assert.deepEqual(readdirSync(fixture.tempRoot), []);
});

test('check mode reports stale attested cache recovery without warming', (t) => {
  const fixture = makeFixture(t);
  const markerPath = writeFixtureAttestation(fixture);
  const npm = recorder(() => {
    throw new Error('cached tarball missing');
  });

  assert.throws(
    () =>
      prewarmWorktree({
        ...fixture,
        checkOnly: true,
        logger: silentLogger(),
        runNpm: npm.runNpm,
      }),
    (error) => {
      assert.match(error.message, /npm run prewarm/u);
      assert.match(error.message, new RegExp(markerPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      return true;
    },
  );
  assert.deepEqual(
    npm.calls.map((call) => call.args.includes('--offline')),
    [true],
  );
  assert.deepEqual(readdirSync(fixture.tempRoot), []);
});

test('check mode fails closed when the current lockfile has not been warmed', (t) => {
  const fixture = makeFixture(t);
  const npm = recorder();

  assert.throws(
    () =>
      prewarmWorktree({
        ...fixture,
        checkOnly: true,
        logger: silentLogger(),
        runNpm: npm.runNpm,
      }),
    /No cache attestation exists for lockfile SHA-256/u,
  );
  assert.equal(npm.calls.length, 0);
});

test('a mismatched attestation fails before npm executes', (t) => {
  const fixture = makeFixture(t);
  const lockfile = readFileSync(join(fixture.repositoryRoot, 'package-lock.json'));
  const lockfileHash = hashLockfile(lockfile);
  const markerPath = markerPathFor({
    cacheDir: fixture.cacheDir,
    lockfileHash,
    projectName: 'fixture-project',
  });
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify({
      schemaVersion: 1,
      projectName: 'fixture-project',
      lockfileSha256: 'f'.repeat(64),
    })}\n`,
  );
  const npm = recorder();

  assert.throws(
    () =>
      prewarmWorktree({
        ...fixture,
        logger: silentLogger(),
        runNpm: npm.runNpm,
      }),
    /Cache attestation hash mismatch/u,
  );
  assert.equal(npm.calls.length, 0);
});

test('npm failure is propagated and never creates an attestation', (t) => {
  const fixture = makeFixture(t);
  const npm = recorder(() => {
    throw new Error('npm failed');
  });

  assert.throws(
    () =>
      prewarmWorktree({
        ...fixture,
        logger: silentLogger(),
        runNpm: npm.runNpm,
      }),
    /npm failed/u,
  );
  const lockfileHash = hashLockfile(
    readFileSync(join(fixture.repositoryRoot, 'package-lock.json')),
  );
  assert.equal(
    existsSync(
      markerPathFor({
        cacheDir: fixture.cacheDir,
        lockfileHash,
        projectName: 'fixture-project',
      }),
    ),
    false,
  );
  assert.deepEqual(readdirSync(fixture.tempRoot), []);
});

test('a lockfile changing during prewarm fails closed before offline verification', (t) => {
  const fixture = makeFixture(t);
  const npm = recorder((_args, _options, callNumber) => {
    if (callNumber === 1) {
      writeFileSync(
        join(fixture.repositoryRoot, 'package-lock.json'),
        `${JSON.stringify({ lockfileVersion: 3, packages: { raced: {} } })}\n`,
      );
    }
  });

  assert.throws(
    () =>
      prewarmWorktree({
        ...fixture,
        logger: silentLogger(),
        runNpm: npm.runNpm,
      }),
    /package-lock\.json changed during prewarm/u,
  );
  assert.equal(npm.calls.length, 1);
});

test('parses help and check mode and rejects unknown arguments', () => {
  assert.deepEqual(parseArguments([]), { checkOnly: false, help: false });
  assert.deepEqual(parseArguments(['--check']), { checkOnly: true, help: false });
  assert.deepEqual(parseArguments(['--help']), { checkOnly: false, help: true });
  assert.deepEqual(parseArguments(['-h']), { checkOnly: false, help: true });
  assert.throws(() => parseArguments(['--wat']), /Unknown argument: --wat/u);
});
