import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRestartTool, createRebuildTool } from './lifecycle.js';
import type { LifecycleNotifier } from '../lifecycle/notifications.js';
import { LifecycleRestartSafeguard } from '../capabilities/safeguards.js';

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
