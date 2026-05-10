import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createWorkerExecutionPolicy, SUBAGENT_WORKER_LANE, WHISPER_WORKER_LANE } from '../worker-lanes.js';
import {
  refreshModelFromConfig,
  requiresFailClosedWorkerModelResolution,
  resolveTurnModelPurpose,
  resolveTurnWorkerExecutionPolicy,
} from './model-runtime.js';

function makeMessage(channelId: string, routing?: { workerExecution?: ReturnType<typeof createWorkerExecutionPolicy> }) {
  return {
    channelId,
    content: '',
    routing,
  } as const;
}

const CHAT_ONLY_CONFIG: SubstrateConfig = {
  primaryModel: 'test-model',
  primaryProvider: 'test',
  extractionModel: 'test-model',
  extractionProvider: 'test',
  discordToken: '',
  discordBotId: '',
  characterCardPath: '',
  dataDir: './data',
  databasePath: ':memory:',
  sessionMessageLimit: 30,
  memoryRetrievalLimit: 15,
  extractionInterval: 5,
  primaryMaxTokens: 16384,
  extractionMaxTokens: 8192,
  maintenanceIntervalMs: 300_000,
  defaultContextWindow: 128_000,
  extractionThresholdPct: 30,
  compactionThresholdPct: 70,
  modelRoster: {
    chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
  },
};

describe('resolveTurnModelPurpose', () => {
  it('routes internal heartbeat and reflection turns through the memory model purpose', () => {
    expect(resolveTurnModelPurpose(makeMessage('internal:heartbeat'))).toBe('memory');
    expect(resolveTurnModelPurpose(makeMessage('internal:heartbeat:daily'))).toBe('memory');
    expect(resolveTurnModelPurpose(makeMessage('internal:reflection:whisper'))).toBe('memory');
  });

  it('keeps ordinary turns on the chat purpose', () => {
    expect(resolveTurnModelPurpose(makeMessage('discord:general'))).toBe('chat');
  });

  it('prefers explicit worker execution policy over channel heuristics', () => {
    const subagentMessage = makeMessage('subagent:task-1', {
      workerExecution: createWorkerExecutionPolicy(SUBAGENT_WORKER_LANE),
    });
    const whisperMessage = makeMessage('internal:reflection:whisper', {
      workerExecution: createWorkerExecutionPolicy(WHISPER_WORKER_LANE),
    });

    expect(resolveTurnWorkerExecutionPolicy(subagentMessage)).toEqual({
      lane: 'subagent',
      profileClass: 'task_focused',
      modelPurpose: 'background',
      failClosed: true,
    });
    expect(resolveTurnModelPurpose(subagentMessage)).toBe('background');
    expect(resolveTurnModelPurpose(whisperMessage)).toBe('memory');
    expect(requiresFailClosedWorkerModelResolution(subagentMessage)).toBe(true);
  });
});

describe('refreshModelFromConfig', () => {
  it('fails closed when an explicit worker model slot is unavailable', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const message = makeMessage('subagent:task-1', {
      workerExecution: createWorkerExecutionPolicy(SUBAGENT_WORKER_LANE),
    });

    expect(() => refreshModelFromConfig({
      reason: 'turn-start',
      config: CHAT_ONLY_CONFIG,
      state: {
        modelResolved: true,
        modelSignature: 'chat::test::test-model',
      },
      message,
      setAgentModel: vi.fn(),
      getCurrentModelId: () => 'test-model',
      logger,
    })).toThrow("No eligible model configured for purpose 'background'");

    expect(logger.warn).toHaveBeenCalledWith(
      'Worker model refresh failed; aborting turn',
      expect.objectContaining({
        workerLane: 'subagent',
        workerProfileClass: 'task_focused',
        purpose: 'background',
      }),
    );
  });
});
