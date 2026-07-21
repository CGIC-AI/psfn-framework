import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import type { PolicyConfig } from '../policy.js';
import { registerShellMethods, resetShellCircuitBreakersForTests } from './shell.js';
import { GatewayErrors } from '../protocol.js';
import { ShellExecPolicyError } from '../../sandbox/execution/shell-runner.js';

type ShellExecutor = (typeof import('../../sandbox/execution/shell-runner.js'))[
  'executeShellCommandWithPolicy'
];

const shellRunnerMock = vi.hoisted(() => ({
  actualExecute: undefined as ShellExecutor | undefined,
  execute: vi.fn<ShellExecutor>(),
}));

vi.mock('../../sandbox/execution/shell-runner.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../sandbox/execution/shell-runner.js')>();
  shellRunnerMock.actualExecute = original.executeShellCommandWithPolicy;
  shellRunnerMock.execute.mockImplementation(original.executeShellCommandWithPolicy);
  return {
    ...original,
    executeShellCommandWithPolicy: shellRunnerMock.execute,
  };
});

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
    sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'test-shell-secret' } },
    notifyRequester: vi.fn(),
    listPendingConfirmations: () => [],
    listConfirmationHistory: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop', status: 'not_found', message: 'noop', executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'stream-1',
    audited: (_method, handler) => handler,
    approvalBoundary: { gate: options => async params => options.handler(params) } as any,
  };
  registerShellMethods(runtime);
  const method = methods.get('shell.exec');
  if (!method) throw new Error('shell.exec method was not registered');
  return { invoke: params => method(params) };
}

describe('registerShellMethods', () => {
  afterEach(() => {
    resetShellCircuitBreakersForTests();
    shellRunnerMock.execute.mockReset();
    shellRunnerMock.execute.mockImplementation(shellRunnerMock.actualExecute!);
  });

  it('maps an execution-policy rejection to a policy denial', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: true, allowlist: ['printf'], allowedCwd: [process.cwd()] },
    });
    await expect(harness.invoke({ command: 'bash', args: ['-c', 'printf never'] })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('command not allowlisted'),
    });
  });

  it('retains the explicit disabled-policy denial', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: false, allowlist: ['printf'], allowedCwd: [process.cwd()] },
    });
    await expect(harness.invoke({ command: 'printf', args: ['never'] })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('policy is disabled'),
    });
  });

  it('denies non-blacklisted evaluators and never turns policy denials into a circuit failure', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: true, allowlist: ['awk'], allowedCwd: [process.cwd()] },
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(harness.invoke({ command: 'awk', args: ['BEGIN { print 1 }'] }))
        .rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    }
  });

  it.each([
    ['non-zero exits', { exitCode: 1, timedOut: false }],
    ['timeouts', { exitCode: null, timedOut: true }],
  ])('does not open the circuit for repeated %s', async (_caseName, result) => {
    shellRunnerMock.execute.mockResolvedValue({
      ...result,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 1,
    });
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: true, allowlist: ['bash'], allowedCwd: [process.cwd()] },
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(harness.invoke({ command: 'bash', args: ['-lc', 'exit 1'] }))
        .resolves.toMatchObject(result);
    }
  });

  it('opens the circuit after repeated sandbox spawn failures', async () => {
    shellRunnerMock.execute.mockRejectedValue(
      new ShellExecPolicyError('shell.exec sandbox failed: spawn EACCES'),
    );
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: true, allowlist: ['bash'], allowedCwd: [process.cwd()] },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(harness.invoke({ command: 'bash', args: ['-lc', 'true'] }))
        .rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    }
    await expect(harness.invoke({ command: 'bash', args: ['-lc', 'true'] }))
      .rejects.toMatchObject({
        code: GatewayErrors.PROVIDER_ERROR,
        data: expect.objectContaining({ code: 'circuit_open' }),
      });
  });
});
