import { describe, expect, it, vi } from 'vitest';
import { createShellTool } from './tools.js';

describe('createShellTool', () => {
  it('executes shell action=exec through the backing operations', async () => {
    const ops = {
      exec: vi.fn(async () => ({
        command: 'node',
        args: ['-v'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: 'v22.0.0',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 12,
      })),
    };

    const tool = createShellTool(ops);
    const result = await tool.execute('call-1', {
      action: 'exec',
      command: 'node',
      args: ['-v'],
      cwd: '/workspace',
      timeout_ms: 500,
      max_output_chars: 1024,
      env_vars: ['OPENAI_API_KEY'],
    });

    expect(ops.exec).toHaveBeenCalledWith('node', ['-v'], {
      cwd: '/workspace',
      timeoutMs: 500,
      maxOutputChars: 1024,
      envVars: ['OPENAI_API_KEY'],
    });
    expect((result.content[0] as any).text).toContain('"action": "exec"');
    expect((result.content[0] as any).text).toContain('"exit_code": 0');
    expect((result.details as any).isError).toBeUndefined();
  });

  it('defaults to exec when action is omitted', async () => {
    const ops = {
      exec: vi.fn(async () => ({
        command: 'node',
        args: [],
        cwd: '/workspace',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 8,
      })),
    };

    const tool = createShellTool(ops);
    await tool.execute('call-2', { command: 'node' });

    expect(ops.exec).toHaveBeenCalledWith('node', [], {});
  });

  it('fails closed on unknown actions', async () => {
    const ops = {
      exec: vi.fn(),
    };

    const tool = createShellTool(ops);
    const result = await tool.execute('call-3', {
      action: 'search',
      command: 'node',
    });

    expect(ops.exec).not.toHaveBeenCalled();
    expect((result.details as any).isError).toBe(true);
    expect(result.details).toMatchObject({
      errorClass: 'invalid_input',
      retryHint: 'try_alternative_input',
      retryable: false,
    });
    expect((result.content[0] as any).text).toContain('Supported actions: exec');
  });

  it('annotates shell allowlist policy failures with structured metadata', async () => {
    const ops = {
      exec: vi.fn(async () => {
        const error = new Error('shell.exec command not allowlisted: rm') as Error & { code: number };
        error.code = -32002;
        throw error;
      }),
    };

    const tool = createShellTool(ops);
    const result = await tool.execute('call-4', {
      command: 'rm',
      args: ['-rf', 'tmp'],
    });

    expect(result.details).toMatchObject({
      isError: true,
      errorClass: 'policy_blocked',
      retryHint: 'try_alternative_input',
      retryable: false,
      rawDiagnostic: 'shell.exec command not allowlisted: rm',
    });
    expect((result.content[0] as any).text).toContain('shell failed: Blocked by runtime policy');
  });
});
