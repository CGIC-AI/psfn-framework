import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryTierCases } from '../cases/memory-tiers.mjs';

test('memory mutation cases follow the capability tier boundary', async () => {
  const queries = [];
  const cases = buildMemoryTierCases({ runToken: 'tier-fixture' }, {
    adminBase: 'https://garden.example.test',
    approveOperatorConfirmation: async () => ({ ok: true, body: { status: 'approved' } }),
    chatCase: async () => ({ response: { ok: true } }),
    fetchJson: async () => ({ ok: true, body: {} }),
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
      return [{ id: 'memory-delete', text: 'autonomous-memory-delete-tier-fixture', deleted_at: null }];
    },
  });

  assert.deepEqual(cases.apprentice.map((entry) => entry.id), ['memory_write_patch']);
  assert.deepEqual(cases.autonomous.map((entry) => entry.id), ['memory_delete_restore']);
  assert.doesNotMatch(cases.apprentice[0].message, /action "delete"|action "restore"/u);
  assert.equal(typeof cases.autonomous[0].execute, 'function');

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

test('memory delete/restore rejects a row that remains soft-deleted', () => {
  const cases = buildMemoryTierCases({ runToken: 'active-restore-fixture' }, {
    adminBase: 'https://garden.example.test',
    approveOperatorConfirmation: async () => ({ ok: true, body: { status: 'approved' } }),
    chatCase: async () => ({ response: { ok: true } }),
    fetchJson: async () => ({ ok: true, body: {} }),
    pgAll: async () => [],
  });

  assert.deepEqual(cases.autonomous[0].validateSideEffects({
    sideChecks: {
      memoryRows: [{
        id: 'memory-delete',
        text: 'autonomous-memory-delete-active-restore-fixture',
        deleted_at: '2026-08-14T19:06:00.000Z',
      }],
      deleteRows: [{
        delete_id: 'delete-1',
        memory_id: 'memory-delete',
        restored_at: '2026-08-14T19:07:00.000Z',
      }],
    },
  }), ['memory_delete_restore must leave its restored memory active']);
});

test('memory delete/restore correlates the active row with its restore journal', () => {
  const cases = buildMemoryTierCases({ runToken: 'correlated-restore-fixture' }, {
    adminBase: 'https://garden.example.test',
    approveOperatorConfirmation: async () => ({ ok: true, body: { status: 'approved' } }),
    chatCase: async () => ({ response: { ok: true } }),
    fetchJson: async () => ({ ok: true, body: {} }),
    pgAll: async () => [],
  });

  assert.deepEqual(cases.autonomous[0].validateSideEffects({
    sideChecks: {
      memoryRows: [
        { id: 'memory-restored', deleted_at: '2026-08-14T19:06:00.000Z' },
        { id: 'unrelated-active-memory', deleted_at: null },
      ],
      deleteRows: [{
        delete_id: 'delete-1',
        memory_id: 'memory-restored',
        restored_at: '2026-08-14T19:07:00.000Z',
      }],
    },
  }), ['memory_delete_restore must correlate its restored journal with an active memory row']);
});

test('memory delete/restore uses the live proposal, Operator approval, and restore workflow', async () => {
  const chatInputs = [];
  const fetchInputs = [];
  const approvalInputs = [];
  const finalOutcome = { response: { ok: true, status: 200 }, turnRecord: { status: 'completed' } };
  const cases = buildMemoryTierCases({ runToken: 'proposal-fixture' }, {
    adminBase: 'https://garden.example.test',
    approveOperatorConfirmation: async (id, signal) => {
      approvalInputs.push({ id, signal });
      return { ok: true, status: 200, body: { status: 'approved' } };
    },
    chatCase: async (input) => {
      chatInputs.push(input);
      return chatInputs.length === 1 ? { response: { ok: true, status: 200 } } : finalOutcome;
    },
    fetchJson: async (url, init = {}) => {
      fetchInputs.push({ url, init });
      return {
        ok: true,
        status: 200,
        body: {
          entries: [{
            id: 'approval-1',
            method: 'memory.deletion.validate',
            params: { proposalId: 'proposal-1' },
          }],
        },
      };
    },
    pgAll: async (query) => {
      if (query.includes('join l2_memories')) {
        return [{ id: 'proposal-1', memory_id: 'memory-1', status: 'pending_operator_validation' }];
      }
      if (query.includes("where id = 'proposal-1'")) {
        return [{ id: 'proposal-1', memory_id: 'memory-1', delete_id: 'delete-1', status: 'approved' }];
      }
      return [];
    },
  });

  const outcome = await cases.autonomous[0].execute({
    sessionId: 'memory-proposal-session',
    apiUserId: 'testing-harness',
    signal: new AbortController().signal,
  });

  assert.equal(outcome, finalOutcome);
  assert.match(chatInputs[0].message, /justification_category "factually_incorrect"/u);
  assert.match(chatInputs[1].message, /action "restore" and delete_id "delete-1"/u);
  assert.deepEqual(chatInputs.map((input) => input.apiUserId), [
    'testing-harness',
    'testing-harness',
  ]);
  assert.equal(fetchInputs[0].url, 'https://garden.example.test/api/admin/confirmations');
  assert.equal(approvalInputs[0].id, 'approval-1');
});
