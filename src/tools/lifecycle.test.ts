import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRestartTool, createRebuildTool } from './lifecycle.js';
import type { LifecycleNotifier } from '../lifecycle/notifications.js';

describe('createRestartTool', () => {
  let mockNotifier: LifecycleNotifier;
  let mockStopFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
  });

  it('has correct tool metadata', () => {
    const tool = createRestartTool(mockNotifier, mockStopFn);
    expect(tool.name).toBe('self_restart');
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema).toBeDefined();
  });

  it('sends pre-restart notification', async () => {
    // Override process.exit and setImmediate to prevent side effects
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createRestartTool(mockNotifier, mockStopFn);
    const result = await tool.execute({});

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith(undefined);
    expect(result.content).toContain('Restart initiated');
    expect(result.isError).toBeUndefined();

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('passes reason to notification', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createRestartTool(mockNotifier, mockStopFn);
    await tool.execute({ reason: 'config change' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('config change');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });
});

describe('createRebuildTool', () => {
  let mockNotifier: LifecycleNotifier;
  let mockStopFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNotifier = {
      notifyPreRestart: vi.fn(async () => {}),
      notifyReady: vi.fn(async () => {}),
      notifyShutdown: vi.fn(async () => {}),
    };
    mockStopFn = vi.fn(async () => {});
  });

  it('has correct tool metadata', () => {
    const tool = createRebuildTool(mockNotifier, mockStopFn);
    expect(tool.name).toBe('self_rebuild');
    expect(tool.description.toLowerCase()).toContain('rebuild');
    expect(tool.description.toLowerCase()).toContain('build');
  });

  it('sends pre-restart notification with rebuild prefix', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createRebuildTool(mockNotifier, mockStopFn);
    const result = await tool.execute({});

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild');
    expect(result.content).toContain('Rebuild initiated');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });

  it('includes reason in rebuild notification', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createRebuildTool(mockNotifier, mockStopFn);
    await tool.execute({ reason: 'new module' });

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild: new module');

    globalThis.setImmediate = origSetImmediate;
    exitSpy.mockRestore();
  });
});
