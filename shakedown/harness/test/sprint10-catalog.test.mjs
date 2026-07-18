import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPRINT10_CASE_IDS,
  buildSprint10Cases,
} from '../cases/sprint10.mjs';

const context = {
  runToken: '2026-07-17T12-00-00',
  primaryContactId: 'contact-fixture',
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

test('Sprint 10 catalog has stable unique IDs and complete execution metadata', () => {
  const cases = buildSprint10Cases(context, services, {});
  assert.deepEqual(cases.map((entry) => entry.id), SPRINT10_CASE_IDS);
  assert.equal(new Set(SPRINT10_CASE_IDS).size, SPRINT10_CASE_IDS.length);
  assert.ok(SPRINT10_CASE_IDS.length >= 9);

  for (const entry of cases) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(['nursery', 'apprentice', 'autonomous', 'all'].includes(entry.tier));
    assert.ok(Array.isArray(entry.variants) && entry.variants.length > 0);
    assert.match(entry.feature, /^psfn-framework-/u);
    assert.equal(typeof entry.proof?.source, 'string');
    assert.equal(typeof entry.proof?.assertion, 'string');
    assert.equal(typeof entry.validatePersistedProof, 'function');
  }
});

test('catalog covers every in-scope Sprint 10 executable seam without duplicating external artifacts', () => {
  const ids = new Set(buildSprint10Cases(context, services, {}).map((entry) => entry.id));
  for (const expected of [
    's10_places_physical',
    's10_places_placeless',
    's10_mindspace_virtual',
    's10_mindspace_physical_precedence',
    's10_world_read_telemetry',
    's10_hub_identity_presence_follow',
    's10_cogsec_document_quarantine',
    's10_temporal_stamp_strip',
    's10_sse_first_chunk',
  ]) {
    assert.ok(ids.has(expected), `missing ${expected}`);
  }
  assert.ok(!ids.has('s10_multi_companion_crossover'), 'multi-companion proof belongs to the support artifact');
  assert.ok(!ids.has('s10_capability_matrix'), 'capability proof belongs to the conformance artifact');
});
