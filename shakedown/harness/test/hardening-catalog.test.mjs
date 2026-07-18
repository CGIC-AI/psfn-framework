import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HARDENING_CASE_IDS,
  buildHardeningCases,
  verifySettingsRoundTrip,
} from '../cases/hardening.mjs';

const context = {
  runToken: '2026-07-18T12-00-00',
  primaryApiUserId: 'api-key-fixture',
};

const services = {
  apiBase: 'http://127.0.0.1:10153',
  apiUrl: 'http://127.0.0.1:10153/v1/chat/completions',
  adminBase: 'http://127.0.0.1:10154',
  apiKey: 'fixture-api-key',
  companionDataDir: '/round/companion-data',
  systemDataDir: '/round/system-data',
  fetchJson: async () => ({ ok: true, status: 200, body: {} }),
  pgAll: async () => [],
  pgScalar: async () => 0,
  readJsonIfExists: () => null,
  readJsonl: () => [],
  waitForTurnRecord: async () => null,
};

test('hardening catalog has stable unique IDs and complete execution metadata', () => {
  const cases = buildHardeningCases(context, services, {});
  assert.deepEqual(cases.map((entry) => entry.id), [...HARDENING_CASE_IDS]);
  assert.equal(new Set(HARDENING_CASE_IDS).size, HARDENING_CASE_IDS.length);

  for (const entry of cases) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(['nursery', 'apprentice', 'autonomous', 'all'].includes(entry.tier));
    assert.ok(Array.isArray(entry.variants) && entry.variants.length > 0);
    assert.match(entry.feature, /^psfn-framework-/u);
    assert.equal(typeof entry.proof?.source, 'string');
    assert.equal(typeof entry.proof?.assertion, 'string');
    assert.equal(typeof entry.execute, 'function');
    assert.equal(typeof entry.validatePersistedProof, 'function');
  }
});

test('hardening catalog authors only the probe-supported hardening rows', () => {
  const ids = new Set(buildHardeningCases(context, services, {}).map((entry) => entry.id));
  assert.ok(ids.has('model_lane_attribution'), 'boundary spend / model-lane attribution (mmo9.7.3)');
  assert.ok(ids.has('backup_encryption_roundtrip'), 'backup.json encryption round-trip (irzz.1)');
  // Voice, passkey ceremonies, PWA, and the DNLL migration path stay
  // operator-eyes / staged-session dispositions, never authored cases.
  assert.ok(!ids.has('voice_reply_streaming'), 'voice stays operator-eyes');
  assert.ok(!ids.has('fleet_passkey_ceremony'), 'passkey ceremony stays operator-eyes');
  assert.ok(!ids.has('dnll_owner_migration'), 'DNLL migration is a staged session, not a case');
});

test('the backup round-trip case fails closed without the settings-save body env', async () => {
  const cases = buildHardeningCases(context, services, {});
  const backup = cases.find((entry) => entry.id === 'backup_encryption_roundtrip');
  assert.ok(backup);
  // The route/method are pinned (PATCH /api/admin/settings); only the harmless
  // payload is operator-supplied, and it is still fail-closed required.
  await assert.rejects(
    () => backup.before({ ctx: context }),
    /PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY/u,
  );
});

test('round-trip verify flags a no-op 2xx that does not reflect the change', async () => {
  const calls = [];
  const roundTripServices = {
    adminBase: 'http://127.0.0.1:10154',
    fetchJson: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET' });
      // Refetch returns settings that did NOT take the submitted value.
      return { ok: true, status: 200, body: { heartbeatIntervalSeconds: 1 } };
    },
  };
  const result = await verifySettingsRoundTrip({
    services: roundTripServices,
    savePath: '/api/admin/settings',
    saveBody: JSON.stringify({ heartbeatIntervalSeconds: 4242 }),
    saveOk: true,
    saveStatus: 200,
  });
  assert.equal(result.verified, false, 'a no-op change is detected as not round-tripping');
  assert.ok(result.mismatches.some((m) => /heartbeatIntervalSeconds/.test(m)), 'names the drifted field');
  assert.ok(calls.some((c) => c.method === 'GET' && c.url.endsWith('/api/admin/settings')),
    'round-trip refetches GET /api/admin/settings');
});

test('round-trip verify passes when the refetch reflects the change (root or .settings)', async () => {
  const okServices = {
    adminBase: 'http://127.0.0.1:10154',
    fetchJson: async () => ({ ok: true, status: 200, body: { settings: { heartbeatIntervalSeconds: 4242 } } }),
  };
  const result = await verifySettingsRoundTrip({
    services: okServices,
    savePath: '/api/admin/settings',
    saveBody: JSON.stringify({ heartbeatIntervalSeconds: 4242 }),
    saveOk: true,
    saveStatus: 200,
  });
  assert.equal(result.verified, true, 'a reflected change round-trips, including via a .settings envelope');
  assert.deepEqual(result.mismatches, []);
});

test('the backup case validateSideEffects flags a failed save or round-trip', () => {
  const backup = buildHardeningCases(context, services, {}).find(
    (entry) => entry.id === 'backup_encryption_roundtrip',
  );
  assert.equal(typeof backup.validateSideEffects, 'function');
  // A clean save that round-trips: no failures.
  assert.deepEqual(
    backup.validateSideEffects({ sideChecks: { backup: { save: { ok: true, roundTripVerified: true, roundTripMismatches: [] } } } }),
    [],
  );
  // A 2xx that did not round-trip: flagged.
  const noopFailures = backup.validateSideEffects({
    sideChecks: { backup: { save: { ok: true, roundTripVerified: false, roundTripMismatches: ["field 'x' did not round-trip"] } } },
  });
  assert.ok(noopFailures.some((f) => /round-trip/.test(f)), 'a no-op save is a side-effect failure');
  // A non-2xx save: flagged.
  const badSaveFailures = backup.validateSideEffects({
    sideChecks: { backup: { save: { ok: false, status: 500, roundTripVerified: false, roundTripMismatches: [] } } },
  });
  assert.ok(badSaveFailures.some((f) => /did not succeed/.test(f)), 'a failed save is a side-effect failure');
});
