import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { wireGitRuntime, type GitRuntimeTarget } from './runtime-wiring.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

class FakeTarget implements GitRuntimeTarget {
  tools: AgentTool<any>[] = [];

  registerTool(tool: AgentTool<any>): void {
    this.tools.push(tool);
  }
}

describe('wireGitRuntime', () => {
  it('registers the unified repo tool as an extended dev surface (psfn img2 audit)', () => {
    const target = new FakeTarget();
    const registerTool = vi.spyOn(target, 'registerTool');

    wireGitRuntime(target, {
      repoRoot: '/test',
      allowedPaths: ['src/'],
    });

    expect(target.tools.map(t => t.name)).toEqual(['repo']);
    expect(registerTool.mock.calls.map(([tool, category]) => [tool.name, category])).toEqual([
      ['repo', 'extended'],
    ]);
  });

  it('supports read_only registration for parent-agent runtime use', async () => {
    const target = new FakeTarget();

    wireGitRuntime(target, {
      repoRoot: '/test',
      allowedPaths: ['src/'],
    }, {
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
  });

  it('returns a GitOps instance', () => {
    const target = new FakeTarget();
    const gitOps = wireGitRuntime(target, { repoRoot: '/test' });

    expect(gitOps).toBeDefined();
    expect(typeof gitOps.status).toBe('function');
    expect(typeof gitOps.commit).toBe('function');
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
