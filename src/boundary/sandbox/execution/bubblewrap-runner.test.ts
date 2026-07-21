import { describe, expect, it } from 'vitest';
import { buildBubblewrapArgs } from './bubblewrap-runner.js';
import type { ResolvedShellExecution } from './shell-execution-policy.js';

function request(): ResolvedShellExecution {
  return {
    command: 'bash',
    executableCommand: '/usr/bin/bash',
    args: ['-lc', 'rg needle docs/large.md'],
    workspacePath: '/app/workspace',
    cwd: '/app/workspace/docs',
    sandboxCwd: '/workspace/docs',
    sandboxBinaryPath: '/usr/bin/bwrap',
    resourceLimitBinaryPath: '/usr/bin/prlimit',
    sandboxPath: '/usr/local/bin:/usr/bin:/bin',
    childEnv: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/workspace',
      PWD: '/workspace',
    },
    timeoutMs: 600_000,
    maxOutputChars: 20_000,
    maxProcesses: 64,
    maxAddressSpaceBytes: 2_147_483_648,
    maxFileBytes: 268_435_456,
    maxCpuSeconds: 1_800,
    maxOpenFiles: 512,
  };
}

describe('buildBubblewrapArgs', () => {
  it('builds a no-network namespace with only the Personal Workspace writable', () => {
    const args = buildBubblewrapArgs(request());
    const rendered = JSON.stringify(args);
    const sequence = args.join('\0');

    expect(args).toEqual(expect.arrayContaining([
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-cgroup',
      '--unshare-net',
      '--cap-drop',
      'ALL',
      '--clearenv',
    ]));
    expect(sequence).toContain('--ro-bind\0/usr\0/usr');
    expect(sequence).toContain('--ro-bind\0/usr/local\0/usr/local');
    expect(sequence).toContain('--bind\0/app/workspace\0/workspace');
    expect(sequence).toContain('--chdir\0/workspace/docs');
    expect(sequence).toContain('--\0/usr/bin/prlimit\0--nproc=64:64');
    expect(args).toEqual(expect.arrayContaining([
      '--as=2147483648:2147483648',
      '--fsize=268435456:268435456',
      '--cpu=1800:1800',
      '--nofile=512:512',
      '--core=0:0',
    ]));
    expect(args.slice(-4)).toEqual([
      '--',
      '/usr/bin/bash',
      '-lc',
      'rg needle docs/large.md',
    ]);
    expect(rendered).not.toContain('/app/system-data');
    expect(rendered).not.toContain('/app/companion-data');
    expect(rendered).not.toContain('/var/run/secrets');
  });

  it('omits the repository mount unless the policy resolved one', () => {
    const sequence = buildBubblewrapArgs(request()).join('\0');
    expect(sequence).not.toContain('/repo');
  });

  it('binds the resolved repository copy read-only at /repo', () => {
    const args = buildBubblewrapArgs({
      ...request(),
      repositoryMountPath: '/app/repository',
    });
    const sequence = args.join('\0');
    expect(sequence).toContain('--ro-bind\0/app/repository\0/repo');
    expect(sequence).not.toContain('--bind\0/app/repository');
    // The workspace bind must stay the only writable persistent root.
    expect(args.filter(arg => arg === '--bind')).toHaveLength(1);
  });
});
