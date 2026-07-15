import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCompanionFleetPaths, type CompanionsFleetConfig } from '../../system/config/companions-config.js';
import {
  hashLegacyWorkspaceTree,
  LEGACY_WORKSPACE_COMPANION_ID_ENV,
  LEGACY_WORKSPACE_SHA256_ENV,
  migrateLegacyWorkspaceForFleet,
} from './legacy-workspace-migration.js';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const FLEET: CompanionsFleetConfig = {
  companions: [
    { companionId: FIRST_ID, companionDataDir: 'companions/one', characterCardPath: 'companions/one/card.json', postgresSchema: 'one' },
    { companionId: SECOND_ID, companionDataDir: 'companions/two', characterCardPath: 'companions/two/card.json', postgresSchema: 'two' },
  ],
};

describe('legacy personal workspace migration', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-legacy-runtime-'));
    const legacy = mkdtempSync(join(tmpdir(), 'psfn-legacy-workspace-'));
    roots.push(runtimeRoot, legacy);
    mkdirSync(join(legacy, 'notes'));
    writeFileSync(join(legacy, 'notes', 'journal.md'), 'private legacy journal\n');
    return { runtimeRoot, legacy, fleet: resolveCompanionFleetPaths(FLEET, runtimeRoot) };
  }

  it('fails closed on unmigrated legacy data and prints its approval digest', () => {
    const { legacy, fleet } = fixture();
    const digest = hashLegacyWorkspaceTree(legacy);
    expect(() => migrateLegacyWorkspaceForFleet({ fleet, legacyWorkspacePath: legacy, env: {} }))
      .toThrow(new RegExp(`Unmigrated legacy WORKSPACE_PATH.*${digest}`));
    expect(existsSync(fleet.workspacesRoot)).toBe(false);
  });

  it('assigns the checksummed source to one explicit companion without deleting or cross-copying', () => {
    const { legacy, fleet } = fixture();
    const digest = hashLegacyWorkspaceTree(legacy);
    const result = migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env: {
        [LEGACY_WORKSPACE_COMPANION_ID_ENV]: SECOND_ID,
        [LEGACY_WORKSPACE_SHA256_ENV]: digest,
      },
    });

    expect(result.status).toBe('migrated');
    expect(readFileSync(join(fleet.companions[1].personalWorkspacePath, 'notes/journal.md'), 'utf8'))
      .toBe('private legacy journal\n');
    expect(existsSync(fleet.companions[0].personalWorkspacePath)).toBe(false);
    expect(readFileSync(join(legacy, 'notes/journal.md'), 'utf8')).toBe('private legacy journal\n');

    // Normal provisioning adds Personal Workspace content after migration.
    // Receipt validation must verify the migrated source subset without
    // treating those legitimate additions as digest drift.
    mkdirSync(join(fleet.companions[1].personalWorkspacePath, '.psfn'), { recursive: true });
    writeFileSync(join(fleet.companions[1].personalWorkspacePath, '.psfn', 'provisioned.json'), '{}\n');

    expect(migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env: {
        [LEGACY_WORKSPACE_COMPANION_ID_ENV]: SECOND_ID,
        [LEGACY_WORKSPACE_SHA256_ENV]: digest,
      },
    }).status).toBe('already_migrated');

    writeFileSync(join(fleet.companions[1].personalWorkspacePath, 'notes/journal.md'), 'tampered\n');
    expect(() => migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env: {
        [LEGACY_WORKSPACE_COMPANION_ID_ENV]: SECOND_ID,
        [LEGACY_WORKSPACE_SHA256_ENV]: digest,
      },
    })).toThrow(/receipt no longer matches/);
  });

  it('refuses digest drift and destination collisions instead of merging', () => {
    const { runtimeRoot, legacy, fleet } = fixture();
    const digest = hashLegacyWorkspaceTree(legacy);
    expect(() => migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env: {
        [LEGACY_WORKSPACE_COMPANION_ID_ENV]: FIRST_ID,
        [LEGACY_WORKSPACE_SHA256_ENV]: '0'.repeat(64),
      },
    })).toThrow(/digest changed/);

    mkdirSync(fleet.companions[0].personalWorkspacePath, { recursive: true });
    writeFileSync(join(fleet.companions[0].personalWorkspacePath, 'existing.txt'), 'do not overwrite');
    expect(() => migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env: {
        [LEGACY_WORKSPACE_COMPANION_ID_ENV]: FIRST_ID,
        [LEGACY_WORKSPACE_SHA256_ENV]: digest,
      },
    })).toThrow(/no-overwrite migration refuses to merge/);

    const linkedSource = join(runtimeRoot, 'linked-legacy');
    symlinkSync(legacy, linkedSource);
    expect(() => hashLegacyWorkspaceTree(linkedSource)).toThrow(/must be a real directory/);
  });
});
