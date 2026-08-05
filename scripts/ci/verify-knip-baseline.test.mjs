import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFIER_PATH = join(REPOSITORY_ROOT, 'scripts/verify-knip-baseline.mjs');
const NPX_MARKER = 'npx-ran';

function emptyCounts(overrides = {}) {
  return {
    binaries: 0,
    catalog: 0,
    dependencies: 0,
    devDependencies: 0,
    duplicates: 0,
    enumMembers: 0,
    exports: 0,
    namespaceMembers: 0,
    optionalPeerDependencies: 0,
    types: 0,
    unlisted: 0,
    unresolved: 0,
    ...overrides,
  };
}

function baseline(overrides = {}) {
  return {
    schemaVersion: 1,
    knipVersion: '6.23.0',
    files: [],
    counts: emptyCounts(),
    ...overrides,
  };
}

function issue(file, overrides = {}) {
  return {
    file,
    binaries: [],
    catalog: [],
    dependencies: [],
    devDependencies: [],
    duplicates: [],
    enumMembers: [],
    exports: [],
    files: [],
    namespaceMembers: [],
    optionalPeerDependencies: [],
    types: [],
    unlisted: [],
    unresolved: [],
    ...overrides,
  };
}

function makeFixture({ knipBaseline, issues = [] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'psfn-knip-baseline-'));
  mkdirSync(join(cwd, 'bin'), { recursive: true });
  writeFileSync(join(cwd, 'report.json'), `${JSON.stringify({ issues })}\n`);
  const npxPath = join(cwd, 'bin/npx');
  writeFileSync(
    npxPath,
    [
      '#!/bin/sh',
      `echo ran > ${JSON.stringify(join(cwd, NPX_MARKER))}`,
      `cat ${JSON.stringify(join(cwd, 'report.json'))}`,
      '',
    ].join('\n'),
  );
  chmodSync(npxPath, 0o755);
  if (knipBaseline) {
    mkdirSync(join(cwd, 'config'), { recursive: true });
    writeFileSync(
      join(cwd, 'config/knip-baseline.json'),
      `${JSON.stringify(knipBaseline, null, 2)}\n`,
    );
  }
  return cwd;
}

function runVerifier(cwd, args = []) {
  return spawnSync(process.execPath, [VERIFIER_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(cwd, 'bin')}:${process.env.PATH}` },
  });
}

function readWrittenBaseline(cwd) {
  return JSON.parse(readFileSync(join(cwd, 'config/knip-baseline.json'), 'utf8'));
}

function assertKnipDidNotRun(cwd) {
  assert.equal(
    existsSync(join(cwd, NPX_MARKER)),
    false,
    'knip must not run when preflight rejects the configuration',
  );
}

test('fails for a missing baseline before starting knip', () => {
  const cwd = makeFixture();

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing config\/knip-baseline\.json/u);
  assertKnipDidNotRun(cwd);
});

test('fails for knip version drift before starting knip', () => {
  const cwd = makeFixture({
    knipBaseline: baseline({ knipVersion: '6.22.0' }),
  });

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Baseline uses knip 6\.22\.0, but the pinned knip is 6\.23\.0/u,
  );
  assertKnipDidNotRun(cwd);
});

test('fails for an unsorted baseline files list before starting knip', () => {
  const cwd = makeFixture({
    knipBaseline: baseline({ files: ['src/b.ts', 'src/a.ts'] }),
  });

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Knip baseline files must be sorted/u);
  assertKnipDidNotRun(cwd);
});

test('fails for duplicate baseline files before starting knip', () => {
  const cwd = makeFixture({
    knipBaseline: baseline({ files: ['src/a.ts', 'src/a.ts'] }),
  });

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Duplicate knip baseline file: src\/a\.ts/u);
  assertKnipDidNotRun(cwd);
});

test('passes when findings match the baseline', () => {
  const cwd = makeFixture({
    issues: [issue('src/dead.ts', { files: [{ name: 'src/dead.ts' }] })],
    knipBaseline: baseline({ files: ['src/dead.ts'] }),
  });

  const result = runVerifier(cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[verify-knip-baseline\] PASS/u);
  assert.equal(existsSync(join(cwd, NPX_MARKER)), true);
});

test('fails for a new unused file', () => {
  const cwd = makeFixture({
    issues: [issue('src/dead.ts', { files: [{ name: 'src/dead.ts' }] })],
    knipBaseline: baseline(),
  });

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\+ src\/dead\.ts: new unused file/u);
});

test('fails for a category count increase', () => {
  const cwd = makeFixture({
    issues: [issue('src/a.ts', { exports: [{ name: 'one' }, { name: 'two' }] })],
    knipBaseline: baseline({ counts: emptyCounts({ exports: 1 }) }),
  });

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /\+ exports: 2 finding\(s\), baseline allows 1 \(\+1\)/u,
  );
});

test('passes with an update note when findings shrink', () => {
  const cwd = makeFixture({
    issues: [issue('src/a.ts', { exports: [{ name: 'one' }] })],
    knipBaseline: baseline({
      counts: emptyCounts({ exports: 3 }),
      files: ['src/dead.ts'],
    }),
  });

  const result = runVerifier(cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nice: baseline findings were removed/u);
  assert.match(result.stdout, /-- --update/u);
});

test('update rewrites the baseline when findings shrink', () => {
  const cwd = makeFixture({
    issues: [],
    knipBaseline: baseline({
      counts: emptyCounts({ exports: 3 }),
      files: ['src/dead.ts'],
    }),
  });

  const result = runVerifier(cwd, ['--update']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[verify-knip-baseline\] wrote config\/knip-baseline\.json/u);
  const written = readWrittenBaseline(cwd);
  assert.deepEqual(written.files, []);
  assert.equal(written.counts.exports, 0);
});

test('update refuses to record increased findings', () => {
  const cwd = makeFixture({
    issues: [issue('src/a.ts', { exports: [{ name: 'one' }] })],
    knipBaseline: baseline(),
  });

  const result = runVerifier(cwd, ['--update']);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Refusing to update the baseline because dead-code findings increased/u,
  );
  assert.deepEqual(readWrittenBaseline(cwd), baseline());
});

test('fails when knip writes load errors to stderr', () => {
  const cwd = makeFixture({ knipBaseline: baseline() });
  writeFileSync(
    join(cwd, 'bin/npx'),
    [
      '#!/bin/sh',
      'echo "ERROR: Error loading companion-ui/playwright.config.ts" >&2',
      `cat ${JSON.stringify(join(cwd, 'report.json'))}`,
      '',
    ].join('\n'),
  );
  chmodSync(join(cwd, 'bin/npx'), 0o755);

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /knip reported load errors/u);
});
