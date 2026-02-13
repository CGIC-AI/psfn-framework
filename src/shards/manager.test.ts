import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../event-bus.js';
import { SessionStore } from '../session/store.js';
import { ShardManager } from './manager.js';
import { createSpawnShardTool } from './tools.js';
import type { LLMProvider, MemoryProvider } from '../agent-loop.js';
import type { SubstrateConfig, LLMResponse } from '../types.js';

// ── Mock LLM that returns a canned response ──

function mockLLM(content = 'shard response'): LLMProvider {
  return {
    stream: vi.fn(async () => ({
      content,
      toolCalls: [],
      model: 'mock-model',
      inputTokens: 10,
      outputTokens: 20,
      stopReason: 'stop',
    } satisfies LLMResponse)),
    complete: vi.fn(async () => ({
      content,
      toolCalls: [],
      model: 'mock-model',
      inputTokens: 10,
      outputTokens: 20,
      stopReason: 'stop',
    } satisfies LLMResponse)),
  };
}

function mockMemoryProvider(): MemoryProvider {
  return { retrieve: vi.fn(async () => '') };
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
};

describe('ShardManager', () => {
  let dir: string;
  let sessionStore: SessionStore;
  let eventBus: EventBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-shard-'));
    sessionStore = new SessionStore(dir);
    eventBus = new EventBus();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('spawns a shard and returns result', async () => {
    const llm = mockLLM('Hello from shard');
    const manager = new ShardManager({
      eventBus,
      llmProvider: llm,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const result = await manager.spawn({ name: 'test', task: 'Do something' });

    expect(result.name).toBe('test');
    expect(result.content).toBe('Hello from shard');
    expect(result.model).toBe('mock-model');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
    expect(result.turns).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.shardId).toMatch(/^shard-/);
  });

  it('uses isolated channelId for session entries', async () => {
    const llm = mockLLM('isolated response');
    const manager = new ShardManager({
      eventBus,
      llmProvider: llm,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'system prompt',
    });

    const result = await manager.spawn({ name: 'iso', task: 'Check isolation' });

    // Shard should have written to shard:<id> channelId
    const channelId = `shard:${result.shardId}`;
    const entries = sessionStore.getRecent(channelId, 10);
    expect(entries.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(entries[0].role).toBe('user');
    expect(entries[0].content).toBe('Check isolation');
    expect(entries[1].role).toBe('assistant');
    expect(entries[1].content).toBe('isolated response');

    // Parent channel should have no entries
    const parentEntries = sessionStore.getRecent('main-channel', 10);
    expect(parentEntries).toHaveLength(0);
  });

  it('inherits parent system prompt when none specified', async () => {
    const llm = mockLLM();
    const manager = new ShardManager({
      eventBus,
      llmProvider: llm,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'I am PSFN.',
    });

    await manager.spawn({ name: 'inherit', task: 'test' });

    // Check the LLM was called with parent system prompt
    const streamCall = (llm.stream as ReturnType<typeof vi.fn>).mock.calls[0];
    const context = streamCall[0];
    expect(context.systemPrompt).toContain('I am PSFN.');
  });

  it('uses custom system prompt when provided', async () => {
    const llm = mockLLM();
    const manager = new ShardManager({
      eventBus,
      llmProvider: llm,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'I am PSFN.',
    });

    await manager.spawn({
      name: 'custom',
      task: 'test',
      systemPrompt: 'You are a research shard.',
    });

    const streamCall = (llm.stream as ReturnType<typeof vi.fn>).mock.calls[0];
    const context = streamCall[0];
    expect(context.systemPrompt).toContain('You are a research shard.');
    expect(context.systemPrompt).not.toContain('I am PSFN.');
  });

  it('runs concurrent shards in parallel', async () => {
    let concurrentPeak = 0;
    let currentActive = 0;

    const slowLLM: LLMProvider = {
      stream: vi.fn(async () => {
        currentActive++;
        concurrentPeak = Math.max(concurrentPeak, currentActive);
        await new Promise(r => setTimeout(r, 50));
        currentActive--;
        return {
          content: 'done',
          toolCalls: [],
          model: 'mock',
          inputTokens: 5,
          outputTokens: 5,
          stopReason: 'stop',
        };
      }),
      complete: vi.fn(),
    };

    const manager = new ShardManager({
      eventBus,
      llmProvider: slowLLM,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const results = await Promise.all([
      manager.spawn({ name: 'a', task: 'task a' }),
      manager.spawn({ name: 'b', task: 'task b' }),
      manager.spawn({ name: 'c', task: 'task c' }),
    ]);

    expect(results).toHaveLength(3);
    expect(concurrentPeak).toBeGreaterThanOrEqual(2); // At least some parallelism
  });

  it('enforces max concurrency limit', async () => {
    const slowLLM: LLMProvider = {
      stream: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 100));
        return {
          content: 'done',
          toolCalls: [],
          model: 'mock',
          inputTokens: 5,
          outputTokens: 5,
          stopReason: 'stop',
        };
      }),
      complete: vi.fn(),
    };

    const manager = new ShardManager({
      eventBus,
      llmProvider: slowLLM,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
      maxConcurrent: 2,
    });

    // Start 2 shards (at limit)
    const p1 = manager.spawn({ name: 'a', task: 'task a' });
    const p2 = manager.spawn({ name: 'b', task: 'task b' });

    // Third should fail immediately
    await expect(
      manager.spawn({ name: 'c', task: 'task c' }),
    ).rejects.toThrow('Shard limit reached');

    // Wait for the first two to complete
    await Promise.all([p1, p2]);

    // Now should work again
    const result = await manager.spawn({ name: 'd', task: 'task d' });
    expect(result.name).toBe('d');
  });

  it('includes usage stats in result', async () => {
    const llm = mockLLM('stats test');
    const manager = new ShardManager({
      eventBus,
      llmProvider: llm,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const result = await manager.spawn({ name: 'stats', task: 'test' });

    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
    expect(result.model).toBe('mock-model');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('wires memory provider for read access', async () => {
    const memory = mockMemoryProvider();
    const llm = mockLLM();
    const manager = new ShardManager({
      eventBus,
      llmProvider: llm,
      sessionStore,
      embeddingService: null,
      memoryProvider: memory,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    await manager.spawn({ name: 'mem', task: 'test memory' });

    // Memory retrieval should have been called for the shard's channel
    expect(memory.retrieve).toHaveBeenCalled();
  });

  it('decrements active count even on failure', async () => {
    const failLLM: LLMProvider = {
      stream: vi.fn(async () => { throw new Error('LLM failed'); }),
      complete: vi.fn(),
    };

    const manager = new ShardManager({
      eventBus,
      llmProvider: failLLM,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    await expect(
      manager.spawn({ name: 'fail', task: 'test' }),
    ).rejects.toThrow('LLM failed');

    // Active count should be back to 0
    expect(manager.getActiveCount()).toBe(0);
  });
});

describe('createSpawnShardTool', () => {
  let dir: string;
  let sessionStore: SessionStore;
  let eventBus: EventBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-shard-tool-'));
    sessionStore = new SessionStore(dir);
    eventBus = new EventBus();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a valid SubstrateTool', () => {
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const tool = createSpawnShardTool(manager);

    expect(tool.name).toBe('spawn_shard');
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('formats result content with stats', async () => {
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM('tool output'),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const tool = createSpawnShardTool(manager);
    const result = await tool.execute({ name: 'test-tool', task: 'do something' });

    expect(result.content).toContain('Shard "test-tool" completed');
    expect(result.content).toContain('1 turn(s)');
    expect(result.content).toContain('30 tokens');
    expect(result.content).toContain('tool output');
  });

  it('returns error content on failure', async () => {
    const failLLM: LLMProvider = {
      stream: vi.fn(async () => { throw new Error('boom'); }),
      complete: vi.fn(),
    };

    const manager = new ShardManager({
      eventBus,
      llmProvider: failLLM,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const tool = createSpawnShardTool(manager);
    const result = await tool.execute({ name: 'fail', task: 'test' });

    expect(result.content).toContain('Shard error');
    expect(result.isError).toBe(true);
  });
});
