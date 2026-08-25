import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProcessAlive, loadLocalContext, parseAgentAuthFile } from './local-lifecycle.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

function writeLocalEnvironment(root: string): void {
  const runtimeRoot = join(root, 'runtime');
  const systemDataDir = join(runtimeRoot, 'system-data');
  const companionDataDir = join(runtimeRoot, 'companion-data', 'main');
  mkdirSync(systemDataDir, { recursive: true });
  mkdirSync(companionDataDir, { recursive: true });
  writeFileSync(join(root, '.env'), [
    `COMPANION_ID=${COMPANION_ID}`,
    `PSFN_RUNTIME_ROOT=${runtimeRoot}`,
    `SYSTEM_DATA_DIR=${systemDataDir}`,
    `COMPANION_DATA_DIR=${companionDataDir}`,
    `WORKSPACE_PATH=${join(runtimeRoot, 'workspaces/personal', COMPANION_ID)}`,
    `CHARACTER_CARD_PATH=${join(companionDataDir, 'companion.json')}`,
    `PSFN_LOGS_DIR=${join(runtimeRoot, 'logs')}`,
    `PSFN_TEMP_DIR=${join(runtimeRoot, 'tmp')}`,
    `BACKUP_ROOT_DIR=${join(runtimeRoot, 'backups')}`,
    `PSFN_AGENT_AUTH_DIR=${join(runtimeRoot, 'run/agent-auth')}`,
    `GATEWAY_SOCKET=${join(runtimeRoot, 'run/gateway.sock')}`,
    `ADMIN_TRANSPORT_SOCKET=${join(runtimeRoot, 'run/garden.sock')}`,
    'POSTGRES_ADMIN_DATABASE_URL=postgresql://postgres:admin@127.0.0.1:5432/psfn',
    'POSTGRES_DATABASE_URL=postgresql://companion_main_runtime:runtime@127.0.0.1:5432/psfn',
    'COMPANION_MAIN_DATABASE_URL=postgresql://companion_main_runtime:runtime@127.0.0.1:5432/psfn',
    'SHARED_SCHEMA_MIGRATION_DATABASE_URL=postgresql://shared_schema_migration:migration@127.0.0.1:5432/psfn',
    'PSFN_COMPANION_DATABASE_PASSWORD=runtime',
    'PSFN_SHARED_MIGRATION_DATABASE_PASSWORD=migration',
    'API_KEY=api',
    'ADMIN_TOKEN=admin',
    'GATEWAY_SESSION_HMAC_KEY=hmac',
    'PSFN_BACKUP_ENCRYPTION_KEY=backup',
    '',
  ].join('\n'));
}

describe('repository-native lifecycle contracts', () => {
  it('resolves generated paths and creates only runtime-owned support directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-local-context-'));
    writeLocalEnvironment(root);
    const context = loadLocalContext(root, { PATH: process.env.PATH });
    expect(context.runtimeRoot).toBe(join(root, 'runtime'));
    expect(context.companionDataDir).toBe(join(root, 'runtime/companion-data/main'));
    expect(context.gardenBase).toBe('http://127.0.0.1:10053');
    expect(context.apiBase).toBe('http://127.0.0.1:10054');
  });

  it('parses the exact role-bound agent handoff and rejects shell content', () => {
    expect(parseAgentAuthFile([
      'export GATEWAY_COMPANION_AUTH_TOKEN=v1.agent',
      'export GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN=v1.integrity',
      'export PSFN_BACKUP_ENCRYPTION_KEY=backup-key',
      '',
    ].join('\n'))).toEqual({
      GATEWAY_COMPANION_AUTH_TOKEN: 'v1.agent',
      GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN: 'v1.integrity',
      PSFN_BACKUP_ENCRYPTION_KEY: 'backup-key',
    });
    expect(() => parseAgentAuthFile('export GATEWAY_COMPANION_AUTH_TOKEN=$(bad)'))
      .toThrow(/invalid line/u);
  });

  it('reports the current process as live and impossible PIDs as stopped', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
