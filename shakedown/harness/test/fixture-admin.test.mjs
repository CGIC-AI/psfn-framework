import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFixtureAdminToken } from '../lib/fixture-admin.mjs';

const KUBE_TARGET = {
  isKube: true,
  chatBaseUrl: 'https://fleet.example.test',
  apiKey: 'testing-harness-key',
  adminToken: 'testing-harness-key',
  companionId: '22222222-2222-4222-8222-222222222222',
};

test('kube fixture restores use the independent Operator door, not the harness key (xpgnr)', () => {
  assert.equal(resolveFixtureAdminToken(KUBE_TARGET, { ADMIN_TOKEN: 'operator-token' }), 'operator-token');
  assert.throws(() => resolveFixtureAdminToken(KUBE_TARGET, {}), /PSFN_OPERATOR_ADMIN_TOKEN/u);
  assert.throws(
    () => resolveFixtureAdminToken(KUBE_TARGET, { ADMIN_TOKEN: 'testing-harness-key' }),
    /independent from TESTING_HARNESS_API_KEY/u,
  );
});

test('the local target keeps its Garden admin token', () => {
  assert.equal(resolveFixtureAdminToken({ isKube: false, adminToken: 'local-admin' }, {}), 'local-admin');
});
