import { parseEnvList, parsePositiveIntEnv } from '../../../shared/utils/env.js';

export interface ShellExecPolicyConfig {
  enabled?: boolean;
  allowlist?: string[];
  allowedCwd?: string[];
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  defaultMaxOutputChars?: number;
  maxOutputChars?: number;
}

const DEFAULT_SHELL_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_SHELL_EXEC_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_SHELL_EXEC_OUTPUT_CHARS = 20_000;
const DEFAULT_SHELL_EXEC_OUTPUT_CHARS_CAP = 100_000;

function parseBooleanEnvWithFallback(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function buildShellExecPolicyConfig(
  env: NodeJS.ProcessEnv,
): ShellExecPolicyConfig {
  const allowlist = parseEnvList(env.SHELL_EXEC_ALLOWLIST, { separators: [','] });
  const allowedCwd = parseEnvList(env.SHELL_EXEC_ALLOWED_CWD, { separators: [','] });

  return {
    enabled: parseBooleanEnvWithFallback(env.SHELL_EXEC_ENABLED, false),
    ...(allowlist ? { allowlist } : {}),
    ...(allowedCwd ? { allowedCwd } : {}),
    defaultTimeoutMs: parsePositiveIntEnv(
      env.SHELL_EXEC_DEFAULT_TIMEOUT_MS,
      DEFAULT_SHELL_EXEC_TIMEOUT_MS,
    ),
    maxTimeoutMs: parsePositiveIntEnv(
      env.SHELL_EXEC_MAX_TIMEOUT_MS,
      DEFAULT_SHELL_EXEC_MAX_TIMEOUT_MS,
    ),
    defaultMaxOutputChars: parsePositiveIntEnv(
      env.SHELL_EXEC_DEFAULT_MAX_OUTPUT_CHARS,
      DEFAULT_SHELL_EXEC_OUTPUT_CHARS,
    ),
    maxOutputChars: parsePositiveIntEnv(
      env.SHELL_EXEC_MAX_OUTPUT_CHARS,
      DEFAULT_SHELL_EXEC_OUTPUT_CHARS_CAP,
    ),
  };
}
