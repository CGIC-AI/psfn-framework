import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

import { affectsEvals, detectChangeScope } from './detect-change-scope.mjs';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const EVAL_ROOT = join(REPOSITORY_ROOT, 'tools/evals/eval');
const STATIC_IMPORT_PATTERN = /(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/gu;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function resolveRelativeImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/u, '.ts'),
    base.replace(/\.jsx$/u, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function reachableEvalRootFiles() {
  const entries = walk(EVAL_ROOT).filter((path) =>
    path.endsWith('.test.ts') || (path.includes('/eval/src/') && path.endsWith('.ts')),
  );
  const pending = [...entries];
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(STATIC_IMPORT_PATTERN)) {
      const dependency = resolveRelativeImport(file, match[1]);
      if (dependency && !seen.has(dependency)) pending.push(dependency);
    }
  }
  return [...seen]
    .map((path) => relative(REPOSITORY_ROOT, path).replaceAll('\\', '/'))
    .filter((path) => path.startsWith('src/'))
    .sort();
}

test('detects specialist validation scopes', () => {
  assert.deepEqual(
    detectChangeScope([
      '.github/workflows/ci.yml',
      'admin-ui/src/routes/settings/+page.svelte',
      'companion-ui/src/App.tsx',
      'src/system/config/load-config.ts',
    ]),
    {
      settings: true,
      supply_chain: true,
      admin_ui: true,
      companion_ui: true,
      satellite_hub: false,
      evals: false,
      root_build_contract: false,
      root_runtime: true,
      root_test_only: false,
      root_validation: true,
      clean_environment: true,
    },
  );
});

test('leaves unrelated source changes on the core CI path', () => {
  assert.deepEqual(detectChangeScope(['src/core/session/manager.ts']), {
    settings: false,
    supply_chain: false,
    admin_ui: false,
    companion_ui: false,
    satellite_hub: false,
    evals: false,
    root_build_contract: false,
    root_runtime: true,
    root_test_only: false,
    root_validation: true,
    clean_environment: true,
  });
});

test('test-only root changes avoid product build and typecheck scopes', () => {
  for (const path of [
    'src/core/session/manager.test.ts',
    'scripts/onboarding/flow.test.ts',
  ]) {
    const scope = detectChangeScope([path]);
    assert.equal(scope.root_runtime, false, path);
    assert.equal(scope.root_test_only, true, path);
    assert.equal(scope.root_validation, true, path);
    assert.equal(scope.evals, false, path);
  }
});

test('build contracts retain the full root build scope', () => {
  for (const path of ['tsup.config.ts', 'tsconfig.tsup.json']) {
    const scope = detectChangeScope([path]);
    assert.equal(scope.root_build_contract, true, path);
    assert.equal(scope.root_validation, true, path);
  }
});

test('keeps docs and workflow metadata on the cheap path', () => {
  const scope = detectChangeScope([
    '.github/workflows/ci.yml',
    'AGENTS.md',
    'docs/architecture.md',
    'package.json',
  ]);
  assert.equal(scope.root_runtime, false);
  assert.equal(scope.root_validation, false);
  assert.equal(scope.satellite_hub, false);
  assert.equal(scope.evals, false);
  assert.equal(scope.clean_environment, false);
});

test('routes UI changes to specialists without selecting root runtime', () => {
  for (const path of [
    'admin-ui/src/routes/+page.svelte',
    'companion-ui/src/App.tsx',
  ]) {
    const scope = detectChangeScope([path]);
    assert.equal(scope.root_runtime, false, path);
    assert.equal(scope.clean_environment, true, path);
  }
  assert.equal(detectChangeScope(['package-lock.json']).root_runtime, true);
});

test('selects imported packages and their explicit root dependency manifests', () => {
  const hub = detectChangeScope(['apps/satellite-hub/src/ts/hub/main.ts']);
  assert.equal(hub.satellite_hub, true);
  assert.equal(hub.root_runtime, false);
  assert.equal(hub.evals, false);

  const protocol = detectChangeScope(['companion-ui/src/lib/protocol/events.ts']);
  assert.equal(protocol.companion_ui, true);
  assert.equal(protocol.satellite_hub, true);

  const evals = detectChangeScope(['tools/evals/eval/src/validation.ts']);
  assert.equal(evals.evals, true);
  assert.equal(evals.root_runtime, false);
  assert.equal(evals.satellite_hub, false);

  for (const path of [
    'src/core/emotion/calibration.ts',
    'src/core/emotion/state.ts',
    'src/shared/contracts/emotion-contracts.ts',
    'src/shared/utils/types.ts',
  ]) {
    assert.equal(detectChangeScope([path]).evals, true, path);
  }
  assert.equal(detectChangeScope(['src/shared/utils/numeric.ts']).evals, true);
  assert.equal(detectChangeScope(['src/faculties/memory/store.ts']).evals, false);
  assert.equal(detectChangeScope(['src/system/config/runtime-config.ts']).evals, false);
  assert.equal(detectChangeScope(['src/core/session/manager.ts']).evals, false);
});

test('eval scope manifest exactly covers the fast build and test root graph', () => {
  const reachable = reachableEvalRootFiles();
  assert.deepEqual(reachable, [
    'src/core/emotion/calibration.ts',
    'src/core/emotion/state.ts',
    'src/shared/contracts/emotion-contracts.ts',
    'src/shared/utils/load-dotenv.ts',
    'src/shared/utils/numeric.ts',
    'src/shared/utils/types.ts',
  ]);
  for (const path of reachable) assert.equal(affectsEvals([path]), true, path);
  assert.equal(affectsEvals(['src/core/session/manager.ts']), false);
});
