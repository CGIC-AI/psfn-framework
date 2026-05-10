import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSystemTool,
  createRestartTool,
  createRebuildTool,
  DEFERRED_LIFECYCLE_ACTION_KIND,
  inferDeferredLifecycleActions,
  registerDeferredLifecycleRuntime,
} from './lifecycle.js';
import type { LifecycleNotifier } from '../../system/lifecycle/notifications.js';
import { LifecycleRestartSafeguard } from '../../system/capabilities/safeguards.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

/** Extract text from AgentToolResult content array */
function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(c => c.text).join('');
}

function makeConfig(): SubstrateConfig {
  return {
    primaryModel: 'z-ai/glm-5',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    discordToken: 'secret-token',
    discordBotId: '123',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: {
        model: 'z-ai/glm-5',
        provider: 'openrouter',
        maxTokens: 16384,
        contextWindow: 128_000,
      },
      background: {
        model: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 8192,
      },
    },
    thinkMaxSubQueries: 9,
    retryMaxAttempts: 3,
    retryBaseDelayMs: 2000,
  };
}

describe('createRestartTool', () => {
  let mockNotifier: LifecycleNotifier;
  let mockStopFn: ReturnType<typeof vi.fn>;
  let runRestartCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
    runRestartCommand = vi.fn(async () => {});
  });

  it('has correct tool metadata', () => {
    const tool = createRestartTool(mockNotifier, mockStopFn);
    expect(tool.name).toBe('self_restart');
    expect(tool.description).toBeTruthy();
    expect(tool.label).toBe('self_restart');
    expect(tool.parameters).toBeDefined();
  });

  it('sends pre-restart notification', async () => {
    // Override process.exit and setImmediate to prevent side effects
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createRestartTool(mockNotifier, mockStopFn);
    const result = await tool.execute('call-1', { reason: 'apply config' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('apply config');
    expect(resultText(result)).toContain('Restart initiated');
    expect(result.details?.isError).toBeUndefined();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('passes reason to notification', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createRestartTool(mockNotifier, mockStopFn);
    await tool.execute('call-2', { reason: 'config change' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('config change');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('blocks restart when reason is missing', async () => {
    const tool = createRestartTool(mockNotifier, mockStopFn);
    const result = await tool.execute('call-3', { reason: '   ' });

    expect(resultText(result)).toContain('reason is required');
    expect((result.details as any).isError).toBe(true);
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
  });

  it('enforces restart cooldown/max-per-hour when safeguard is configured', async () => {
    let now = 0;
    const safeguard = new LifecycleRestartSafeguard({
      now: () => now,
      cooldownMs: 60_000,
      maxPerHour: 1,
    });
    const tool = createRestartTool(mockNotifier, mockStopFn, {
      restartSafeguard: safeguard,
      getCapabilityTier: () => 'autonomous',
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const first = await tool.execute('call-4', { reason: 'first' });
    expect(resultText(first)).toContain('Restart initiated');

    const cooldownBlocked = await tool.execute('call-5', { reason: 'second' });
    expect(resultText(cooldownBlocked)).toContain('cooldown');
    expect((cooldownBlocked.details as any).isError).toBe(true);

    now = 61_000;
    const hourlyBlocked = await tool.execute('call-6', { reason: 'third' });
    expect(resultText(hourlyBlocked)).toContain('hourly limit');
    expect((hourlyBlocked.details as any).isError).toBe(true);

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('launches configured restart command before shutdown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = createRestartTool(mockNotifier, mockStopFn, {
      runRestartCommand,
    });
    await tool.execute('call-7', { reason: 'mode-aware restart' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(runRestartCommand).toHaveBeenCalledOnce();
    expect(runRestartCommand.mock.invocationCallOrder[0]!).toBeLessThan(mockStopFn.mock.invocationCallOrder[0]!);
    expect(exitSpy).toHaveBeenCalledWith(0);

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('uses split wrapper reexec exit codes without launching a nested split command', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = createRestartTool(mockNotifier, mockStopFn, {
      restartContract: {
        strategy: 'reexec',
        source: 'mode-default',
        exitCode: 75,
      },
      runRestartCommand,
    });
    const result = await tool.execute('call-reexec', { reason: 'split wrapper restart' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(resultText(result)).toContain('Restart initiated');
    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(75);

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('fails closed for unsupported restart strategies without stopping the runtime', async () => {
    const tool = createRestartTool(mockNotifier, mockStopFn, {
      restartContract: {
        strategy: 'unsupported',
        source: 'none',
      },
      runRestartCommand,
    });

    const result = await tool.execute('call-unsupported', { reason: 'unsafe self restart' });

    expect(resultText(result)).toContain('Restart blocked');
    expect(resultText(result)).toContain('current process was left running');
    expect((result.details as any).isError).toBe(true);
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
  });

  it('aborts shutdown when a configured restart command fails', async () => {
    runRestartCommand.mockImplementation(async () => {
      throw new Error('supervisor unavailable');
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = createRestartTool(mockNotifier, mockStopFn, {
      restartContract: {
        strategy: 'command',
        source: 'explicit',
        command: 'systemctl --user restart psfn.service',
      },
      runRestartCommand,
    });
    const result = await tool.execute('call-command-fail', { reason: 'supervisor restart' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(resultText(result)).toContain('Restart initiated');
    expect(mockNotifier.notifyShutdown).toHaveBeenCalledWith('restart failed: supervisor unavailable');
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });
});

describe('createRebuildTool', () => {
  let mockNotifier: LifecycleNotifier;
  let mockStopFn: ReturnType<typeof vi.fn>;
  let runRestartCommand: ReturnType<typeof vi.fn>;
  let runBuildCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
    runRestartCommand = vi.fn(async () => {});
    runBuildCommand = vi.fn(async () => {});
  });

  it('has correct tool metadata', () => {
    const tool = createRebuildTool(mockNotifier, mockStopFn);
    expect(tool.name).toBe('self_rebuild');
    expect(tool.description.toLowerCase()).toContain('rebuild');
    expect(tool.description.toLowerCase()).toContain('build');
    expect(tool.label).toBe('self_rebuild');
    expect(tool.parameters).toBeDefined();
  });

  it('sends pre-restart notification with rebuild prefix', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createRebuildTool(mockNotifier, mockStopFn);
    const result = await tool.execute('call-3', { reason: 'dependency refresh' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild: dependency refresh');
    expect(resultText(result)).toContain('Rebuild initiated');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('includes reason in rebuild notification', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createRebuildTool(mockNotifier, mockStopFn);
    await tool.execute('call-4', { reason: 'new module' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild: new module');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('notifies shutdown and aborts restart when build fails', async () => {
    runBuildCommand.mockImplementation(async () => {
      throw new Error('build blew up');
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = createRebuildTool(mockNotifier, mockStopFn, {
      runBuildCommand,
      runRestartCommand,
    });
    await tool.execute('call-5', { reason: 'verify build' });
    await new Promise(r => setTimeout(r, 0));

    expect(mockNotifier.notifyShutdown).toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('blocks rebuild when reason is missing', async () => {
    const tool = createRebuildTool(mockNotifier, mockStopFn);
    const result = await tool.execute('call-6', { reason: '   ' });

    expect(resultText(result)).toContain('reason is required');
    expect((result.details as any).isError).toBe(true);
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
  });
});

describe('createSystemTool', () => {
  let mockNotifier: LifecycleNotifier;
  let mockStopFn: ReturnType<typeof vi.fn>;
  let runRestartCommand: ReturnType<typeof vi.fn>;
  let runBuildCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
    runRestartCommand = vi.fn(async () => {});
    runBuildCommand = vi.fn(async () => {});
  });

  it('reads runtime settings through action=read and defaults to read behavior', async () => {
    const tool = createSystemTool(makeConfig());

    const single = await tool.execute('system-read-single', { action: 'read', key: 'thinkMaxSubQueries' });
    expect(JSON.parse(resultText(single)).value).toBe(9);

    const listed = await tool.execute('system-read-default', { list: true });
    expect(JSON.parse(resultText(listed)).mode).toBe('list');
  });

  it('delegates restart and rebuild actions through the current lifecycle runtime', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      stopFn: mockStopFn,
      runRestartCommand,
      runBuildCommand,
    });

    const restart = await tool.execute('system-restart', { action: 'restart', reason: 'apply config' });
    expect(resultText(restart)).toContain('Restart initiated');
    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('apply config');

    const rebuild = await tool.execute('system-rebuild', { action: 'rebuild', reason: 'refresh build' });
    expect(resultText(rebuild)).toContain('Rebuild initiated');
    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild: refresh build');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('fails closed when lifecycle actions are unavailable in this runtime', async () => {
    const tool = createSystemTool(makeConfig());
    const result = await tool.execute('system-no-runtime', { action: 'restart', reason: 'no runtime hooks' });

    expect(resultText(result)).toContain('system action=restart is not available');
    expect((result.details as any).isError).toBe(true);
  });

  it('fails closed through system action=restart when the runtime restart strategy is unsupported', async () => {
    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      stopFn: mockStopFn,
      restartContract: {
        strategy: 'unsupported',
        source: 'none',
      },
      runRestartCommand,
    });

    const result = await tool.execute('system-unsupported-restart', {
      action: 'restart',
      reason: 'self-managed split restart',
    });

    expect(resultText(result)).toContain('Restart blocked');
    expect(resultText(result)).toContain('current process was left running');
    expect((result.details as any).isError).toBe(true);
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
  });
});

describe('deferred lifecycle execution', () => {
  let mockNotifier: LifecycleNotifier;
  let mockStopFn: ReturnType<typeof vi.fn>;
  let runRestartCommand: ReturnType<typeof vi.fn>;
  let runBuildCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
    runRestartCommand = vi.fn(async () => {});
    runBuildCommand = vi.fn(async () => {});
  });

  it('queues restart work instead of stopping immediately in deferred mode', async () => {
    const tool = createRestartTool(mockNotifier, mockStopFn, {
      executionMode: 'deferred',
      runRestartCommand,
    });

    const result = await tool.execute('call-deferred-restart', { reason: 'autonomy rerun' });

    expect(resultText(result)).toContain('Restart queued');
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
  });

  it('infers deferred lifecycle actions from successful lifecycle tool results', () => {
    const inferred = inferDeferredLifecycleActions({
      message: {
        id: 'message-1',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'restart please',
        timestamp: new Date(1_700_000_000_000),
      },
      response: {
        content: 'Restart queued.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 25,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-restart',
              name: 'self_restart',
              arguments: { reason: 'autonomous shakedown restart' },
            },
            {
              type: 'toolCall',
              id: 'call-rebuild',
              name: 'self_rebuild',
              arguments: { reason: 'autonomous shakedown rebuild' },
            },
          ],
        } as any,
        {
          role: 'toolResult',
          toolCallId: 'call-restart',
          toolName: 'self_restart',
          isError: false,
          content: [{ type: 'text', text: 'Restart queued.' }],
          details: {},
        } as any,
        {
          role: 'toolResult',
          toolCallId: 'call-rebuild',
          toolName: 'self_rebuild',
          isError: false,
          content: [{ type: 'text', text: 'Rebuild queued.' }],
          details: {},
        } as any,
      ],
      turnId: 'turn-1' as any,
      completedAt: 1_700_000_000_100,
    });

    expect(inferred).toEqual([
      {
        kind: DEFERRED_LIFECYCLE_ACTION_KIND,
        payload: {
          operation: 'restart',
          reason: 'autonomous shakedown restart',
        },
        dedupeKey: `${DEFERRED_LIFECYCLE_ACTION_KIND}:turn-1:restart`,
      },
      {
        kind: DEFERRED_LIFECYCLE_ACTION_KIND,
        payload: {
          operation: 'rebuild',
          reason: 'autonomous shakedown rebuild',
        },
        dedupeKey: `${DEFERRED_LIFECYCLE_ACTION_KIND}:turn-1:rebuild`,
      },
    ]);
  });

  it('infers deferred lifecycle actions from structured reason wrappers', () => {
    const inferred = inferDeferredLifecycleActions({
      message: {
        id: 'message-structured-rebuild',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'rebuild please',
        timestamp: new Date(1_700_000_000_000),
      },
      response: {
        content: 'Rebuild queued.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 25,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-rebuild-structured',
              name: 'self_rebuild',
              arguments: {
                reason: {
                  _type: 'rewind_marker',
                  marker: 'autonomous shakedown rebuild',
                },
              },
            },
          ],
        } as any,
        {
          role: 'toolResult',
          toolCallId: 'call-rebuild-structured',
          toolName: 'self_rebuild',
          isError: false,
          content: [{ type: 'text', text: 'Rebuild queued.' }],
          details: {},
        } as any,
      ],
      turnId: 'turn-structured' as any,
      completedAt: 1_700_000_000_100,
    });

    expect(inferred).toEqual([
      {
        kind: DEFERRED_LIFECYCLE_ACTION_KIND,
        payload: {
          operation: 'rebuild',
          reason: 'autonomous shakedown rebuild',
        },
        dedupeKey: `${DEFERRED_LIFECYCLE_ACTION_KIND}:turn-structured:rebuild`,
      },
    ]);
  });

  it('infers deferred restart actions from primary_reason wrappers', () => {
    const inferred = inferDeferredLifecycleActions({
      message: {
        id: 'message-structured-restart',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'restart please',
        timestamp: new Date(1_700_000_000_000),
      },
      response: {
        content: 'Restart queued.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 25,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-restart-structured',
              name: 'self_restart',
              arguments: {
                reason: {
                  primary_reason: 'autonomous shakedown restart',
                },
              },
            },
          ],
        } as any,
        {
          role: 'toolResult',
          toolCallId: 'call-restart-structured',
          toolName: 'self_restart',
          isError: false,
          content: [{ type: 'text', text: 'Restart queued.' }],
          details: {},
        } as any,
      ],
      turnId: 'turn-structured-restart' as any,
      completedAt: 1_700_000_000_100,
    });

    expect(inferred).toEqual([
      {
        kind: DEFERRED_LIFECYCLE_ACTION_KIND,
        payload: {
          operation: 'restart',
          reason: 'autonomous shakedown restart',
        },
        dedupeKey: `${DEFERRED_LIFECYCLE_ACTION_KIND}:turn-structured-restart:restart`,
      },
    ]);
  });

  it('infers deferred lifecycle actions from unified system tool results', () => {
    const inferred = inferDeferredLifecycleActions({
      message: {
        id: 'message-system-restart',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'restart please',
        timestamp: new Date(1_700_000_000_000),
      },
      response: {
        content: 'Restart queued.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 25,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-system-restart',
              name: 'system',
              arguments: {
                action: 'restart',
                reason: { primary_reason: 'autonomous shakedown restart' },
              },
            },
          ],
        } as any,
        {
          role: 'toolResult',
          toolCallId: 'call-system-restart',
          toolName: 'system',
          isError: false,
          content: [{ type: 'text', text: 'Restart queued.' }],
          details: {},
        } as any,
      ],
      turnId: 'turn-system-restart' as any,
      completedAt: 1_700_000_000_100,
    });

    expect(inferred).toEqual([
      {
        kind: DEFERRED_LIFECYCLE_ACTION_KIND,
        payload: {
          operation: 'restart',
          reason: 'autonomous shakedown restart',
        },
        dedupeKey: `${DEFERRED_LIFECYCLE_ACTION_KIND}:turn-system-restart:restart`,
      },
    ]);
  });

  it('executes deferred restart actions through the post-turn handler', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const registerHandler = vi.fn((_kind, _handler) => {
      return () => undefined;
    });
    const postTurnActions = {
      registerHandler,
      listQueued: () => [],
      getStatus: vi.fn(),
    };
    const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => undefined);

    registerDeferredLifecycleRuntime({
      agentLoop: { registerPostTurnActionInferer },
      postTurnActions: postTurnActions as any,
      notifier: mockNotifier,
      stopFn: mockStopFn,
      runRestartCommand,
      runBuildCommand,
    });

    const handler = registerHandler.mock.calls[0]?.[1] as (action: any) => Promise<void>;
    await handler({
      id: 'action-restart',
      payload: {
        operation: 'restart',
        reason: 'autonomous shakedown restart',
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(registerPostTurnActionInferer).toHaveBeenCalledOnce();
    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('autonomous shakedown restart');
    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(runRestartCommand).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it('blocks deferred restart actions before shutdown when the strategy is unsupported', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const registerHandler = vi.fn((_kind, _handler) => {
      return () => undefined;
    });

    registerDeferredLifecycleRuntime({
      agentLoop: { registerPostTurnActionInferer: vi.fn().mockReturnValue(() => undefined) },
      postTurnActions: {
        registerHandler,
        listQueued: () => [],
        getStatus: vi.fn(),
      } as any,
      notifier: mockNotifier,
      stopFn: mockStopFn,
      restartContract: {
        strategy: 'unsupported',
        source: 'none',
      },
      runRestartCommand,
      runBuildCommand,
    });

    const handler = registerHandler.mock.calls[0]?.[1] as (action: any) => Promise<void>;
    await handler({
      id: 'action-restart-unsupported',
      payload: {
        operation: 'restart',
        reason: 'autonomous shakedown restart',
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
    expect(mockNotifier.notifyShutdown).toHaveBeenCalledWith(expect.stringContaining('restart blocked'));
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('notifies shutdown and aborts deferred rebuild restart when build fails', async () => {
    runBuildCommand.mockImplementation(async () => {
      throw new Error('build blew up');
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const registerHandler = vi.fn((_kind, _handler) => {
      return () => undefined;
    });

    registerDeferredLifecycleRuntime({
      agentLoop: { registerPostTurnActionInferer: vi.fn().mockReturnValue(() => undefined) },
      postTurnActions: {
        registerHandler,
        listQueued: () => [],
        getStatus: vi.fn(),
      } as any,
      notifier: mockNotifier,
      stopFn: mockStopFn,
      runRestartCommand,
      runBuildCommand,
    });

    const handler = registerHandler.mock.calls[0]?.[1] as (action: any) => Promise<void>;
    await handler({
      id: 'action-rebuild',
      payload: {
        operation: 'rebuild',
        reason: 'autonomous shakedown rebuild',
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild: autonomous shakedown rebuild');
    expect(mockNotifier.notifyShutdown).toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
