import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminSessionTurnData } from '../types';
import {
  buildPromptMonitorTurns,
  formatPromptMonitorStageLabel,
  mergePromptMonitorEvent,
  resolvePromptMonitorMetrics,
  resolvePromptMonitorSummary,
} from './prompt-monitor';

function buildTurn(seed: {
  turnId: string;
  channelId: string;
  promptVersionPointer: string;
  completedAt: number;
  ttftMs: number;
  promptDurationMs: number;
}): AdminSessionTurnData {
  return {
    record: {
      turnId: seed.turnId,
      requestId: seed.turnId,
      channelId: seed.channelId,
      channelType: 'api',
      startedAt: seed.completedAt - 50,
      completedAt: seed.completedAt,
      status: 'completed',
      userMessage: {
        role: 'user',
        content: 'hello',
        timestamp: String(seed.completedAt - 50),
      },
      assistantMessage: {
        role: 'assistant',
        content: 'world',
        timestamp: String(seed.completedAt),
      },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: {
        promptStack: seed.promptVersionPointer,
        promptMode: 'default',
      },
      provenanceRefs: [],
    },
    stages: [
      {
        observedAt: seed.completedAt - 40,
        turnId: seed.turnId,
        requestId: seed.turnId,
        channelId: seed.channelId,
        callType: 'chat',
        purpose: 'agent.turn.stage.first-token',
        stage: 'first-token',
        elapsedMs: seed.ttftMs,
        data: {
          ttftMs: seed.ttftMs,
          source: 'stream',
        },
      },
      {
        observedAt: seed.completedAt - 10,
        turnId: seed.turnId,
        requestId: seed.turnId,
        channelId: seed.channelId,
        callType: 'chat',
        purpose: 'agent.turn.stage.prompt',
        stage: 'prompt',
        elapsedMs: seed.promptDurationMs,
        data: {
          ttftMs: seed.ttftMs,
          promptMode: 'default',
        },
      },
      {
        observedAt: seed.completedAt,
        turnId: seed.turnId,
        requestId: seed.turnId,
        channelId: seed.channelId,
        callType: 'chat',
        purpose: 'agent.turn.stage.end',
        stage: 'end',
        elapsedMs: seed.promptDurationMs + 12,
        data: {},
      },
    ],
    retrievals: [],
    snapshot: {
      turnId: seed.turnId,
      requestId: seed.turnId,
      channelId: seed.channelId,
      capturedAt: seed.completedAt - 45,
      trustLevel: 'regular',
      prompt: {
        staticPrefixTemplate: 'Static prefix',
        dynamicSuffixTemplate: 'Dynamic suffix',
        staticHash: `${seed.promptVersionPointer}-hash`,
        versionPointer: seed.promptVersionPointer,
      },
    },
  };
}

test('buildPromptMonitorTurns preserves newest-first order and summary metrics', () => {
  const turns = buildPromptMonitorTurns([
    buildTurn({
      turnId: 'turn-1',
      channelId: 'api:monitor',
      promptVersionPointer: 'prompt-v1',
      completedAt: 1_000,
      ttftMs: 20,
      promptDurationMs: 120,
    }),
    buildTurn({
      turnId: 'turn-2',
      channelId: 'api:monitor',
      promptVersionPointer: 'prompt-v2',
      completedAt: 2_000,
      ttftMs: 40,
      promptDurationMs: 160,
    }),
  ]);

  assert.equal(turns[0]?.turnId, 'turn-2');
  assert.equal(turns[1]?.turnId, 'turn-1');

  const metrics = resolvePromptMonitorMetrics(turns[0]!);
  assert.equal(metrics.promptDurationMs, 160);
  assert.equal(metrics.ttftMs, 40);
  assert.equal(metrics.promptVersionPointer, 'prompt-v2');
  assert.equal(metrics.firstTokenSource, 'stream');
  assert.equal(metrics.isComplete, true);

  assert.deepEqual(resolvePromptMonitorSummary(turns), {
    turnCount: 2,
    liveTurnCount: 0,
    averagePromptDurationMs: 140,
    averageTtftMs: 30,
    latestPromptVersionPointer: 'prompt-v2',
    latestStaticHash: 'prompt-v2-hash',
  });
});

test('mergePromptMonitorEvent overlays live snapshots and stages onto the selected turn', () => {
  const seeded = buildPromptMonitorTurns([
    buildTurn({
      turnId: 'turn-3',
      channelId: 'api:monitor',
      promptVersionPointer: 'prompt-v3',
      completedAt: 3_000,
      ttftMs: 25,
      promptDurationMs: 110,
    }),
  ]);

  const mergedSnapshot = mergePromptMonitorEvent(seeded, {
    type: 'agent.turn.snapshot',
    timestamp: 3_100,
    correlation: {
      channelId: 'api:monitor',
      turnId: 'turn-live',
    },
    data: {
      snapshot: {
        turnId: 'turn-live',
        requestId: 'turn-live',
        channelId: 'api:monitor',
        capturedAt: 3_050,
        trustLevel: 'regular',
        prompt: {
          staticPrefixTemplate: 'Live static',
          dynamicSuffixTemplate: 'Live dynamic',
          staticHash: 'live-hash',
          versionPointer: 'prompt-live',
        },
      },
    },
  });

  const mergedStages = mergePromptMonitorEvent(mergedSnapshot, {
    type: 'agent.turn.stage',
    timestamp: 3_200,
    correlation: {
      channelId: 'api:monitor',
      turnId: 'turn-live',
    },
    data: {
      observedAt: 3_200,
      turnId: 'turn-live',
      requestId: 'turn-live',
      channelId: 'api:monitor',
      callType: 'chat',
      purpose: 'agent.turn.stage.prompt',
      stage: 'prompt',
      elapsedMs: 95,
      data: {
        ttftMs: 18,
        mode: 'default',
      },
    },
  });

  assert.equal(mergedStages[0]?.turnId, 'turn-live');
  const metrics = resolvePromptMonitorMetrics(mergedStages[0]!);
  assert.equal(metrics.promptDurationMs, 95);
  assert.equal(metrics.ttftMs, 18);
  assert.equal(metrics.promptVersionPointer, 'prompt-live');
  assert.equal(metrics.isComplete, false);
});

test('mergePromptMonitorEvent ignores unrelated payloads and labels stages clearly', () => {
  const seeded = buildPromptMonitorTurns([]);
  const untouched = mergePromptMonitorEvent(seeded, {
    type: 'message.sent',
    timestamp: 1,
    correlation: {},
    data: {},
  });

  assert.deepEqual(untouched, []);
  assert.equal(formatPromptMonitorStageLabel('first-token'), 'First Token');
  assert.equal(formatPromptMonitorStageLabel('memory'), 'Memory');
});
