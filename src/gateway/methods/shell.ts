import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { ShellExecParams } from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import type { GatedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerGatedDescriptors } from './register.js';
import { executeShellCommandWithPolicy, ShellExecPolicyError } from '../../execution/shell-runner.js';
import { toErrorMessage } from '../../utils/errors.js';

const shellDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'shell.exec',
    handler: async (params: ShellExecParams, runtime: GatewayMethodRuntime) => {
      const policy = runtime.policyConfig.shellExec ?? {};
      try {
        return await executeShellCommandWithPolicy(params, {
          workspacePath: runtime.workspacePath,
          policy,
        });
      } catch (error) {
        if (error instanceof ShellExecPolicyError) {
          throw new JSONRPCErrorException(error.message, GatewayErrors.POLICY_DENIED);
        }
        throw new JSONRPCErrorException(
          `shell.exec failed: ${toErrorMessage(error)}`,
          GatewayErrors.PROVIDER_ERROR,
        );
      }
    },
    summary: (params: ShellExecParams) => ({
      command: params.command,
      argCount: Array.isArray(params.args) ? params.args.length : 0,
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
      maxOutputChars: params.maxOutputChars,
    }),
    approvalAction: 'shell.exec',
    approvalScope: (params: ShellExecParams) => params.command,
  },
];

export function registerShellMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, shellDescriptors);
}
