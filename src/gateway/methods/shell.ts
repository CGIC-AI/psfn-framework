import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { ShellExecParams, ShellExecResult } from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import { isInsideAllowedPaths, type ShellExecPolicyConfig } from '../policy.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { registerGatedDescriptors } from './register.js';
import { toErrorMessage } from '../../utils/errors.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_MAX_OUTPUT_CHARS_CAP = 100_000;
const MAX_COMMAND_LENGTH = 256;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;

interface NormalizedShellAllowlist {
  names: Set<string>;
  canonicalPaths: Set<string>;
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const parsed = Math.floor(Number(value));
  if (parsed <= 0) return undefined;
  return parsed;
}

function includesPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function resolveCanonicalPath(pathValue: string): string {
  const normalized = resolve(normalize(pathValue));
  try {
    return realpathSync(normalized);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      try {
        const parent = realpathSync(dirname(normalized));
        return resolve(parent, basename(normalized));
      } catch {
        return normalized;
      }
    }
    return normalized;
  }
}

function resolveCanonicalExecutablePath(command: string): string | null {
  const absolute = resolve(normalize(command));
  try {
    accessSync(absolute, constants.X_OK);
    return realpathSync(absolute);
  } catch {
    return null;
  }
}

function resolveExecutableFromPath(command: string): string | null {
  const pathValue = process.env.PATH ?? '';
  const candidates = pathValue.split(delimiter).filter(Boolean);
  for (const candidateDir of candidates) {
    const candidate = join(candidateDir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep scanning PATH
    }
  }
  return null;
}

function normalizeAllowlist(values: readonly string[] | undefined): NormalizedShellAllowlist {
  const names = new Set<string>();
  const canonicalPaths = new Set<string>();
  if (!values || values.length === 0) {
    return { names, canonicalPaths };
  }

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (includesPathSeparator(trimmed) || isAbsolute(trimmed)) {
      const canonical = resolveCanonicalExecutablePath(trimmed);
      if (canonical) {
        canonicalPaths.add(canonical);
      }
      continue;
    }
    names.add(trimmed.toLowerCase());
  }

  return { names, canonicalPaths };
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
  const canonicalCwd = resolveCanonicalPath(resolvedCwd);
  const allowedRootsRaw = policy.allowedCwd && policy.allowedCwd.length > 0
    ? policy.allowedCwd
    : [runtime.workspacePath];
  const allowedRoots = allowedRootsRaw.map(path => resolve(normalize(path)));
  const canonicalAllowedRoots = allowedRoots.map(path => resolveCanonicalPath(path));
  if (!isInsideAllowedPaths(resolvedCwd, allowedRoots)) {
    throw new JSONRPCErrorException(
      `shell.exec cwd not allowlisted: ${resolvedCwd}`,
      GatewayErrors.POLICY_DENIED,
    );
  }
  if (!isInsideAllowedPaths(canonicalCwd, canonicalAllowedRoots)) {
    throw new JSONRPCErrorException(
      `shell.exec cwd not allowlisted: ${canonicalCwd}`,
      GatewayErrors.POLICY_DENIED,
    );
  }
  return canonicalCwd;
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
  if (normalizedAllowlist.names.size === 0 && normalizedAllowlist.canonicalPaths.size === 0) {
    throw new JSONRPCErrorException('shell.exec allowlist is empty', GatewayErrors.POLICY_DENIED);
  }

  const commandIsPath = includesPathSeparator(command) || isAbsolute(command);
  const canonicalCommand = commandIsPath
    ? resolveCanonicalExecutablePath(command)
    : resolveExecutableFromPath(command);
  const commandLower = command.toLowerCase();

  if (!commandIsPath) {
    if (normalizedAllowlist.names.has(commandLower)) {
      return;
    }
    if (canonicalCommand && normalizedAllowlist.canonicalPaths.has(canonicalCommand)) {
      return;
    }
    throw new JSONRPCErrorException(
      `shell.exec command not allowlisted: ${command}`,
      GatewayErrors.POLICY_DENIED,
    );
  }

  if (!canonicalCommand) {
    throw new JSONRPCErrorException(
      `shell.exec command not executable or not found: ${command}`,
      GatewayErrors.POLICY_DENIED,
    );
  }

  if (normalizedAllowlist.canonicalPaths.has(canonicalCommand)) {
    return;
  }

  const canonicalBase = basename(canonicalCommand).toLowerCase();
  if (normalizedAllowlist.names.has(canonicalBase)) {
    const expectedCanonical = resolveExecutableFromPath(canonicalBase);
    if (expectedCanonical && expectedCanonical === canonicalCommand) {
      return;
    }
  }

  throw new JSONRPCErrorException(
    `shell.exec command not allowlisted: ${command}`,
    GatewayErrors.POLICY_DENIED,
  );
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

    child.stdout.on('data', chunk => appendOutput('stdout', chunk));
    child.stderr.on('data', chunk => appendOutput('stderr', chunk));
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
