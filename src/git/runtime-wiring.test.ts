import { readFileSync } from 'node:fs';
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
  it('registers all 6 git tools', () => {
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
  it('runtime.ts uses wireGitRuntime', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const runtimeSource = fs.readFileSync(resolve('src/runtime.ts'), 'utf-8');
    expect(runtimeSource).toContain('wireGitRuntime(');
  });

  it('agent-main.ts uses wireGitRuntime', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const agentMainSource = fs.readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(agentMainSource).toContain('wireGitRuntime(');
  });
});
