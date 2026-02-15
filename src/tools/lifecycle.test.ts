import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRestartTool, createRebuildTool } from './lifecycle.js';
import type { LifecycleNotifier } from '../lifecycle/notifications.js';

/** Extract text from AgentToolResult content array */
function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(c => c.text).join('');
}

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
    const result = await tool.execute('call-1', {});

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith(undefined);
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
    expect(tool.label).toBe('self_rebuild');
    expect(tool.parameters).toBeDefined();
  });

  it('sends pre-restart notification with rebuild prefix', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const origSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = vi.fn((_fn: unknown) => {}) as unknown as typeof setImmediate;

    const tool = createRebuildTool(mockNotifier, mockStopFn);
    const result = await tool.execute('call-3', {});

    expect(mockNotifier.notifyPreRestart).toHaveBeenCalledWith('rebuild');
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
});
