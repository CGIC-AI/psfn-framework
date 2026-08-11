import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

test('installs Knip workspace dependencies before repository hygiene', () => {
  const hygiene = workflow.indexOf('run: npm run verify:repository-hygiene');
  const adminInstall = workflow.indexOf('npm ci --prefix admin-ui --ignore-scripts');
  const companionInstall = workflow.indexOf('npm ci --prefix companion-ui --ignore-scripts');

  assert.notEqual(hygiene, -1, 'CI must run repository hygiene');
  assert.notEqual(adminInstall, -1, 'CI must install admin-ui dependencies for Knip');
  assert.notEqual(companionInstall, -1, 'CI must install companion-ui dependencies for Knip');
  assert.ok(adminInstall < hygiene, 'admin-ui dependencies must be installed before hygiene');
  assert.ok(companionInstall < hygiene, 'companion-ui dependencies must be installed before hygiene');
});
