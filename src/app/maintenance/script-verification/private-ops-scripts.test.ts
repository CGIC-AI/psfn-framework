import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const opsDir = join(repoRoot, 'scripts/ops');
const loaderPath = join(opsDir, 'load-private-ops-config.sh');
const scripts = [
  'load-private-ops-config.sh',
  'ship-kube-update.sh',
  'sync-companion-beads.sh',
  'validate-kube-rollout.sh',
];

describe('private deployment operations scripts', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function emptyPrivateConfig() {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-private-ops-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'private-ops.env');
    writeFileSync(configPath, '# Intentionally empty for fail-closed tests.\n', 'utf8');
    return configPath;
  }

  function runScript(scriptName: string, args: string[], configPath: string) {
    return spawnSync('bash', [join(opsDir, scriptName), ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PSFN_HOST_ALIAS: '',
        PSFN_OPS_CONFIG: configPath,
      },
    });
  }

  it.each(scripts)('passes bash syntax validation: %s', (scriptName) => {
    const result = spawnSync('bash', ['-n', join(opsDir, scriptName)], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('loads operator inputs from an explicitly selected untracked config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-private-ops-config-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'operator.env');
    writeFileSync(
      configPath,
      'PSFN_HOST_ALIAS=offline-example\nPSFN_NAMESPACE=example-namespace\n',
      'utf8',
    );

    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; load_private_ops_config "$2"; printf "%s|%s" "$PSFN_HOST_ALIAS" "$PSFN_NAMESPACE"',
        '_',
        loaderPath,
        opsDir,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, PSFN_OPS_CONFIG: configPath },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('offline-example|example-namespace');
  });

  it('rejects an explicitly selected config that is not readable', () => {
    const missingPath = join(mkdtempSync(join(tmpdir(), 'psfn-private-ops-missing-')), 'missing.env');
    tempDirs.push(join(missingPath, '..'));
    const result = runScript('ship-kube-update.sh', ['--components', 'agent'], missingPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PSFN_OPS_CONFIG is not readable');
  });

  it.each([
    ['ship-kube-update.sh', ['--components', 'agent']],
    ['sync-companion-beads.sh', ['--push']],
    ['validate-kube-rollout.sh', ['--remote']],
  ])('%s fails before remote work when no destination is configured', (scriptName, args) => {
    const result = runScript(scriptName, args, emptyPrivateConfig());

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PSFN_HOST_ALIAS is required');
  });
});
