import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PROCESS_TERMINATION_GRACE_TIMEOUT_MS } from '../../shared/process-termination-policy.js';
import { resolveRuntimeCommandInvocation } from './runtime-mode.js';

const DEFAULT_MAX_OUTPUT_CHARS = 10_000;

export interface LifecycleCommandOptions {
  cwd?: string;
  timeoutMs: number;
  maxOutputChars?: number;
}

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const parsed = Math.floor(Number(value));
  return parsed > 0 ? parsed : fallback;
}

export async function runConfiguredLifecycleCommand(
  rawCommand: string | undefined,
  options: LifecycleCommandOptions,
): Promise<void> {
  const invocation = resolveRuntimeCommandInvocation(rawCommand);
  if (!invocation) {
    throw new Error('Lifecycle restart command strategy is missing a restart command');
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const timeoutMs = resolvePositiveInt(options.timeoutMs, 0);
  if (timeoutMs === 0) {
    throw new Error('Lifecycle restart command timeout must be a positive integer');
  }
  const maxOutputChars = resolvePositiveInt(
    options.maxOutputChars,
    DEFAULT_MAX_OUTPUT_CHARS,
  );

  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let combinedOutput = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const appendOutput = (value: Buffer | string): void => {
      const text = typeof value === 'string' ? value : value.toString('utf8');
      if (!text) return;
      const remaining = maxOutputChars - combinedOutput.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      combinedOutput += text.slice(0, remaining);
      if (text.length > remaining) truncated = true;
    };
    const outputSuffix = (): string => (
      `${truncated ? ' (output truncated)' : ''}${combinedOutput ? `\n${combinedOutput}` : ''}`
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), PROCESS_TERMINATION_GRACE_TIMEOUT_MS).unref();
    }, timeoutMs);

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectCommand(new Error(`Lifecycle restart command failed to start: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        rejectCommand(new Error(
          `Lifecycle restart command timed out after ${timeoutMs}ms${outputSuffix()}`,
        ));
        return;
      }
      if (code === null) {
        rejectCommand(new Error(
          `Lifecycle restart command exited without a status${signal ? ` after signal ${signal}` : ''}${outputSuffix()}`,
        ));
        return;
      }
      if (code !== 0) {
        rejectCommand(new Error(
          `Lifecycle restart command failed with exit code ${code}${outputSuffix()}`,
        ));
        return;
      }
      resolveCommand();
    });
  });
}
