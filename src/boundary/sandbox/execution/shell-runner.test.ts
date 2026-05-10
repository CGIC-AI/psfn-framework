import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeShellCommandWithPolicy } from './shell-runner.js';

describe('executeShellCommandWithPolicy', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    while (tempPaths.length > 0) {
      const target = tempPaths.pop();
      if (!target) continue;
      rmSync(target, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempPaths.push(dir);
    return dir;
  }

  function makeWorkspaceFixture(): { workspace: string; outside: string } {
    const root = makeTempDir('psfn-shell-runner-');
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(workspace, 'visible.txt'), 'workspace-data', 'utf8');
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret', 'utf8');
    return { workspace, outside };
  }

  it('allows allowlisted cat to read a relative file inside the workspace', async () => {
    const { workspace } = makeWorkspaceFixture();

    const result = await executeShellCommandWithPolicy(
      {
        command: 'cat',
        args: ['visible.txt'],
        cwd: workspace,
      },
      {
        workspacePath: workspace,
        policy: {
          enabled: true,
          allowlist: ['cat'],
          allowedCwd: [workspace],
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('workspace-data');
  });

  it('denies allowlisted cat reading outside the workspace via relative path arguments', async () => {
    const { workspace } = makeWorkspaceFixture();

    await expect(executeShellCommandWithPolicy(
      {
        command: 'cat',
        args: ['../outside/secret.txt'],
        cwd: workspace,
      },
      {
        workspacePath: workspace,
        policy: {
          enabled: true,
          allowlist: ['cat'],
          allowedCwd: [workspace],
        },
      },
    )).rejects.toThrow('argument path not allowlisted');
  });

  it('denies allowlisted cat reading outside through a workspace symlink argument', async () => {
    const { workspace, outside } = makeWorkspaceFixture();
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'secret-link'));

    await expect(executeShellCommandWithPolicy(
      {
        command: 'cat',
        args: ['secret-link'],
        cwd: workspace,
      },
      {
        workspacePath: workspace,
        policy: {
          enabled: true,
          allowlist: ['cat'],
          allowedCwd: [workspace],
        },
      },
    )).rejects.toThrow('argument path not allowlisted');
  });
});
