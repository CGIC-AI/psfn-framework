import type { GatewayREPLCapabilities, SandboxBudgetRef, ShellExecView } from './contracts.js';
import {
  consumeToolCallBudget,
  toErrorMessage,
  toTrimmedString,
  TOOL_CALL_BUDGET_EXCEEDED_MESSAGE,
} from './common.js';

const MAX_COMMAND_LENGTH = 256;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;
const MAX_CWD_LENGTH = 4096;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 500_000;

export interface ShellExecCapabilityResult extends ShellExecView {
  ok: boolean;
  error?: string;
}

export interface ShellCapabilities {
  shell_exec: (
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      timeoutMs?: number;
      maxOutputChars?: number;
    },
  ) => Promise<ShellExecCapabilityResult>;
}

interface CreateShellCapabilitiesOptions {
  gatewayCaps: GatewayREPLCapabilities;
  budgetRef?: SandboxBudgetRef;
}

function normalizeArgs(args: unknown): { value: string[] } | { error: string } {
  if (args === undefined) return { value: [] };
  if (!Array.isArray(args)) return { error: 'args must be an array of strings' };
  if (args.length > MAX_ARGS) return { error: `args exceed max length (${MAX_ARGS})` };

  const normalized: string[] = [];
  for (const raw of args) {
    if (typeof raw !== 'string') {
      return { error: 'args must be an array of strings' };
    }
    if (raw.includes('\0') || raw.length > MAX_ARG_LENGTH) {
      return { error: `arg too large or invalid (max ${MAX_ARG_LENGTH} chars)` };
    }
    normalized.push(raw);
  }
  return { value: normalized };
}

function normalizeBoundedInteger(
  value: unknown,
  max: number,
): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const parsed = Math.floor(Number(value));
  if (parsed <= 0) return undefined;
  return Math.min(parsed, max);
}

export function createShellCapabilities(
  options: CreateShellCapabilitiesOptions,
): ShellCapabilities {
  const shell_exec: ShellCapabilities['shell_exec'] = async (
    command,
    args,
    execOptions,
  ) => {
    if (!consumeToolCallBudget(options.budgetRef)) {
      return {
        ok: false,
        error: TOOL_CALL_BUDGET_EXCEEDED_MESSAGE,
        command: '',
        args: [],
        cwd: '',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    }

    if (typeof options.gatewayCaps.shellExec !== 'function') {
      return {
        ok: false,
        error: 'shell_exec unavailable: requires gateway shell.exec policy and audit path',
        command: '',
        args: [],
        cwd: '',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    }

    const normalizedCommand = toTrimmedString(command);
    if (!normalizedCommand) {
      return {
        ok: false,
        error: 'command is required',
        command: '',
        args: [],
        cwd: '',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    }
    if (normalizedCommand.includes('\0') || normalizedCommand.length > MAX_COMMAND_LENGTH) {
      return {
        ok: false,
        error: `command too large or invalid (max ${MAX_COMMAND_LENGTH} chars)`,
        command: normalizedCommand.slice(0, MAX_COMMAND_LENGTH),
        args: [],
        cwd: '',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    }

    const normalizedArgs = normalizeArgs(args);
    if ('error' in normalizedArgs) {
      return {
        ok: false,
        error: normalizedArgs.error,
        command: normalizedCommand,
        args: [],
        cwd: '',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    }

    const cwd = execOptions?.cwd;
    const normalizedCwd = typeof cwd === 'string'
      ? cwd.trim()
      : undefined;
    if (normalizedCwd && (normalizedCwd.includes('\0') || normalizedCwd.length > MAX_CWD_LENGTH)) {
      return {
        ok: false,
        error: `cwd too large or invalid (max ${MAX_CWD_LENGTH} chars)`,
        command: normalizedCommand,
        args: normalizedArgs.value,
        cwd: normalizedCwd.slice(0, MAX_CWD_LENGTH),
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    }

    const timeoutMs = normalizeBoundedInteger(execOptions?.timeoutMs, MAX_TIMEOUT_MS);
    const maxOutputChars = normalizeBoundedInteger(execOptions?.maxOutputChars, MAX_OUTPUT_CHARS);

    try {
      const result = await options.gatewayCaps.shellExec(
        normalizedCommand,
        normalizedArgs.value,
        {
          ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(maxOutputChars !== undefined ? { maxOutputChars } : {}),
        },
      );
      return {
        ok: true,
        ...result,
      };
    } catch (err) {
      return {
        ok: false,
        error: toErrorMessage(err),
        command: normalizedCommand,
        args: normalizedArgs.value,
        cwd: normalizedCwd ?? '',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    }
  };

  return {
    shell_exec,
  };
}
