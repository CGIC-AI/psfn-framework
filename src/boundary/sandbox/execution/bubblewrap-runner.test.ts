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
    timeoutMs: 5_000,
    maxOutputChars: 20_000,
    maxProcesses: 8,
    maxAddressSpaceBytes: 134_217_728,
    maxFileBytes: 16_777_216,
    maxCpuSeconds: 10,
    maxOpenFiles: 128,
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
    expect(sequence).toContain('--bind\0/app/workspace\0/workspace');
    expect(sequence).toContain('--chdir\0/workspace/docs');
    expect(sequence).toContain('--\0/usr/bin/prlimit\0--nproc=8:8');
    expect(args).toEqual(expect.arrayContaining([
      '--as=134217728:134217728',
      '--fsize=16777216:16777216',
      '--cpu=10:10',
      '--nofile=128:128',
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
});
