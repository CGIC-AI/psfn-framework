import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HARDENING_CASE_IDS,
  buildHardeningCases,
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

test('the backup round-trip case fails closed without the settings-save env', async () => {
  const cases = buildHardeningCases(context, services, {});
  const backup = cases.find((entry) => entry.id === 'backup_encryption_roundtrip');
  assert.ok(backup);
  await assert.rejects(
    () => backup.before({ ctx: context }),
    /PSFN_SHAKEDOWN_SETTINGS_SAVE_PATH/u,
  );
});
