import {
  assertNoUnknownKeys,
  isRecord,
  normalizeStringArray,
} from '../../shared/utils/types.js';

export interface ShellExecSettings {
  enabled: boolean;
  allowlist: string[];
  envAllowlist: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  defaultMaxOutputChars: number;
  maxOutputChars: number;
  maxProcesses: number;
  maxAddressSpaceBytes: number;
  maxFileBytes: number;
  maxCpuSeconds: number;
  maxOpenFiles: number;
}

export const SHELL_EXEC_SETTINGS_RANGES = {
  timeoutMs: { min: 100, max: 60_000 },
  outputChars: { min: 256, max: 1_000_000 },
  maxProcesses: { min: 2, max: 16 },
  maxAddressSpaceBytes: { min: 64 * 1024 * 1024, max: 512 * 1024 * 1024 },
  maxFileBytes: { min: 1_024, max: 64 * 1024 * 1024 },
  maxCpuSeconds: { min: 1, max: 60 },
  maxOpenFiles: { min: 16, max: 256 },
  maxAggregateAddressSpaceBytes: 1024 * 1024 * 1024,
} as const;

const SHELL_EXEC_SETTING_KEYS = [
  'enabled',
  'allowlist',
  'envAllowlist',
  'defaultTimeoutMs',
  'maxTimeoutMs',
  'defaultMaxOutputChars',
  'maxOutputChars',
  'maxProcesses',
  'maxAddressSpaceBytes',
  'maxFileBytes',
  'maxCpuSeconds',
  'maxOpenFiles',
] as const;

const COMMAND_ALLOWLIST_ENTRY_PATTERN = /^(?:[A-Za-z0-9._+-]+|\/usr\/[A-Za-z0-9._+/-]+)$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function createDefaultShellExecSettings(): ShellExecSettings {
  return {
    enabled: false,
    allowlist: [],
    envAllowlist: [],
    defaultTimeoutMs: 5_000,
    maxTimeoutMs: 30_000,
    defaultMaxOutputChars: 20_000,
    maxOutputChars: 100_000,
    maxProcesses: 8,
    maxAddressSpaceBytes: 128 * 1024 * 1024,
    maxFileBytes: 16 * 1024 * 1024,
    maxCpuSeconds: 10,
    maxOpenFiles: 128,
  };
}

function expectBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid settings at ${fieldPath}: expected boolean`);
  }
  return value;
}

function expectIntegerInRange(
  value: unknown,
  fieldPath: string,
  range: { min: number; max: number },
): number {
  if (!Number.isSafeInteger(value) || Number(value) < range.min || Number(value) > range.max) {
    throw new Error(
      `Invalid settings at ${fieldPath}: expected integer ${range.min}-${range.max}`,
    );
  }
  return Number(value);
}

function normalizeBoundedList(
  value: unknown,
  fieldPath: string,
  pattern: RegExp,
  maxEntries: number,
): string[] {
  const normalized = normalizeStringArray(value, fieldPath, {
    errorPrefix: 'Invalid settings',
  });
  if (normalized.length > maxEntries) {
    throw new Error(
      `Invalid settings at ${fieldPath}: expected at most ${maxEntries} entries`,
    );
  }
  for (const entry of normalized) {
    if (!pattern.test(entry)) {
      throw new Error(`Invalid settings at ${fieldPath}: invalid entry ${JSON.stringify(entry)}`);
    }
  }
  return normalized;
}

export function normalizeShellExecSettings(
  value: unknown,
  fieldPath = 'shellExec',
): ShellExecSettings {
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }
  assertNoUnknownKeys(value, SHELL_EXEC_SETTING_KEYS, fieldPath, {
    errorPrefix: 'Invalid settings',
  });

  const enabled = expectBoolean(value.enabled, `${fieldPath}.enabled`);
  const allowlist = normalizeBoundedList(
    value.allowlist,
    `${fieldPath}.allowlist`,
    COMMAND_ALLOWLIST_ENTRY_PATTERN,
    32,
  );
  const envAllowlist = normalizeBoundedList(
    value.envAllowlist,
    `${fieldPath}.envAllowlist`,
    ENV_NAME_PATTERN,
    16,
  );
  if (enabled && allowlist.length === 0) {
    throw new Error(
      `Invalid settings at ${fieldPath}.allowlist: enabled shell requires at least one command`,
    );
  }

  const defaultTimeoutMs = expectIntegerInRange(
    value.defaultTimeoutMs,
    `${fieldPath}.defaultTimeoutMs`,
    SHELL_EXEC_SETTINGS_RANGES.timeoutMs,
  );
  const maxTimeoutMs = expectIntegerInRange(
    value.maxTimeoutMs,
    `${fieldPath}.maxTimeoutMs`,
    SHELL_EXEC_SETTINGS_RANGES.timeoutMs,
  );
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new Error(
      `Invalid settings at ${fieldPath}.defaultTimeoutMs: must not exceed maxTimeoutMs`,
    );
  }

  const defaultMaxOutputChars = expectIntegerInRange(
    value.defaultMaxOutputChars,
    `${fieldPath}.defaultMaxOutputChars`,
    SHELL_EXEC_SETTINGS_RANGES.outputChars,
  );
  const maxOutputChars = expectIntegerInRange(
    value.maxOutputChars,
    `${fieldPath}.maxOutputChars`,
    SHELL_EXEC_SETTINGS_RANGES.outputChars,
  );
  if (defaultMaxOutputChars > maxOutputChars) {
    throw new Error(
      `Invalid settings at ${fieldPath}.defaultMaxOutputChars: must not exceed maxOutputChars`,
    );
  }

  const maxProcesses = expectIntegerInRange(
    value.maxProcesses,
    `${fieldPath}.maxProcesses`,
    SHELL_EXEC_SETTINGS_RANGES.maxProcesses,
  );
  const maxAddressSpaceBytes = expectIntegerInRange(
    value.maxAddressSpaceBytes,
    `${fieldPath}.maxAddressSpaceBytes`,
    SHELL_EXEC_SETTINGS_RANGES.maxAddressSpaceBytes,
  );
  if (
    maxProcesses * maxAddressSpaceBytes
    > SHELL_EXEC_SETTINGS_RANGES.maxAggregateAddressSpaceBytes
  ) {
    throw new Error(
      `Invalid settings at ${fieldPath}: maxProcesses * maxAddressSpaceBytes `
      + `must not exceed ${SHELL_EXEC_SETTINGS_RANGES.maxAggregateAddressSpaceBytes}`,
    );
  }

  return {
    enabled,
    allowlist,
    envAllowlist,
    defaultTimeoutMs,
    maxTimeoutMs,
    defaultMaxOutputChars,
    maxOutputChars,
    maxProcesses,
    maxAddressSpaceBytes,
    maxFileBytes: expectIntegerInRange(
      value.maxFileBytes,
      `${fieldPath}.maxFileBytes`,
      SHELL_EXEC_SETTINGS_RANGES.maxFileBytes,
    ),
    maxCpuSeconds: expectIntegerInRange(
      value.maxCpuSeconds,
      `${fieldPath}.maxCpuSeconds`,
      SHELL_EXEC_SETTINGS_RANGES.maxCpuSeconds,
    ),
    maxOpenFiles: expectIntegerInRange(
      value.maxOpenFiles,
      `${fieldPath}.maxOpenFiles`,
      SHELL_EXEC_SETTINGS_RANGES.maxOpenFiles,
    ),
  };
}
