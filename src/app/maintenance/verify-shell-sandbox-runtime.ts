import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeShellCommandWithPolicy,
  ShellExecPolicyError,
} from '../../boundary/sandbox/execution/shell-runner.js';
import type { ShellExecPolicyConfig } from '../../boundary/sandbox/execution/shell-policy-config.js';
import {
  createDefaultShellExecSettings,
  normalizeShellExecSettings,
} from '../../system/config/shell-exec-config.js';

async function runShell(
  workspacePath: string,
  command: string,
  timeoutMs = 2_000,
  policyOverrides: Partial<ShellExecPolicyConfig> = {},
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
      policy: {
        ...normalizeShellExecSettings({
          ...createDefaultShellExecSettings(),
          enabled: true,
          allowlist: ['bash', 'rg'],
          mountRepositoryReadOnly: policyOverrides.mountRepositoryReadOnly === true,
        }),
        ...policyOverrides,
      },
    },
  );
}

/**
 * Every analysis tool the image contract promises must run inside the sandbox
 * and identify itself; a missing binary fails the probe, never skips it.
 */
const SANDBOX_TOOL_PROBES: ReadonlyArray<{ name: string; probe: string; expect: string }> = [
  { name: 'jq', probe: 'printf tool=; jq --version', expect: 'tool=jq-' },
  { name: 'file', probe: 'printf "tool=file:"; file --version | head -n1', expect: 'tool=file:file-' },
  { name: 'unzip', probe: 'printf "tool="; unzip -v | head -n1', expect: 'tool=UnZip' },
  { name: 'zip', probe: 'printf "tool="; zip -v | head -n2 | tail -n1', expect: 'This is Zip' },
  { name: 'sqlite3', probe: 'printf "tool=sqlite3 "; sqlite3 --version', expect: 'tool=sqlite3 3.' },
  { name: 'pdftotext', probe: 'pdftotext -v 2>&1 | head -n1', expect: 'pdftotext version' },
  { name: 'pandoc', probe: 'pandoc --version | head -n1', expect: 'pandoc' },
  { name: 'python3', probe: 'python3 --version', expect: 'Python 3.' },
  { name: 'uv', probe: 'uv --version', expect: 'uv ' },
];

async function verifySandboxToolset(workspacePath: string): Promise<string[]> {
  const verified: string[] = [];
  for (const tool of SANDBOX_TOOL_PROBES) {
    const result = await runShell(workspacePath, tool.probe, 10_000);
    if (result.exitCode !== 0 || !result.stdout.includes(tool.expect)) {
      throw new Error(
        `sandbox toolset probe failed for ${tool.name}: ${JSON.stringify(result)}`,
      );
    }
    verified.push(tool.name);
  }
  return verified;
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
      'printf "bytes="; wc -c < large.txt; rg -n needle-with-provenance large.txt; '
        + 'git --version; node -e \'console.log("node-cli=ok")\'',
    );
    if (
      document.exitCode !== 0
      || !document.stdout.includes('bytes=26023')
      || !document.stdout.includes('2001:needle-with-provenance')
      || !document.stdout.includes('git version')
      || !document.stdout.includes('node-cli=ok')
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
      || limits.stdout !== 'nproc=64 as=2097152 fsize=262144 cpu=1800 nofile=512\n'
    ) {
      throw new Error(`resource limits missing: ${JSON.stringify(limits)}`);
    }

    const toolset = await verifySandboxToolset(workspacePath);

    // Read-only repository mount: readable at /repo, advertised via
    // $PSFN_REPO, never writable, and absent unless the policy enables it.
    const repoSource = join(root, 'repo-src');
    mkdirSync(repoSource);
    writeFileSync(join(repoSource, 'README.md'), 'repo-copy-marker\n', 'utf8');
    const repoMounted = await runShell(
      workspacePath,
      'printf "repo_env=%s\\n" "${PSFN_REPO-unset}"; cat /repo/README.md; '
        + 'if printf x > /repo/write-probe 2>/dev/null; then printf "repo_write=allowed\\n"; '
        + 'else printf "repo_write=denied\\n"; fi',
      2_000,
      { mountRepositoryReadOnly: true, repositoryMountSource: repoSource },
    );
    if (
      repoMounted.exitCode !== 0
      || !repoMounted.stdout.includes('repo_env=/repo')
      || !repoMounted.stdout.includes('repo-copy-marker')
      || !repoMounted.stdout.includes('repo_write=denied')
    ) {
      throw new Error(`read-only repository mount failed: ${JSON.stringify(repoMounted)}`);
    }
    const repoUnmounted = await runShell(
      workspacePath,
      'if [ -e /repo ]; then printf "repo=present\\n"; else printf "repo=absent\\n"; fi; '
        + 'printf "repo_env=%s\\n" "${PSFN_REPO-unset}"',
    );
    if (
      repoUnmounted.exitCode !== 0
      || !repoUnmounted.stdout.includes('repo=absent')
      || !repoUnmounted.stdout.includes('repo_env=unset')
    ) {
      throw new Error(`repository mount leaked into default policy: ${JSON.stringify(repoUnmounted)}`);
    }
    let repoFailClosed = false;
    try {
      await runShell(workspacePath, 'true', 2_000, { mountRepositoryReadOnly: true });
    } catch (error) {
      repoFailClosed = error instanceof ShellExecPolicyError;
    }
    if (!repoFailClosed) {
      throw new Error('repository mount without a configured checkout must fail closed');
    }

    const forkPressure = await runShell(
      workspacePath,
      'for i in $(seq 1 128); do sleep 10 & done; wait',
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
      toolset,
      repositoryMount: 'read-only, env-advertised, fail-closed without checkout',
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
