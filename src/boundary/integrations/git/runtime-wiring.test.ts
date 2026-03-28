import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { wireGitRuntime, type GitRuntimeTarget } from './runtime-wiring.js';

// Mock child_process so GitOps doesn't try to run real git commands
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
  it('registers git read tools as core and git write tools as extended', () => {
    const target = new FakeTarget();
    wireGitRuntime(target, {
      repoRoot: '/test',
      allowedPaths: ['src/'],
    });

    expect(target.tools.map(t => t.name).sort()).toEqual([
      'repo_apply_patch',
      'repo_commit',
      'repo_create_branch',
      'repo_diff',
      'repo_open_pr',
      'repo_status',
    ]);
    const registerTool = vi.spyOn(target, 'registerTool');
    wireGitRuntime(target, {
      repoRoot: '/test',
      allowedPaths: ['src/'],
    });
    const categories = registerTool.mock.calls.map(([tool, category]) => [tool.name, category]);
    expect(categories).toEqual(expect.arrayContaining([
      ['repo_status', 'core'],
      ['repo_diff', 'core'],
      ['repo_apply_patch', 'extended'],
      ['repo_commit', 'extended'],
    ]));
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
  it('agent-main.ts registers git tools via gateway-backed ops', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const agentMainSource = fs.readFileSync(resolve('src/app/agent/main.ts'), 'utf-8');
    expect(agentMainSource).toContain('registerGitTools(');
    expect(agentMainSource).toContain('new GatewayGitOps(gateway)');
  });
});
