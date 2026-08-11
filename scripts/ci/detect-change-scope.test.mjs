import assert from 'node:assert/strict';
import test from 'node:test';

import { detectChangeScope } from './detect-change-scope.mjs';

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
      evals: true,
      root_runtime: true,
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
    evals: true,
    root_runtime: true,
    clean_environment: true,
  });
});

test('keeps docs and workflow metadata on the cheap path', () => {
  const scope = detectChangeScope([
    '.github/workflows/ci.yml',
    'AGENTS.md',
    'docs/architecture.md',
    'package.json',
  ]);
  assert.equal(scope.root_runtime, false);
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

test('selects imported packages and their shared contracts', () => {
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
});
