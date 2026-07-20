import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeShellCommandWithPolicy } from '../../boundary/sandbox/execution/shell-runner.js';
import {
  createDefaultShellExecSettings,
  normalizeShellExecSettings,
} from '../../system/config/shell-exec-config.js';

async function runShell(
  workspacePath: string,
  command: string,
  timeoutMs = 2_000,
) {
  return await executeShellCommandWithPolicy(
    {
      command: 'bash',
      args: ['-lc', command],
      cwd: workspacePath,
      timeoutMs,
    },
    {
      workspacePath,
      policy: normalizeShellExecSettings({
        ...createDefaultShellExecSettings(),
        enabled: true,
        allowlist: ['bash', 'rg'],
        maxProcesses: 4,
      }),
    },
  );
}

export async function verifyShellSandboxRuntime(): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'psfn-shell-runtime-'));
  const workspacePath = join(root, 'workspace');
  const outsidePath = join(root, 'outside-secret.txt');
  mkdirSync(workspacePath);
  writeFileSync(
    join(workspacePath, 'large.txt'),
    `${'context-line\n'.repeat(2_000)}needle-with-provenance\n`,
    'utf8',
  );
  writeFileSync(outsidePath, 'must-not-be-readable', 'utf8');

  try {
    const document = await runShell(
      workspacePath,
      'printf "bytes="; wc -c < large.txt; rg -n needle-with-provenance large.txt',
    );
    if (
      document.exitCode !== 0
      || !document.stdout.includes('bytes=26023')
      || !document.stdout.includes('2001:needle-with-provenance')
    ) {
      throw new Error(`bounded document inspection failed: ${JSON.stringify(document)}`);
    }

    const isolation = await runShell(
      workspacePath,
      'printf "secret=%s\\n" "${PSFN_SHELL_RUNTIME_SECRET-unset}"; '
        + `if cat ${JSON.stringify(outsidePath)} >/dev/null 2>&1; then printf "outside=read\\n"; `
        + 'else printf "outside=blocked\\n"; fi; '
        + 'printf "net="; cut -d: -f1 /proc/net/dev | tr -d " " | tail -n +3 | paste -sd, -',
    );
    if (
      isolation.exitCode !== 0
      || !isolation.stdout.includes('secret=unset')
      || !isolation.stdout.includes('outside=blocked')
      || !isolation.stdout.includes('net=lo')
      || isolation.stdout.includes('must-not-be-readable')
    ) {
      throw new Error(`sandbox isolation failed: ${JSON.stringify(isolation)}`);
    }

    const limits = await runShell(
      workspacePath,
      'printf "nproc=%s as=%s fsize=%s cpu=%s nofile=%s\\n" '
        + '"$(ulimit -u)" "$(ulimit -v)" "$(ulimit -f)" "$(ulimit -t)" "$(ulimit -n)"',
    );
    if (
      limits.exitCode !== 0
      || limits.stdout !== 'nproc=4 as=131072 fsize=32768 cpu=10 nofile=128\n'
    ) {
      throw new Error(`resource limits missing: ${JSON.stringify(limits)}`);
    }

    const forkPressure = await runShell(
      workspacePath,
      'for i in 1 2 3 4 5 6 7 8; do sleep 10 & done; wait',
      1_000,
    );
    if (!forkPressure.timedOut || !forkPressure.stderr.includes('Resource temporarily unavailable')) {
      throw new Error(`descendant process ceiling missing: ${JSON.stringify(forkPressure)}`);
    }

    return {
      ok: true,
      documentBytes: 26_023,
      outsideWorkspace: 'blocked',
      networkInterfaces: ['lo'],
      inheritedSecret: false,
      resourceLimits: limits.stdout.trim(),
      forkPressureBlocked: true,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('verify-shell-sandbox-runtime.js')) {
  verifyShellSandboxRuntime()
    .then(result => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
