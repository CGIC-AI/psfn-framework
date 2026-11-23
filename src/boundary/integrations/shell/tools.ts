import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult, SubstrateAgentTool } from '../../pi-agent/index.js';
import { withCapabilityRequirement } from '../../../system/capabilities/requirements.js';
import { tagToolWithReversibility } from '../../../system/capabilities/safeguards.js';
import type { ShellOperations } from './ops.js';
import { textResult, textResultFromError } from '../../../core/tools/results.js';

type ShellAction = 'exec';

const SHELL_SESSION_NAME_PATTERN = /^[A-Za-z0-9._-]{1,48}$/u;

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

function parseOptionalSession(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('session must be a string matching /^[A-Za-z0-9._-]{1,48}$/.');
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!SHELL_SESSION_NAME_PATTERN.test(trimmed)) {
    throw new Error('session must contain 1-48 letters, digits, dots, underscores, or hyphens.');
  }
  return trimmed;
}

function wrapScriptWithWorkspaceSession(
  script: string,
  session: string,
  explicitCwdProvided: boolean,
): string {
  const stateDir = '/workspace/.shell-sessions';
  const cwdFile = `${stateDir}/${session}.cwd`;
  const restoreCwd = explicitCwdProvided
    ? ''
    : `if [ -f "${cwdFile}" ]; then __shell_saved_cwd=$(cat "${cwdFile}" 2>/dev/null || true); `
      + 'case "$__shell_saved_cwd" in /workspace|/workspace/*) [ -d "$__shell_saved_cwd" ] && cd "$__shell_saved_cwd" ;; esac; fi\n';
  return [
    restoreCwd + '{',
    script,
    '}',
    '__shell_ec=$?',
    `mkdir -p "${stateDir}"`,
    `case "$PWD" in /workspace|/workspace/*) printf '%s' "$PWD" > "${cwdFile}" ;; esac`,
    'exit $__shell_ec',
  ].join('\n');
}

function resolveShellInvocation(params: Record<string, unknown>, explicitCwdProvided: boolean): {
  command: string;
  args: string[];
  session?: string;
} {
  const script = typeof params.script === 'string' ? params.script.trim() : '';
  const command = typeof params.command === 'string' ? params.command.trim() : '';
  const session = parseOptionalSession(params.session);

  if (script && command) {
    throw new Error('Provide either script (for bash) or command (for a direct executable), not both.');
  }
  if (script) {
    if (params.args !== undefined && (!Array.isArray(params.args) || params.args.length > 0)) {
      throw new Error('args cannot be combined with script; put arguments directly in script.');
    }
    const effectiveScript = session
      ? wrapScriptWithWorkspaceSession(script, session, explicitCwdProvided)
      : script;
    return {
      command: 'bash',
      args: ['-lc', effectiveScript],
      ...(session ? { session } : {}),
    };
  }
  if (session) {
    throw new Error('session requires script.');
  }
  if (!command) {
    throw new Error('script or command is required.');
  }
  return {
    command,
    args: requireArgs(params.args),
  };
}

export function createShellTool(ops: ShellOperations): SubstrateAgentTool {
  const tool: SubstrateAgentTool = {
    name: 'shell',
    label: 'shell',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.shell,
    parameters: Type.Object({
      action: Type.Literal('exec', {
        description: 'Required shell action: exec.',
      }),
      script: Type.Optional(Type.String({
        description:
          'Bash script or command line to execute via `bash -lc` inside the sandboxed Personal Workspace (preferred for CLI, git, search, builds, and tests).',
      })),
      session: Type.Optional(Type.String({
        description:
          'Optional workspace session name (1-48 alphanumeric/._- chars) used with script to persist working directory under /workspace/.shell-sessions across calls.',
      })),
      command: Type.Optional(Type.String({
        description:
          'Explicit allowlisted image executable to run directly without bash parsing (omit when using script).',
      })),
      args: Type.Optional(Type.Array(Type.String(), {
        description:
          'Exact argv entries for command. They are not parsed by a shell unless command is explicitly bash.',
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
        const cwd = typeof rawParams.cwd === 'string' && rawParams.cwd.trim().length > 0
          ? rawParams.cwd.trim()
          : undefined;
        const invocation = resolveShellInvocation(rawParams, cwd !== undefined);

        const result = await ops.exec(
          invocation.command,
          invocation.args,
          {
            ...(cwd ? { cwd } : {}),
            ...(typeof rawParams.timeout_ms === 'number' ? { timeoutMs: rawParams.timeout_ms } : {}),
            ...(typeof rawParams.max_output_chars === 'number'
              ? { maxOutputChars: rawParams.max_output_chars }
              : {}),
            ...(Array.isArray(rawParams.env_vars) ? { envVars: requireArgs(rawParams.env_vars) } : {}),
          },
        );

        return textResult(JSON.stringify({
          action: 'exec',
          ...(invocation.session ? { session: invocation.session } : {}),
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
