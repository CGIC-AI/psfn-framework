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

// Services whose GET /api/admin/settings returns the supplied settings body,
// recording every request so before()/derive assertions can inspect them.
function settingsServices(getBody) {
  const calls = [];
  return {
    calls,
    adminBase: 'http://127.0.0.1:10154',
    systemDataDir: '/round/system-data',
    companionDataDir: '/round/companion-data',
    readJsonIfExists: () => null,
    fetchJson: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ?? null });
      if ((init.method ?? 'GET') === 'GET') {
        return { ok: true, status: 200, body: getBody };
      }
      return { ok: true, status: 200, body: { ok: true } };
    },
  };
}

test('the backup round-trip case self-derives a harmless settings flip with no env', async () => {
  const svc = settingsServices({ config: { sessionRestartBehavior: 'reuse_latest_session' } });
  const backup = buildHardeningCases(context, svc, {}).find(
    (entry) => entry.id === 'backup_encryption_roundtrip',
  );
  assert.ok(backup);
  const beforeChecks = await backup.before({ ctx: context });
  // The route/method are pinned; only the harmless payload is self-derived — the
  // opposite enum value for a companion-neutral session/UX-plumbing default.
  assert.equal(beforeChecks.isOverride, false);
  assert.deepEqual(JSON.parse(beforeChecks.saveBody), { sessionRestartBehavior: 'new_session' });
  assert.deepEqual(beforeChecks.originals, { sessionRestartBehavior: 'reuse_latest_session' });
  assert.ok(svc.calls.some((c) => c.method === 'GET' && c.url.endsWith('/api/admin/settings')),
    'before() derives from a GET of the pinned settings route');
});

test('the backup round-trip case fails closed when the settings GET lacks the round-trip field', async () => {
  const svc = settingsServices({ config: {} });
  const backup = buildHardeningCases(context, svc, {}).find(
    (entry) => entry.id === 'backup_encryption_roundtrip',
  );
  await assert.rejects(
    () => backup.before({ ctx: context }),
    /sessionRestartBehavior/u,
  );
});

test('the backup round-trip case honors the optional settings-save body override', async () => {
  const svc = settingsServices({ config: { sessionRestartBehavior: 'reuse_latest_session', heartbeatIntervalSeconds: 1 } });
  const backup = buildHardeningCases(context, svc, {
    PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY: JSON.stringify({ heartbeatIntervalSeconds: 4242 }),
  }).find((entry) => entry.id === 'backup_encryption_roundtrip');
  const beforeChecks = await backup.before({ ctx: context });
  assert.equal(beforeChecks.isOverride, true);
  assert.deepEqual(JSON.parse(beforeChecks.saveBody), { heartbeatIntervalSeconds: 4242 });
  // The override's original value is still captured for the idempotent restore.
  assert.deepEqual(beforeChecks.originals, { heartbeatIntervalSeconds: 1 });
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
  // A clean save that round-trips and restores: no failures.
  assert.deepEqual(
    backup.validateSideEffects({ sideChecks: { backup: { save: { ok: true, roundTripVerified: true, roundTripMismatches: [], restored: true, restoreMismatches: [] } } } }),
    [],
  );
  // A 2xx that did not round-trip: flagged.
  const noopFailures = backup.validateSideEffects({
    sideChecks: { backup: { save: { ok: true, roundTripVerified: false, roundTripMismatches: ["field 'x' did not round-trip"], restored: true } } },
  });
  assert.ok(noopFailures.some((f) => /round-trip/.test(f)), 'a no-op save is a side-effect failure');
  // A non-2xx save: flagged.
  const badSaveFailures = backup.validateSideEffects({
    sideChecks: { backup: { save: { ok: false, status: 500, roundTripVerified: false, roundTripMismatches: [], restored: false } } },
  });
  assert.ok(badSaveFailures.some((f) => /did not succeed/.test(f)), 'a failed save is a side-effect failure');
  // A save that round-tripped but left settings mutated (restore not confirmed): flagged.
  const notRestored = backup.validateSideEffects({
    sideChecks: { backup: { save: { ok: true, roundTripVerified: true, roundTripMismatches: [], restored: false, restoreMismatches: ['restore round-trip was not confirmed'] } } },
  });
  assert.ok(notRestored.some((f) => /were not restored/.test(f)), 'an unrestored settings change is a side-effect failure');
});

test('the backup case exposes an idempotent top-level cleanup', async () => {
  const svc = settingsServices({ config: { sessionRestartBehavior: 'reuse_latest_session' } });
  const backup = buildHardeningCases(context, svc, {}).find(
    (entry) => entry.id === 'backup_encryption_roundtrip',
  );
  assert.equal(typeof backup.cleanup, 'function');
  // Cleanup before before(): nothing derived, so it is a no-op.
  const clean = await backup.cleanup();
  assert.deepEqual(clean.cleanupErrors, []);
  assert.equal(clean.cleanup.settings.alreadyClean, true);
  // After before() derives originals, cleanup restores them via a PATCH.
  await backup.before({ ctx: context });
  const restored = await backup.cleanup();
  assert.deepEqual(restored.cleanupErrors, []);
  assert.ok(svc.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/api/admin/settings')),
    'cleanup PATCHes the pinned settings route to restore the original value');
});
