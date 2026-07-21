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
    '--unshare-net',
    '--cap-drop', 'ALL',
    '--clearenv',
  ];
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
    request.executableCommand,
    ...request.args,
  );
  return args;
}

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
    });
    let stdout = '';
    let stderr = '';
    let totalChars = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

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

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, request.timeoutMs);

    child.stdout.on('data', chunk => appendOutput('stdout', chunk));
    child.stderr.on('data', chunk => appendOutput('stderr', chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      rejectResult(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolveResult({
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        exitCode: timedOut ? null : code,
        stdout,
        stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export async function runBubblewrapCommand(
  request: ResolvedShellExecution,
): Promise<ShellExecResult> {
  return await runBounded(request, buildBubblewrapArgs(request));
}
