import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
const VERIFIER_PATH = join(REPOSITORY_ROOT, 'scripts/verify-typecheck-baseline.mjs');
const COMPILER_MARKER = 'compiler-ran';

function baseline(overrides = {}) {
  return {
    schemaVersion: 1,
    typescriptVersion: '5.9.3',
    project: 'tsconfig.json',
    aggregation: 'path-and-code-count',
    totalErrors: 0,
    filesWithErrors: 0,
    errors: [],
    ...overrides,
  };
}

function makeFixture({ typecheckBaseline } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'psfn-typecheck-baseline-'));
  mkdirSync(join(cwd, 'node_modules/typescript/bin'), { recursive: true });
  writeFileSync(
    join(cwd, 'node_modules/typescript/package.json'),
    `${JSON.stringify({ version: '5.9.3' })}\n`,
  );
  writeFileSync(
    join(cwd, 'node_modules/typescript/bin/tsc'),
    [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(COMPILER_MARKER)}, JSON.stringify(process.argv.slice(2)));`,
      '',
    ].join('\n'),
  );
  writeFileSync(join(cwd, 'tsconfig.json'), '{}\n');
  if (typecheckBaseline) {
    mkdirSync(join(cwd, 'config'), { recursive: true });
    writeFileSync(
      join(cwd, 'config/typecheck-baseline.json'),
      `${JSON.stringify(typecheckBaseline, null, 2)}\n`,
    );
  }
  return cwd;
}

function runVerifier(cwd, args = []) {
  return spawnSync(process.execPath, [VERIFIER_PATH, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function assertCompilerDidNotRun(cwd) {
  assert.equal(
    existsSync(join(cwd, COMPILER_MARKER)),
    false,
    'TypeScript compiler must not run when preflight rejects the configuration',
  );
}

test('fails for a missing baseline before starting TypeScript', () => {
  const cwd = makeFixture();

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing config\/typecheck-baseline\.json/u);
  assertCompilerDidNotRun(cwd);
});

test('fails for a mismatched project before starting TypeScript', () => {
  const cwd = makeFixture({
    typecheckBaseline: baseline({ project: 'tsconfig.other.json' }),
  });

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Baseline is for tsconfig\.other\.json, but this run requested tsconfig\.json/u,
  );
  assertCompilerDidNotRun(cwd);
});

test('fails for TypeScript version drift before starting TypeScript', () => {
  const cwd = makeFixture({
    typecheckBaseline: baseline({ typescriptVersion: '5.8.0' }),
  });

  const result = runVerifier(cwd);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Baseline uses TypeScript 5\.8\.0, but installed TypeScript is 5\.9\.3/u,
  );
  assertCompilerDidNotRun(cwd);
});

test('starts TypeScript after a valid baseline passes preflight', () => {
  const cwd = makeFixture({ typecheckBaseline: baseline() });

  const result = runVerifier(cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[verify-typecheck-baseline\] PASS/u);
  assert.equal(existsSync(join(cwd, COMPILER_MARKER)), true);
  const compilerArgs = JSON.parse(readFileSync(join(cwd, COMPILER_MARKER), 'utf8'));
  assert.ok(compilerArgs.includes('--incremental'));
  assert.deepEqual(
    compilerArgs.slice(compilerArgs.indexOf('--tsBuildInfoFile'), compilerArgs.indexOf('--tsBuildInfoFile') + 2),
    [
      '--tsBuildInfoFile',
      join(cwd, 'node_modules/.cache/psfn/typecheck.tsbuildinfo'),
    ],
  );
});
