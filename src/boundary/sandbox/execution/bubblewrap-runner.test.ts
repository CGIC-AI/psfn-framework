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
    sandboxPath: '/usr/local/bin:/usr/bin:/bin',
    childEnv: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/workspace',
      PWD: '/workspace',
    },
    timeoutMs: 5_000,
    maxOutputChars: 20_000,
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
