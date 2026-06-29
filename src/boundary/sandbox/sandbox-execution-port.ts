import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type {
  GatewayProcessExecutionBoundary,
  SandboxCodeExecutionBoundary,
  SandboxCodeExecutionRequest,
  SandboxCodeExecutionResponse,
  SandboxExecutionPort,
} from './capabilities/contracts.js';
import {
  ANALYSIS_WORKBENCH_CHILD_PROTOCOL,
  ANALYSIS_WORKBENCH_CHILD_SOURCE,
} from './execution/analysis-workbench-child-source.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';
import { createRateLimitedLogEmitter } from '../../shared/log-rate-limit.js';

type SandboxExecutionPortSeed =
  Pick<SandboxExecutionPort, 'boundary' | 'shellExec'>
  & Partial<Pick<SandboxExecutionPort, 'codeExecutionBoundary' | 'executeCode'>>;

type ChildSandboxMessage =
  | {
    type: 'sandbox_helper_call';
    protocol: typeof ANALYSIS_WORKBENCH_CHILD_PROTOCOL;
    id: number;
    name: string;
    args: unknown[];
  }
  | ({
    type: 'sandbox_result';
    protocol: typeof ANALYSIS_WORKBENCH_CHILD_PROTOCOL;
  } & SandboxCodeExecutionResponse)
  | {
    type: 'sandbox_debug_log';
    protocol: typeof ANALYSIS_WORKBENCH_CHILD_PROTOCOL;
    message: string;
    key: string;
    details?: unknown;
  };

const DEFAULT_SHELL_UNAVAILABLE_REASON = 'shell_exec unavailable: requires sandbox broker boundary and audit path';
const CHILD_PROCESS_BOUNDARY_REASON =
  'analysis_workbench code executes in a short-lived child process with an empty environment, '
  + 'Node permissions enabled, string code generation disabled, and helper access limited to an IPC allowlist';
const CHILD_PROCESS_DENIED_CAPABILITIES = [
  'filesystem',
  'network',
  'process',
  'module_import',
  'global_escape',
  'child_process',
  'environment',
] as const;
const CHILD_PROCESS_NODE_ARGS = [
  '--permission',
  '--no-experimental-fetch',
  '--no-experimental-websocket',
  '--disable-proto=throw',
  '--disallow-code-generation-from-strings',
  '--no-global-search-paths',
  '--eval',
  ANALYSIS_WORKBENCH_CHILD_SOURCE,
] as const;
const CHILD_STDIO = ['ignore', 'pipe', 'pipe', 'ipc'] as const;
const MAX_IPC_DEPTH = 20;
const MAX_IPC_ARRAY_LENGTH = 10_000;
const MAX_IPC_OBJECT_KEYS = 2_000;
const log = createComponentLogger('AnalysisWorkbenchSandbox');
const rateLimitedDebugLog = createRateLimitedLogEmitter({ windowMs: 60_000 });

function createUnavailableShellBoundary(): GatewayProcessExecutionBoundary {
  return {
    kind: 'gateway_process',
    isolatedFromGatewaySecrets: false,
    reason: DEFAULT_SHELL_UNAVAILABLE_REASON,
  };
}

function createChildProcessCodeExecutionBoundary(): SandboxCodeExecutionBoundary {
  return {
    kind: 'child_process',
    isolatedFromGatewaySecrets: true,
    securityPosture: 'out_of_process_default_deny',
    protocol: ANALYSIS_WORKBENCH_CHILD_PROTOCOL,
    deniedCapabilities: CHILD_PROCESS_DENIED_CAPABILITIES,
    reason: CHILD_PROCESS_BOUNDARY_REASON,
  };
}

function normalizeChildProcessCodeExecutionBoundary(
  boundary: SandboxCodeExecutionBoundary,
): SandboxCodeExecutionBoundary {
  const rawBoundary = boundary as {
    kind?: unknown;
    isolatedFromGatewaySecrets?: unknown;
    securityPosture?: unknown;
    protocol?: unknown;
    deniedCapabilities?: unknown;
    reason?: unknown;
  };

  if (
    rawBoundary.kind !== 'child_process'
    || rawBoundary.isolatedFromGatewaySecrets !== true
    || rawBoundary.securityPosture !== 'out_of_process_default_deny'
    || rawBoundary.protocol !== ANALYSIS_WORKBENCH_CHILD_PROTOCOL
  ) {
    throw new Error(
      'analysis_workbench code execution requires an out-of-process child_process sandbox boundary',
    );
  }

  const denied = Array.isArray(rawBoundary.deniedCapabilities)
    ? new Set(rawBoundary.deniedCapabilities)
    : new Set<unknown>();
  for (const capability of CHILD_PROCESS_DENIED_CAPABILITIES) {
    if (!denied.has(capability)) {
      throw new Error(`analysis_workbench child_process sandbox must deny ${capability}`);
    }
  }

  const reason = typeof rawBoundary.reason === 'string' ? rawBoundary.reason.trim() : '';
  return {
    kind: 'child_process',
    isolatedFromGatewaySecrets: true,
    securityPosture: 'out_of_process_default_deny',
    protocol: ANALYSIS_WORKBENCH_CHILD_PROTOCOL,
    deniedCapabilities: CHILD_PROCESS_DENIED_CAPABILITIES,
    reason: reason || CHILD_PROCESS_BOUNDARY_REASON,
  };
}

function sanitizeForIpc(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
  if (valueType === 'bigint') return value.toString();
  if (valueType === 'symbol') return String(value);
  if (valueType === 'function') {
    const name = (value as { name?: unknown }).name;
    return typeof name === 'string' && name
      ? `[Function: ${name}]`
      : '[Function]';
  }
  if (valueType !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_IPC_DEPTH) return '[MaxDepth]';
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_IPC_ARRAY_LENGTH)
      .map(item => sanitizeForIpc(item, depth + 1, seen));
  }
  if (value instanceof Map) {
    return sanitizeForIpc(Object.fromEntries(value), depth + 1, seen);
  }
  if (value instanceof Set) {
    return sanitizeForIpc([...value], depth + 1, seen);
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, MAX_IPC_OBJECT_KEYS);
  for (const [key, childValue] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    output[key] = sanitizeForIpc(childValue, depth + 1, seen);
  }
  return output;
}

function normalizeTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function isChildSandboxMessage(message: unknown): message is ChildSandboxMessage {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; protocol?: unknown };
  return (
    (
      candidate.type === 'sandbox_helper_call'
      || candidate.type === 'sandbox_result'
      || candidate.type === 'sandbox_debug_log'
    )
    && candidate.protocol === ANALYSIS_WORKBENCH_CHILD_PROTOCOL
  );
}

function normalizeSandboxDebugDetails(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeForIpc(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {};
  }
  return sanitized as Record<string, unknown>;
}

function handleSandboxDebugLog(
  message: Extract<ChildSandboxMessage, { type: 'sandbox_debug_log' }>,
): void {
  rateLimitedDebugLog(
    message.key,
    () => log.debug(message.message, normalizeSandboxDebugDetails(message.details)),
  );
}

function createChildProcessFailure(
  message: string,
): SandboxCodeExecutionResponse {
  return {
    output: [],
    error: message,
    finalAnswer: null,
    locals: {},
  };
}

async function unavailableShellExec(): Promise<never> {
  throw new Error(DEFAULT_SHELL_UNAVAILABLE_REASON);
}

async function sendHelperFailure(
  child: ChildProcess,
  id: number,
  error: string,
): Promise<void> {
  if (!child.connected) return;
  child.send({
    type: 'sandbox_helper_result',
    protocol: ANALYSIS_WORKBENCH_CHILD_PROTOCOL,
    id,
    ok: false,
    error,
  });
}

async function sendHelperSuccess(
  child: ChildProcess,
  id: number,
  value: unknown,
): Promise<void> {
  if (!child.connected) return;
  child.send({
    type: 'sandbox_helper_result',
    protocol: ANALYSIS_WORKBENCH_CHILD_PROTOCOL,
    id,
    ok: true,
    value: sanitizeForIpc(value),
  });
}

async function handleHelperCall(
  child: ChildProcess,
  request: SandboxCodeExecutionRequest,
  message: Extract<ChildSandboxMessage, { type: 'sandbox_helper_call' }>,
): Promise<void> {
  if (!request.helperNames.includes(message.name)) {
    await sendHelperFailure(child, message.id, `sandbox helper unavailable: ${message.name}`);
    return;
  }

  const helper = request.hostHelpers[message.name];
  if (typeof helper !== 'function') {
    await sendHelperFailure(child, message.id, `sandbox helper unavailable: ${message.name}`);
    return;
  }

  try {
    const args = Array.isArray(message.args) ? message.args : [];
    const value = await helper(...args);
    await sendHelperSuccess(child, message.id, value);
  } catch (error) {
    await sendHelperFailure(child, message.id, toErrorMessage(error));
  }
}

async function executeCodeInChildProcess(
  request: SandboxCodeExecutionRequest,
): Promise<SandboxCodeExecutionResponse> {
  const timeoutMs = normalizeTimeoutMs(request.timeoutMs);

  return await new Promise<SandboxCodeExecutionResponse>((resolve) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [...CHILD_PROCESS_NODE_ARGS],
      {
        env: {},
        stdio: [...CHILD_STDIO],
        serialization: 'advanced',
      },
    );
    const stderrChunks: string[] = [];
    let settled = false;

    const settle = (result: SandboxCodeExecutionResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(parentTimeout);
      if (child.connected) {
        child.disconnect();
      }
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      resolve(result);
    };

    const parentTimeout = setTimeout(() => {
      settle(createChildProcessFailure(`Execution timed out after ${timeoutMs}ms`));
    }, Math.max(timeoutMs + 1_000, timeoutMs * 2));

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'));
    });

    child.on('message', (rawMessage: unknown) => {
      if (!isChildSandboxMessage(rawMessage)) return;
      if (rawMessage.type === 'sandbox_result') {
        settle({
          output: Array.isArray(rawMessage.output) ? rawMessage.output.map(String) : [],
          error: typeof rawMessage.error === 'string' ? rawMessage.error : null,
          finalAnswer: typeof rawMessage.finalAnswer === 'string' ? rawMessage.finalAnswer : null,
          locals: typeof rawMessage.locals === 'object'
            ? rawMessage.locals
            : {},
        });
        return;
      }

      if (rawMessage.type === 'sandbox_debug_log') {
        handleSandboxDebugLog(rawMessage);
        return;
      }

      void handleHelperCall(child, request, rawMessage);
    });

    child.on('error', (error: Error) => {
      settle(createChildProcessFailure(`child process sandbox failed: ${toErrorMessage(error)}`));
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      const stderr = stderrChunks.join('').trim();
      const suffix = stderr ? `: ${stderr}` : '';
      settle(createChildProcessFailure(
        `child process sandbox exited before returning a result (code=${String(code)}, signal=${String(signal)})${suffix}`,
      ));
    });

    child.send({
      type: 'sandbox_execute',
      protocol: ANALYSIS_WORKBENCH_CHILD_PROTOCOL,
      code: request.code,
      timeoutMs,
      memoryCeilingBytes: request.memoryCeilingBytes,
      initialLocals: sanitizeForIpc(request.initialLocals),
      helperNames: [...request.helperNames],
    });
  });
}

export function withChildProcessSandboxExecutionPort(
  port: SandboxExecutionPortSeed | null,
): SandboxExecutionPort {
  const codeExecutionBoundary = port?.codeExecutionBoundary
    ? normalizeChildProcessCodeExecutionBoundary(port.codeExecutionBoundary)
    : createChildProcessCodeExecutionBoundary();

  return {
    boundary: port?.boundary ?? createUnavailableShellBoundary(),
    codeExecutionBoundary,
    shellExec: port?.shellExec ?? unavailableShellExec,
    executeCode: port?.executeCode ?? executeCodeInChildProcess,
  };
}
