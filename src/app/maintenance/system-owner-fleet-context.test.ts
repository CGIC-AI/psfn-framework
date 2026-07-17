import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSystemOwnerFleetContext } from './system-owner-fleet-context.js';

const roots: string[] = [];

function singleCompanionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'psfn-owner-context-'));
  roots.push(root);
  for (const relativePath of [
    'system-data',
    'companions/companion',
    'workspace',
    'logs',
    'tmp',
    'backups',
  ]) {
    mkdirSync(join(root, relativePath), { recursive: true });
  }
  return {
    NODE_ENV: 'production',
    PSFN_RUNTIME_LAYOUT_MODE: 'production',
    PSFN_RUNTIME_ROOT: root,
    SYSTEM_DATA_DIR: join(root, 'system-data'),
    COMPANION_DATA_DIR: join(root, 'companions', 'companion'),
    WORKSPACE_PATH: join(root, 'workspace'),
    PSFN_LOGS_DIR: join(root, 'logs'),
    PSFN_TEMP_DIR: join(root, 'tmp'),
    BACKUP_ROOT_DIR: join(root, 'backups'),
    DATA_DIR: '',
    COMPANION_ID: 'companion',
    PSFN_MULTI_COMPANION: 'false',
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveSystemOwnerFleetContext', () => {
  it('binds the default topology to its one explicit companion root', () => {
    const env = singleCompanionEnv();
    const { layout, fleet } = resolveSystemOwnerFleetContext(env);

    expect(fleet.companions).toHaveLength(1);
    expect(fleet.companions[0]).toMatchObject({
      companionId: 'companion',
      companionDataDir: layout.companionDataDir,
      characterCardPath: join(layout.companionDataDir, 'companion.json'),
      postgresSchema: 'public',
    });
  });

  it('requires an explicit identity for a single-companion migration', () => {
    const env = singleCompanionEnv({ COMPANION_ID: '' });
    expect(() => resolveSystemOwnerFleetContext(env)).toThrow(
      'COMPANION_ID for single-companion system-owner migration must be a non-empty string',
    );
  });

  it('keeps multi-companion mode bound to companions.json', () => {
    const env = singleCompanionEnv({ PSFN_MULTI_COMPANION: 'true' });
    expect(() => resolveSystemOwnerFleetContext(env)).toThrow(
      'Multi-companion mode requires a companions.json enumerating the fleet',
    );
  });

  it('accepts an explicit one-entry manifest without treating it as single topology', () => {
    const env = singleCompanionEnv({ PSFN_MULTI_COMPANION: 'true' });
    const companionId = '123e4567-e89b-42d3-a456-426614174000';
    writeFileSync(
      join(env.SYSTEM_DATA_DIR!, 'companions.json'),
      `${JSON.stringify({
        companions: [{
          companionId,
          companionDataDir: 'companions/companion',
          characterCardPath: 'companions/companion/companion.json',
          postgresSchema: 'companion_one',
        }],
      })}\n`,
    );

    const { fleet } = resolveSystemOwnerFleetContext(env);
    expect(fleet.companions).toHaveLength(1);
    expect(fleet.companions[0].companionId).toBe(companionId);
  });
});
