import { describe, expect, it } from 'vitest';
import { buildBubblewrapArgs, READ_ONLY_ETC_PATHS } from './bubblewrap-runner.js';
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
    deadlineBinaryPath: '/usr/bin/timeout',
    sandboxPath: '/usr/local/bin:/usr/bin:/bin',
    networkAccess: false,
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
  it('masks quarantined artifacts with read-only /dev/null binds AFTER the workspace/repo binds (hrmrq.54)', () => {
    const args = buildBubblewrapArgs({
      ...request(),
      repositoryMountPath: '/srv/psfn-repo',
      shadowReadPaths: ['/workspace/files/doc.md', '/repo/docs/held.txt'],
    });
    const sequence = args.join('\0');

    expect(sequence).toContain('--ro-bind\0/dev/null\0/workspace/files/doc.md');
    expect(sequence).toContain('--ro-bind\0/dev/null\0/repo/docs/held.txt');
    // Ordering is load-bearing: the /dev/null mount must layer OVER the
    // workspace and repo binds, or the real bytes stay visible.
    expect(sequence.indexOf('--bind\0/app/workspace\0/workspace'))
      .toBeLessThan(sequence.indexOf('--ro-bind\0/dev/null\0/workspace/files/doc.md'));
    expect(sequence.indexOf('--ro-bind\0/srv/psfn-repo\0/repo'))
      .toBeLessThan(sequence.indexOf('--ro-bind\0/dev/null\0/repo/docs/held.txt'));
  });

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
    expect(args.slice(-3)).toEqual([
      '/usr/bin/bash',
      '-lc',
      'rg needle docs/large.md',
    ]);
    expect(rendered).not.toContain('/app/system-data');
    expect(rendered).not.toContain('/app/companion-data');
    expect(rendered).not.toContain('/var/run/secrets');
  });

  it('shares the gateway network only for a policy-resolved top-level command', () => {
    const args = buildBubblewrapArgs({
      ...request(),
      command: 'multica',
      executableCommand: '/usr/local/bin/multica',
      args: ['workspace', 'list', '--output', 'json'],
      networkAccess: true,
    });

    expect(args).not.toContain('--unshare-net');
    expect(args.slice(-5)).toEqual([
      '/usr/local/bin/multica',
      'workspace',
      'list',
      '--output',
      'json',
    ]);
  });

  it('wraps the command in a kernel-enforced in-sandbox deadline after the rlimit stage', () => {
    const sequence = buildBubblewrapArgs(request()).join('\0');

    // prlimit → timeout → command: the deadline supervisor runs inside the
    // namespace so its SIGKILL and the namespace teardown on its exit are
    // kernel-enforced, independent of the agent process's event loop.
    expect(sequence).toContain(
      ['--core=0:0', '--', '/usr/bin/timeout', '--signal=KILL', '600.000', '/usr/bin/bash'].join('\0'),
    );

    const millisecondPrecision = buildBubblewrapArgs({ ...request(), timeoutMs: 50 }).join('\0');
    expect(millisecondPrecision).toContain(
      ['/usr/bin/timeout', '--signal=KILL', '0.050', '/usr/bin/bash'].join('\0'),
    );
  });

  it('exposes only the allowlisted host configuration needed by image tools', () => {
    expect(READ_ONLY_ETC_PATHS).toEqual(expect.arrayContaining([
      '/etc/alternatives',
      '/etc/ca-certificates',
      '/etc/hosts',
      '/etc/resolv.conf',
      '/etc/ssl',
    ]));
    expect(READ_ONLY_ETC_PATHS).not.toContain('/etc');
    expect(READ_ONLY_ETC_PATHS).not.toContain('/etc/shadow');
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
