import { JSONRPCErrorException } from 'json-rpc-2.0';
import { isAbsolute, resolve } from 'node:path';
import type { ShellExecParams, ShellExecResult } from '../protocol.js';
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

function shouldRecordShellFailure(error: Error): boolean {
  if (!(error instanceof ShellExecPolicyError)) return true;
  return error.message.startsWith('shell.exec sandbox failed:');
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

/** Cap on quarantine-guard lookups per shell.exec call (each loads the store file). */
const MAX_GUARD_PATH_CANDIDATES = 128;

/**
 * Best-effort path candidates named by a shell.exec request: the resolved
 * cwd, every argv entry, and the whitespace-separated tokens inside each
 * entry (so `bash -lc "cat ./doc.pdf"` surfaces `./doc.pdf`). Relative
 * tokens resolve against the resolved cwd. Argv shapes this parse cannot
 * see are covered by the bwrap /dev/null shadow binds (hrmrq.54).
 */
function collectShellPathCandidates(
  params: ShellExecParams,
  workspacePath: string,
): string[] {
  const requestedCwd = typeof params.cwd === 'string' && params.cwd.trim()
    ? params.cwd.trim()
    : workspacePath;
  const resolvedCwd = isAbsolute(requestedCwd)
    ? resolve(requestedCwd)
    : resolve(workspacePath, requestedCwd);
  const candidates = new Set<string>([resolvedCwd]);
  const tokens: string[] = [];
  for (const arg of Array.isArray(params.args) ? params.args : []) {
    if (typeof arg !== 'string') continue;
    tokens.push(arg);
    for (const token of arg.split(/\s+/u)) tokens.push(token);
  }
  for (const raw of tokens) {
    if (candidates.size >= MAX_GUARD_PATH_CANDIDATES) break;
    const token = raw.replace(/^["']+/u, '').replace(/["';|&]+$/u, '').trim();
    if (!token || token.startsWith('-') || token.length > 4096) continue;
    candidates.add(isAbsolute(token) ? resolve(token) : resolve(resolvedCwd, token));
  }
  return [...candidates];
}

/**
 * hrmrq.54 shell seam: consult the quarantined-artifact guard for every path
 * the request names BEFORE anything executes. A withheld verdict returns the
 * fixed quarantine notice as a failed exec result (the attempt is recorded on
 * the Garden queue entry by the guard) — the sandbox never launches.
 */
function checkShellQuarantinedArtifacts(
  params: ShellExecParams,
  runtime: GatewayMethodRuntime,
): ShellExecResult | null {
  const guard = runtime.quarantinedArtifactGuard;
  if (!guard) return null;
  for (const candidate of collectShellPathCandidates(params, runtime.workspacePath)) {
    const verdict = guard.check(candidate, { via: 'gateway:shell.exec' });
    if (!verdict.withheld) continue;
    log.warn('shell.exec withheld: request names a quarantined artifact', {
      envelopeId: verdict.envelopeId,
      command: params.command,
    });
    return {
      command: params.command,
      args: Array.isArray(params.args) ? params.args : [],
      cwd: typeof params.cwd === 'string' && params.cwd.trim()
        ? params.cwd.trim()
        : runtime.workspacePath,
      exitCode: 1,
      stdout: '',
      stderr: verdict.noticeText,
      timedOut: false,
      truncated: false,
      durationMs: 0,
    };
  }
  return null;
}

const shellDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'shell.exec',
    handler: async (params: ShellExecParams, runtime: GatewayMethodRuntime) => {
      const policy = runtime.policyConfig.shellExec ?? {};
      try {
        // hrmrq.54 (a): descriptor-level guard — parseable artifact reads are
        // withheld with the quarantine notice and an audited attempt.
        const withheldResult = checkShellQuarantinedArtifacts(params, runtime);
        if (withheldResult) return withheldResult;
        // hrmrq.54 (b): physical backstop — every active quarantined artifact
        // is /dev/null-shadowed inside the sandbox (enforce mode), covering
        // argv shapes the descriptor cannot parse. An unenumerable deny set
        // throws here and fails the exec closed.
        const quarantinedArtifactPaths =
          runtime.quarantinedArtifactGuard?.listEnforcedArtifactPaths() ?? [];
        return await shellCircuitBreaker.execute({
          key: shellCircuitKey(params, runtime),
          method: 'shell.exec',
          operation: async () => executeShellCommandWithPolicy(params, {
            workspacePath: runtime.workspacePath,
            policy,
            ...(quarantinedArtifactPaths.length > 0 ? { quarantinedArtifactPaths } : {}),
          }),
          shouldRecordFailure: shouldRecordShellFailure,
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
