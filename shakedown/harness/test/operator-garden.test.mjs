// xpgnr: prompt/skill residue maintenance runs as the audited ADMIN_TOKEN
// operator on kube, never through the testing-harness door and never by
// falling back to the harness key.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { operatorGardenHeaders, resolveOperatorGardenToken } from '../lib/operator-garden.mjs';

const KUBE = { isKube: true, apiKey: 'harness-key-0123456789', adminToken: 'harness-key-0123456789' };

test('kube requires the ADMIN_TOKEN operator credential', () => {
  assert.throws(() => resolveOperatorGardenToken(KUBE, {}), /ADMIN_TOKEN/);
  assert.equal(resolveOperatorGardenToken(KUBE, { ADMIN_TOKEN: 'operator-token-0123456789' }), 'operator-token-0123456789');
  assert.equal(
    resolveOperatorGardenToken(KUBE, { PSFN_OPERATOR_ADMIN_TOKEN: 'op-a', ADMIN_TOKEN: 'op-b' }),
    'op-a',
  );
});

test('kube refuses to reuse the testing-harness key as the operator credential', () => {
  assert.throws(
    () => resolveOperatorGardenToken(KUBE, { ADMIN_TOKEN: KUBE.apiKey }),
    /independent from TESTING_HARNESS_API_KEY/,
  );
});

test('local keeps its standalone Garden ADMIN_TOKEN', () => {
  assert.equal(resolveOperatorGardenToken({ isKube: false, apiKey: 'k', adminToken: 'local-admin' }, {}), 'local-admin');
});

test('operator requests carry an explicit bearer', () => {
  assert.deepEqual(operatorGardenHeaders('op', undefined), { Authorization: 'Bearer op' });
  assert.deepEqual(operatorGardenHeaders('op', {}), { Authorization: 'Bearer op', 'Content-Type': 'application/json' });
});

test('every prompt/skill residue maintenance call site uses the operator request', () => {
  const source = readFileSync(new URL('../live-system-shakedown.mjs', import.meta.url), 'utf8');
  for (const call of ['sweepHarnessPromptMarkers(', 'restorePromptLayers(', 'sweepHarnessSkills(', 'removeHarnessSkill(']) {
    const sites = source.split(call).slice(1);
    assert.ok(sites.length > 0, `${call} is called`);
    for (const site of sites) {
      assert.match(site.slice(0, 120), /adminRequest: operatorAdminRequest/u, `${call} runs as the operator`);
    }
  }
  assert.doesNotMatch(source, /\bfunction adminRequest\(/u, 'no harness-door maintenance request remains');
});
