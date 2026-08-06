import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function checkIgnored(path) {
  return spawnSync('git', ['check-ignore', '--no-index', '--quiet', path], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('ignores only the root ML-model directory', () => {
  const rootModels = checkIgnored('models/.gitignore-scope-probe');
  assert.equal(rootModels.status, 0, rootModels.stderr);

  const adminModels = checkIgnored('admin-ui/src/routes/models/+page.svelte');
  assert.equal(adminModels.status, 1, adminModels.stderr);
});

test('does not need a Knip entry workaround for the admin models route', () => {
  const knip = JSON.parse(readFileSync('knip.json', 'utf8'));
  assert.deepEqual(knip.workspaces?.['admin-ui']?.entry, ['src/hooks.ts']);
});
