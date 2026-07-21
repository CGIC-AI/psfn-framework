import {
  DEFAULT_REEXEC_RESTART_EXIT_CODE,
  type RuntimeRestartContract,
} from '../../system/lifecycle/runtime-mode.js';

/**
 * Resolve the process exit code to use when the startup gateway-connect retry
 * budget is exhausted.
 *
 * Exhausting the budget is a transient gateway-readiness condition, not a fatal
 * bug, so the agent must exit through the supervised restart path — the reexec
 * exit code (default {@link DEFAULT_REEXEC_RESTART_EXIT_CODE}) for the split
 * reexec wrapper, or a non-zero code that an external supervisor treats as a
 * restart signal — rather than crashing with a generic fatal exit(1). A fresh
 * process then re-attempts the connection once the gateway is up.
 */
export function resolveGatewayConnectFailureExitCode(restart: RuntimeRestartContract): number {
  if (restart.strategy === 'reexec') {
    return restart.exitCode ?? DEFAULT_REEXEC_RESTART_EXIT_CODE;
  }
  return DEFAULT_REEXEC_RESTART_EXIT_CODE;
}
