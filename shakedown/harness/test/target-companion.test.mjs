// psfn-framework-gz50o: the kube target's COMPANION_ID selects the fleet
// companion for both the Garden route and the chat selector, so it must be an
// exact companion id and never silently fall back to the pinned primary.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTarget } from '../lib/target.mjs';

const FOLLOWER = '22222222-2222-4222-8222-222222222222';

function kubeEnv(companionId) {
  return {
    PSFN_TARGET: 'kube',
    PSFN_API_BASE: 'https://fleet.example.test',
    TESTING_HARNESS_API_KEY: 'harness-key-0123456789',
    POSTGRES_DATABASE_URL: 'postgres://harness@db.example.test/fleet',
    COMPANION_ID: companionId,
  };
}

test('the kube target binds the Garden route and the chat selector to one companion', () => {
  const target = resolveTarget(kubeEnv(FOLLOWER.toUpperCase()));
  assert.equal(target.companionId, FOLLOWER);
  assert.equal(target.adminBaseUrl, `https://fleet.example.test/companions/${FOLLOWER}/garden`);
});

test('a non-UUID kube COMPANION_ID fails closed', () => {
  assert.throws(() => resolveTarget(kubeEnv('vega-unit-zero')), /COMPANION_ID/);
});

test('the local target keeps pinned routing (no companion selector)', () => {
  const target = resolveTarget({
    PSFN_TARGET: 'local',
    PSFN_API_BASE: 'http://127.0.0.1:19999',
    PSFN_ADMIN_BASE: 'http://127.0.0.1:19998',
    TESTING_HARNESS_API_KEY: 'harness-key-0123456789',
    ADMIN_TOKEN: 'admin-token-0123456789',
    POSTGRES_DATABASE_URL: 'postgres://harness@db.example.test/fleet',
  });
  assert.equal(target.companionId, null);
});
