import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(repositoryRoot, 'scripts', 'check-dependency-cycles.ts');
const tsxPath = join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function writeBaseline(root: string, cycles: string[]): void {
  writeFixtureFile(
    root,
    'config/dependency-cycle-baseline.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        remediationTracker: 'psfn-framework-683cc',
        cycles,
      },
      null,
      2,
    )}\n`,
  );
}

function runGate(root: string) {
  return spawnSync(
    process.execPath,
    [tsxPath, scriptPath, '--baseline', 'config/dependency-cycle-baseline.json'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
}

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dependency-cycle-gate-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('passes when an empty baseline matches an acyclic graph', () => {
  withFixture((root) => {
    writeFixtureFile(root, 'src/alpha.ts', 'export const alpha = 1;\n');
    writeBaseline(root, []);

    const result = runGate(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No circular imports detected\./u);
  });
});

test('fails closed when the baseline contains a stale cycle', () => {
  withFixture((root) => {
    writeFixtureFile(root, 'src/alpha.ts', 'export const alpha = 1;\n');
    writeBaseline(root, ['alpha.ts -> beta.ts']);

    const result = runGate(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Stale baseline entries not currently detected \(1\)/u);
    assert.match(result.stderr, /alpha\.ts -> beta\.ts/u);
    assert.match(result.stderr, /stale baseline entries must be pruned/u);
  });
});

test('accepts a currently detected cycle only when it is baselined', () => {
  withFixture((root) => {
    writeFixtureFile(root, 'src/alpha.ts', "import './beta.js';\nexport const alpha = 1;\n");
    writeFixtureFile(root, 'src/beta.ts', "import './alpha.js';\nexport const beta = 2;\n");
    writeBaseline(root, []);

    const regression = runGate(root);
    assert.equal(regression.status, 1);
    assert.match(regression.stderr, /alpha\.ts -> beta\.ts/u);

    writeBaseline(root, ['alpha.ts -> beta.ts']);
    const accepted = runGate(root);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Baseline-matched cycles \(1\)/u);
  });
});
