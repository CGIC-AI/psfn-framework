import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { withCapabilityRequirement } from '../../../system/capabilities/requirements.js';
import { tagToolWithReversibility } from '../../../system/capabilities/safeguards.js';
import type { ShellOperations } from './ops.js';
import { textResult, textResultFromError } from '../../../core/tools/results.js';

type ShellAction = 'exec';

function normalizeAction(params: Record<string, unknown>): ShellAction {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  if (action.length === 0) {
    return 'exec';
  }
  if (action === 'exec') {
    return action;
  }
  throw new Error('action is required. Supported actions: exec.');
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function requireArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('args must be an array of strings.');
  }
  return value;
}

export function createShellTool(ops: ShellOperations): AgentTool<any> {
  const tool: AgentTool<any> = {
    name: 'shell',
    label: 'shell',
    description:
      'Unified shell primitive for direct command execution via the gateway allowlist. '
      + 'Use action=exec with an explicit command and args. This is distinct from fs/repo tools and does not rely on analysis_workbench fallback semantics.',
    parameters: Type.Object({
      action: Type.Optional(Type.Literal('exec', {
        description: 'Shell action. Defaults to exec.',
      })),
      command: Type.Optional(Type.String({
        description: 'Executable name or allowlisted executable path to run directly.',
      })),
      args: Type.Optional(Type.Array(Type.String(), {
        description: 'Exact argv entries to pass to the command.',
      })),
      cwd: Type.Optional(Type.String({
        description: 'Optional working directory. Must remain within the configured shell allowlist.',
      })),
      timeout_ms: Type.Optional(Type.Integer({
        minimum: 1,
        description: 'Optional timeout override in milliseconds, bounded by gateway policy.',
      })),
      max_output_chars: Type.Optional(Type.Integer({
        minimum: 1,
        description: 'Optional combined stdout/stderr cap, bounded by gateway policy.',
      })),
      env_vars: Type.Optional(Type.Array(Type.String(), {
        description: 'Optional environment variable names to request from the gateway-owned shell env allowlist.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      rawParams: Record<string, unknown>,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        normalizeAction(rawParams);

        const result = await ops.exec(
          requireNonEmptyString(rawParams.command, 'command'),
          requireArgs(rawParams.args),
          {
            ...(typeof rawParams.cwd === 'string' && rawParams.cwd.trim().length > 0
              ? { cwd: rawParams.cwd.trim() }
              : {}),
            ...(typeof rawParams.timeout_ms === 'number' ? { timeoutMs: rawParams.timeout_ms } : {}),
            ...(typeof rawParams.max_output_chars === 'number'
              ? { maxOutputChars: rawParams.max_output_chars }
              : {}),
            ...(Array.isArray(rawParams.env_vars) ? { envVars: requireArgs(rawParams.env_vars) } : {}),
          },
        );

        return textResult(JSON.stringify({
          action: 'exec',
          command: result.command,
          args: result.args,
          cwd: result.cwd,
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timed_out: result.timedOut,
          truncated: result.truncated,
          duration_ms: result.durationMs,
        }, null, 2));
      } catch (error) {
        return textResultFromError('shell failed', error);
      }
    },
  };

  return withCapabilityRequirement(tagToolWithReversibility(tool, 'irreversible'), 'repl.execute');
}
