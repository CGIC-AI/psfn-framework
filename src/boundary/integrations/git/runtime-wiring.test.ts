import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { AgentTool } from '../../pi-agent/index.js';
import type { GitOperations } from './ops.js';
import { registerGitTools, type GitRuntimeTarget } from './runtime-wiring.js';

function gitOperations(): GitOperations {
  return {
    status: vi.fn(async () => ({ branch: 'feature/example', ahead: 0, behind: 0, staged: [], modified: [], untracked: [] })),
    diff: vi.fn(async () => ({ staged: '', unstaged: '' })),
    applyPatch: vi.fn(),
    createBranch: vi.fn(),
    commit: vi.fn(),
    openPR: vi.fn(),
  };
}

class FakeTarget implements GitRuntimeTarget {
  tools: AgentTool<unknown>[] = [];

  registerTool(tool: AgentTool<unknown>): void {
    this.tools.push(tool);
  }
}

describe('registerGitTools', () => {
  it('registers the unified repo tool as an extended dev surface (psfn img2 audit)', () => {
    const target = new FakeTarget();
    const registerTool = vi.spyOn(target, 'registerTool');

    registerGitTools(target, gitOperations());

    expect(target.tools.map(t => t.name)).toEqual(['repo']);
    expect(registerTool.mock.calls.map(([tool, category]) => [tool.name, category])).toEqual([
      ['repo', 'extended'],
    ]);
  });

  it('supports read_only registration for parent-agent runtime use', async () => {
    const target = new FakeTarget();

    const operations = gitOperations();
    registerGitTools(target, operations, {
      access: 'read_only',
    });

    expect(target.tools.map(t => t.name)).toEqual(['repo']);
    const result = await target.tools[0].execute('call', {
      action: 'patch',
      file_path: 'src/x.ts',
      content: 'x',
    });
    expect((result.content[0] as { text: string }).text).toContain('read_only mode');
    expect(result.details?.isError).toBe(true);
    expect(operations.applyPatch).not.toHaveBeenCalled();
  });
});

describe('entrypoint composition', () => {
  it('agent-main.ts registers parent git tools via gateway-backed read-only ops', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const agentMainSource = fs.readFileSync(resolve('src/app/agent/main.ts'), 'utf-8');
    expect(agentMainSource).toContain('registerGitTools(');
    expect(agentMainSource).toContain('createGatewayOpsPortFromClient(gateway)');
    expect(agentMainSource).toContain('new GatewayGitOps(gatewayOps)');
    expect(agentMainSource).toContain("access: 'read_only'");
  });
});
