import { afterEach, describe, expect, it, vi } from 'vitest';
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

const fsIdentityAliases = vi.hoisted(() => ({
  aliasPath: null as string | null,
  targetPath: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: ((path, options) => {
      const inspectedPath = String(path);
      if (fsIdentityAliases.aliasPath === inspectedPath && fsIdentityAliases.targetPath) {
        return actual.statSync(fsIdentityAliases.targetPath, options);
      }
      return actual.statSync(path, options);
    }) as typeof actual.statSync,
  };
});

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
    fsIdentityAliases.aliasPath = null;
    fsIdentityAliases.targetPath = null;
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

  it('treats a realpath alias of a canonical Personal Workspace as not needing migration', () => {
    const { runtimeRoot, fleet } = fixture();
    const destination = fleet.companions[0].personalWorkspacePath;
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'live.txt'), 'same live workspace\n');
    const alias = join(runtimeRoot, 'legacy-workspace-alias');
    symlinkSync(destination, alias);

    expect(migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: alias,
      env: {},
    })).toMatchObject({
      status: 'not_needed',
      reason: 'same_directory_identity',
      companionId: FIRST_ID,
      sourcePath: alias,
      destinationPath: destination,
    });
    expect(existsSync(join(fleet.workspacesRoot, '.migration'))).toBe(false);
  });

  it('treats bind-mount-like paths with the same device and inode as not needing migration', () => {
    const { legacy, fleet } = fixture();
    const destination = fleet.companions[0].personalWorkspacePath;
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'separate.txt'), 'separate path before identity simulation\n');
    fsIdentityAliases.aliasPath = destination;
    fsIdentityAliases.targetPath = legacy;

    expect(migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env: {},
    })).toMatchObject({
      status: 'not_needed',
      reason: 'same_directory_identity',
      companionId: FIRST_ID,
      sourcePath: legacy,
      destinationPath: destination,
    });
    expect(existsSync(join(fleet.workspacesRoot, '.migration'))).toBe(false);
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

    // Normal Personal Workspace activity may add and change content after migration.
    // Receipt validation must not re-hash this mutable live tree.
    mkdirSync(join(fleet.companions[1].personalWorkspacePath, '.psfn'), { recursive: true });
    writeFileSync(join(fleet.companions[1].personalWorkspacePath, '.psfn', 'provisioned.json'), '{}\n');
    writeFileSync(join(fleet.companions[1].personalWorkspacePath, 'notes/journal.md'), 'continued journal\n');

    expect(migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env: {
        [LEGACY_WORKSPACE_COMPANION_ID_ENV]: SECOND_ID,
        [LEGACY_WORKSPACE_SHA256_ENV]: digest,
      },
    }).status).toBe('already_migrated');

    expect(() => migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env: {},
    })).toThrow(new RegExp(`${LEGACY_WORKSPACE_COMPANION_ID_ENV} remains required`));

    const receiptPath = join(fleet.workspacesRoot, '.migration', 'legacy-workspace.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const receiptEntries = receipt.sourceEntries as Array<Record<string, unknown>>;
    receiptEntries[1].sha256 = '0'.repeat(64);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env: {
        [LEGACY_WORKSPACE_COMPANION_ID_ENV]: SECOND_ID,
        [LEGACY_WORKSPACE_SHA256_ENV]: digest,
      },
    })).toThrow(/receipt integrity check failed/);
  });

  it('fails closed when a completed receipt remains but both migration trees disappear', () => {
    const { legacy, fleet } = fixture();
    const digest = hashLegacyWorkspaceTree(legacy);
    const env = {
      [LEGACY_WORKSPACE_COMPANION_ID_ENV]: FIRST_ID,
      [LEGACY_WORKSPACE_SHA256_ENV]: digest,
    };
    expect(migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env,
    }).status).toBe('migrated');

    rmSync(legacy, { recursive: true });
    rmSync(fleet.companions[0].personalWorkspacePath, { recursive: true });

    expect(() => migrateLegacyWorkspaceForFleet({
      fleet,
      legacyWorkspacePath: legacy,
      env,
    })).toThrow(/receipt no longer matches its migration identity/);
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
