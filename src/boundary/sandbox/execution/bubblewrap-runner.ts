import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ShellExecResult } from '../../gateway/protocol.js';
import {
  SANDBOX_REPOSITORY_MOUNT_TARGET,
  type ResolvedShellExecution,
} from './shell-execution-policy.js';

export const READ_ONLY_ETC_PATHS = [
  '/etc/alternatives',
  '/etc/ca-certificates',
  '/etc/group',
  '/etc/hosts',
  '/etc/ld.so.cache',
  '/etc/nsswitch.conf',
  '/etc/passwd',
  '/etc/resolv.conf',
  '/etc/ssl',
] as const;

function appendReadOnlyEtcBindings(args: string[]): void {
  args.push('--dir', '/etc');
  for (const path of READ_ONLY_ETC_PATHS) {
    if (existsSync(path)) args.push('--ro-bind', path, path);
  }
}

export function buildBubblewrapArgs(request: ResolvedShellExecution): string[] {
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
  ];
  if (!request.networkAccess) args.push('--unshare-net');
  args.push('--cap-drop', 'ALL', '--clearenv');
  for (const [name, value] of Object.entries(request.childEnv).sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    if (typeof value === 'string') args.push('--setenv', name, value);
  }
  args.push(
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/usr/local', '/usr/local',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/sbin', '/sbin',
  );
  appendReadOnlyEtcBindings(args);
  args.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--dir', '/workspace',
    '--bind', request.workspacePath, '/workspace',
  );
  if (request.repositoryMountPath) {
    args.push('--ro-bind', request.repositoryMountPath, SANDBOX_REPOSITORY_MOUNT_TARGET);
  }
  // hrmrq.54: mask quarantined-artifact files AFTER the workspace/repo binds
  // so the /dev/null mount shadows the real bytes. This is the physical
  // backstop for argv shapes the gateway descriptor cannot parse (cp, pipes,
  // globs, here-docs): inside the sandbox the file exists but reads empty.
  for (const shadowPath of request.shadowReadPaths ?? []) {
    args.push('--ro-bind', '/dev/null', shadowPath);
  }
  args.push(
    '--chdir', request.sandboxCwd,
    '--',
    request.resourceLimitBinaryPath,
    `--nproc=${request.maxProcesses}:${request.maxProcesses}`,
    `--as=${request.maxAddressSpaceBytes}:${request.maxAddressSpaceBytes}`,
    `--fsize=${request.maxFileBytes}:${request.maxFileBytes}`,
    `--cpu=${request.maxCpuSeconds}:${request.maxCpuSeconds}`,
    `--nofile=${request.maxOpenFiles}:${request.maxOpenFiles}`,
    '--core=0:0',
    '--',
    // Kernel-enforced policy deadline, inside the sandbox. The `timeout`
    // supervisor's alarm is kernel-delivered, so it fires even when the agent
    // process's event loop is starved (JS timers do not). When it KILLs the
    // command and exits, bubblewrap's namespace-init exits with it, and the
    // kernel tears down the PID namespace, SIGKILLing every remaining
    // descendant — no orphan can survive or hold our stdio pipes open. The
    // command path is canonical-absolute, so no `--` separator is needed (and
    // keeping it out stays compatible with both GNU and uutils coreutils).
    request.deadlineBinaryPath,
    '--signal=KILL',
    formatDeadlineSeconds(request.timeoutMs),
    request.executableCommand,
    ...request.args,
  );
  return args;
}

/** `timeout` duration in seconds; both GNU and uutils accept fractions. */
function formatDeadlineSeconds(timeoutMs: number): string {
  return (timeoutMs / 1000).toFixed(3);
}

/**
 * Bounded wait between the sandbox host's `exit` and its stdio `close`.
 * `close` only fires once every holder of the stdout/stderr pipes is gone;
 * a sandbox descendant that briefly outlives the host must not be able to
 * hang the run promise on that drain (observed pre-fix as an unbounded
 * `shell.exec` hang under load; bead ijtak.6).
 */
const STREAM_DRAIN_GRACE_MS = 500;

function runBounded(
  request: ResolvedShellExecution,
  bubblewrapArgs: string[],
): Promise<ShellExecResult> {
  const startedAt = Date.now();
  return new Promise<ShellExecResult>((resolveResult, rejectResult) => {
    const child = spawn(request.sandboxBinaryPath, bubblewrapArgs, {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Give the sandbox host its own process group/session so the deadline
      // escalation below can SIGKILL the group without touching this process.
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let totalChars = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let hostExited = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const appendOutput = (target: 'stdout' | 'stderr', value: Buffer | string): void => {
      const text = typeof value === 'string' ? value : value.toString('utf8');
      const remaining = request.maxOutputChars - totalChars;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const next = text.length > remaining ? text.slice(0, remaining) : text;
      totalChars += next.length;
      if (target === 'stdout') stdout += next;
      else stderr += next;
      if (next.length < text.length) truncated = true;
    };

    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      complete();
    };

    const killSandboxProcessGroup = (): void => {
      // Once the host is reaped its PID (and group id) may be recycled, so
      // never signal after `exit`; the in-sandbox kernel deadline owns any
      // remaining cleanup from there.
      if (hostExited || typeof child.pid !== 'number') return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; // group already gone
        settle(() => rejectResult(error instanceof Error ? error : new Error(String(error))));
      }
    };

    // Best-effort escalation only: JS timers starve with the event loop. The
    // authoritative deadline is the in-sandbox `timeout --signal=KILL` (see
    // buildBubblewrapArgs), whose kill and namespace teardown the kernel
    // enforces regardless of this process's liveness.
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      killSandboxProcessGroup();
    }, request.timeoutMs);

    const finalize = (code: number | null, signal: NodeJS.Signals | null): void => settle(() => {
      const deadlineElapsed = Date.now() - startedAt >= request.timeoutMs;
      // Detect a deadline kill even when the JS timer above never fired
      // (starved event loop): GNU coreutils `timeout --signal=KILL` exits 137,
      // uutils coreutils exits 124, and the host-group escalation surfaces as
      // SIGKILL. Any of these after the policy deadline elapsed is a timeout.
      const killedAtDeadline = timedOut
        || (deadlineElapsed && (code === 124 || code === 137 || signal === 'SIGKILL'));
      resolveResult({
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        exitCode: killedAtDeadline ? null : code,
        stdout,
        stderr,
        timedOut: killedAtDeadline,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });

    child.stdout.on('data', chunk => appendOutput('stdout', chunk));
    child.stderr.on('data', chunk => appendOutput('stderr', chunk));
    child.once('error', (error) => {
      settle(() => rejectResult(error));
    });
    child.once('exit', (code, signal) => {
      hostExited = true;
      if (settled) return;
      // `close` waits for stdio to drain; bound that wait so a pipe-holding
      // straggler can never hang the run promise. Normal runs settle via
      // `close` immediately after `exit` and cancel this timer.
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finalize(code, signal);
      }, STREAM_DRAIN_GRACE_MS);
    });
    child.once('close', (code, signal) => finalize(code, signal));
  });
}

export async function runBubblewrapCommand(
  request: ResolvedShellExecution,
): Promise<ShellExecResult> {
  return await runBounded(request, buildBubblewrapArgs(request));
}
