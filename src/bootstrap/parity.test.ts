import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { HeartbeatPolicyStore } from '../scheduler/heartbeat-policy.js';
import type { LLMProvider } from '../agent/contracts.js';
import { readLastActiveSession } from '../lifecycle/notifications.js';
import { createDefaultExtendedToolAutoloadPolicy } from '../agent/extended-tool-autoload-policy.js';
import {
  wireExtendedToolAutoloadPolicy,
  wireHeartbeatRuntime,
  wireSessionToolsRuntime,
  wireSettingsRuntime,
} from './parity.js';
import { wirePostTurnActionRuntime } from './post-turn-actions.js';
import { DEFERRED_TOOL_HANDOFF_ACTION_KIND } from '../agent/deferred-tool-handoff.js';

describe('wireSessionToolsRuntime', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-tools-runtime-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers session tools as extended tools and wires session_new state updates', async () => {
    const target = {
      registerTool: vi.fn(),
    };
    const sessionManager = {
      appendSystemNote: vi.fn(),
      listRecentSessions: vi.fn(() => []),
      getSessionActivity: vi.fn(() => null),
      setActiveContextSession: vi.fn(),
      getActiveContextSession: vi.fn(() => null),
    } as any;

    wireSessionToolsRuntime(target, sessionManager, tempDir);

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    expect(calls).toHaveLength(3);
    expect(calls.map(([tool]) => tool.name).sort()).toEqual(['session_list', 'session_new', 'session_resume']);
    expect(calls.every(([, category]) => category === 'extended')).toBe(true);

    const sessionNewTool = calls.find(([tool]) => tool.name === 'session_new')?.[0] as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: Record<string, unknown> }>;
    };
    expect(sessionNewTool).toBeDefined();

    const result = await sessionNewTool.execute('call-session-new', {});
    const details = result.details as {
      newSessionId: string;
      previousSessionId: string | null;
    };
    expect(details.previousSessionId).toBe(null);
    expect(details.newSessionId.startsWith('api:session-')).toBe(true);
    expect(sessionManager.setActiveContextSession).toHaveBeenCalledWith(details.newSessionId);
    expect(sessionManager.appendSystemNote).toHaveBeenCalledWith(
      details.newSessionId,
      'Session initialized via session_new.',
    );

    const active = readLastActiveSession(tempDir);
    expect(active?.sessionId).toBe(details.newSessionId);
    expect(active?.channelType).toBe('api');
  });
});

describe('wireSettingsRuntime', () => {
  it('registers settings and promoted-tool runtime helpers when target supports promotions', () => {
    const target = {
      registerTool: vi.fn(),
      getPromotedExtendedToolsLimit: () => 4,
      getPromotedExtendedTools: () => ['repo_status'],
      addPromotedExtendedTool: vi.fn(() => ({
        ok: true,
        changed: true,
        promotedTools: ['repo_status'],
        message: 'ok',
      })),
      removePromotedExtendedTool: vi.fn(() => ({
        ok: true,
        changed: true,
        promotedTools: [],
        message: 'ok',
      })),
      swapPromotedExtendedTools: vi.fn(() => ({
        ok: true,
        changed: true,
        promotedTools: ['repo_status'],
        message: 'ok',
      })),
    };

    wireSettingsRuntime(target as any, {} as any);

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    expect(calls.map(([tool]) => tool.name).sort()).toEqual([
      'promoted_tools_add',
      'promoted_tools_list',
      'promoted_tools_remove',
      'promoted_tools_swap',
      'settings_get',
    ]);
    expect(calls.every(([, category]) => category === 'extended')).toBe(true);
  });
});

describe('wireExtendedToolAutoloadPolicy', () => {
  it('applies default autoload policy when no override is provided', () => {
    const target = {
      setExtendedToolAutoloadPolicy: vi.fn(),
    };

    wireExtendedToolAutoloadPolicy(target);

    expect(target.setExtendedToolAutoloadPolicy).toHaveBeenCalledTimes(1);
    const policy = target.setExtendedToolAutoloadPolicy.mock.calls[0]?.[0];
    expect(policy.maxPreloadCount).toBeGreaterThan(0);
    expect(policy.classifyIntent({
      channelId: 'discord-dev',
      channelType: 'discord',
      content: 'check git diff',
    })).toBe('dev');
  });

  it('uses caller-provided policy override', () => {
    const target = {
      setExtendedToolAutoloadPolicy: vi.fn(),
    };
    const customPolicy = createDefaultExtendedToolAutoloadPolicy(1);

    wireExtendedToolAutoloadPolicy(target, customPolicy);

    expect(target.setExtendedToolAutoloadPolicy).toHaveBeenCalledWith(customPolicy);
  });
});

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

  it('wires post-turn inference/handler runtime when manual run is busy', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => {});
    const agentLoop = {
      handleMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Agent is already processing another prompt'))
        .mockResolvedValue({ content: 'Deferred reflection output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      registerPostTurnActionInferer,
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
    };

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
      undefined,
      {
        eventBus,
        postTurnActions,
      },
    );

    expect(postTurnActions.registerHandler).toHaveBeenCalledTimes(2);
    const heartbeatRegisterCall = postTurnActions.registerHandler.mock.calls.find(
      (call) => call[0] === 'heartbeat.run_template',
    );
    expect(heartbeatRegisterCall).toBeDefined();
    expect(registerPostTurnActionInferer).toHaveBeenCalledTimes(1);
    const inferer = registerPostTurnActionInferer.mock.calls[0]?.[0] as (
      context: {
        message: { id: string; channelId: string };
        response: { content: string };
        turnMessages: unknown[];
      },
    ) => Array<{ kind: string; dedupeKey?: string; payload?: Record<string, unknown> }>;
    const inferredActions = inferer({
      message: { id: 'msg-1', channelId: 'test-channel' },
      response: { content: 'ok' },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'heartbeat_run_template',
        result: {
          details: {
            deferredAction: {
              kind: 'heartbeat.run_template',
              payload: { templateId: 'whisper' },
              dedupeKey: 'heartbeat.run_template:whisper',
              maxRetries: 2,
            },
          },
        },
      }],
    });
    expect(inferredActions).toEqual([{
      kind: 'heartbeat.run_template',
      payload: { templateId: 'whisper' },
      dedupeKey: 'heartbeat.run_template:whisper',
      maxRetries: 2,
    }]);

    const registeredTools = target.registerTool.mock.calls.map(call => call[0]);
    const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool?.name === 'heartbeat_run_template');
    expect(runTemplateTool).toBeDefined();

    const runResult = await runTemplateTool.execute(
      'manual-2',
      { templateId: 'whisper' },
      new AbortController().signal,
    );
    const runText = runResult.content.map((part: { text: string }) => part.text).join('');
    expect(runText).toContain('Queued reflection template');
    expect((runResult.details as { deferredAction?: { kind?: string } }).deferredAction?.kind)
      .toBe('heartbeat.run_template');

    const deferredTask = scheduler.listTasks().find(task => task.id.startsWith('reflection:deferred:'));
    expect(deferredTask).toBeUndefined();

    const deferredHandler = heartbeatRegisterCall?.[1] as (
      action: {
        id: string;
        kind: string;
        payload: Record<string, unknown>;
        dedupeKey: string;
        channelId: string;
        sourceMessageId: string;
        inferredAt: number;
      },
    ) => Promise<void>;
    await deferredHandler({
      id: 'deferred-1',
      kind: 'heartbeat.run_template',
      payload: { templateId: 'whisper' },
      dedupeKey: 'heartbeat.run_template:whisper',
      channelId: 'test-channel',
      sourceMessageId: 'msg-1',
      inferredAt: Date.now(),
    });

    expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
    expect(agentLoop.handleMessage.mock.calls[1]?.[0]?.channelId).toBe('internal:reflection:whisper');
  });

  it('suppresses rapid-fire deferred heartbeat template execution loops', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'Loop candidate reflection output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      registerPostTurnActionInferer: vi.fn().mockReturnValue(() => {}),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_100_000);
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
        },
      );

      const heartbeatRegisterCall = postTurnActions.registerHandler.mock.calls.find(
        (call) => call[0] === 'heartbeat.run_template',
      );
      expect(heartbeatRegisterCall).toBeDefined();

      const deferredHandler = heartbeatRegisterCall?.[1] as (
        action: {
          id: string;
          kind: string;
          payload: Record<string, unknown>;
          dedupeKey: string;
          channelId: string;
          sourceMessageId: string;
          inferredAt: number;
        },
      ) => Promise<void>;

      for (let index = 0; index < 6; index += 1) {
        const now = 1_700_000_100_000 + index * 1_000;
        nowSpy.mockReturnValue(now);
        await deferredHandler({
          id: `deferred-loop-${index}`,
          kind: 'heartbeat.run_template',
          payload: { templateId: 'emotional-check' },
          dedupeKey: `heartbeat.run_template:emotional-check:${index}`,
          channelId: 'test-channel',
          sourceMessageId: `msg-loop-${index}`,
          inferredAt: now,
        });
      }

      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(4);
      const handledChannels = agentLoop.handleMessage.mock.calls.map(call => call[0]?.channelId);
      expect(handledChannels).toEqual([
        'internal:reflection:emotional-check',
        'internal:reflection:emotional-check',
        'internal:reflection:emotional-check',
        'internal:reflection:emotional-check',
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('infers deferred tool-handoff actions from late load_tools discovery payloads', () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => {});
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      activateExtendedTools: vi.fn().mockReturnValue({
        requestedTools: ['extended_probe_tool'],
        activatedTools: ['extended_probe_tool'],
        alreadyActiveTools: [],
        missingTools: [],
      }),
      registerPostTurnActionInferer,
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
    };

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
      undefined,
      {
        eventBus,
        postTurnActions,
      },
    );

    const inferer = registerPostTurnActionInferer.mock.calls[0]?.[0] as (
      context: {
        message: {
          id: string;
          channelId: string;
          channelType: 'terminal';
          authorId: string;
          authorName: string;
          content: string;
          timestamp: Date;
        };
        response: { content: string };
        turnMessages: unknown[];
      },
    ) => Array<{
      kind: string;
      payload?: {
        toolNames?: string[];
        intendedAction?: string;
        turn?: {
          turnId?: string;
          requestId?: string;
          channelId?: string;
          channelType?: string;
          callType?: string;
        };
      };
      dedupeKey?: string;
      maxRetries?: number;
    }>;
    const inferredActions = inferer({
      message: {
        id: 'msg-1',
        channelId: 'test-channel',
        channelType: 'terminal',
        authorId: 'user-1',
        authorName: 'Test User',
        content: 'hello',
        timestamp: new Date(),
      },
      response: { content: 'ok' },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'load_tools',
        result: {
          details: {
            deferredToolHandoff: {
              toolNames: ['extended_probe_tool'],
              intendedAction: 'Use extended_probe_tool to collect diagnostics.',
              maxRetries: 1,
            },
          },
        },
      }],
    });

    expect(inferredActions).toHaveLength(1);
    expect(inferredActions[0]).toMatchObject({
      kind: DEFERRED_TOOL_HANDOFF_ACTION_KIND,
      maxRetries: 1,
      payload: {
        toolNames: ['extended_probe_tool'],
        intendedAction: 'Use extended_probe_tool to collect diagnostics.',
        turn: {
          turnId: 'msg-1',
          requestId: 'msg-1',
          channelId: 'test-channel',
          channelType: 'terminal',
          callType: 'chat',
        },
      },
    });
    expect(inferredActions[0]?.dedupeKey).toContain(`${DEFERRED_TOOL_HANDOFF_ACTION_KIND}:msg-1:`);
  });

  it('continues deferred tool handoff after idle and emits queued/activated/executed telemetry', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => {});
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'Deferred continuation output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      activateExtendedTools: vi.fn().mockReturnValue({
        requestedTools: ['extended_probe_tool'],
        activatedTools: ['extended_probe_tool'],
        alreadyActiveTools: [],
        missingTools: [],
      }),
      registerPostTurnActionInferer,
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      intervalMs: 1,
    });

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
      undefined,
      {
        eventBus,
        postTurnActions,
      },
    );

    const inferer = registerPostTurnActionInferer.mock.calls[0]?.[0] as (
      context: {
        message: {
          id: string;
          channelId: string;
          channelType: 'terminal';
          authorId: string;
          authorName: string;
          content: string;
          timestamp: Date;
        };
        response: { content: string };
        turnMessages: unknown[];
      },
    ) => Array<any>;
    const message = {
      id: 'msg-load-tools-1',
      channelId: 'test-channel',
      channelType: 'terminal' as const,
      authorId: 'user-1',
      authorName: 'Test User',
      content: 'hello',
      timestamp: new Date(),
    };
    const inferredActions = inferer({
      message,
      response: { content: 'ok' },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'load_tools',
        result: {
          details: {
            deferredToolHandoff: {
              toolNames: ['extended_probe_tool'],
              intendedAction: 'Use extended_probe_tool to collect diagnostics.',
              maxRetries: 1,
            },
          },
        },
      }],
    });

    const phases: string[] = [];
    eventBus.on('agent.tool_handoff.telemetry', ({ phase }) => {
      phases.push(phase);
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message,
      response: {
        content: 'ok',
        channelId: message.channelId,
        metadata: {
          model: 'mock-model',
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
        },
      },
      actions: inferredActions,
    });

    await scheduler.tick();

    expect(agentLoop.waitForIdle).toHaveBeenCalled();
    expect(agentLoop.activateExtendedTools).toHaveBeenCalledTimes(1);
    expect(agentLoop.activateExtendedTools).toHaveBeenCalledWith(
      ['extended_probe_tool'],
      expect.objectContaining({
        source: 'deferred',
        correlation: expect.objectContaining({
          callType: 'tool',
          purpose: 'agent.tools.adaptive.decision',
        }),
        taskKind: 'deferred_tool_handoff',
        intent: 'deferred_tool_handoff',
      }),
    );
    expect(agentLoop.handleMessage).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith('test-channel', 'Deferred continuation output');
    expect(phases).toEqual(expect.arrayContaining(['queued', 'activated', 'executed']));
  });

  it('bounds deferred tool-handoff retries and emits failed telemetry once exhausted', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);

      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const target = {
        registerTool: vi.fn(),
      };
      const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => {});
      const agentLoop = {
        handleMessage: vi.fn().mockRejectedValue(new Error('continuation failed')),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        activateExtendedTools: vi.fn().mockReturnValue({
          requestedTools: ['extended_probe_tool'],
          activatedTools: ['extended_probe_tool'],
          alreadyActiveTools: [],
          missingTools: [],
        }),
        registerPostTurnActionInferer,
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
        baseRetryDelayMs: 10,
        maxRetryDelayMs: 10,
      });

      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
        },
      );

      const inferer = registerPostTurnActionInferer.mock.calls[0]?.[0] as (
        context: {
          message: {
            id: string;
            channelId: string;
            channelType: 'terminal';
            authorId: string;
            authorName: string;
            content: string;
            timestamp: Date;
          };
          response: { content: string };
          turnMessages: unknown[];
        },
      ) => Array<any>;
      const message = {
        id: 'msg-load-tools-fail-1',
        channelId: 'test-channel',
        channelType: 'terminal' as const,
        authorId: 'user-1',
        authorName: 'Test User',
        content: 'hello',
        timestamp: new Date(),
      };
      const inferredActions = inferer({
        message,
        response: { content: 'ok' },
        turnMessages: [{
          role: 'toolResult',
          toolName: 'load_tools',
          result: {
            details: {
              deferredToolHandoff: {
                toolNames: ['extended_probe_tool'],
                intendedAction: 'Use extended_probe_tool to collect diagnostics.',
                maxRetries: 1,
              },
            },
          },
        }],
      });

      const phases: string[] = [];
      eventBus.on('agent.tool_handoff.telemetry', ({ phase }) => {
        phases.push(phase);
      });

      nowSpy.mockReturnValue(1_700_000_000_101);
      await eventBus.emit('agent.post_turn.actions.inferred', {
        message,
        response: {
          content: 'ok',
          channelId: message.channelId,
          metadata: {
            model: 'mock-model',
            inputTokens: 1,
            outputTokens: 1,
            durationMs: 1,
          },
        },
        actions: inferredActions,
      });

      await scheduler.tick();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(1);
      expect(agentLoop.activateExtendedTools).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_700_000_000_150);
      await scheduler.tick();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_700_000_000_250);
      await scheduler.tick();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
      expect(agentLoop.activateExtendedTools).toHaveBeenCalledTimes(1);
      expect(sender.send).not.toHaveBeenCalled();
      expect(phases).toEqual(expect.arrayContaining(['queued', 'activated', 'failed']));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('defers scheduled template runs when the agent is busy and executes after idle', async () => {
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
        .mockResolvedValue({ content: 'Deferred scheduled output' }),
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

      const whisperTask = scheduler.getTask('reflection:whisper');
      expect(whisperTask).toBeDefined();

      nowSpy.mockReturnValue(1_700_000_000_000 + (whisperTask?.intervalMs ?? 0) + 1);
      await scheduler.tick();

      const deferredTask = scheduler.listTasks().find(task => task.id.startsWith('reflection:deferred:whisper'));
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
