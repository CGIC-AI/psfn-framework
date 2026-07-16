import { describe, expect, it } from 'vitest';
import { runConfiguredLifecycleCommand } from './command-runner.js';

function nodeCommand(script: string): string {
  return `${process.execPath} -e "${script}"`;
}

describe('runConfiguredLifecycleCommand', () => {
  it('settles only after a fixed-argv command exits successfully', async () => {
    await expect(runConfiguredLifecycleCommand(
      nodeCommand('process.stdout.write(\'ok\')'),
    )).resolves.toBeUndefined();
  });

  it('rejects a non-zero command result with bounded diagnostics', async () => {
    await expect(runConfiguredLifecycleCommand(
      nodeCommand('process.stderr.write(\'failed\');process.exit(7)'),
      { maxOutputChars: 4 },
    )).rejects.toThrow('exit code 7 (output truncated)\nfail');
  });

  it('terminates and rejects a command that exceeds its deadline', async () => {
    await expect(runConfiguredLifecycleCommand(
      nodeCommand('setInterval(() => undefined,1000)'),
      { timeoutMs: 25 },
    )).rejects.toThrow('timed out after 25ms');
  });

  it('rejects a command terminated without an exit status', async () => {
    await expect(runConfiguredLifecycleCommand(
      nodeCommand('process.kill(process.pid,\'SIGTERM\')'),
    )).rejects.toThrow('exited without a status after signal SIGTERM');
  });

  it('rejects missing and unstartable operator commands', async () => {
    await expect(runConfiguredLifecycleCommand(undefined)).rejects.toThrow(
      'missing a restart command',
    );
    await expect(runConfiguredLifecycleCommand(
      'definitely-not-a-psfn-lifecycle-command',
    )).rejects.toThrow('failed to start');
  });
});
