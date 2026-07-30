import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { ShellExecParams } from '../../gateway/protocol.js';
import { isInsideAllowedPaths } from '../../gateway/policy.js';
import type { ShellExecPolicyConfig } from './shell-policy-config.js';
import { createDefaultShellExecSettings } from '../../../system/config/shell-exec-config.js';

const DEFAULT_SANDBOX_BINARY = '/usr/bin/bwrap';
const DEFAULT_RESOURCE_LIMIT_BINARY = '/usr/bin/prlimit';
const DEFAULT_DEADLINE_BINARY = '/usr/bin/timeout';
const DEFAULT_SANDBOX_PATH = ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);
const DEFAULT_SHELL_EXEC_SETTINGS = createDefaultShellExecSettings();
const MAX_COMMAND_LENGTH = 256;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;
const RESERVED_SANDBOX_ENV_VARS = new Set([
  'PATH',
  'HOME',
  'PWD',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
]);
const RESERVED_SANDBOX_ENV_PREFIXES = ['LD_', 'DYLD_'] as const;

interface NormalizedShellAllowlist {
  names: Set<string>;
  canonicalPaths: Set<string>;
}

interface RuntimeRootShellExecPolicy extends ShellExecPolicyConfig {
  systemDataRoot: string;
  companionDataRoot: string;
}

export const SANDBOX_REPOSITORY_MOUNT_TARGET = '/repo';

export interface ResolvedShellExecution {
  command: string;
  executableCommand: string;
  args: string[];
  workspacePath: string;
  /** Canonical host path bind-mounted read-only at /repo, when enabled. */
  repositoryMountPath?: string;
  cwd: string;
  sandboxCwd: string;
  sandboxBinaryPath: string;
  resourceLimitBinaryPath: string;
  /**
   * coreutils `timeout` binary that enforces the policy deadline inside the
   * sandbox. The kernel delivers its alarm and tears down the PID namespace
   * when it exits, so the deadline holds even when the agent process's event
   * loop is starved (see bubblewrap-runner.ts).
   */
  deadlineBinaryPath: string;
  sandboxPath: string;
  childEnv: NodeJS.ProcessEnv;
  /**
   * Sandbox-absolute file paths masked with a read-only /dev/null bind
   * (hrmrq.54): quarantined-artifact bytes the sandbox must be PHYSICALLY
   * unable to read, regardless of how the command names them (cat, cp,
   * pipes, globs — shapes no argv parser can enumerate).
   */
  shadowReadPaths?: string[];
  timeoutMs: number;
  maxOutputChars: number;
  maxProcesses: number;
  maxAddressSpaceBytes: number;
  maxFileBytes: number;
  maxCpuSeconds: number;
  maxOpenFiles: number;
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
  for (const candidateDir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(candidateDir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through the curated PATH.
    }
  }
  return null;
}

function normalizeAllowlist(values: readonly string[] | undefined): NormalizedShellAllowlist {
  const names = new Set<string>();
  const canonicalPaths = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (includesPathSeparator(trimmed) || isAbsolute(trimmed)) {
      const canonical = resolveCanonicalExecutablePath(trimmed);
      if (canonical) canonicalPaths.add(canonical);
      continue;
    }
    names.add(trimmed.toLowerCase());
  }
  return { names, canonicalPaths };
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
  if (!canonicalCommand) {
    if (!commandIsPath && !normalizedAllowlist.names.has(command.toLowerCase())) {
      throw new ShellExecPolicyError(`shell.exec command not allowlisted: ${command}`);
    }
    throw new ShellExecPolicyError(`shell.exec command not executable or not found: ${command}`);
  }
  if (!isInsideAllowedPaths(canonicalCommand, ['/usr', '/usr/local'])) {
    throw new ShellExecPolicyError(
      `shell.exec command must resolve to a read-only image executable: ${command}`,
    );
  }

  if (normalizedAllowlist.canonicalPaths.has(canonicalCommand)) return canonicalCommand;
  const canonicalBase = basename(canonicalCommand).toLowerCase();
  if (!normalizedAllowlist.names.has(canonicalBase)) {
    throw new ShellExecPolicyError(`shell.exec command not allowlisted: ${command}`);
  }
  const expectedCanonical = resolveExecutableFromPath(canonicalBase, sandboxPath);
  if (expectedCanonical !== canonicalCommand) {
    throw new ShellExecPolicyError(`shell.exec command not allowlisted: ${command}`);
  }
  return canonicalCommand;
}

function resolveArgs(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ShellExecPolicyError('shell.exec args must be an array of strings');
  }
  if (raw.length > MAX_ARGS) {
    throw new ShellExecPolicyError(`shell.exec args exceed max length (${MAX_ARGS})`);
  }

  return raw.map((item) => {
    if (typeof item !== 'string') {
      throw new ShellExecPolicyError('shell.exec args must be an array of strings');
    }
    if (item.length > MAX_ARG_LENGTH || item.includes('\0')) {
      throw new ShellExecPolicyError(
        `shell.exec argument too large or invalid (max ${MAX_ARG_LENGTH} chars)`,
      );
    }
    return item;
  });
}

function resolveExistingDirectory(path: string, field: string): string {
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) {
      throw new ShellExecPolicyError(`${field} must be a directory: ${canonical}`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof ShellExecPolicyError) throw error;
    throw new ShellExecPolicyError(`${field} is unavailable: ${path}`);
  }
}

function resolveWorkingDirectory(
  rawCwd: unknown,
  workspacePath: string,
  policy: ShellExecPolicyConfig,
): string {
  const requested = typeof rawCwd === 'string' && rawCwd.trim()
    ? rawCwd.trim()
    : workspacePath;
  const logicalCwd = isAbsolute(requested)
    ? resolve(normalize(requested))
    : resolve(workspacePath, normalize(requested));
  const cwd = resolveExistingDirectory(logicalCwd, 'shell.exec cwd');

  const allowedRoots = (policy.allowedCwd && policy.allowedCwd.length > 0
    ? policy.allowedCwd
    : [workspacePath])
    .map((root) => {
      const logicalRoot = isAbsolute(root)
        ? resolve(normalize(root))
        : resolve(workspacePath, normalize(root));
      const canonicalRoot = resolveExistingDirectory(logicalRoot, 'shell.exec allowed cwd');
      if (!isInsideAllowedPaths(canonicalRoot, [workspacePath])) {
        throw new ShellExecPolicyError(
          `shell.exec allowed cwd must remain inside the Personal Workspace: ${canonicalRoot}`,
        );
      }
      return canonicalRoot;
    });

  if (!isInsideAllowedPaths(cwd, allowedRoots)) {
    throw new ShellExecPolicyError(`shell.exec cwd not allowlisted: ${cwd}`);
  }
  return cwd;
}

function resolveRequestedEnvVars(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) {
    throw new ShellExecPolicyError('shell.exec envVars must be an array of strings');
  }
  return raw.map((value) => {
    const trimmed = String(value).trim();
    if (!trimmed || trimmed.includes('\0')) {
      throw new ShellExecPolicyError('shell.exec envVars entries must be non-empty strings');
    }
    return trimmed;
  });
}

function isReservedSandboxEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_SANDBOX_ENV_VARS.has(upper)
    || RESERVED_SANDBOX_ENV_PREFIXES.some(prefix => upper.startsWith(prefix));
}

function buildSandboxChildEnv(
  requestedEnvVars: readonly string[],
  envAllowlist: readonly string[],
  sandboxPath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: sandboxPath,
    HOME: '/workspace',
    PWD: '/workspace',
    SHELL: '/usr/bin/bash',
    USER: 'companion',
    LOGNAME: 'companion',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
  const allowed = new Set(envAllowlist.map(value => value.trim()).filter(Boolean));
  for (const name of requestedEnvVars) {
    if (isReservedSandboxEnvVar(name)) {
      throw new ShellExecPolicyError(`shell.exec env var is reserved and cannot be passed through: ${name}`);
    }
    if (!allowed.has(name)) {
      throw new ShellExecPolicyError(`shell.exec env var not allowlisted: ${name}`);
    }
    const value = env[name];
    if (typeof value === 'string') childEnv[name] = value;
  }
  return childEnv;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right
    || isInsideAllowedPaths(left, [right])
    || isInsideAllowedPaths(right, [left]);
}

/**
 * Resolve the read-only repository mount. Fail-closed: when the operator-owned
 * `mountRepositoryReadOnly` setting is true, a missing or unusable repository
 * checkout is an error, never a silent skip. The source must be a real
 * directory disjoint from the Personal Workspace and runtime data roots so
 * the mount can never widen the writable surface or expose privileged data
 * under a second name.
 */
function resolveRepositoryMount(
  policy: ShellExecPolicyConfig,
  workspacePath: string,
): string | undefined {
  if (policy.mountRepositoryReadOnly !== true) return undefined;
  const source = typeof policy.repositoryMountSource === 'string'
    ? policy.repositoryMountSource.trim()
    : '';
  if (!source) {
    throw new ShellExecPolicyError(
      'shell.exec repository mount is enabled but no repository checkout is configured (PSFN_REPOSITORY_DIR)',
    );
  }
  const canonical = resolveExistingDirectory(
    resolve(normalize(source)),
    'shell.exec repository mount',
  );
  if (pathsOverlap(canonical, workspacePath)) {
    throw new ShellExecPolicyError(
      `shell.exec repository mount must not overlap the Personal Workspace: ${canonical}`,
    );
  }
  const runtimePolicy = policy as RuntimeRootShellExecPolicy;
  for (const [label, configuredRoot] of [
    ['system-data', runtimePolicy.systemDataRoot],
    ['companion-data', runtimePolicy.companionDataRoot],
  ] as const) {
    if (typeof configuredRoot !== 'string' || !configuredRoot.trim()) {
      throw new ShellExecPolicyError(
        `shell.exec ${label} root is required when the repository mount is enabled`,
      );
    }
    const canonicalRoot = resolveExistingDirectory(
      resolve(normalize(configuredRoot.trim())),
      `shell.exec ${label} root`,
    );
    if (pathsOverlap(canonical, canonicalRoot)) {
      throw new ShellExecPolicyError(
        `shell.exec repository mount must not overlap the ${label} root: ${canonical}`,
      );
    }
  }
  return canonical;
}

function mapHostPathIntoSandbox(
  hostPath: string,
  workspacePath: string,
  repositoryMountPath: string | undefined,
): string | null {
  const workspaceRelative = relative(workspacePath, hostPath);
  if (
    workspaceRelative.length > 0
    && !workspaceRelative.startsWith('..')
    && !isAbsolute(workspaceRelative)
  ) {
    return `/workspace/${workspaceRelative.replaceAll('\\', '/')}`;
  }
  if (repositoryMountPath) {
    const repoRelative = relative(repositoryMountPath, hostPath);
    if (
      repoRelative.length > 0
      && !repoRelative.startsWith('..')
      && !isAbsolute(repoRelative)
    ) {
      return `${SANDBOX_REPOSITORY_MOUNT_TARGET}/${repoRelative.replaceAll('\\', '/')}`;
    }
  }
  // Outside every sandbox mount: the file is not visible inside the sandbox
  // at all, so there is nothing to mask.
  return null;
}

/**
 * Maps quarantined-artifact host paths (hrmrq.54) onto the sandbox paths that
 * must be masked with a /dev/null bind. Both the registered form and its
 * realpath are mapped, so a symlinked-prefix registration cannot leave the
 * canonical file readable (or vice versa). Exported for direct unit coverage
 * on hosts without the sandbox binary (resolveShellExecution requires bwrap).
 */
export function resolveShadowReadPaths(
  artifactPaths: readonly string[] | undefined,
  workspacePath: string,
  repositoryMountPath: string | undefined,
): string[] {
  const shadowPaths = new Set<string>();
  for (const raw of artifactPaths ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const resolved = resolve(normalize(raw.trim()));
    const candidates = new Set<string>([resolved]);
    try {
      candidates.add(realpathSync(resolved));
    } catch {
      // Missing file: the resolve()-normalized form is the only mappable name.
    }
    for (const candidate of candidates) {
      const mapped = mapHostPathIntoSandbox(candidate, workspacePath, repositoryMountPath);
      if (mapped) shadowPaths.add(mapped);
    }
  }
  return [...shadowPaths].sort();
}

function resolveRequiredRuntimeBinary(path: string, label: string): string {
  const canonical = resolveCanonicalExecutablePath(path);
  if (!canonical) {
    throw new ShellExecPolicyError(`shell.exec ${label} unavailable: ${path}`);
  }
  return canonical;
}

function resolveLimits(
  params: ShellExecParams,
  policy: ShellExecPolicyConfig,
): { timeoutMs: number; maxOutputChars: number } {
  const maxTimeoutMs = normalizePositiveInt(policy.maxTimeoutMs)
    ?? DEFAULT_SHELL_EXEC_SETTINGS.maxTimeoutMs;
  const defaultTimeoutMs = normalizePositiveInt(policy.defaultTimeoutMs)
    ?? DEFAULT_SHELL_EXEC_SETTINGS.defaultTimeoutMs;
  const timeoutMs = Math.min(
    normalizePositiveInt(params.timeoutMs) ?? defaultTimeoutMs,
    maxTimeoutMs,
  );

  const maxOutputCharsCap = normalizePositiveInt(policy.maxOutputChars)
    ?? DEFAULT_SHELL_EXEC_SETTINGS.maxOutputChars;
  const defaultMaxOutputChars = normalizePositiveInt(policy.defaultMaxOutputChars)
    ?? DEFAULT_SHELL_EXEC_SETTINGS.defaultMaxOutputChars;
  const maxOutputChars = Math.min(
    normalizePositiveInt(params.maxOutputChars) ?? defaultMaxOutputChars,
    maxOutputCharsCap,
  );
  return { timeoutMs, maxOutputChars };
}

function resolveResourceLimits(
  policy: ShellExecPolicyConfig,
): Pick<
  ResolvedShellExecution,
  | 'maxProcesses'
  | 'maxAddressSpaceBytes'
  | 'maxFileBytes'
  | 'maxCpuSeconds'
  | 'maxOpenFiles'
> {
  return {
    maxProcesses: normalizePositiveInt(policy.maxProcesses)
      ?? DEFAULT_SHELL_EXEC_SETTINGS.maxProcesses,
    maxAddressSpaceBytes: normalizePositiveInt(policy.maxAddressSpaceBytes)
      ?? DEFAULT_SHELL_EXEC_SETTINGS.maxAddressSpaceBytes,
    maxFileBytes: normalizePositiveInt(policy.maxFileBytes)
      ?? DEFAULT_SHELL_EXEC_SETTINGS.maxFileBytes,
    maxCpuSeconds: normalizePositiveInt(policy.maxCpuSeconds)
      ?? DEFAULT_SHELL_EXEC_SETTINGS.maxCpuSeconds,
    maxOpenFiles: normalizePositiveInt(policy.maxOpenFiles)
      ?? DEFAULT_SHELL_EXEC_SETTINGS.maxOpenFiles,
  };
}

export function resolveShellExecution(
  params: ShellExecParams,
  options: {
    workspacePath: string;
    policy: ShellExecPolicyConfig;
    /**
     * Host paths of quarantined-artifact files (hrmrq.54) the sandbox must
     * not be able to read; mapped to /dev/null shadow binds when they fall
     * inside a sandbox mount.
     */
    quarantinedArtifactPaths?: readonly string[];
  },
): ResolvedShellExecution {
  if (options.policy.enabled !== true) {
    throw new ShellExecPolicyError('shell.exec policy is disabled');
  }

  const workspacePath = resolveExistingDirectory(
    resolve(normalize(options.workspacePath)),
    'shell.exec Personal Workspace',
  );
  const sandboxPath = DEFAULT_SANDBOX_PATH;
  const command = typeof params.command === 'string' ? params.command.trim() : '';
  const executableCommand = resolveAllowedCommandExecutable(
    command,
    options.policy.allowlist ?? [],
    sandboxPath,
  );
  const args = resolveArgs(params.args);
  const cwd = resolveWorkingDirectory(params.cwd, workspacePath, options.policy);
  const cwdRelative = relative(workspacePath, cwd);
  if (cwdRelative.startsWith('..') || isAbsolute(cwdRelative)) {
    throw new ShellExecPolicyError(`shell.exec cwd not allowlisted: ${cwd}`);
  }
  const sandboxCwd = cwdRelative
    ? `/workspace/${cwdRelative.replaceAll('\\', '/')}`
    : '/workspace';
  const requestedEnvVars = resolveRequestedEnvVars(params.envVars);
  const childEnv = buildSandboxChildEnv(
    requestedEnvVars,
    options.policy.envAllowlist ?? [],
    sandboxPath,
  );
  const repositoryMountPath = resolveRepositoryMount(options.policy, workspacePath);
  if (repositoryMountPath) {
    // Discoverability inside the sandbox: the read-only copy is always at
    // /repo regardless of the host checkout path.
    childEnv.PSFN_REPO = SANDBOX_REPOSITORY_MOUNT_TARGET;
  }
  const limits = resolveLimits(params, options.policy);
  const shadowReadPaths = resolveShadowReadPaths(
    options.quarantinedArtifactPaths,
    workspacePath,
    repositoryMountPath,
  );

  return {
    command,
    executableCommand,
    args,
    workspacePath,
    ...(repositoryMountPath ? { repositoryMountPath } : {}),
    ...(shadowReadPaths.length > 0 ? { shadowReadPaths } : {}),
    cwd,
    sandboxCwd,
    sandboxBinaryPath: resolveRequiredRuntimeBinary(DEFAULT_SANDBOX_BINARY, 'sandbox'),
    resourceLimitBinaryPath: resolveRequiredRuntimeBinary(
      DEFAULT_RESOURCE_LIMIT_BINARY,
      'resource limiter',
    ),
    deadlineBinaryPath: resolveRequiredRuntimeBinary(
      DEFAULT_DEADLINE_BINARY,
      'deadline enforcer',
    ),
    sandboxPath,
    childEnv,
    ...limits,
    ...resolveResourceLimits(options.policy),
  };
}
