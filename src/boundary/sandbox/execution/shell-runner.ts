import type { ShellExecParams, ShellExecResult } from '../../gateway/protocol.js';
import type { ShellExecPolicyConfig } from './shell-policy-config.js';

export const SHELL_EXEC_CONFINEMENT_UNAVAILABLE =
  'shell.exec is unavailable because this runtime has no OS-enforced filesystem confinement';

export class ShellExecPolicyError extends Error {}

/**
 * `cwd`, argv inspection, executable allowlists, and canonical-path checks are
 * not an execution sandbox. Evaluators can hide file access inside program
 * text, and every pathname check races the later `execve(2)`/open performed by
 * a child. Until the production runtime supplies an enforceable open/exec
 * boundary (for example Landlock/openat2 or an equivalent container profile),
 * the only honest policy is to execute nothing.
 */
export async function executeShellCommandWithPolicy(
  _params: ShellExecParams,
  options: {
    workspacePath: string;
    policy: ShellExecPolicyConfig;
  },
): Promise<ShellExecResult> {
  if (options.policy.enabled !== true) {
    throw new ShellExecPolicyError('shell.exec policy is disabled');
  }
  throw new ShellExecPolicyError(SHELL_EXEC_CONFINEMENT_UNAVAILABLE);
}
