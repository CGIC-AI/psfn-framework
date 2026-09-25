import assert from 'node:assert/strict';
import test from 'node:test';

import {
  restorePromptLayers,
  snapshotPromptLayers,
  stripHarnessPromptMarkers,
  sweepHarnessPromptMarkers,
} from '../lib/prompt-layer-restore.mjs';

const ATTENTION = '<runtime_attention>\n<open_threads>{{runtime_concerns_top_lines}}</open_threads>\n</runtime_attention>';

/** In-memory Garden prompt admin API. */
function fakeGarden(layers) {
  const state = new Map(layers.map((layer) => [layer.id, { ...layer }]));
  const calls = [];
  const adminRequest = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/api/admin/prompts') {
      return { ok: true, status: 200, body: { layers: [...state.values()].map((layer) => ({ ...layer })) } };
    }
    const toggle = /^\/api\/admin\/prompts\/([^/]+)\/toggle$/u.exec(path);
    if (method === 'POST' && toggle) {
      const layer = state.get(decodeURIComponent(toggle[1]));
      layer.enabled = !layer.enabled;
      return { ok: true, status: 200, body: {} };
    }
    const patch = /^\/api\/admin\/prompts\/([^/]+)$/u.exec(path);
    if (method === 'PATCH' && patch) {
      state.get(decodeURIComponent(patch[1])).content = body.content;
      return { ok: true, status: 200, body: {} };
    }
    return { ok: false, status: 404, body: null };
  };
  return { state, calls, adminRequest };
}

test('a case that leaves a marker and a toggled layer is restored byte-identically', async () => {
  const garden = fakeGarden([
    { id: 'layer-attention', content: ATTENTION, enabled: true },
    { id: 'layer-last-message', content: 'last message', enabled: true },
  ]);
  const before = snapshotPromptLayers((await garden.adminRequest('GET', '/api/admin/prompts')).body);
  // What a failed prompt_mutation_cycle rollback and a single toggle leave behind.
  garden.state.get('layer-attention').content = `${ATTENTION}\n[matrix prompt marker 2026-09-24T22-51-02-294Z]`;
  garden.state.get('layer-last-message').enabled = false;

  const result = await restorePromptLayers({ before, adminRequest: garden.adminRequest });

  assert.deepEqual(result.cleanupErrors, []);
  assert.equal(result.cleanup.byteIdentical, true);
  assert.equal(garden.state.get('layer-attention').content, ATTENTION);
  assert.equal(garden.state.get('layer-last-message').enabled, true);
});

test('an unchanged inventory issues no writes', async () => {
  const garden = fakeGarden([{ id: 'layer-attention', content: ATTENTION, enabled: true }]);
  const before = snapshotPromptLayers((await garden.adminRequest('GET', '/api/admin/prompts')).body);
  const result = await restorePromptLayers({ before, adminRequest: garden.adminRequest });
  assert.equal(result.cleanup.byteIdentical, true);
  assert.equal(garden.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('a failed restore write is reported, not hidden', async () => {
  const garden = fakeGarden([{ id: 'layer-attention', content: ATTENTION, enabled: true }]);
  const before = snapshotPromptLayers((await garden.adminRequest('GET', '/api/admin/prompts')).body);
  garden.state.get('layer-attention').content = `${ATTENTION}\n[matrix prompt marker x]`;
  const failingPatch = async (method, path, body) => (
    method === 'PATCH' ? { ok: false, status: 500, body: null } : garden.adminRequest(method, path, body)
  );
  const result = await restorePromptLayers({ before, adminRequest: failingPatch });
  assert.equal(result.cleanup.byteIdentical, false);
  assert.ok(result.cleanupErrors.some((error) => error.includes('could not restore prompt layer layer-attention')));
  assert.ok(result.cleanupErrors.some((error) => error.includes('not byte-identical')));
});

test('the startup sweep removes marker residue from earlier rounds only', async () => {
  const withResidue = `[matrix prompt marker 2026-09-24T22-51-02-294Z]\n\n${ATTENTION}\n[matrix prompt marker 2026-09-25T03-30-06-336Z]\n\n<style/>`;
  const garden = fakeGarden([
    { id: 'layer-attention', content: withResidue, enabled: true },
    { id: 'layer-clean', content: 'untouched [matrix] text', enabled: true },
  ]);
  const swept = await sweepHarnessPromptMarkers({ adminRequest: garden.adminRequest });
  assert.deepEqual(swept, ['layer-attention']);
  assert.equal(garden.state.get('layer-attention').content.includes('matrix prompt marker'), false);
  assert.ok(garden.state.get('layer-attention').content.includes(ATTENTION));
  assert.equal(garden.state.get('layer-clean').content, 'untouched [matrix] text');
});

test('stripHarnessPromptMarkers returns null when there is nothing to remove', () => {
  assert.equal(stripHarnessPromptMarkers(ATTENTION), null);
});
