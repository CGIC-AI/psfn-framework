import { fromAny } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import { createShellTool } from './tools.js';
import { createFileEditorTool } from '../filesystem/file-editor-tool.js';
import { gateToolWithCapabilities, type CapabilityAccess } from '../../../system/capabilities/gate.js';
import { resolveTierCapabilityTokens } from '../../../system/capabilities/tiers.js';
import { resolveActiveTools } from '../../../core/agent/substrate-agent/tool-orchestration-runtime.js';

describe('createShellTool', () => {
  it('executes shell action=exec with concise bash script and optional workspace session', async () => {
    const ops = {
      exec: vi.fn(async (command: string, args: string[] = []) => ({
        command,
        args,
        cwd: '/workspace',
        exitCode: 0,
        stdout: 'M README.md\n',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 14,
      })),
    };

    const tool = createShellTool(ops);
    const directScript = await tool.execute('call-script', {
      action: 'exec',
      script: 'git status --short',
    });
    expect(ops.exec).toHaveBeenCalledWith('bash', ['-lc', 'git status --short'], {});
    expect(fromAny(directScript.content[0]).text).toContain('M README.md');

    const sessionResult = await tool.execute('call-session', {
      action: 'exec',
      script: 'cd docs && pwd',
      session: 'work_1',
    });
    const sessionCall = ops.exec.mock.calls[1];
    expect(sessionCall?.[0]).toBe('bash');
    expect(sessionCall?.[1]?.[0]).toBe('-lc');
    expect(sessionCall?.[1]?.[1]).toContain('/workspace/.shell-sessions/work_1.cwd');
    expect(sessionCall?.[1]?.[1]).toContain('cd docs && pwd');
    expect(fromAny(sessionResult.content[0]).text).toContain('"session": "work_1"');
  });

  it('rejects invalid session names or ambiguous script+command invocations fail-closed', async () => {
    const ops = { exec: vi.fn() };
    const tool = createShellTool(ops);

    const badSession = await tool.execute('call-bad-session', {
      action: 'exec',
      script: 'pwd',
      session: '../escape',
    });
    expect(fromAny(badSession.details).isError).toBe(true);
    expect(fromAny(badSession.content[0]).text).toContain('session must contain');

    const bothInputs = await tool.execute('call-both', {
      action: 'exec',
      script: 'pwd',
      command: 'node',
    });
    expect(fromAny(bothInputs.details).isError).toBe(true);
    expect(fromAny(bothInputs.content[0]).text).toContain('not both');

    const missingInputs = await tool.execute('call-missing', { action: 'exec' });
    expect(fromAny(missingInputs.details).isError).toBe(true);
    expect(fromAny(missingInputs.content[0]).text).toContain('script or command is required');
    expect(ops.exec).not.toHaveBeenCalled();
  });

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
    expect((fromAny(result.content[0])).text).toContain('"action": "exec"');
    expect((fromAny(result.content[0])).text).toContain('"exit_code": 0');
    expect((fromAny(result.details)).isError).toBeUndefined();
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

  it('describes the audited sandboxed Personal Workspace shell boundary and durable writes', () => {
    const tool = createShellTool({ exec: vi.fn() });

    expect(tool.description).toContain('Personal Workspace');
    expect(tool.description).toContain('Git repositories');
    expect(tool.description).toContain('observability');
    expect(tool.description).toContain('network');
    expect(tool.description).toContain('persist');
    expect(tool.description).toContain('fresh');
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
    expect((fromAny(result.details)).isError).toBe(true);
    expect(result.details).toMatchObject({
      errorClass: 'invalid_input',
      retryHint: 'try_alternative_input',
      retryable: false,
    });
    expect((fromAny(result.content[0])).text).toContain('Supported actions: exec');
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
    expect((fromAny(result.content[0])).text).toContain('shell failed: Blocked by runtime policy');
  });

  it('omits shell from advertised schemas and blocks execution when disabledTools includes shell without affecting file_editor (b3h5p.3)', async () => {
    const shellOps = { exec: vi.fn() };
    const fsOps = {
      list: vi.fn(),
      read: vi.fn(async () => ({
        content: 'still works',
        offsetBytes: 0,
        nextOffsetBytes: null,
        eof: true,
        truncated: false,
      })),
      search: vi.fn(),
      write: vi.fn(),
      edit: vi.fn(),
    };
    const shellTool = createShellTool(shellOps);
    const fileEditorTool = createFileEditorTool(fsOps);
    const granted = new Set(resolveTierCapabilityTokens('autonomous'));
    const disabled = new Set(['shell']);
    const access: CapabilityAccess = {
      getTier: () => 'autonomous',
      getGrantedTokens: () => granted,
      has: (token) => granted.has(token),
      getDisabledTools: () => disabled,
      isToolDisabled: (name) => disabled.has(name),
    };

    const resolution = resolveActiveTools({
      coreTools: [shellTool, fileEditorTool],
      extendedTools: [],
      promotedResolution: { activeNames: new Set(), orderedNames: [], skipped: [] },
      disabledTools: disabled,
    });
    expect(resolution.tools.map(t => t.name)).toEqual(['file_editor']);
    expect(resolution.promotedSkipped).toEqual([
      { toolName: 'shell', source: 'core', reason: 'disabled_by_override' },
    ]);

    const gatedShell = gateToolWithCapabilities(shellTool, () => access);
    const gatedEditor = gateToolWithCapabilities(fileEditorTool, () => access);

    const blockedShell = await gatedShell.execute('call-blocked-shell', {
      action: 'exec',
      script: 'pwd',
    });
    expect(shellOps.exec).not.toHaveBeenCalled();
    expect(fromAny(blockedShell.details)).toMatchObject({
      isError: true,
      toolDisabledByOverride: true,
      toolName: 'shell',
    });

    const allowedRead = await gatedEditor.execute('call-editor-read', {
      action: 'read',
      path: 'notes.txt',
    });
    expect(fsOps.read).toHaveBeenCalledWith('notes.txt', { maxBytes: 100_000, offsetBytes: 0 });
    expect(fromAny(allowedRead.details).isError).toBeUndefined();
    expect(fromAny(allowedRead.content[0]).text).toContain('still works');
  });
});
