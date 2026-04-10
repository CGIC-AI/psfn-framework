import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createRestartTool,
  createRebuildTool,
  DEFERRED_LIFECYCLE_ACTION_KIND,
  inferDeferredLifecycleActions,
  registerDeferredLifecycleRuntime,
} from './lifecycle.js';
import type { LifecycleNotifier } from '../../system/lifecycle/notifications.js';
import { LifecycleRestartSafeguard } from '../../system/capabilities/safeguards.js';

/** Extract text from AgentToolResult content array */
function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(c => c.text).join('');
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

  it('launches configured restart command after shutdown', async () => {
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
    expect(exitSpy).toHaveBeenCalledWith(0);

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

  it('executes deferred restart actions through the post-turn handler', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const registerHandler = vi.fn((_kind, _handler) => {
      return () => undefined;
    });
    const postTurnActions = {
      registerHandler,
      listQueued: () => [],
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
