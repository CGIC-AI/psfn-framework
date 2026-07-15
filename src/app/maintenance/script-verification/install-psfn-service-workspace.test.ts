import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const installScriptPath = join(repoRoot, 'scripts/system/install-psfn-service.sh');
const execFileAsync = promisify(execFile);

describe('install-psfn-service.sh WORKSPACE_PATH handling', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('retains WORKSPACE_PATH in the generated service env', async () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), 'psfn-workspace-staging-'));
    tempDirs.push(stagingRoot);

    const envSourceDir = mkdtempSync(join(tmpdir(), 'psfn-workspace-env-'));
    tempDirs.push(envSourceDir);

    const envSourcePath = join(envSourceDir, 'runtime.env');
    writeFileSync(envSourcePath, 'export WORKSPACE_PATH=/srv/psfn/purrsephone\nADMIN_PORT=3001\n', 'utf8');

    await execFileAsync(
      'bash',
      [
        installScriptPath,
        '--source-repo-root',
        repoRoot,
        '--env-source',
        envSourcePath,
        '--staging-root',
        stagingRoot,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );

    const envFilePath = join(stagingRoot, 'var/lib/psfn/app/deployment/systemd/psfn.env');
    expect(readFileSync(envFilePath, 'utf8')).toContain('WORKSPACE_PATH=/srv/psfn/purrsephone');
  }, 30_000);

  it('rejects an env source without WORKSPACE_PATH before generating the service env', async () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), 'psfn-workspace-staging-'));
    tempDirs.push(stagingRoot);

    const envSourceDir = mkdtempSync(join(tmpdir(), 'psfn-workspace-env-'));
    tempDirs.push(envSourceDir);

    const envSourcePath = join(envSourceDir, 'runtime.env');
    writeFileSync(envSourcePath, 'ADMIN_PORT=3001\n', 'utf8');

    await expect(execFileAsync(
      'bash',
      [
        installScriptPath,
        '--source-repo-root',
        repoRoot,
        '--env-source',
        envSourcePath,
        '--staging-root',
        stagingRoot,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )).rejects.toThrow('Source env must define a non-empty WORKSPACE_PATH');

    const envFilePath = join(stagingRoot, 'var/lib/psfn/app/deployment/systemd/psfn.env');
    expect(existsSync(envFilePath)).toBe(false);
  }, 30_000);
});
