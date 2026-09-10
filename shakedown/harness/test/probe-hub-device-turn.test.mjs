import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findCaseTurnRecord, waitForMatchingTurnRecord } from '../lib/probe.mjs';

test('exact-message proof can resolve an opaque Hub-device TurnRecord channel', () => {
  const root = mkdtempSync(join(tmpdir(), 'psfn-hub-turn-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'hub-device%3Aopaque.jsonl'), `${JSON.stringify({
    turnId: 'hub-turn',
    startedAt: 200,
    status: 'completed',
    userMessage: { content: 'exact shakedown witness' },
  })}\n`);
  writeFileSync(join(root, 'api%3Aother.jsonl'), `${JSON.stringify({
    turnId: 'other-turn',
    startedAt: 100,
    status: 'completed',
    userMessage: { content: 'another witness' },
  })}\n`);

  assert.deepEqual(findCaseTurnRecord(root, {
    sessionId: 'satellite-session',
    apiUserId: 'api-key-fixture',
    message: 'exact shakedown witness',
    minStartedAtMs: 150,
    searchAllChannels: true,
  }), {
    turnId: 'hub-turn',
    startedAt: 200,
    status: 'completed',
    userMessage: { content: 'exact shakedown witness' },
  });
});

test('the live wait path forwards search-all to the matcher (ajgo2: device turns land in hub-device channels)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'psfn-hub-turn-wait-'));
  writeFileSync(join(root, 'hub-device%3Aopaque.jsonl'), `${JSON.stringify({
    turnId: 'hub-turn',
    startedAt: 200,
    status: 'completed',
    userMessage: { content: 'exact device witness' },
    assistantMessage: { content: 'acknowledged' },
  })}\n`);
  const found = await waitForMatchingTurnRecord(root, 'satellite-session', 'exact device witness', 150, 50, 'api-key-fixture', 10, undefined, true);
  assert.equal(found?.turnId, 'hub-turn');
  const missed = await waitForMatchingTurnRecord(root, 'satellite-session', 'exact device witness', 150, 50, 'api-key-fixture', 10, undefined, false);
  assert.equal(missed, null);
});
