import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult } from '../../pi-agent/index.js';
import type { SubstrateAgentTool } from '../../pi-agent/index.js';
import { withCapabilityRequirement } from '../../../system/capabilities/requirements.js';
import { tagToolWithReversibility } from '../../../system/capabilities/safeguards.js';
import type { ShellOperations } from './ops.js';
import { textResult, textResultFromError } from '../../../core/tools/results.js';
import { requireNonEmptyString } from '../../../shared/utils/strings.js';

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

function requireArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('args must be an array of strings.');
  }
  return value;
}

export function createShellTool(ops: ShellOperations): SubstrateAgentTool {
  const tool: SubstrateAgentTool = {
    name: 'shell',
    label: 'shell',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.shell,
    parameters: Type.Object({
      action: Type.Optional(Type.Literal('exec', {
        description: 'Run one fresh, isolated command. Defaults to exec.',
      })),
      command: Type.Optional(Type.String({
        description:
          'Allowlisted image executable to run directly. Use bash with args ["-lc", "..."] for normal CLI work.',
      })),
      args: Type.Optional(Type.Array(Type.String(), {
        description:
          'Exact argv entries. They are not parsed by a shell unless command is explicitly bash.',
      })),
      cwd: Type.Optional(Type.String({
        description:
          'Working directory relative to the Personal Workspace, or a returned absolute workspace path. Defaults to the workspace root and cannot escape it.',
      })),
      timeout_ms: Type.Optional(Type.Integer({
        minimum: 1,
        description:
          'Optional wall-time override in milliseconds. Default is 10 minutes; gateway policy caps it at 1 hour.',
      })),
      max_output_chars: Type.Optional(Type.Integer({
        minimum: 1,
        description:
          'Optional combined stdout/stderr cap. Use targeted CLI filters instead of dumping large files.',
      })),
      env_vars: Type.Optional(Type.Array(Type.String(), {
        description:
          'Environment names to request from the gateway allowlist. Inherited secrets are absent by default.',
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
