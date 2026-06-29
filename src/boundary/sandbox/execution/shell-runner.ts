import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, normalize, resolve } from 'node:path';
import type { ShellExecParams, ShellExecResult } from '../../gateway/protocol.js';
import { resolveCanonicalPath } from '../../gateway/filesystem-paths.js';
import { isInsideAllowedPaths } from '../../gateway/policy.js';
import type { ShellExecPolicyConfig } from './shell-policy-config.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_MAX_OUTPUT_CHARS_CAP = 100_000;
const MAX_COMMAND_LENGTH = 256;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;
// ponytail: the sandbox child must not inherit the parent PATH. A poisoned PATH
// could shadow an allowlisted command name (e.g. a hostile `cat` earlier on
// PATH). Resolve commands AND run the child against this curated, system-safe
// PATH unless an operator override (SHELL_EXEC_PATH) is set.
const DEFAULT_SANDBOX_PATH = ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);
const SHELL_CANONICAL_PATH_OPTIONS = {
  missingPathBehavior: 'resolveParent',
  errorBehavior: 'returnNormalized',
} as const;
const SANDBOX_CHILD_ENV_ALLOWLIST = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PWD',
  'SHELL',
  'TERM',
  'TMP',
  'TMPDIR',
  'TEMP',
  'TZ',
  'USER',
] as const;

interface NormalizedShellAllowlist {
  names: Set<string>;
  canonicalPaths: Set<string>;
}

interface ResolvedAllowedShellRoots {
  logical: string[];
  canonical: string[];
}

export class ShellExecPolicyError extends Error {}

function normalizePositiveInt(value: unknown): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const parsed = Math.floor(Number(value));
  if (parsed <= 0) return undefined;
  return parsed;
}

function includesPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
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

function resolveExecutableFromPath(command: string, pathValue: string): string | null {
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

function resolveCurrentNodeExecutable(): string | null {
  try {
    accessSync(process.execPath, constants.X_OK);
    return realpathSync(process.execPath);
  } catch {
    return null;
  }
}

function buildSandboxChildEnv(
  requestedEnvVars: readonly string[],
  envAllowlist: readonly string[],
  sandboxPath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {};
  for (const key of SANDBOX_CHILD_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      nextEnv[key] = value;
    }
  }
  // PATH is deliberately not inherited; use the curated sandbox PATH.
  nextEnv.PATH = sandboxPath;

  const allowedEnvNames = new Set(envAllowlist.map((value) => value.trim()).filter(Boolean));
  for (const envVar of requestedEnvVars) {
    const trimmed = envVar.trim();
    if (!trimmed) continue;
    if (!allowedEnvNames.has(trimmed)) {
      throw new ShellExecPolicyError(`shell.exec env var not allowlisted: ${trimmed}`);
    }
    const value = env[trimmed];
    if (typeof value === 'string') {
      nextEnv[trimmed] = value;
    }
  }

  return nextEnv;
}

function resolveRequestedEnvVars(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ShellExecPolicyError('shell.exec envVars must be an array of strings');
  }
  const requested: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw new ShellExecPolicyError('shell.exec envVars must be an array of strings');
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('\0')) {
      throw new ShellExecPolicyError('shell.exec envVars entries must be non-empty strings');
    }
    requested.push(trimmed);
  }
  return requested;
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
    throw new ShellExecPolicyError('shell.exec args must be an array of strings');
  }
  if (raw.length > MAX_ARGS) {
    throw new ShellExecPolicyError(`shell.exec args exceed max length (${MAX_ARGS})`);
  }

  const args: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new ShellExecPolicyError('shell.exec args must be an array of strings');
    }
    if (item.length > MAX_ARG_LENGTH || item.includes('\0')) {
      throw new ShellExecPolicyError(
        `shell.exec argument too large or invalid (max ${MAX_ARG_LENGTH} chars)`,
      );
    }
    args.push(item);
  }
  return args;
}

function resolveAllowedShellRoots(
  workspacePath: string,
  policy: ShellExecPolicyConfig,
): ResolvedAllowedShellRoots {
  const allowedRootsRaw = policy.allowedCwd && policy.allowedCwd.length > 0
    ? policy.allowedCwd
    : [workspacePath];
  const logical = allowedRootsRaw.map(path => resolve(normalize(path)));
  const canonical = logical.map(path => resolveCanonicalPath(path, SHELL_CANONICAL_PATH_OPTIONS));
  return { logical, canonical };
}

function resolveWorkingDirectory(
  rawCwd: unknown,
  workspacePath: string,
  allowedRoots: ResolvedAllowedShellRoots,
): string {
  const requestedCwd = typeof rawCwd === 'string' && rawCwd.trim()
    ? rawCwd.trim()
    : workspacePath;
  const resolvedCwd = resolve(normalize(requestedCwd));
  const canonicalCwd = resolveCanonicalPath(resolvedCwd, SHELL_CANONICAL_PATH_OPTIONS);
  if (!isInsideAllowedPaths(resolvedCwd, allowedRoots.logical)) {
    throw new ShellExecPolicyError(`shell.exec cwd not allowlisted: ${resolvedCwd}`);
  }
  if (!isInsideAllowedPaths(canonicalCwd, allowedRoots.canonical)) {
    throw new ShellExecPolicyError(`shell.exec cwd not allowlisted: ${canonicalCwd}`);
  }
  return canonicalCwd;
}

function trimMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return value.slice(1, -1);
  }
  return value;
}

function resolveArgumentPathCandidate(value: string, cwd: string): string {
  const normalized = normalize(value);
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(cwd, normalized);
}

function collectArgumentPathCandidates(arg: string): string[] {
  const candidates = new Set<string>();
  const trimmed = arg.trim();
  if (trimmed) {
    candidates.add(trimmed);
  }

  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex >= 0 && equalsIndex < trimmed.length - 1) {
    const value = trimMatchingQuotes(trimmed.slice(equalsIndex + 1).trim());
    if (value) {
      candidates.add(value);
    }
  }

  return [...candidates];
}

function assertArgumentPathsAllowed(
  args: readonly string[],
  cwd: string,
  allowedRoots: ResolvedAllowedShellRoots,
): void {
  for (const arg of args) {
    for (const candidate of collectArgumentPathCandidates(arg)) {
      const resolvedPath = resolveArgumentPathCandidate(candidate, cwd);
      const canonicalPath = resolveCanonicalPath(resolvedPath, SHELL_CANONICAL_PATH_OPTIONS);
      if (!isInsideAllowedPaths(resolvedPath, allowedRoots.logical)) {
        throw new ShellExecPolicyError(`shell.exec argument path not allowlisted: ${resolvedPath}`);
      }
      if (!isInsideAllowedPaths(canonicalPath, allowedRoots.canonical)) {
        throw new ShellExecPolicyError(`shell.exec argument path not allowlisted: ${canonicalPath}`);
      }
    }
  }
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

function resolveAllowedCommandExecutable(
  command: string,
  allowlist: readonly string[],
  sandboxPath: string,
): string {
  if (!command) {
    throw new ShellExecPolicyError('shell.exec command is required');
  }
  if (command.includes('\0') || command.length > MAX_COMMAND_LENGTH) {
    throw new ShellExecPolicyError(
      `shell.exec command too large or invalid (max ${MAX_COMMAND_LENGTH} chars)`,
    );
  }
  const normalizedAllowlist = normalizeAllowlist(allowlist);
  if (normalizedAllowlist.names.size === 0 && normalizedAllowlist.canonicalPaths.size === 0) {
    throw new ShellExecPolicyError('shell.exec allowlist is empty');
  }

  const commandIsPath = includesPathSeparator(command) || isAbsolute(command);
  const canonicalCommand = commandIsPath
    ? resolveCanonicalExecutablePath(command)
    : resolveExecutableFromPath(command, sandboxPath);
  const commandLower = command.toLowerCase();
  const currentNodeExecutable = commandLower === 'node'
    ? resolveCurrentNodeExecutable()
    : null;

  if (!commandIsPath) {
    if (normalizedAllowlist.names.has(commandLower)) {
      const resolvedCommand = canonicalCommand ?? currentNodeExecutable;
      if (resolvedCommand) {
        return resolvedCommand;
      }
      throw new ShellExecPolicyError(`shell.exec command not executable or not found: ${command}`);
    }
    if (canonicalCommand && normalizedAllowlist.canonicalPaths.has(canonicalCommand)) {
      return canonicalCommand;
    }
    throw new ShellExecPolicyError(`shell.exec command not allowlisted: ${command}`);
  }

  if (!canonicalCommand) {
    throw new ShellExecPolicyError(`shell.exec command not executable or not found: ${command}`);
  }

  if (normalizedAllowlist.canonicalPaths.has(canonicalCommand)) {
    return canonicalCommand;
  }

  const canonicalBase = basename(canonicalCommand).toLowerCase();
  if (normalizedAllowlist.names.has(canonicalBase)) {
    const expectedCanonical = resolveExecutableFromPath(canonicalBase, sandboxPath);
    if (
      (expectedCanonical && expectedCanonical === canonicalCommand)
      || (canonicalBase === 'node' && currentNodeExecutable === canonicalCommand)
    ) {
      return canonicalCommand;
    }
  }

  throw new ShellExecPolicyError(`shell.exec command not allowlisted: ${command}`);
}

async function runCommandBounded(
  command: string,
  executableCommand: string,
  args: string[],
  cwd: string,
  limits: { timeoutMs: number; maxOutputChars: number },
  childEnv: NodeJS.ProcessEnv,
): Promise<ShellExecResult> {
  const startedAt = Date.now();
  return await new Promise<ShellExecResult>((resolveResult, rejectResult) => {
    const child = spawn(executableCommand, args, {
      cwd,
      env: childEnv,
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

export async function executeShellCommandWithPolicy(
  params: ShellExecParams,
  options: {
    workspacePath: string;
    policy: ShellExecPolicyConfig;
  },
): Promise<ShellExecResult> {
  const { workspacePath, policy } = options;
  if (policy.enabled !== true) {
    throw new ShellExecPolicyError('shell.exec policy is disabled');
  }

  const sandboxPath = policy.pathOverride ?? DEFAULT_SANDBOX_PATH;
  const command = resolveCommand(params.command);
  const executableCommand = resolveAllowedCommandExecutable(command, policy.allowlist ?? [], sandboxPath);
  const args = resolveArgs(params.args);
  const allowedRoots = resolveAllowedShellRoots(workspacePath, policy);
  const cwd = resolveWorkingDirectory(params.cwd, workspacePath, allowedRoots);
  assertArgumentPathsAllowed(args, cwd, allowedRoots);
  const limits = resolveBoundedExecutionPolicy(params, policy);
  const requestedEnvVars = resolveRequestedEnvVars((params as { envVars?: unknown }).envVars);
  const childEnv = buildSandboxChildEnv(requestedEnvVars, policy.envAllowlist ?? [], sandboxPath);
  return await runCommandBounded(command, executableCommand, args, cwd, limits, childEnv);
}
