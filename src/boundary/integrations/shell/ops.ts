import type { ShellExecResult } from '../gateway/protocol.js';

export interface ShellExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  envVars?: string[];
}

export interface ShellOperations {
  exec(
    command: string,
    args?: string[],
    options?: ShellExecOptions,
  ): Promise<ShellExecResult>;
}
