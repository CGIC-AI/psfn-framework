import { describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import type { PolicyConfig } from '../policy.js';
import { registerShellMethods } from './shell.js';
import { GatewayErrors } from '../protocol.js';

function createHarness(policyConfig: PolicyConfig): { invoke(params: Record<string, unknown>): Promise<any> } {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<any>>();
  const runtime: GatewayMethodRuntime = {
    target: {
      addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<any>) {
        methods.set(name, handler);
      },
    } as any,
    llmProvider: {} as any,
    embeddingService: {} as any,
    discordAdapter: {} as any,
    policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: null,
    notifyAll: vi.fn(),
    listPendingConfirmations: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'stream-1',
    audited: (_method, handler) => handler,
    gated: (_method, handler) => handler,
  };
  registerShellMethods(runtime);
  const method = methods.get('shell.exec');
  if (!method) {
    throw new Error('shell.exec method was not registered');
  }
  return {
    invoke(params: Record<string, unknown>) {
      return method(params);
    },
  };
}

describe('registerShellMethods', () => {
  it('executes allowlisted command within policy bounds', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: {
        enabled: true,
        allowlist: ['node'],
        allowedCwd: [process.cwd()],
      },
    });

    const result = await harness.invoke({
      command: 'node',
      args: ['-e', 'process.stdout.write("ok")'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
  });

  it('denies command outside allowlist', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: {
        enabled: true,
        allowlist: ['bash'],
        allowedCwd: [process.cwd()],
      },
    });

    await expect(harness.invoke({
      command: 'node',
      args: ['-v'],
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('not allowlisted'),
    });
  });

  it('enforces execution timeout', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: {
        enabled: true,
        allowlist: ['node'],
        allowedCwd: [process.cwd()],
        maxTimeoutMs: 150,
      },
    });

    const result = await harness.invoke({
      command: 'node',
      args: ['-e', 'setTimeout(() => process.stdout.write("late"), 500)'],
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('enforces output limit', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: {
        enabled: true,
        allowlist: ['node'],
        allowedCwd: [process.cwd()],
        maxOutputChars: 120,
      },
    });

    const result = await harness.invoke({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(300)); process.stderr.write("e".repeat(300));'],
      maxOutputChars: 80,
    });

    expect(result.truncated).toBe(true);
    expect((result.stdout.length + result.stderr.length)).toBeLessThanOrEqual(80);
  });

  it('denies cwd outside allowlist', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: {
        enabled: true,
        allowlist: ['node'],
        allowedCwd: [process.cwd()],
      },
    });

    await expect(harness.invoke({
      command: 'node',
      args: ['-v'],
      cwd: '/tmp',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('cwd not allowlisted'),
    });
  });
});
