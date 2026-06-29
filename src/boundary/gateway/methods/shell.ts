import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { ShellExecParams } from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import type { GatedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerGatedDescriptors } from './register.js';
import { executeShellCommandWithPolicy, ShellExecPolicyError } from '../../sandbox/execution/shell-runner.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  type CircuitBreakerTransition,
  CircuitOpenError,
  SlidingWindowCircuitBreaker,
} from '../../../shared/resilience/circuit-breaker.js';

interface ShellExecResultLike {
  exitCode: number | null;
  timedOut: boolean;
}

const shellCircuitBreaker = new SlidingWindowCircuitBreaker({
  failureThreshold: 3,
  windowMs: 60_000,
  cooldownMs: 30_000,
});
const log = createComponentLogger('GatewayShell');

function shellCircuitKey(params: ShellExecParams, runtime: GatewayMethodRuntime): string {
  const command = params.command.trim().toLowerCase();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim()
    ? params.cwd.trim()
    : runtime.workspacePath;
  return `shell.exec::${command}::${cwd}`;
}

function shellFailureResult(result: ShellExecResultLike): Error | null {
  if (result.timedOut) {
    return new Error('shell.exec timed out');
  }
  if (result.exitCode === null || result.exitCode !== 0) {
    return new Error(`shell.exec exited with code ${String(result.exitCode)}`);
  }
  return null;
}

function toCircuitOpenJsonRpcError(error: CircuitOpenError): JSONRPCErrorException {
  return new JSONRPCErrorException(
    error.message,
    GatewayErrors.PROVIDER_ERROR,
    {
      code: error.code,
      circuitKey: error.circuitKey,
      method: error.method,
      state: error.state,
      failureCount: error.failureCount,
      failureThreshold: error.failureThreshold,
      windowMs: error.windowMs,
      cooldownMs: error.cooldownMs,
      openedAtMs: error.openedAtMs,
      openUntilMs: error.openUntilMs,
    },
  );
}

function logShellCircuitTransition(transition: CircuitBreakerTransition): void {
  const payload = {
    method: transition.method,
    circuitKey: transition.key,
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
    failureCount: transition.failureCount,
    failureThreshold: transition.failureThreshold,
    windowMs: transition.windowMs,
    cooldownMs: transition.cooldownMs,
    ...(transition.openUntilMs !== undefined ? {
      openUntil: new Date(transition.openUntilMs).toISOString(),
    } : {}),
    ...(transition.lastError ? { lastError: transition.lastError } : {}),
  };

  if (transition.to === 'open') {
    log.warn('Shell exec circuit breaker opened', payload);
    return;
  }
  log.info('Shell exec circuit breaker state changed', payload);
}

export function resetShellCircuitBreakersForTests(): void {
  shellCircuitBreaker.reset();
}

const shellDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'shell.exec',
    handler: async (params: ShellExecParams, runtime: GatewayMethodRuntime) => {
      const policy = runtime.policyConfig.shellExec ?? {};
      try {
        return await shellCircuitBreaker.execute({
          key: shellCircuitKey(params, runtime),
          method: 'shell.exec',
          operation: async () => executeShellCommandWithPolicy(params, {
            workspacePath: runtime.workspacePath,
            policy,
          }),
          isFailureResult: shellFailureResult,
          shouldRecordFailure: error => !(error instanceof ShellExecPolicyError),
          onTransition: logShellCircuitTransition,
        });
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          throw toCircuitOpenJsonRpcError(error);
        }
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
