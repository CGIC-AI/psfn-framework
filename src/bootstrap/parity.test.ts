import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { HeartbeatPolicyStore } from '../scheduler/heartbeat-policy.js';
import type { LLMProvider } from '../agent/contracts.js';
import { wireHeartbeatRuntime } from './parity.js';

describe('wireHeartbeatRuntime', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-runtime-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes versioned values entries when values-reflection task runs', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'Values reflection body' }),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
      );

      const task = scheduler.getTask('reflection:values-reflection');
      expect(task).toBeDefined();
      expect(task?.intervalMs).toBe(24 * 60 * 60_000);

      nowSpy.mockReturnValue(1_700_000_000_000 + task!.intervalMs + 1);
      await scheduler.tick();

      const raw = readFileSync(join(tempDir, 'notes', 'values.jsonl'), 'utf-8').trim();
      const lines = raw.split('\n');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0] ?? '{}') as {
        version: number;
        templateId: string;
        templateName: string;
        reflection: string;
      };
      expect(entry.version).toBe(1);
      expect(entry.templateId).toBe('values-reflection');
      expect(entry.templateName).toBe('Values Reflection');
      expect(entry.reflection).toContain('Values reflection body');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('runs deliberation mode and persists journal/memory metadata', async () => {
    const store = new HeartbeatPolicyStore(join(tempDir, 'heartbeat-policy.json'));
    const policy = store.load();
    const values = policy.templates.find(template => template.id === 'values-reflection');
    if (!values) {
      throw new Error('values-reflection template missing');
    }
    values.mode = 'deliberation';
    values.deliberation = {
      maxRounds: 1,
      maxTotalTokens: 4000,
      maxWallTimeMs: 30_000,
      voices: ['reasoning', 'background'],
    };
    store.save(policy);

    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'fallback response' }),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    const purposes: string[] = [];
    const llmProvider: LLMProvider = {
      stream: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'mock-stream',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      })),
      complete: vi.fn(async (_context, purpose) => {
        purposes.push(purpose);
        const responses = {
          reasoning: {
            content: purposes.length === 3
              ? 'A single synthesized values reflection.'
              : 'Reasoning voice: continuity and trust matter.',
            inputTokens: 30,
            outputTokens: 40,
          },
          background: {
            content: 'Background voice: steadiness and care matter.',
            inputTokens: 20,
            outputTokens: 30,
          },
          extraction: {
            content: '',
            inputTokens: 0,
            outputTokens: 0,
          },
          summary: {
            content: '',
            inputTokens: 0,
            outputTokens: 0,
          },
        } as const;
        const selected = responses[purpose];
        return {
          content: selected.content,
          toolCalls: [],
          model: `mock-${purpose}`,
          inputTokens: selected.inputTokens,
          outputTokens: selected.outputTokens,
          stopReason: 'stop',
        };
      }),
    };
    const memoryWriter = {
      write: vi.fn().mockResolvedValue({
        action: 'created',
        memory: { id: 'mem-1' },
      }),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          llmProvider,
          memoryWriter,
        },
      );

      const task = scheduler.getTask('reflection:values-reflection');
      expect(task).toBeDefined();

      nowSpy.mockReturnValue(1_700_000_000_000 + task!.intervalMs + 1);
      await scheduler.tick();

      const handledChannels = (agentLoop.handleMessage as ReturnType<typeof vi.fn>).mock.calls
        .map(call => call[0]?.channelId);
      expect(handledChannels).not.toContain('internal:reflection:values-reflection');
      expect(purposes).toEqual(['reasoning', 'background', 'reasoning']);
      expect(memoryWriter.write).toHaveBeenCalledTimes(1);

      const raw = readFileSync(join(tempDir, 'notes', 'values.jsonl'), 'utf-8').trim();
      const entry = JSON.parse(raw) as {
        reflection: string;
        deliberation?: {
          rounds: number;
          totalTokens: number;
          estimatedCostUsd: number;
        };
      };
      expect(entry.reflection).toContain('synthesized values reflection');
      expect(entry.deliberation?.rounds).toBe(1);
      expect(entry.deliberation?.totalTokens).toBe(190);
      expect(entry.deliberation?.estimatedCostUsd).toBeGreaterThan(0);

      const reflectionRaw = readFileSync(join(tempDir, 'notes', 'reflections', 'journal.jsonl'), 'utf-8').trim();
      const reflectionLines = reflectionRaw.split('\n').filter(line => line.trim().length > 0);
      expect(reflectionLines.length).toBeGreaterThan(0);
      const reflectionEntry = JSON.parse(reflectionLines[reflectionLines.length - 1] ?? '{}') as {
        mode: string;
        templateId: string;
      };
      expect(reflectionEntry.templateId).toBe('values-reflection');
      expect(reflectionEntry.mode).toBe('deliberation');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('defers manual template runs when the agent is busy and executes them after idle', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const agentLoop = {
      handleMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Agent is already processing another prompt'))
        .mockResolvedValue({ content: 'Deferred reflection output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
      );

      const registeredTools = target.registerTool.mock.calls.map(call => call[0]);
      const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool?.name === 'heartbeat_run_template');
      expect(runTemplateTool).toBeDefined();

      const runResult = await runTemplateTool.execute(
        'manual-1',
        { templateId: 'whisper' },
        new AbortController().signal,
      );
      const runText = runResult.content.map((part: { text: string }) => part.text).join('');
      expect(runText).toContain('Queued reflection template');

      const deferredTask = scheduler.listTasks().find(task => task.id.startsWith('reflection:deferred:'));
      expect(deferredTask).toBeDefined();

      nowSpy.mockReturnValue((deferredTask?.runAt ?? 0) + 1);
      await scheduler.tick();

      expect(agentLoop.waitForIdle).toHaveBeenCalledOnce();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
      expect(agentLoop.handleMessage.mock.calls[1]?.[0]?.channelId).toBe('internal:reflection:whisper');
    } finally {
      nowSpy.mockRestore();
    }
  });
});
