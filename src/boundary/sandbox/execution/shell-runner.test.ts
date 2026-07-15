import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeShellCommandWithPolicy,
  SHELL_EXEC_CONFINEMENT_UNAVAILABLE,
} from './shell-runner.js';

describe('executeShellCommandWithPolicy', () => {
  const tempPaths: string[] = [];

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

  async function expectConfinementDenial(
    command: string,
    args: string[],
    workspace: string,
  ): Promise<void> {
    await expect(executeShellCommandWithPolicy(
      { command, args, cwd: workspace },
      {
        workspacePath: workspace,
        policy: { enabled: true, allowlist: [command], allowedCwd: [workspace] },
      },
    )).rejects.toThrow(SHELL_EXEC_CONFINEMENT_UNAVAILABLE);
  }

  it('retains the explicit disabled-policy denial', async () => {
    const { workspace } = workspaceFixture();
    await expect(executeShellCommandWithPolicy(
      { command: 'printf', args: ['never'], cwd: workspace },
      { workspacePath: workspace, policy: { enabled: false, allowlist: ['printf'] } },
    )).rejects.toThrow('shell.exec policy is disabled');
  });

  it('fails closed for Python program-text file access', async () => {
    const { workspace, outside } = workspaceFixture();
    await expectConfinementDenial(
      'python3',
      ['-c', `open(${JSON.stringify(join(outside, 'secret.txt'))}).read()`],
      workspace,
    );
  });

  it('fails closed for an interpreter reached through a symlink alias', async () => {
    const { workspace } = workspaceFixture();
    const alias = join(workspace, 'innocent-command');
    symlinkSync(process.execPath, alias);
    await expectConfinementDenial(alias, ['-e', 'process.exit(0)'], workspace);
  });

  it('fails closed for non-blacklisted evaluators such as awk', async () => {
    const { workspace } = workspaceFixture();
    await expectConfinementDenial('awk', ['BEGIN { getline line < "/etc/hostname"; print line }'], workspace);
  });

  it('never executes an allowlisted binary that is swapped after policy configuration', async () => {
    const { workspace, outside } = workspaceFixture();
    const executable = join(workspace, 'approved-command');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // Model the check/use replacement the old canonical-path policy could not
    // bind to exec: the same allowlisted pathname now contains a file read.
    writeFileSync(executable, `#!/bin/sh\ncat '${join(outside, 'secret.txt')}' > '${join(workspace, 'leak.txt')}'\n`);
    chmodSync(executable, 0o755);

    await expectConfinementDenial(executable, [], workspace);
    expect(existsSync(join(workspace, 'leak.txt'))).toBe(false);
  });

  it('never follows cwd or argument path swaps because no child is spawned', async () => {
    const { workspace, outside } = workspaceFixture();
    const cwdAlias = join(workspace, 'cwd');
    const argumentAlias = join(workspace, 'argument.txt');
    mkdirSync(cwdAlias);
    writeFileSync(argumentAlias, 'safe');
    rmSync(cwdAlias, { recursive: true });
    rmSync(argumentAlias);
    symlinkSync(outside, cwdAlias, 'dir');
    symlinkSync(join(outside, 'secret.txt'), argumentAlias);

    await expectConfinementDenial('cat', [argumentAlias], workspace);
  });
});
