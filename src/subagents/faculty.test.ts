import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mariozechner/pi-agent-core';
import { EventBus } from '../event-bus.js';
import { SessionStore } from '../session/store.js';
import type { LLMProvider } from '../agent/contracts.js';
import type { LLMResponse, SubstrateConfig } from '../types.js';
import { SubagentFaculty } from './faculty.js';

let mockSubagentContent = 'subagent response';
let mockSubagentError: Error | null = null;

const promptSpy = vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
  if (mockSubagentError) throw mockSubagentError;
  this.appendMessage({
    role: 'assistant',
    content: [{ type: 'text' as const, text: mockSubagentContent }],
    api: '' as any,
    provider: '' as any,
    model: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as any,
    timestamp: Date.now(),
  });
});

function mockLLM(): LLMProvider {
  const response: LLMResponse = {
    content: 'unused',
    toolCalls: [],
    model: 'mock-model',
    inputTokens: 10,
    outputTokens: 20,
    stopReason: 'stop',
  };
  return {
    stream: vi.fn(async () => response),
    complete: vi.fn(async () => response),
  };
}

const TEST_CONFIG: SubstrateConfig = {
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

describe('SubagentFaculty', () => {
  let root: string;
  let eventBus: EventBus;
  let sessionStore: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'psfn-subagent-'));
    eventBus = new EventBus();
    sessionStore = new SessionStore(root);
    mockSubagentContent = 'subagent response';
    mockSubagentError = null;
    promptSpy.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('executes bounded subagent tasks with an independent registry and lifecycle', async () => {
    mockSubagentContent = 'task completed';
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const result = await faculty.execute({
      name: 'inspect',
      task: 'inspect runtime state',
    });

    expect(result.subagentId).toMatch(/^subagent-/);
    expect(result.workerLane).toBe('subagent');
    expect(result.lifecycleState).toBe('completed');
    expect(result.content).toBe('task completed');
    expect(faculty.getActiveCount()).toBe(0);
    expect(faculty.getRecentTasks(1)).toEqual([
      expect.objectContaining({
        subagentId: result.subagentId,
        lifecycleState: 'completed',
        channelId: `subagent:${result.subagentId}`,
        workerLane: 'subagent',
      }),
    ]);

    const entries = sessionStore.getRecent(`subagent:${result.subagentId}`, 10);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.content).toBe('inspect runtime state');
    expect(entries[1]?.content).toBe('task completed');
  });

  it('delegates Wyoming sessions through subagent lifecycle without shard ids', async () => {
    mockSubagentContent = 'wyoming delegated response';
    const auditTrail = {
      append: vi.fn(),
    };
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
      auditTrail,
    });

    const result = await faculty.delegateWyomingSession({
      message: {
        id: 'wyoming-msg-1',
        channelId: 'api:wyoming:ha-main:voice-pe-kitchen',
        channelType: 'api',
        authorId: 'wyoming-user:owner',
        authorName: 'Wyoming Voice User',
        content: 'status check',
        isDirectMessage: true,
        timestamp: new Date('2026-02-26T12:00:00.000Z'),
      },
      routing: {
        connectionId: 'conn-kitchen',
        sessionId: 'session-kitchen',
        turnId: 'wyoming-turn-1',
        siteId: 'ha-main',
        satelliteId: 'voice-pe-kitchen',
      },
    });

    expect(result.subagentId).toMatch(/^subagent-/);
    const recentTask = faculty.getRecentTasks(1)[0];
    expect(recentTask).toMatchObject({
      subagentId: result.subagentId,
      channelId: 'api:wyoming:ha-main:voice-pe-kitchen',
      lifecycleState: 'completed',
      workerLane: 'subagent',
      capabilities: ['wyoming', 'wyoming:ha-main', 'wyoming:ha-main:voice-pe-kitchen'],
    });

    const delegatedEntries = sessionStore.getRecent('api:wyoming:ha-main:voice-pe-kitchen', 10);
    expect(delegatedEntries).toHaveLength(2);
    expect(delegatedEntries[0]?.content).toBe('status check');
    expect(delegatedEntries[1]?.content).toBe('wyoming delegated response');
    expect(auditTrail.append).toHaveBeenCalledWith(
      'wyoming.subagent.delegate.start',
      expect.objectContaining({
        connectionId: 'conn-kitchen',
        sessionId: 'session-kitchen',
        turnId: 'wyoming-turn-1',
      }),
    );
    expect(auditTrail.append).toHaveBeenCalledWith(
      'wyoming.subagent.delegate.end',
      expect.objectContaining({
        subagentId: result.subagentId,
        status: 'completed',
        connectionId: 'conn-kitchen',
        sessionId: 'session-kitchen',
      }),
    );
  });
});
