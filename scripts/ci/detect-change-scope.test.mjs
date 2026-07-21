import assert from 'node:assert/strict';
import test from 'node:test';

import { detectChangeScope } from './detect-change-scope.mjs';

test('detects specialist validation scopes', () => {
  assert.deepEqual(
    detectChangeScope([
      '.github/workflows/ci.yml',
      'admin-ui/src/routes/settings/+page.svelte',
      'companion-ui/src/App.tsx',
      'deploy/helm/psfn/values.yaml',
      'src/system/config/load-config.ts',
    ]),
    {
      settings: true,
      deployment: true,
      supply_chain: true,
      admin_ui: true,
      companion_ui: true,
      clean_environment: true,
    },
  );
});

test('leaves unrelated source changes on the core CI path', () => {
  assert.deepEqual(detectChangeScope(['src/core/session/manager.ts']), {
    settings: false,
    deployment: false,
    supply_chain: false,
    admin_ui: false,
    companion_ui: false,
    clean_environment: true,
  });
});

test('keeps docs, delivery tooling, and package scripts on the cheap GitHub path', () => {
  assert.equal(
    detectChangeScope(['AGENTS.md', 'CLAUDE.md', 'docs/orchestration-process.md', 'package.json'])
      .clean_environment,
    false,
  );
});
