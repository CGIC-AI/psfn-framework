import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createSystemTool,
  DEFERRED_LIFECYCLE_ACTION_KIND,
  inferDeferredLifecycleActions,
  registerDeferredLifecycleRuntime,
} from './lifecycle.js';
import type { LifecycleNotifier } from '../../system/lifecycle/notifications.js';
import { LifecycleRestartSafeguard } from '../../system/capabilities/safeguards.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { GatewayClient } from '../../boundary/gateway/client.js';
import type {
  GatewayRpcConnection,
  GatewayRpcSerializedTransportStats,
} from '../../boundary/gateway/transport.js';
import {
  createRetryableShutdown,
  runShutdownStep,
  type ShutdownLogger,
} from '../../app/startup/support/shutdown-helpers.js';
import { runConfiguredLifecycleCommand } from '../../system/lifecycle/command-runner.js';

/** Extract text from AgentToolResult content array */
function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(c => c.text).join('');
}

function createRestartCommandGateway(): {
  client: GatewayClient;
  isDestroyed: () => boolean;
} {
  const emitter = new EventEmitter();
  let destroyed = false;
  const emptyStats: GatewayRpcSerializedTransportStats = {
    frameCount: 0,
    serializedBytes: 0,
    rpcCallCount: 0,
    byMethod: {},
  };
  const connection: GatewayRpcConnection = Object.assign(emitter, {
    send(data: unknown): boolean {
      if (destroyed) return false;
      void data;
      return true;
    },
    sendHeartbeat: () => !destroyed,
    onMessage(handler: (message: unknown) => void): void {
      emitter.on('message', handler);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      emitter.emit('close');
    },
    get destroyed(): boolean {
      return destroyed;
    },
    get serializedTransportStats(): GatewayRpcSerializedTransportStats {
      return emptyStats;
    },
  });
  return {
    client: new GatewayClient(connection, 1024, { keepaliveIntervalMs: 60_000 }),
    isDestroyed: () => destroyed,
  };
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
    analysisWorkbenchMaxSubQueries: 9,
    retryMaxAttempts: 3,
    retryBaseDelayMs: 2000,
  };
}

describe('system action=restart', () => {
  let mockNotifier: LifecycleNotifier;
  let mockStopFn: ReturnType<typeof vi.fn>;
  let prepareRestartCommand: ReturnType<typeof vi.fn>;
  let runRestartCommand: ReturnType<typeof vi.fn>;

  function makeTool(
    options: Omit<Parameters<typeof createSystemTool>[1] & object, 'notifier' | 'stopFn'> = {},
  ): ReturnType<typeof createSystemTool> {
    return createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      stopFn: mockStopFn,
      prepareRestartCommand,
      ...options,
    });
  }

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
    prepareRestartCommand = vi.fn(async () => {});
    runRestartCommand = vi.fn(async () => {});
  });

  it('sends pre-restart notification', async () => {
    // Override process.exit and setImmediate to prevent side effects
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = makeTool();
    const result = await tool.execute('call-1', { action: 'restart', reason: 'apply config' });

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

    const tool = makeTool();
    await tool.execute('call-2', { action: 'restart', reason: 'config change' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('config change');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('blocks restart when reason is missing', async () => {
    const tool = makeTool();
    const result = await tool.execute('call-3', { action: 'restart', reason: '   ' });

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
    const tool = makeTool({
      restartSafeguard: safeguard,
      getCapabilityTier: () => 'autonomous',
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const first = await tool.execute('call-4', { action: 'restart', reason: 'first' });
    expect(resultText(first)).toContain('Restart initiated');

    const cooldownBlocked = await tool.execute('call-5', { action: 'restart', reason: 'second' });
    expect(resultText(cooldownBlocked)).toContain('cooldown');
    expect((cooldownBlocked.details as any).isError).toBe(true);

    now = 61_000;
    const hourlyBlocked = await tool.execute('call-6', { action: 'restart', reason: 'third' });
    expect(resultText(hourlyBlocked)).toContain('hourly limit');
    expect((hourlyBlocked.details as any).isError).toBe(true);

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('launches a configured restart command after durable preparation and before final shutdown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = makeTool({ runRestartCommand });
    await tool.execute('call-7', { action: 'restart', reason: 'mode-aware restart' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(prepareRestartCommand).toHaveBeenCalledOnce();
    expect(runRestartCommand).toHaveBeenCalledOnce();
    expect(prepareRestartCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(runRestartCommand.mock.invocationCallOrder[0]!);
    expect(runRestartCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(mockStopFn.mock.invocationCallOrder[0]!);
    expect(exitSpy).toHaveBeenCalledWith(0);

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('allows a later command-strategy restart after two durable preparation failures', async () => {
    const logger: ShutdownLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let releaseAttempts = 0;
    const retryablePreparation = createRetryableShutdown(async () => {
      await runShutdownStep(
        'release background claims',
        async () => {
          releaseAttempts += 1;
          if (releaseAttempts <= 2) throw new Error('release unavailable');
        },
        logger,
        2,
        true,
      );
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;
    const tool = makeTool({
      prepareRestartCommand: retryablePreparation,
      runRestartCommand,
    });

    await tool.execute('call-release-fail', { action: 'restart', reason: 'first attempt' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(releaseAttempts).toBe(2);
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    await tool.execute('call-release-retry', { action: 'restart', reason: 'retry attempt' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(releaseAttempts).toBe(3);
    expect(runRestartCommand).toHaveBeenCalledOnce();
    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledOnce();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('settles a local fixed-argv command before destroying the live gateway transport', async () => {
    const events: string[] = [];
    const gateway = createRestartCommandGateway();
    let resolveFinalShutdown!: () => void;
    const finalShutdown = new Promise<void>((resolve) => {
      resolveFinalShutdown = resolve;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;
    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      restartContract: {
        strategy: 'command',
        source: 'explicit',
        command: 'systemctl --user restart psfn.service',
      },
      prepareRestartCommand: vi.fn(async () => {
        events.push('background-released');
      }),
      runRestartCommand: vi.fn(async () => {
        events.push('command-started');
        expect(gateway.isDestroyed()).toBe(false);
        await runConfiguredLifecycleCommand(
          `${process.execPath} -e "process.exit(0)"`,
          { timeoutMs: 1_000 },
        );
        events.push('command-settled');
      }),
      stopFn: vi.fn(async () => {
        events.push('final-shutdown');
        gateway.client.destroy();
        resolveFinalShutdown();
      }),
    });

    await tool.execute('call-live-gateway', { action: 'restart', reason: 'production transport' });
    await finalShutdown;
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(events).toEqual([
      'background-released',
      'command-started',
      'command-settled',
      'final-shutdown',
    ]);
    expect(gateway.isDestroyed()).toBe(true);
    expect(exitSpy).toHaveBeenCalledOnce();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('does not launch a restart command, stop transports, or exit when durable preparation fails', async () => {
    prepareRestartCommand.mockRejectedValueOnce(new Error('durable release failed'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = makeTool({ runRestartCommand });
    await tool.execute('call-stop-fail', { action: 'restart', reason: 'mode-aware restart' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockNotifier.notifyShutdown).toHaveBeenCalledWith(
      expect.stringContaining('restart blocked: durable release failed'),
    );

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

    const tool = makeTool({
      restartContract: {
        strategy: 'reexec',
        source: 'mode-default',
        exitCode: 75,
      },
      runRestartCommand,
    });
    const result = await tool.execute('call-reexec', { action: 'restart', reason: 'split wrapper restart' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(resultText(result)).toContain('Restart initiated');
    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(75);

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('fails closed for unsupported restart strategies without stopping the runtime', async () => {
    const tool = makeTool({
      restartContract: {
        strategy: 'unsupported',
        source: 'none',
      },
      runRestartCommand,
    });

    const result = await tool.execute('call-unsupported', { action: 'restart', reason: 'unsafe self restart' });

    expect(resultText(result)).toContain('Restart blocked');
    expect(resultText(result)).toContain('current process was left running');
    expect((result.details as any).isError).toBe(true);
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
  });

  it('fails closed when a command restart has no durable preparation boundary', async () => {
    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      stopFn: mockStopFn,
      restartContract: {
        strategy: 'command',
        source: 'explicit',
        command: 'systemctl --user restart psfn.service',
      },
      runRestartCommand,
    });

    const result = await tool.execute('call-missing-preparation', {
      action: 'restart',
      reason: 'unsafe command boundary',
    });

    expect(resultText(result)).toContain('Restart blocked');
    expect(resultText(result)).toContain('durable preparation boundary');
    expect((result.details as any).isError).toBe(true);
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
  });

  it('keeps the quiesced command transport open and permits an explicit retry after command failure', async () => {
    runRestartCommand.mockRejectedValueOnce(new Error('supervisor unavailable'));
    const durablePreparation = vi.fn(async () => {});
    const retryablePreparation = createRetryableShutdown(durablePreparation);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = makeTool({
      restartContract: {
        strategy: 'command',
        source: 'explicit',
        command: 'systemctl --user restart psfn.service',
      },
      prepareRestartCommand: retryablePreparation,
      runRestartCommand,
    });
    const result = await tool.execute('call-command-fail', { action: 'restart', reason: 'supervisor restart' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(resultText(result)).toContain('Restart initiated');
    expect(mockNotifier.notifyShutdown).toHaveBeenCalledWith('restart failed: supervisor unavailable');
    expect(durablePreparation).toHaveBeenCalledOnce();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    await tool.execute('call-command-retry', { action: 'restart', reason: 'retry supervisor restart' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(durablePreparation).toHaveBeenCalledOnce();
    expect(runRestartCommand).toHaveBeenCalledTimes(2);
    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledOnce();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });
});

describe('system action=rebuild', () => {
  let mockNotifier: LifecycleNotifier;
  let mockStopFn: ReturnType<typeof vi.fn>;
  let prepareRestartCommand: ReturnType<typeof vi.fn>;
  let runRestartCommand: ReturnType<typeof vi.fn>;
  let runBuildCommand: ReturnType<typeof vi.fn>;

  function makeTool(
    options: Omit<Parameters<typeof createSystemTool>[1] & object, 'notifier' | 'stopFn'> = {},
  ): ReturnType<typeof createSystemTool> {
    return createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      stopFn: mockStopFn,
      prepareRestartCommand,
      ...options,
    });
  }

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
    prepareRestartCommand = vi.fn(async () => {});
    runRestartCommand = vi.fn(async () => {});
    runBuildCommand = vi.fn(async () => {});
  });

  it('sends pre-restart notification with rebuild prefix', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = makeTool({ runBuildCommand });
    const result = await tool.execute('call-3', { action: 'rebuild', reason: 'dependency refresh' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild: dependency refresh');
    expect(resultText(result)).toContain('Rebuild initiated');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('includes reason in rebuild notification', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = makeTool({ runBuildCommand });
    await tool.execute('call-4', { action: 'rebuild', reason: 'new module' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild: new module');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('notifies shutdown and aborts restart when build fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Callback API intentionally preserves its Promise-returning lifecycle contract.
    runBuildCommand.mockImplementation(async () => {
      throw new Error('build blew up');
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = makeTool({
      runBuildCommand,
      runRestartCommand,
    });
    await tool.execute('call-5', { action: 'rebuild', reason: 'verify build' });
    await new Promise(r => setTimeout(r, 0));

    expect(mockNotifier.notifyShutdown).toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('does not launch the rebuild restart command or close transports when durable preparation fails', async () => {
    prepareRestartCommand.mockRejectedValueOnce(new Error('durable release failed'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = makeTool({ runBuildCommand, runRestartCommand });
    await tool.execute('call-rebuild-stop-fail', { action: 'rebuild', reason: 'verify rebuild' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(runBuildCommand).toHaveBeenCalledOnce();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockNotifier.notifyShutdown).toHaveBeenCalledWith(
      expect.stringContaining('rebuild restart blocked: durable release failed'),
    );

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('runs an immediate rebuild command before preparation and keeps restart transport alive until teardown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = makeTool({ runBuildCommand, runRestartCommand });
    await tool.execute('call-rebuild-order', { action: 'rebuild', reason: 'ordered rebuild' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(runBuildCommand).toHaveBeenCalledOnce();
    expect(prepareRestartCommand).toHaveBeenCalledOnce();
    expect(runRestartCommand).toHaveBeenCalledOnce();
    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(runBuildCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(prepareRestartCommand.mock.invocationCallOrder[0]!);
    expect(prepareRestartCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(runRestartCommand.mock.invocationCallOrder[0]!);
    expect(runRestartCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(mockStopFn.mock.invocationCallOrder[0]!);
    expect(exitSpy).toHaveBeenCalledOnce();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('blocks rebuild when reason is missing', async () => {
    const tool = makeTool();
    const result = await tool.execute('call-6', { action: 'rebuild', reason: '   ' });

    expect(resultText(result)).toContain('reason is required');
    expect((result.details as any).isError).toBe(true);
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
  });

  it('blocks rebuild before notification when no lifecycle build command is configured', async () => {
    const tool = makeTool();
    const result = await tool.execute('call-no-build-command', { action: 'rebuild', reason: 'verify rebuild' });

    expect(resultText(result)).toContain('Rebuild blocked');
    expect(resultText(result)).toContain('no lifecycle rebuild command is configured');
    expect((result.details as any).isError).toBe(true);
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
  });
});

describe('createSystemTool', () => {
  let mockNotifier: LifecycleNotifier;
  let mockStopFn: ReturnType<typeof vi.fn>;
  let prepareRestartCommand: ReturnType<typeof vi.fn>;
  let runRestartCommand: ReturnType<typeof vi.fn>;
  let runBuildCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
    prepareRestartCommand = vi.fn(async () => {});
    runRestartCommand = vi.fn(async () => {});
    runBuildCommand = vi.fn(async () => {});
  });

  it('reads runtime settings through action=read and defaults to read behavior', async () => {
    const tool = createSystemTool(makeConfig());

    const single = await tool.execute('system-read-single', { action: 'read', key: 'analysisWorkbenchMaxSubQueries' });
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
      prepareRestartCommand,
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
  let prepareRestartCommand: ReturnType<typeof vi.fn>;
  let runRestartCommand: ReturnType<typeof vi.fn>;
  let runBuildCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
    prepareRestartCommand = vi.fn(async () => {});
    runRestartCommand = vi.fn(async () => {});
    runBuildCommand = vi.fn(async () => {});
  });

  it('queues restart work instead of stopping immediately in deferred mode', async () => {
    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      stopFn: mockStopFn,
      executionMode: 'deferred',
      prepareRestartCommand,
      runRestartCommand,
    });

    const result = await tool.execute('call-deferred-restart', { action: 'restart', reason: 'autonomy rerun' });

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
      prepareRestartCommand,
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
    expect(registerPostTurnActionInferer).toHaveBeenCalledOnce();
    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('autonomous shakedown restart');
    expect(prepareRestartCommand).toHaveBeenCalledOnce();
    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(runRestartCommand).toHaveBeenCalledOnce();
    expect(prepareRestartCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(runRestartCommand.mock.invocationCallOrder[0]!);
    expect(runRestartCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(mockStopFn.mock.invocationCallOrder[0]!);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it('does not run or exit a deferred restart when durable preparation fails', async () => {
    prepareRestartCommand.mockRejectedValueOnce(new Error('durable release failed'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const registerHandler = vi.fn((_kind, _handler) => () => undefined);
    registerDeferredLifecycleRuntime({
      agentLoop: { registerPostTurnActionInferer: vi.fn().mockReturnValue(() => undefined) },
      postTurnActions: { registerHandler, listQueued: () => [], getStatus: vi.fn() } as any,
      notifier: mockNotifier,
      stopFn: mockStopFn,
      prepareRestartCommand,
      runRestartCommand,
      runBuildCommand,
    });
    const handler = registerHandler.mock.calls[0]?.[1] as (action: any) => Promise<void>;

    await handler({
      id: 'action-restart-stop-fail',
      payload: { operation: 'restart', reason: 'safe restart' },
    });
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
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
      prepareRestartCommand,
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
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
    expect(mockNotifier.notifyShutdown).toHaveBeenCalledWith(expect.stringContaining('restart blocked'));
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('notifies shutdown and aborts deferred rebuild restart when build fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Callback API intentionally preserves its Promise-returning lifecycle contract.
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
      prepareRestartCommand,
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
    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild: autonomous shakedown rebuild');
    expect(mockNotifier.notifyShutdown).toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('does not run or exit a deferred rebuild when durable preparation fails', async () => {
    prepareRestartCommand.mockRejectedValueOnce(new Error('durable release failed'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const registerHandler = vi.fn((_kind, _handler) => () => undefined);
    registerDeferredLifecycleRuntime({
      agentLoop: { registerPostTurnActionInferer: vi.fn().mockReturnValue(() => undefined) },
      postTurnActions: { registerHandler, listQueued: () => [], getStatus: vi.fn() } as any,
      notifier: mockNotifier,
      stopFn: mockStopFn,
      prepareRestartCommand,
      runRestartCommand,
      runBuildCommand,
    });
    const handler = registerHandler.mock.calls[0]?.[1] as (action: any) => Promise<void>;

    await handler({
      id: 'action-rebuild-stop-fail',
      payload: { operation: 'rebuild', reason: 'safe rebuild' },
    });
    expect(runBuildCommand).toHaveBeenCalledOnce();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('runs a deferred rebuild command through preparation, live restart transport, and final teardown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const registerHandler = vi.fn((_kind, _handler) => () => undefined);
    registerDeferredLifecycleRuntime({
      agentLoop: { registerPostTurnActionInferer: vi.fn().mockReturnValue(() => undefined) },
      postTurnActions: { registerHandler, listQueued: () => [], getStatus: vi.fn() } as any,
      notifier: mockNotifier,
      stopFn: mockStopFn,
      prepareRestartCommand,
      runRestartCommand,
      runBuildCommand,
    });
    const handler = registerHandler.mock.calls[0]?.[1] as (action: any) => Promise<void>;

    await handler({
      id: 'action-rebuild-order',
      payload: { operation: 'rebuild', reason: 'ordered rebuild' },
    });
    expect(runBuildCommand).toHaveBeenCalledOnce();
    expect(prepareRestartCommand).toHaveBeenCalledOnce();
    expect(runRestartCommand).toHaveBeenCalledOnce();
    expect(mockStopFn).toHaveBeenCalledOnce();
    expect(runBuildCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(prepareRestartCommand.mock.invocationCallOrder[0]!);
    expect(prepareRestartCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(runRestartCommand.mock.invocationCallOrder[0]!);
    expect(runRestartCommand.mock.invocationCallOrder[0]!)
      .toBeLessThan(mockStopFn.mock.invocationCallOrder[0]!);
    expect(exitSpy).toHaveBeenCalledOnce();

    exitSpy.mockRestore();
  });

  it('blocks deferred rebuild before pre-restart notification when no build command is configured', async () => {
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
      prepareRestartCommand,
      runRestartCommand,
    });

    const handler = registerHandler.mock.calls[0]?.[1] as (action: any) => Promise<void>;
    await handler({
      id: 'action-rebuild-no-command',
      payload: {
        operation: 'rebuild',
        reason: 'autonomous shakedown rebuild',
      },
    });
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
    expect(mockNotifier.notifyShutdown).toHaveBeenCalledWith(
      'rebuild blocked: no lifecycle rebuild command is configured',
    );
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(runRestartCommand).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});

describe('system tool under a guarded Kubernetes deployment', () => {
  const VALID_COMMIT = '0123456789abcdef0123456789abcdef01234567';
  const VALID_IMAGE = 'localhost/psfn-framework:0.1.0-kube-0ecaa08d';

  function enabledContext() {
    return {
      deployment: 'kube' as const,
      selfManagement: {
        enabled: true as const,
        namespace: 'psfn',
        release: 'psfn',
        sourceRevision: VALID_COMMIT,
        targetImage: VALID_IMAGE,
        helmRevision: 8,
      },
    };
  }

  function makeKubeTool(invoke: ReturnType<typeof vi.fn>, context = enabledContext()) {
    // No notifier/stopFn: kube lifecycle must not depend on the local restart path.
    return createSystemTool(makeConfig(), {
      kubeLifecycle: { context, invoke },
    });
  }

  it('routes restart through the gateway controller and surfaces the pending approval', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const invoke = vi.fn(async () => ({ status: 'approval_required', approvalId: 'appr-1', expiresAt: 42 }));
    const tool = makeKubeTool(invoke);

    const result = await tool.execute('call-kube-restart', { action: 'restart', reason: 'apply hotfix' });

    expect(invoke).toHaveBeenCalledWith({
      action: 'restart',
      namespace: 'psfn',
      release: 'psfn',
      sourceRevision: VALID_COMMIT,
      targetImage: VALID_IMAGE,
      helmRevision: 8,
      reason: 'apply hotfix',
    });
    expect(resultText(result)).toContain('queued for operator approval');
    expect(resultText(result)).toContain('appr-1');
    expect((result.details as { isError?: boolean }).isError).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('reports a completed rollout restart', async () => {
    const invoke = vi.fn(async () => ({
      status: 'completed',
      validationResult: 'passed',
      rollbackStatus: 'not_requested',
    }));
    const tool = makeKubeTool(invoke);
    const result = await tool.execute('call-kube-restart-done', { action: 'restart', reason: 'apply hotfix' });
    expect(resultText(result)).toContain('Rollout restart completed');
    expect(resultText(result)).toContain('passed');
  });

  it('fails closed (no local restart) when kube self-management is disabled', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const invoke = vi.fn();
    const tool = makeKubeTool(invoke, {
      deployment: 'kube' as const,
      selfManagement: { enabled: false as const, reason: 'self-management disabled' },
    });

    const result = await tool.execute('call-kube-disabled', { action: 'restart', reason: 'apply hotfix' });

    expect((result.details as { isError?: boolean }).isError).toBe(true);
    expect(resultText(result)).toContain('No local restart was performed');
    expect(invoke).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('requires a reason for a kube restart', async () => {
    const invoke = vi.fn();
    const tool = makeKubeTool(invoke);
    const result = await tool.execute('call-kube-noreason', { action: 'restart', reason: '  ' });
    expect(resultText(result)).toContain('reason is required');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses an in-pod rebuild and points at the guarded pipeline', async () => {
    const invoke = vi.fn();
    const tool = makeKubeTool(invoke);
    const result = await tool.execute('call-kube-rebuild', { action: 'rebuild', reason: 'ship a fix' });
    expect((result.details as { isError?: boolean }).isError).toBe(true);
    expect(resultText(result)).toContain('does not run in-pod');
    expect(resultText(result)).toContain('x5rt.6');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('surfaces an RPC failure as a loud error rather than a silent restart', async () => {
    const invoke = vi.fn(async () => { throw new Error('gateway unreachable'); });
    const tool = makeKubeTool(invoke);
    const result = await tool.execute('call-kube-rpc-fail', { action: 'restart', reason: 'apply hotfix' });
    expect((result.details as { isError?: boolean }).isError).toBe(true);
    expect(resultText(result)).toContain('Restart failed');
    expect(resultText(result)).toContain('gateway unreachable');
  });

  it('appends live kube lifecycle status to a settings read', async () => {
    const invoke = vi.fn(async () => ({
      status: 'completed',
      validationResult: 'not_run',
      rollbackStatus: 'not_requested',
      details: {
        deployments: [
          { name: 'psfn-agent', readyReplicas: 1, desiredReplicas: 1 },
          { name: 'psfn-gateway', readyReplicas: 0, desiredReplicas: 1 },
        ],
      },
    }));
    const tool = makeKubeTool(invoke);
    const result = await tool.execute('call-kube-read', { action: 'read', list: true });
    const text = resultText(result);
    expect(invoke).toHaveBeenCalledWith({ action: 'diagnose', namespace: 'psfn', release: 'psfn' });
    expect(text).toContain('Deployment mode: kubernetes');
    expect(text).toContain(VALID_IMAGE);
    expect(text).toContain('psfn-agent: ready 1/1');
    expect(text).toContain('psfn-gateway: ready 0/1');
  });

  it('keeps a settings read working when live diagnose fails', async () => {
    const invoke = vi.fn(async () => { throw new Error('diagnose timeout'); });
    const tool = makeKubeTool(invoke);
    const result = await tool.execute('call-kube-read-fail', { action: 'read', list: true });
    const text = resultText(result);
    expect(text).toContain('Deployment mode: kubernetes');
    expect(text).toContain('Live deployment state unavailable');
  });
});
