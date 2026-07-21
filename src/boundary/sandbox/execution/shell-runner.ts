import type { ShellExecParams, ShellExecResult } from '../../gateway/protocol.js';
import { runBubblewrapCommand } from './bubblewrap-runner.js';
import {
  resolveShellExecution,
  ShellExecPolicyError,
} from './shell-execution-policy.js';
import type { ShellExecPolicyConfig } from './shell-policy-config.js';

export { ShellExecPolicyError } from './shell-execution-policy.js';

export async function executeShellCommandWithPolicy(
  params: ShellExecParams,
  options: {
    workspacePath: string;
    policy: ShellExecPolicyConfig;
  },
): Promise<ShellExecResult> {
  try {
    return await runBubblewrapCommand(resolveShellExecution(params, options));
  } catch (error) {
    if (error instanceof ShellExecPolicyError) throw error;
    throw new ShellExecPolicyError(
      `shell.exec sandbox failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
