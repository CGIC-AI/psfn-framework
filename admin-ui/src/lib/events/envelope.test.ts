import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesGardenEventFilter,
  normalizeGardenEventCorrelation,
  normalizeGardenEventEnvelope,
} from './envelope';

test('normalizeGardenEventEnvelope accepts valid admin websocket payloads', () => {
  assert.deepEqual(
    normalizeGardenEventEnvelope({
      type: 'agent.turn.stage',
      timestamp: 1234,
      correlation: {
        turnId: ' turn-1 ',
        channelId: ' api:session ',
        purpose: ' agent.turn.stage.prompt ',
      },
      data: { stage: 'prompt' },
    }),
    {
      type: 'agent.turn.stage',
      timestamp: 1234,
      correlation: {
        turnId: 'turn-1',
        channelId: 'api:session',
        purpose: 'agent.turn.stage.prompt',
      },
      data: { stage: 'prompt' },
    },
  );
});

test('normalizeGardenEventEnvelope fails closed on malformed payloads', () => {
  assert.equal(normalizeGardenEventEnvelope(null), null);
  assert.equal(normalizeGardenEventEnvelope({ type: '', timestamp: 1, data: {} }), null);
  assert.equal(normalizeGardenEventEnvelope({ type: 'agent.turn.stage', timestamp: 'later', data: {} }), null);
});

test('normalizeGardenEventCorrelation drops unknown or invalid fields', () => {
  assert.deepEqual(
    normalizeGardenEventCorrelation({
      turnId: 'turn-2',
      channelId: 'api:test',
      purpose: 42,
      nested: { nope: true },
    }),
    {
      turnId: 'turn-2',
      channelId: 'api:test',
    },
  );
});

test('matchesGardenEventFilter checks type, channel, turn, and predicate filters', () => {
  const event = {
    type: 'agent.turn.snapshot',
    timestamp: 99,
    correlation: {
      channelId: 'api:prompt-monitor',
      turnId: 'turn-9',
    },
    data: {
      snapshot: {
        turnId: 'turn-9',
      },
    },
  };

  assert.equal(matchesGardenEventFilter(event, { types: ['agent.turn.snapshot'] }), true);
  assert.equal(matchesGardenEventFilter(event, { types: ['agent.turn.stage'] }), false);
  assert.equal(matchesGardenEventFilter(event, { channelId: 'api:prompt-monitor' }), true);
  assert.equal(matchesGardenEventFilter(event, { channelId: 'discord:other' }), false);
  assert.equal(matchesGardenEventFilter(event, { turnId: 'turn-9' }), true);
  assert.equal(matchesGardenEventFilter(event, { turnId: 'turn-miss' }), false);
  assert.equal(matchesGardenEventFilter(event, { predicate: (candidate) => candidate.timestamp === 99 }), true);
});
