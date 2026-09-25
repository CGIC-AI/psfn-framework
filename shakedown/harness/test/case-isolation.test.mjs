import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROOM_SETTLE_MESSAGE,
  SHARED_HARNESS_ROOM_CHANNEL_ID,
  applyRoomIsolationOutcome,
  createSharedRoomLedger,
  settleSharedRoom,
} from '../lib/case-isolation.mjs';

const ROOM = SHARED_HARNESS_ROOM_CHANNEL_ID;

/** Simulate one chatCase dispatch into the shared room. */
function dispatch(ledger, { answered, throws = false, roomChannelId = ROOM }) {
  ledger.dispatchStarted({ roomChannelId, sessionId: 'case-session' });
  if (throws) throw new Error('turn failed before settlement');
  ledger.dispatchSettled({ roomChannelId, answered });
}

test('a failed final step leaves the shared room pending', () => {
  const ledger = createSharedRoomLedger();
  dispatch(ledger, { answered: true });
  assert.equal(ledger.pending(), null);
  dispatch(ledger, { answered: false });
  assert.deepEqual(ledger.pending(), { sessionId: 'case-session' });
});

test('a dispatch that throws after posting stays pending', () => {
  const ledger = createSharedRoomLedger();
  assert.throws(() => dispatch(ledger, { answered: true, throws: true }));
  assert.notEqual(ledger.pending(), null);
});

test('dispatches to per-principal rooms never touch the shared ledger', () => {
  const ledger = createSharedRoomLedger();
  dispatch(ledger, { answered: false, roomChannelId: 'api:satellite-principal:case-session' });
  assert.equal(ledger.pending(), null);
});

test('a clean room needs no settle turn', async () => {
  const ledger = createSharedRoomLedger();
  let calls = 0;
  const outcome = await settleSharedRoom({
    ledger,
    fromCaseId: 'issue_read_sync',
    runSettleTurn: async () => { calls += 1; },
  });
  assert.equal(outcome, null);
  assert.equal(calls, 0);
});

test('an answered settle turn isolates the next case', async () => {
  const ledger = createSharedRoomLedger();
  dispatch(ledger, { answered: false });
  const sent = [];
  const outcome = await settleSharedRoom({
    ledger,
    fromCaseId: 'issue_read_sync',
    runSettleTurn: async (message) => {
      sent.push(message);
      dispatch(ledger, { answered: true });
    },
  });
  assert.deepEqual(sent, [ROOM_SETTLE_MESSAGE]);
  assert.deepEqual(outcome, { fromCaseId: 'issue_read_sync', settled: true });

  const nextResult = applyRoomIsolationOutcome(
    { caseId: 's10_mindspace_virtual', caseStatus: 'semantic_failure', sideChecks: {} },
    outcome,
  );
  // With the room settled, the next case's own failure stands.
  assert.equal(nextResult.caseStatus, 'semantic_failure');
  assert.deepEqual(nextResult.sideChecks.preCaseRoomSettle, outcome);
});

test('a failed settle marks a failing next case contaminated, not semantic_failure', async () => {
  const ledger = createSharedRoomLedger();
  dispatch(ledger, { answered: false });
  const outcome = await settleSharedRoom({
    ledger,
    fromCaseId: 'issue_read_sync',
    runSettleTurn: async () => {
      dispatch(ledger, { answered: false });
    },
  });
  assert.deepEqual(outcome, { fromCaseId: 'issue_read_sync', settled: false });

  const failing = applyRoomIsolationOutcome(
    { caseId: 's10_mindspace_virtual', caseStatus: 'semantic_failure' },
    outcome,
  );
  assert.equal(failing.caseStatus, 'contaminated');
  assert.equal(failing.contaminatedCaseStatus, 'semantic_failure');
  assert.equal(failing.failureReason, 'contaminated:unanswered_turn_from:issue_read_sync');

  const passing = applyRoomIsolationOutcome({ caseId: 'next', caseStatus: 'ok' }, outcome);
  assert.equal(passing.caseStatus, 'ok');
});

test('a settle turn that throws is recorded and treated as unsettled', async () => {
  const ledger = createSharedRoomLedger();
  dispatch(ledger, { answered: false });
  const outcome = await settleSharedRoom({
    ledger,
    fromCaseId: 'issue_read_sync',
    runSettleTurn: async () => { throw new Error('gateway unavailable'); },
  });
  assert.equal(outcome.settled, false);
  assert.equal(outcome.error, 'Error: gateway unavailable');
});
