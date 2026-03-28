import type { ShellExecPolicyConfig } from '../boundary/gateway/policy.js';
import { executeShellCommandWithPolicy } from '../execution/shell-runner.js';
import type { SandboxExecutionPort } from './sandbox-capabilities/contracts.js';

export function createSandboxBrokerExecutionPort(options: {
  workspacePath: string;
  policy: ShellExecPolicyConfig;
  brokerId?: string;
}): SandboxExecutionPort | null {
  if (options.policy.enabled !== true) {
    return null;
  }

  return {
    boundary: {
      kind: 'sandbox_broker',
      isolatedFromGatewaySecrets: true,
      ...(options.brokerId ? { brokerId: options.brokerId } : {}),
    },
    shellExec: async (command, args = [], execOptions = {}) => await executeShellCommandWithPolicy(
      {
        command,
        args,
        ...execOptions,
      },
      {
        workspacePath: options.workspacePath,
        policy: options.policy,
      },
    ),
  };
}
