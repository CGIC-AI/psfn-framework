import { spawn } from 'node:child_process';
import { basename, normalize, resolve } from 'node:path';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { ShellExecParams, ShellExecResult } from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import { isInsideAllowedPaths, type ShellExecPolicyConfig } from '../policy.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { registerGatedDescriptors } from './register.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_MAX_OUTPUT_CHARS_CAP = 100_000;
const MAX_COMMAND_LENGTH = 256;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;

function normalizePositiveInt(value: unknown): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const parsed = Math.floor(Number(value));
  if (parsed <= 0) return undefined;
  return parsed;
}

function normalizeAllowlist(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [...new Set(
    values
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  )];
}

function resolveCommand(command: unknown): string {
  if (typeof command !== 'string') return '';
  return command.trim();
}

function resolveArgs(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new JSONRPCErrorException(
      'shell.exec args must be an array of strings',
      GatewayErrors.POLICY_DENIED,
    );
  }
  if (raw.length > MAX_ARGS) {
    throw new JSONRPCErrorException(
      `shell.exec args exceed max length (${MAX_ARGS})`,
      GatewayErrors.POLICY_DENIED,
    );
  }

  const args: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new JSONRPCErrorException(
        'shell.exec args must be an array of strings',
        GatewayErrors.POLICY_DENIED,
      );
    }
    if (item.length > MAX_ARG_LENGTH || item.includes('\0')) {
      throw new JSONRPCErrorException(
        `shell.exec argument too large or invalid (max ${MAX_ARG_LENGTH} chars)`,
        GatewayErrors.POLICY_DENIED,
      );
    }
    args.push(item);
  }
  return args;
}

function resolveWorkingDirectory(
  rawCwd: unknown,
  runtime: GatewayMethodRuntime,
  policy: ShellExecPolicyConfig,
): string {
  const requestedCwd = typeof rawCwd === 'string' && rawCwd.trim()
    ? rawCwd.trim()
    : runtime.workspacePath;
  const resolvedCwd = resolve(normalize(requestedCwd));
  const allowedRootsRaw = policy.allowedCwd && policy.allowedCwd.length > 0
    ? policy.allowedCwd
    : [runtime.workspacePath];
  const allowedRoots = allowedRootsRaw.map(path => resolve(normalize(path)));
  if (!isInsideAllowedPaths(resolvedCwd, allowedRoots)) {
    throw new JSONRPCErrorException(
      `shell.exec cwd not allowlisted: ${resolvedCwd}`,
      GatewayErrors.POLICY_DENIED,
    );
  }
  return resolvedCwd;
}

function resolveBoundedExecutionPolicy(
  params: ShellExecParams,
  policy: ShellExecPolicyConfig,
): { timeoutMs: number; maxOutputChars: number } {
  const maxTimeoutMs = normalizePositiveInt(policy.maxTimeoutMs) ?? DEFAULT_MAX_TIMEOUT_MS;
  const defaultTimeoutMs = normalizePositiveInt(policy.defaultTimeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const requestedTimeoutMs = normalizePositiveInt(params.timeoutMs);
  const timeoutMs = Math.min(requestedTimeoutMs ?? defaultTimeoutMs, maxTimeoutMs);

  const maxOutputCharsCap = normalizePositiveInt(policy.maxOutputChars) ?? DEFAULT_MAX_OUTPUT_CHARS_CAP;
  const defaultMaxOutputChars = normalizePositiveInt(policy.defaultMaxOutputChars) ?? DEFAULT_MAX_OUTPUT_CHARS;
  const requestedMaxOutputChars = normalizePositiveInt(params.maxOutputChars);
  const maxOutputChars = Math.min(requestedMaxOutputChars ?? defaultMaxOutputChars, maxOutputCharsCap);

  return { timeoutMs, maxOutputChars };
}

function assertCommandAllowed(command: string, allowlist: readonly string[]): void {
  if (!command) {
    throw new JSONRPCErrorException('shell.exec command is required', GatewayErrors.POLICY_DENIED);
  }
  if (command.includes('\0') || command.length > MAX_COMMAND_LENGTH) {
    throw new JSONRPCErrorException(
      `shell.exec command too large or invalid (max ${MAX_COMMAND_LENGTH} chars)`,
      GatewayErrors.POLICY_DENIED,
    );
  }
  const normalizedAllowlist = normalizeAllowlist(allowlist);
  if (normalizedAllowlist.length === 0) {
    throw new JSONRPCErrorException('shell.exec allowlist is empty', GatewayErrors.POLICY_DENIED);
  }

  const commandLower = command.toLowerCase();
  const commandBaseLower = basename(command).toLowerCase();
  if (!normalizedAllowlist.includes(commandLower) && !normalizedAllowlist.includes(commandBaseLower)) {
    throw new JSONRPCErrorException(
      `shell.exec command not allowlisted: ${command}`,
      GatewayErrors.POLICY_DENIED,
    );
  }
}

async function runCommandBounded(
  command: string,
  args: string[],
  cwd: string,
  limits: { timeoutMs: number; maxOutputChars: number },
): Promise<ShellExecResult> {
  const startedAt = Date.now();
  return await new Promise<ShellExecResult>((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let totalChars = 0;
    let truncated = false;
    let timedOut = false;

    const appendOutput = (target: 'stdout' | 'stderr', value: Buffer | string): void => {
      const text = typeof value === 'string' ? value : value.toString('utf8');
      if (!text) return;

      const remaining = limits.maxOutputChars - totalChars;
      if (remaining <= 0) {
        truncated = true;
        return;
      }

      const next = text.length > remaining ? text.slice(0, remaining) : text;
      totalChars += next.length;
      if (target === 'stdout') stdout += next;
      else stderr += next;

      if (next.length < text.length) {
        truncated = true;
      }
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, limits.timeoutMs);

    child.stdout?.on('data', chunk => appendOutput('stdout', chunk));
    child.stderr?.on('data', chunk => appendOutput('stderr', chunk));
    child.once('error', (error) => {
      clearTimeout(timeoutHandle);
      rejectResult(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeoutHandle);
      resolveResult({
        command,
        args,
        cwd,
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

const shellDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'shell.exec',
    handler: async (params: ShellExecParams, runtime) => {
      const policy = runtime.policyConfig.shellExec ?? {};

      const command = resolveCommand(params.command);
      assertCommandAllowed(command, policy.allowlist);
      const args = resolveArgs(params.args);
      const cwd = resolveWorkingDirectory(params.cwd, runtime, policy);
      const limits = resolveBoundedExecutionPolicy(params, policy);

      try {
        return await runCommandBounded(command, args, cwd, limits);
      } catch (error) {
        throw new JSONRPCErrorException(
          `shell.exec failed: ${error instanceof Error ? error.message : String(error)}`,
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
