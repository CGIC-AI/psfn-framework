import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeShellCommandWithPolicy,
} from './shell-runner.js';

describe('executeShellCommandWithPolicy', () => {
  const tempPaths: string[] = [];
  const sandboxBinaryPath = '/usr/bin/bwrap';

  afterEach(() => {
    for (const target of tempPaths.splice(0)) rmSync(target, { recursive: true, force: true });
  });

  function workspaceFixture(): { workspace: string; outside: string } {
    const root = mkdtempSync(join(tmpdir(), 'psfn-shell-fail-closed-'));
    tempPaths.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'peer-secret');
    return { workspace, outside };
  }

  function enabledPolicy(workspace: string) {
    return {
      enabled: true,
      allowlist: ['bash', 'rg'],
      allowedCwd: [workspace],
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 2_000,
      defaultMaxOutputChars: 20_000,
      maxOutputChars: 20_000,
    };
  }

  it('retains the explicit disabled-policy denial', async () => {
    const { workspace } = workspaceFixture();
    await expect(executeShellCommandWithPolicy(
      { command: 'printf', args: ['never'], cwd: workspace },
      { workspacePath: workspace, policy: { enabled: false, allowlist: ['printf'] } },
    )).rejects.toThrow('shell.exec policy is disabled');
  });

  it('rejects commands outside the explicit allowlist before execution', async () => {
    const { workspace } = workspaceFixture();

    await expect(executeShellCommandWithPolicy(
      { command: 'node', args: ['--version'], cwd: workspace },
      { workspacePath: workspace, policy: enabledPolicy(workspace) },
    )).rejects.toThrow('shell.exec command not allowlisted: node');
  });

  it('rejects working directories outside the canonical Personal Workspace', async () => {
    const { workspace, outside } = workspaceFixture();

    await expect(executeShellCommandWithPolicy(
      { command: 'bash', args: ['-lc', 'pwd'], cwd: outside },
      { workspacePath: workspace, policy: enabledPolicy(workspace) },
    )).rejects.toThrow('shell.exec cwd not allowlisted');
  });

  it('fails closed when the repository mount is enabled without a configured checkout', async () => {
    const { workspace } = workspaceFixture();

    await expect(executeShellCommandWithPolicy(
      { command: 'bash', args: ['-lc', 'true'], cwd: workspace },
      {
        workspacePath: workspace,
        policy: { ...enabledPolicy(workspace), mountRepositoryReadOnly: true },
      },
    )).rejects.toThrow('no repository checkout is configured');
  });

  it('fails closed when the repository mount source is missing or overlaps the workspace', async () => {
    const { workspace, outside } = workspaceFixture();

    await expect(executeShellCommandWithPolicy(
      { command: 'bash', args: ['-lc', 'true'], cwd: workspace },
      {
        workspacePath: workspace,
        policy: {
          ...enabledPolicy(workspace),
          mountRepositoryReadOnly: true,
          repositoryMountSource: join(outside, 'missing-checkout'),
        },
      },
    )).rejects.toThrow('shell.exec repository mount is unavailable');

    for (const overlapping of [workspace, join(workspace, '.')]) {
      await expect(executeShellCommandWithPolicy(
        { command: 'bash', args: ['-lc', 'true'], cwd: workspace },
        {
          workspacePath: workspace,
          policy: {
            ...enabledPolicy(workspace),
            mountRepositoryReadOnly: true,
            repositoryMountSource: overlapping,
          },
        },
      )).rejects.toThrow('must not overlap the Personal Workspace');
    }
  });

  it.each([
    ['system-data parent', 'system-data', 'owners', '.'],
    ['system-data child', 'system-data', '.', 'repository'],
    ['companion-data parent', 'companion-data', 'state', '.'],
    ['companion-data child', 'companion-data', '.', 'repository'],
  ])('fails closed when the repository mount overlaps the %s root', async (
    _caseName,
    protectedRootName,
    protectedRootSuffix,
    repositorySuffix,
  ) => {
    const { workspace, outside } = workspaceFixture();
    const systemDataPath = join(
      outside,
      'system-data',
      protectedRootName === 'system-data' ? protectedRootSuffix : '.',
    );
    const companionDataPath = join(
      outside,
      'companion-data',
      protectedRootName === 'companion-data' ? protectedRootSuffix : '.',
    );
    mkdirSync(systemDataPath, { recursive: true });
    mkdirSync(companionDataPath, { recursive: true });
    if (repositorySuffix !== '.') {
      mkdirSync(join(outside, protectedRootName, repositorySuffix));
    }
    const policy = {
      ...enabledPolicy(workspace),
      mountRepositoryReadOnly: true,
      repositoryMountSource: join(outside, protectedRootName, repositorySuffix),
      systemDataRoot: systemDataPath,
      companionDataRoot: companionDataPath,
    };

    await expect(executeShellCommandWithPolicy(
      { command: 'bash', args: ['-lc', 'true'], cwd: workspace },
      { workspacePath: workspace, policy },
    )).rejects.toThrow(`must not overlap the ${protectedRootName} root`);
  });

  it.each(['system-data', 'companion-data'])(
    'fails closed when the %s root is missing from repository mount policy resolution',
    async (missingRoot) => {
      const { workspace, outside } = workspaceFixture();
      const repositoryMountSource = join(outside, 'repository');
      const systemDataRoot = join(outside, 'system-data');
      const companionDataRoot = join(outside, 'companion-data');
      mkdirSync(repositoryMountSource);
      mkdirSync(systemDataRoot);
      mkdirSync(companionDataRoot);
      const policy = {
        ...enabledPolicy(workspace),
        mountRepositoryReadOnly: true,
        repositoryMountSource,
        ...(missingRoot === 'system-data' ? {} : { systemDataRoot }),
        ...(missingRoot === 'companion-data' ? {} : { companionDataRoot }),
      };

      await expect(executeShellCommandWithPolicy(
        { command: 'bash', args: ['-lc', 'true'], cwd: workspace },
        { workspacePath: workspace, policy },
      )).rejects.toThrow(
        `shell.exec ${missingRoot} root is required when the repository mount is enabled`,
      );
    },
  );

  it.runIf(!existsSync(sandboxBinaryPath))('fails closed when the namespace sandbox is unavailable', async () => {
    const { workspace } = workspaceFixture();

    await expect(executeShellCommandWithPolicy(
      { command: 'bash', args: ['-lc', 'printf ok'], cwd: workspace },
      { workspacePath: workspace, policy: enabledPolicy(workspace) },
    )).rejects.toThrow('shell.exec sandbox unavailable');
  });

  describe.runIf(existsSync(sandboxBinaryPath))('with the OS namespace sandbox', () => {
    it('runs Bash in the Personal Workspace and persists its writes there', async () => {
      const { workspace } = workspaceFixture();

      const result = await executeShellCommandWithPolicy(
        {
          command: 'bash',
          args: ['-lc', 'printf "alpha\\nbeta\\n" > notes.txt && rg beta notes.txt'],
          cwd: workspace,
        },
        { workspacePath: workspace, policy: enabledPolicy(workspace) },
      );

      expect(result).toMatchObject({
        command: 'bash',
        args: ['-lc', 'printf "alpha\\nbeta\\n" > notes.txt && rg beta notes.txt'],
        cwd: workspace,
        exitCode: 0,
        stdout: 'beta\n',
        stderr: '',
        timedOut: false,
        truncated: false,
      });
      expect(existsSync(join(workspace, 'notes.txt'))).toBe(true);
    });

    it('cannot read outside the Personal Workspace or inherit process secrets', async () => {
      const previousSecret = process.env.PSFN_SHELL_TEST_SECRET;
      process.env.PSFN_SHELL_TEST_SECRET = 'must-not-leak';
      const { workspace, outside } = workspaceFixture();

      try {
        const result = await executeShellCommandWithPolicy(
          {
            command: 'bash',
            args: [
              '-lc',
              'printf "secret=%s\\n" "${PSFN_SHELL_TEST_SECRET-unset}"; '
                + 'if cat "$1" >/tmp/outside 2>/dev/null; then printf "outside=read\\n"; '
                + 'else printf "outside=blocked\\n"; fi; '
                + 'printf "net_devices="; cut -d: -f1 /proc/net/dev | tr -d " " | tail -n +3 | paste -sd, -',
              '--',
              join(outside, 'secret.txt'),
            ],
            cwd: workspace,
          },
          { workspacePath: workspace, policy: enabledPolicy(workspace) },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('secret=unset');
        expect(result.stdout).toContain('outside=blocked');
        expect(result.stdout).toContain('net_devices=lo');
        expect(result.stdout).not.toContain('peer-secret');
        expect(result.stdout).not.toContain('eth0');
      } finally {
        if (previousSecret === undefined) delete process.env.PSFN_SHELL_TEST_SECRET;
        else process.env.PSFN_SHELL_TEST_SECRET = previousSecret;
      }
    });

    it('bounds output and terminates commands at the configured timeout', async () => {
      const { workspace } = workspaceFixture();
      const output = await executeShellCommandWithPolicy(
        {
          command: 'bash',
          args: ['-lc', 'printf 1234567890'],
          cwd: workspace,
          maxOutputChars: 4,
        },
        { workspacePath: workspace, policy: enabledPolicy(workspace) },
      );
      const timeout = await executeShellCommandWithPolicy(
        {
          command: 'bash',
          args: ['-lc', 'while :; do :; done'],
          cwd: workspace,
          timeoutMs: 50,
        },
        { workspacePath: workspace, policy: enabledPolicy(workspace) },
      );

      expect(output.stdout).toBe('1234');
      expect(output.truncated).toBe(true);
      expect(timeout.exitCode).toBeNull();
      expect(timeout.timedOut).toBe(true);
    });

    it('enforces descendant process, address-space, file, CPU, and fd ceilings', async () => {
      const { workspace } = workspaceFixture();
      const result = await executeShellCommandWithPolicy(
        {
          command: 'bash',
          args: [
            '-lc',
            // fsize is read in BYTES from /proc/self/limits rather than via
            // `ulimit -f`, whose reporting unit is not stable across shells:
            // bash 5.3 prints the RLIMIT_FSIZE soft limit in 1024-byte units
            // while older bash/dash print 512-byte POSIX blocks, so the same
            // 1 MiB ceiling surfaces as different numbers. /proc/self/limits is
            // authoritative and unit-stable (the OS-namespace sandbox is
            // Linux-only, so /proc is always present). awk splits on runs of
            // whitespace, so the column index is robust to spacing; "Max file
            // size" spans fields 1-3, leaving the soft limit at field 4.
            'printf "nproc=%s as=%s fsize=%s cpu=%s nofile=%s\\n" '
              + '"$(ulimit -u)" "$(ulimit -v)" '
              + '"$(awk \'/^Max file size/ { print $4 }\' /proc/self/limits)" '
              + '"$(ulimit -t)" "$(ulimit -n)"',
          ],
          cwd: workspace,
        },
        {
          workspacePath: workspace,
          policy: {
            ...enabledPolicy(workspace),
            maxProcesses: 4,
            maxAddressSpaceBytes: 128 * 1024 * 1024,
            maxFileBytes: 1024 * 1024,
            maxCpuSeconds: 2,
            maxOpenFiles: 32,
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('nproc=4 as=131072 fsize=1048576 cpu=2 nofile=32\n');
    });

    it('mounts the configured repository copy read-only at /repo and keeps it out by default', async () => {
      const { workspace, outside } = workspaceFixture();
      const repoSource = join(outside, 'repo-src');
      const systemDataRoot = join(outside, 'system-data');
      const companionDataRoot = join(outside, 'companion-data');
      mkdirSync(repoSource);
      mkdirSync(systemDataRoot);
      mkdirSync(companionDataRoot);
      writeFileSync(join(repoSource, 'README.md'), 'repo-copy-marker\n');

      const mounted = await executeShellCommandWithPolicy(
        {
          command: 'bash',
          args: [
            '-lc',
            'printf "repo_env=%s\\n" "${PSFN_REPO-unset}"; cat /repo/README.md; '
              + 'if printf x > /repo/probe 2>/dev/null; then printf "repo_write=allowed\\n"; '
              + 'else printf "repo_write=denied\\n"; fi',
          ],
          cwd: workspace,
        },
        {
          workspacePath: workspace,
          policy: {
            ...enabledPolicy(workspace),
            mountRepositoryReadOnly: true,
            repositoryMountSource: repoSource,
            systemDataRoot,
            companionDataRoot,
          },
        },
      );
      expect(mounted.exitCode).toBe(0);
      expect(mounted.stdout).toContain('repo_env=/repo');
      expect(mounted.stdout).toContain('repo-copy-marker');
      expect(mounted.stdout).toContain('repo_write=denied');

      const unmounted = await executeShellCommandWithPolicy(
        {
          command: 'bash',
          args: [
            '-lc',
            'if [ -e /repo ]; then printf present; else printf absent; fi; '
              + 'printf " repo_env=%s" "${PSFN_REPO-unset}"',
          ],
          cwd: workspace,
        },
        {
          workspacePath: workspace,
          // A configured source without the operator toggle must not mount.
          policy: { ...enabledPolicy(workspace), repositoryMountSource: repoSource },
        },
      );
      expect(unmounted.stdout).toBe('absent repo_env=unset');
    });

    it('does not expose a host path through a symlink inside the workspace', async () => {
      const { workspace, outside } = workspaceFixture();
      const link = join(workspace, 'outside-link');
      symlinkSync(join(outside, 'secret.txt'), link);

      const result = await executeShellCommandWithPolicy(
        {
          command: 'bash',
          args: ['-lc', 'if cat outside-link >/dev/null 2>&1; then printf read; else printf blocked; fi'],
          cwd: workspace,
        },
        { workspacePath: workspace, policy: enabledPolicy(workspace) },
      );

      expect(result.stdout).toBe('blocked');
    });
  });
});
