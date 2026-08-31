import assert from 'node:assert/strict';
import test from 'node:test';

import { requireAdaptiveToolCatalog } from '../lib/adaptive-catalog.mjs';

test('extracts unique sorted tool names from a successful adaptive catalog response', () => {
  assert.deepEqual(requireAdaptiveToolCatalog({
    ok: true,
    status: 200,
    body: {
      catalog: {
        tools: [{ name: 'north_star' }, { name: 'beads' }, { name: 'north_star' }],
      },
    },
  }), ['beads', 'north_star']);
});

test('fails loudly when the sanctioned principal cannot fetch the catalog', () => {
  assert.throws(
    () => requireAdaptiveToolCatalog({
      ok: false,
      status: 400,
      body: { error: { type: 'fleet_sso_request_denied' } },
    }),
    /adaptive tool catalog.*HTTP 400.*fleet_sso_request_denied/iu,
  );
});

test('fails loudly when a nominally successful response has no catalog array', () => {
  assert.throws(
    () => requireAdaptiveToolCatalog({ ok: true, status: 200, body: {} }),
    /missing catalog\.tools/iu,
  );
});
