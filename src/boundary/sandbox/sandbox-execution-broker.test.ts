import { describe, expect, it } from 'vitest';
import { createSandboxBrokerExecutionPort } from './sandbox-execution-broker.js';

describe('createSandboxBrokerExecutionPort', () => {
  it('returns null when shell execution policy is disabled', () => {
    const port = createSandboxBrokerExecutionPort({
      workspacePath: process.cwd(),
      policy: {
        enabled: false,
        allowlist: ['printf'],
        allowedCwd: [process.cwd()],
      },
    });

    expect(port).toBeNull();
  });

  it('keeps the broker metadata but fails closed without OS filesystem confinement', async () => {
    const port = createSandboxBrokerExecutionPort({
      workspacePath: process.cwd(),
      brokerId: 'test-broker',
      policy: {
        enabled: true,
        allowlist: ['printf'],
        allowedCwd: [process.cwd()],
      },
    });

    expect(port?.boundary).toEqual({
      kind: 'sandbox_broker',
      isolatedFromGatewaySecrets: true,
      brokerId: 'test-broker',
    });
    expect(port?.codeExecutionBoundary).toMatchObject({
      kind: 'child_process',
      isolatedFromGatewaySecrets: true,
      securityPosture: 'out_of_process_default_deny',
      protocol: 'analysis-workbench-child-v1',
      deniedCapabilities: expect.arrayContaining([
        'filesystem',
        'network',
        'process',
        'module_import',
        'global_escape',
      ]),
    });
    expect(port?.codeExecutionBoundary.reason).toContain('child process');

    await expect(port?.shellExec('printf', ['ok'], {}))
      .rejects.toThrow('no OS-enforced filesystem confinement');
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

    await expect(port?.shellExec('node', ['-v'], {}))
      .rejects.toThrow('no OS-enforced filesystem confinement');
  });

  it('does not inherit agent process secrets into brokered child commands', async () => {
    process.env.SANDBOX_BROKER_SECRET = 'should-not-leak';
    const port = createSandboxBrokerExecutionPort({
      workspacePath: process.cwd(),
      policy: {
        enabled: true,
        allowlist: ['printenv'],
        allowedCwd: [process.cwd()],
      },
    });

    try {
      await expect(port?.shellExec('printenv', ['SANDBOX_BROKER_SECRET'], {}))
        .rejects.toThrow('no OS-enforced filesystem confinement');
    } finally {
      delete process.env.SANDBOX_BROKER_SECRET;
    }
  });
});
