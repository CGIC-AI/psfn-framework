import { JSONRPCErrorException } from 'json-rpc-2.0';
import { opendir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ShellExecParams, ShellExecResult } from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import { defineGatedMethod, type GatewayMethodRuntime } from './types.js';
import { gatewayMethodParamDecoders } from './params.js';
import { registerGatedDescriptors } from './register.js';
import { executeShellCommandWithPolicy, ShellExecPolicyError } from '../../sandbox/execution/shell-runner.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  type CircuitBreakerTransition,
  CircuitOpenError,
  SlidingWindowCircuitBreaker,
} from '../../../shared/resilience/circuit-breaker.js';
import { MAX_LIST_MAX_SCANNED_ENTRIES } from '../../integrations/filesystem/workspace-ops.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../../core/cogsec/intake-firewall-notice-templates.js';

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
const MAX_SHELL_QUARANTINE_SCANNED_ENTRIES = MAX_LIST_MAX_SCANNED_ENTRIES * 10;

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

/**
 * Find every path inside a sandbox-visible root that currently names a held
 * inode. Registered names alone are insufficient: a hardlink can be reached
 * through variable expansion or a recursive shell program without ever
 * appearing in argv. Enumeration is deliberately bounded and fail-closed.
 */
async function findQuarantinedArtifactAliases(
  roots: readonly string[],
  identities: readonly string[],
): Promise<Array<{ path: string; identity: string }>> {
  if (identities.length === 0) return [];
  const held = new Set(identities);
  const aliases = new Map<string, string>();
  const uniqueRoots = [...new Set(roots.map(root => resolve(root)))];
  let scanned = 0;
  for (const root of uniqueRoots) {
    const pendingDirectories = [root];
    while (pendingDirectories.length > 0) {
      const directoryPath = pendingDirectories.pop()!;
      let directory;
      try {
        directory = await opendir(directoryPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw error;
      }
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > MAX_SHELL_QUARANTINE_SCANNED_ENTRIES) {
          throw new Error(
            'Quarantined-artifact sandbox scan exceeded '
            + `${String(MAX_SHELL_QUARANTINE_SCANNED_ENTRIES)} entries`,
          );
        }
        const path = join(directoryPath, entry.name);
        try {
          // Follow directory symlinks too: the sandbox can traverse their
          // logical spelling, so every such alias must be considered. Cycles
          // exhaust the bounded scan and fail the launch closed.
          const stats = await stat(path, { bigint: true });
          if (stats.isDirectory()) pendingDirectories.push(path);
          const identity = `${stats.dev.toString()}:${stats.ino.toString()}:${stats.birthtimeNs.toString()}`;
          if (held.has(identity)) aliases.set(path, identity);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        }
      }
    }
  }
  return [...aliases].map(([path, identity]) => ({ path, identity }));
}

const shellDescriptors = [
  defineGatedMethod({
    name: 'shell.exec',
    decode: gatewayMethodParamDecoders['shell.exec'],
    prePolicyGuard: (params: ShellExecParams, runtime) => {
      const guard = runtime.personaMutationAttemptGuard;
      if (!guard) return;
      const detections = guard.inspectShellMutation({
        companionId: runtime.authenticatedCompanionId() ?? '',
        params,
        workspacePath: runtime.workspacePath,
      });
      if (detections.length > 0) {
        throw new JSONRPCErrorException(
          'Direct persona mutation is blocked; use the governed identity tool.',
          GatewayErrors.POLICY_DENIED,
        );
      }
    },
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
        const guard = runtime.quarantinedArtifactGuard;
        const launchRevision = guard?.readRevisionToken();
        const registeredArtifactPaths = guard?.listEnforcedArtifactPaths() ?? [];
        const artifactIdentities = guard?.listEnforcedArtifactIdentities() ?? [];
        const repositoryRoot = policy.mountRepositoryReadOnly === true
          ? policy.repositoryMountSource?.trim()
          : undefined;
        const aliases = await findQuarantinedArtifactAliases(
          [runtime.workspacePath, ...(repositoryRoot ? [repositoryRoot] : [])],
          artifactIdentities,
        );
        const quarantinedArtifactPaths = [...new Set([
          ...registeredArtifactPaths,
          ...aliases.map(alias => alias.path),
        ])];
        if (quarantinedArtifactPaths.length > 0) {
          // Arbitrary shell programs can discover files without spelling a
          // path in argv (`grep -R`, globs, find -exec, variable expansion).
          // The sandbox masks every active path physically; conservatively
          // audit that masked exposure set as part of this exec so such a
          // residual attempt is never invisible to the operator. The seam
          // label distinguishes this preflight evidence from an exact-path
          // descriptor denial.
          guard!.checkMany(quarantinedArtifactPaths, {
            via: 'gateway:shell.exec:masked-backstop',
          });
        }
        const result = await shellCircuitBreaker.execute({
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
        if (guard && launchRevision !== guard.readRevisionToken()) {
          // A hold can land while a long-running shell is active. The initial
          // mask cannot cover a newly registered path, so discard every output
          // bit (including exit-code oracles) and conservatively audit the
          // current deny set before the result reaches the turn.
          const currentPaths = guard.listEnforcedArtifactPaths();
          if (currentPaths.length > 0) {
            guard.checkMany(currentPaths, { via: 'gateway:shell.exec:revision-race' });
          }
          return {
            command: params.command,
            args: Array.isArray(params.args) ? params.args : [],
            cwd: typeof params.cwd === 'string' && params.cwd.trim()
              ? params.cwd.trim()
              : runtime.workspacePath,
            exitCode: 1,
            stdout: '',
            stderr: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
            timedOut: false,
            truncated: false,
            durationMs: result.durationMs,
          };
        }
        return result;
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
  }),
];

export function registerShellMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, shellDescriptors);
}
