import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryTierCases } from '../cases/memory-tiers.mjs';

test('memory mutation cases follow the capability tier boundary', async () => {
  const queries = [];
  const cases = buildMemoryTierCases({ runToken: 'tier-fixture' }, {
    pgAll: async (query) => {
      queries.push(query);
      if (query.includes('l2_memory_patch_events')) {
        return [{ memory_id: 'memory-patch', reason: 'shakedown patch' }];
      }
      if (query.includes('l2_memory_delete_versions')) {
        return [{ delete_id: 'delete-1', memory_id: 'memory-delete', restored_at: '2026-07-31' }];
      }
      if (query.includes('matrix-memory-patched-tier-fixture')) {
        return [{ id: 'memory-patch', text: 'matrix-memory-patched-tier-fixture' }];
      }
      return [{ id: 'memory-delete', text: 'autonomous-memory-delete-tier-fixture' }];
    },
  });

  assert.deepEqual(cases.apprentice.map((entry) => entry.id), ['memory_write_patch']);
  assert.deepEqual(cases.autonomous.map((entry) => entry.id), ['memory_delete_restore']);
  assert.doesNotMatch(cases.apprentice[0].message, /action "delete"|action "restore"/u);
  assert.match(cases.autonomous[0].message, /action "delete"/u);
  assert.match(cases.autonomous[0].message, /action "restore"/u);

  const apprenticeChecks = await cases.apprentice[0].after();
  assert.deepEqual(cases.apprentice[0].validateSideEffects({
    sideChecks: apprenticeChecks,
  }), []);
  const autonomousChecks = await cases.autonomous[0].after();
  assert.deepEqual(cases.autonomous[0].validateSideEffects({
    sideChecks: autonomousChecks,
  }), []);

  assert.ok(queries.every((query) => query.includes('tier-fixture')));
  assert.ok(queries.some((query) => query.includes('join l2_memories')));
});
