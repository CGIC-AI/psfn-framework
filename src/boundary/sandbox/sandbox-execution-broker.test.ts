import { describe, expect, it } from 'vitest';
import { createSandboxBrokerExecutionPort } from './sandbox-execution-broker.js';

describe('createSandboxBrokerExecutionPort', () => {
  it('returns null when shell execution policy is disabled', () => {
    const port = createSandboxBrokerExecutionPort({
      workspacePath: process.cwd(),
      policy: {
        enabled: false,
        allowlist: ['node'],
        allowedCwd: [process.cwd()],
      },
    });

    expect(port).toBeNull();
  });

  it('executes allowlisted commands through the broker boundary', async () => {
    const port = createSandboxBrokerExecutionPort({
      workspacePath: process.cwd(),
      brokerId: 'test-broker',
      policy: {
        enabled: true,
        allowlist: ['node'],
        allowedCwd: [process.cwd()],
      },
    });

    expect(port?.boundary).toEqual({
      kind: 'sandbox_broker',
      isolatedFromGatewaySecrets: true,
      brokerId: 'test-broker',
    });

    const result = await port?.shellExec('node', ['-e', 'process.stdout.write("ok")'], {});

    expect(result).toMatchObject({
      command: 'node',
      args: ['-e', 'process.stdout.write("ok")'],
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
    });
  });

  it('fails closed when the brokered command is not allowlisted', async () => {
    const port = createSandboxBrokerExecutionPort({
      workspacePath: process.cwd(),
      policy: {
        enabled: true,
        allowlist: ['bash'],
        allowedCwd: [process.cwd()],
      },
    });

    await expect(port?.shellExec('node', ['-v'], {})).rejects.toThrow('not allowlisted');
  });

  it('does not inherit agent process secrets into brokered child commands', async () => {
    process.env.SANDBOX_BROKER_SECRET = 'should-not-leak';
    const port = createSandboxBrokerExecutionPort({
      workspacePath: process.cwd(),
      policy: {
        enabled: true,
        allowlist: ['node'],
        allowedCwd: [process.cwd()],
      },
    });

    try {
      const result = await port?.shellExec(
        'node',
        ['-e', 'process.stdout.write(process.env.SANDBOX_BROKER_SECRET ?? "missing")'],
        {},
      );

      expect(result?.stdout).toBe('missing');
    } finally {
      delete process.env.SANDBOX_BROKER_SECRET;
    }
  });
});
