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

  it('allows missing relative path arguments inside the workspace', async () => {
    const { workspace } = makeWorkspaceFixture();

    const result = await executeShellCommandWithPolicy(
      {
        command: 'test',
        args: ['-e', 'missing.txt'],
        cwd: workspace,
      },
      {
        workspacePath: workspace,
        policy: {
          enabled: true,
          allowlist: ['test'],
          allowedCwd: [workspace],
        },
      },
    );

    expect(result.exitCode).toBe(1);
  });

  it('denies missing argument paths when their parent symlink resolves outside', async () => {
    const { workspace, outside } = makeWorkspaceFixture();
    symlinkSync(outside, join(workspace, 'outside-link'));

    await expect(executeShellCommandWithPolicy(
      {
        command: 'cat',
        args: ['outside-link/missing.txt'],
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

  it('falls back to normalized argument paths on symlink loops', async () => {
    const { workspace } = makeWorkspaceFixture();
    const loopA = join(workspace, 'loop-a');
    const loopB = join(workspace, 'loop-b');
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);

    const result = await executeShellCommandWithPolicy(
      {
        command: 'test',
        args: ['-e', 'loop-a'],
        cwd: workspace,
      },
      {
        workspacePath: workspace,
        policy: {
          enabled: true,
          allowlist: ['test'],
          allowedCwd: [workspace],
        },
      },
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('runs the child against a curated PATH that ignores a poisoned parent PATH', async () => {
    const { workspace } = makeWorkspaceFixture();
    const previousPath = process.env.PATH;
    // ponytail: poison parent PATH with a hostile dir first on the list
    process.env.PATH = `${join(workspace, 'hostile')}:${previousPath ?? ''}`;
    try {
      const result = await executeShellCommandWithPolicy(
        { command: 'printenv', args: ['PATH'], cwd: workspace },
        {
          workspacePath: workspace,
          policy: { enabled: true, allowlist: ['printenv'], allowedCwd: [workspace] },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(['/usr/local/bin', '/usr/bin', '/bin'].join(':'));
      expect(result.stdout).not.toContain('hostile');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('honors an operator PATH override for the sandbox child', async () => {
    const { workspace } = makeWorkspaceFixture();
    const result = await executeShellCommandWithPolicy(
      { command: 'printenv', args: ['PATH'], cwd: workspace },
      {
        workspacePath: workspace,
        policy: {
          enabled: true,
          allowlist: ['printenv'],
          allowedCwd: [workspace],
          pathOverride: '/usr/bin',
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/usr/bin');
  });
});
