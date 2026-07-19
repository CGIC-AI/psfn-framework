import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PromptMonitorTurn } from '../../events/prompt-monitor';
import {
  buildPromptMonitorTimingSummary,
  resolvePromptMonitorRetrievals,
} from './PromptMonitorTimingPanel.helpers';

function buildTurn(): PromptMonitorTurn {
  return {
    turnId: 'turn-1',
    channelId: 'channel-1',
    latestEventAt: 1_400,
    record: null,
    snapshot: null,
    promptLoom: null,
    retrievals: [],
    stages: [
      { observedAt: 1_100, turnId: 'turn-1', channelId: 'channel-1', stage: 'trust', elapsedMs: 100, data: { durationMs: 80 } },
      { observedAt: 1_200, turnId: 'turn-1', channelId: 'channel-1', stage: 'memory', elapsedMs: 300, data: { durationMs: 150, memoryChars: 42 } },
      { observedAt: 1_250, turnId: 'turn-1', channelId: 'channel-1', stage: 'context', elapsedMs: 400, data: {} },
      { observedAt: 1_300, turnId: 'turn-1', channelId: 'channel-1', stage: 'first-token', elapsedMs: 700, data: { ttftMs: 300 } },
      { observedAt: 1_350, turnId: 'turn-1', channelId: 'channel-1', stage: 'prompt', elapsedMs: 1_100, data: { durationMs: 700, ttftMs: 300 } },
      { observedAt: 1_400, turnId: 'turn-1', channelId: 'channel-1', stage: 'end', elapsedMs: 1_200, data: {} },
    ],
  };
}

test('timing summary prefers subsystem durationMs and falls back to adjacent elapsed deltas', () => {
  const summary = buildPromptMonitorTimingSummary(buildTurn());

  assert.deepEqual(
    summary.subsystems.map(stage => [stage.stage, stage.durationMs, stage.durationSource]),
    [
      ['trust', 80, 'recorded'],
      ['memory', 150, 'recorded'],
      ['context', 100, 'elapsed_delta'],
      ['prompt', 700, 'recorded'],
    ],
  );
  assert.equal(summary.ttftMs, 300);
  assert.equal(summary.subsystemTotalMs, 1_030);
  assert.equal(summary.totalElapsedMs, 1_200);
  assert.equal(summary.unattributedMs, 170);
  assert.equal(summary.overlapMs, 0);
});

test('timing retrievals prefer the live turn field while retaining a persisted-record fallback', () => {
  const turn = buildTurn();
  turn.retrievals = [{
    observedAt: 1_210,
    turnId: 'turn-1',
    channelId: 'channel-1',
    count: 3,
    retrievalSource: 'embedding',
    data: { query: 'redacted' },
  }];

  assert.equal(resolvePromptMonitorRetrievals(turn).length, 1);
  assert.equal(resolvePromptMonitorRetrievals(turn)[0]?.count, 3);
});
