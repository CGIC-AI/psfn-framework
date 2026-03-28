import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const installScriptPath = join(repoRoot, 'scripts/system/install-psfn-service.sh');

describe('install-psfn-service.sh', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('renders a filtered env file and wrapperless systemd unit for env-file launches', () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), 'psfn-service-staging-'));
    tempDirs.push(stagingRoot);

    const envSourceDir = mkdtempSync(join(tmpdir(), 'psfn-service-env-'));
    tempDirs.push(envSourceDir);

    const envSourcePath = join(envSourceDir, 'runtime.env');
    writeFileSync(
      envSourcePath,
      [
        'DATA_DIR=./data',
        'SYSTEM_DATA_DIR=./system-data',
        'COMPANION_DATA_DIR=./companion-data',
        'WORKSPACE_PATH=./workspace',
        'PSFN_LOGS_DIR=./logs',
        'PSFN_TEMP_DIR=./tmp',
        'BACKUP_ROOT_DIR=./backups',
        'PSFN_RUNTIME_ROOT=./runtime',
        'PSFN_RUNTIME_LAYOUT_MODE=live',
        'PSFN_RUNTIME_MODE=yolo',
        'GATEWAY_SOCKET=./gateway.sock',
        'MODULE_REGISTRY_PATH=./companion/modules/repl-registry.json',
        'NRC_VAD_LEXICON_PATH=./companion/emotion/nrc-vad-lexicon-v2.tsv',
        'PSFN_SKIP_DOTENV=false',
        'DATABASE_PATH=./data/purrsephone.db',
        'AUDIT_DB_PATH=./data/gateway-audit.db',
        'PATH=/tmp/bin',
        'HOME=/tmp/home',
        'CHARACTER_CARD_PATH=/absolute/purrsephone.json',
        'ADMIN_PORT=3001',
        'ADMIN_HOST=0.0.0.0',
        'API_PORT=3100',
        'API_HOST=0.0.0.0',
      ].join('\n'),
      'utf8',
    );

    execFileSync(
      'bash',
      [
        installScriptPath,
        '--source-repo-root',
        repoRoot,
        '--env-source',
        envSourcePath,
        '--staging-root',
        stagingRoot,
        '--mode',
        'yolo',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );

    const envFilePath = join(stagingRoot, 'etc/psfn/psfn.env');
    const unitFilePath = join(stagingRoot, 'etc/systemd/system/psfn.service');
    const envFile = readFileSync(envFilePath, 'utf8');
    const unitFile = readFileSync(unitFilePath, 'utf8');

    expect(envFile).toContain('CHARACTER_CARD_PATH=/absolute/purrsephone.json');
    expect(envFile).toContain('ADMIN_PORT=3001');
    expect(envFile).toContain('ADMIN_HOST=0.0.0.0');
    expect(envFile).toContain('API_PORT=3100');
    expect(envFile).toContain('API_HOST=0.0.0.0');
    expect(envFile).not.toContain('DATA_DIR=');
    expect(envFile).not.toContain('SYSTEM_DATA_DIR=');
    expect(envFile).not.toContain('COMPANION_DATA_DIR=');
    expect(envFile).not.toContain('WORKSPACE_PATH=');
    expect(envFile).not.toContain('PSFN_LOGS_DIR=');
    expect(envFile).not.toContain('PSFN_TEMP_DIR=');
    expect(envFile).not.toContain('BACKUP_ROOT_DIR=');
    expect(envFile).not.toContain('PSFN_RUNTIME_ROOT=');
    expect(envFile).not.toContain('PSFN_RUNTIME_LAYOUT_MODE=');
    expect(envFile).not.toContain('PSFN_RUNTIME_MODE=');
    expect(envFile).not.toContain('GATEWAY_SOCKET=');
    expect(envFile).not.toContain('MODULE_REGISTRY_PATH=');
    expect(envFile).not.toContain('NRC_VAD_LEXICON_PATH=');
    expect(envFile).not.toContain('PSFN_SKIP_DOTENV=');
    expect(envFile).not.toContain('DATABASE_PATH=');
    expect(envFile).not.toContain('AUDIT_DB_PATH=');
    expect(envFile).not.toMatch(/^PATH=/m);
    expect(envFile).not.toMatch(/^HOME=/m);

    expect(unitFile).toContain(`WorkingDirectory=${join(stagingRoot, 'var/lib/psfn/app')}`);
    expect(unitFile).toContain(`EnvironmentFile=-${join(stagingRoot, 'etc/psfn/psfn.env')}`);
    expect(unitFile).toContain('Environment=PSFN_SKIP_DOTENV=true');
    expect(unitFile).toContain('Environment=PSFN_RUNTIME_MODE=yolo');
    expect(unitFile).toContain('Environment=PSFN_RUNTIME_LAYOUT_MODE=production');
    expect(unitFile).toContain(`Environment=PSFN_RUNTIME_ROOT=${join(stagingRoot, 'var/lib/psfn/runtime')}`);
    expect(unitFile).toContain('ExecStart=/bin/bash ');
    expect(unitFile).toContain(`${join(stagingRoot, 'var/lib/psfn/app/scripts/start-gateway-agent.sh')}`);
    expect(unitFile).not.toContain('source /mnt/samesung/ai/psfn-live/.env');
    expect(unitFile).not.toContain('ExecStart=/bin/bash -lc');
  });
});
