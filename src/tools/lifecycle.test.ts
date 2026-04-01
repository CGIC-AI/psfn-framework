import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSystemTool } from './lifecycle.js';
import type { LifecycleNotifier } from '../lifecycle/notifications.js';
import { execSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { LifecycleRestartSafeguard } from '../capabilities/safeguards.js';
import type { SubstrateConfig } from '../types.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);

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

describe('createSystemTool', () => {
  let mockNotifier: LifecycleNotifier;
  let mockRestartStopFn: ReturnType<typeof vi.fn>;
  let mockRebuildStopFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedSpawn.mockReset();
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockRestartStopFn = vi.fn(async () => {});
    mockRebuildStopFn = vi.fn(async () => {});
  });

  it('has unified system metadata', () => {
    const tool = createSystemTool(makeConfig());
    expect(tool.name).toBe('system');
    expect(tool.label).toBe('system');
    expect(tool.description.toLowerCase()).toContain('read');
    expect(tool.description.toLowerCase()).toContain('restart');
    expect(tool.description.toLowerCase()).toContain('rebuild');
    expect(tool.parameters).toBeDefined();
  });

  it('reads runtime settings through action=read', async () => {
    const tool = createSystemTool(makeConfig());
    const result = await tool.execute('call-read', { action: 'read', key: 'thinkMaxSubQueries' });
    const payload = JSON.parse(resultText(result));

    expect(payload.mode).toBe('single');
    expect(payload.value).toBe(9);
    expect(result.details.isError).toBeUndefined();
  });

  it('defaults to read behavior when no action is provided', async () => {
    const tool = createSystemTool(makeConfig());
    const result = await tool.execute('call-read-default', { list: true });
    const payload = JSON.parse(resultText(result));

    expect(payload.mode).toBe('list');
    expect(payload.keys).toContain('primaryModel');
  });

  it('sends pre-restart notification for action=restart', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      restartStopFn: mockRestartStopFn,
    });
    const result = await tool.execute('call-restart', { action: 'restart', reason: 'apply config' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('apply config');
    expect(resultText(result)).toContain('Restart initiated');
    expect(result.details?.isError).toBeUndefined();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('passes reason to restart safeguard checks', async () => {
    let now = 0;
    const safeguard = new LifecycleRestartSafeguard({
      now: () => now,
      cooldownMs: 60_000,
      maxPerHour: 1,
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      restartStopFn: mockRestartStopFn,
      restartSafeguard: safeguard,
      getCapabilityTier: () => 'autonomous',
    });

    const first = await tool.execute('call-1', { action: 'restart', reason: 'first' });
    expect(resultText(first)).toContain('Restart initiated');

    const cooldownBlocked = await tool.execute('call-2', { action: 'restart', reason: 'second' });
    expect(resultText(cooldownBlocked)).toContain('cooldown');
    expect((cooldownBlocked.details as any).isError).toBe(true);

    now = 61_000;
    const hourlyBlocked = await tool.execute('call-3', { action: 'restart', reason: 'third' });
    expect(resultText(hourlyBlocked)).toContain('hourly limit');
    expect((hourlyBlocked.details as any).isError).toBe(true);

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('launches configured restart command after shutdown', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    mockedSpawn.mockReturnValue(child as any);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      restartStopFn: mockRestartStopFn,
      restartCommand: 'npm run split',
      runtimeMode: 'split',
    });
    await tool.execute('call-4', { action: 'restart', reason: 'mode-aware restart' });
    child.emit('spawn');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockRestartStopFn).toHaveBeenCalledOnce();
    expect(mockedSpawn).toHaveBeenCalledWith('npm run split', {
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('sends pre-restart notification with rebuild prefix', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      rebuildStopFn: mockRebuildStopFn,
    });
    const result = await tool.execute('call-5', { action: 'rebuild', reason: 'dependency refresh' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild: dependency refresh');
    expect(resultText(result)).toContain('Rebuild initiated');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('notifies shutdown and aborts restart when build fails', async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('build blew up');
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      void fn();
      return 0 as any;
    }) as typeof setImmediate;

    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      rebuildStopFn: mockRebuildStopFn,
    });
    await tool.execute('call-6', { action: 'rebuild', reason: 'verify build' });
    await new Promise(r => setTimeout(r, 0));

    expect(mockNotifier.notifyShutdown).toHaveBeenCalled();
    expect(mockRebuildStopFn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('blocks restart and rebuild when reason is missing', async () => {
    const tool = createSystemTool(makeConfig(), {
      notifier: mockNotifier,
      restartStopFn: mockRestartStopFn,
      rebuildStopFn: mockRebuildStopFn,
    });

    const restartResult = await tool.execute('call-7', { action: 'restart', reason: '   ' });
    expect(resultText(restartResult)).toContain('reason is required');
    expect((restartResult.details as any).isError).toBe(true);

    const rebuildResult = await tool.execute('call-8', { action: 'rebuild', reason: '   ' });
    expect(resultText(rebuildResult)).toContain('reason is required');
    expect((rebuildResult.details as any).isError).toBe(true);
    expect(mockNotifier.notifyPreRestart).not.toHaveBeenCalled();
  });

  it('fails closed when lifecycle actions are unavailable in this runtime', async () => {
    const tool = createSystemTool(makeConfig());
    const result = await tool.execute('call-9', { action: 'restart', reason: 'no runtime hooks' });

    expect(resultText(result)).toContain('not available in this runtime');
    expect((result.details as any).isError).toBe(true);
  });
});
