import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveCompanionFleetPaths,
  type CompanionsFleetConfig,
} from '../system/config/companions-config.js';
import { executeSystemOwnerFleetMigration } from './system-owner-fleet-migration.js';
import {
  captureSystemOwnerFleetSnapshot,
  restoreSystemOwnerFleetSnapshot,
} from './system-owner-fleet-snapshot.js';

const FLEET: CompanionsFleetConfig = {
  companions: [
    {
      companionId: '11111111-1111-4111-8111-111111111111',
      companionDataDir: 'companions/one',
      characterCardPath: 'companions/one/companion.json',
      postgresSchema: 'one',
    },
    {
      companionId: '22222222-2222-4222-8222-222222222222',
      companionDataDir: 'companions/two',
      characterCardPath: 'companions/two/companion.json',
      postgresSchema: 'two',
    },
  ],
};

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('system-owner fleet pre-migration snapshot', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-owner-snapshot-'));
    roots.push(runtimeRoot);
    const systemDataDir = join(runtimeRoot, 'system-data');
    mkdirSync(systemDataDir);
    const fleet = resolveCompanionFleetPaths(FLEET, runtimeRoot);
    writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify(FLEET, null, 2)}\n`);
    fleet.companions.forEach((companion, index) => {
      mkdirSync(companion.companionDataDir, { recursive: true });
      writeFileSync(join(companion.companionDataDir, 'identity.txt'), `companion-${index + 1}\n`);
    });
    const charge = readFileSync(join(process.cwd(), 'config', 'charge-policy.seed.json'));
    writeFileSync(join(systemDataDir, 'charge-policy.json'), charge);
    return { runtimeRoot, systemDataDir, fleet, charge };
  }

  function provisionFreshRoots(runtimeRoot: string): string {
    const restoreRoot = join(runtimeRoot, 'fresh-runtime');
    mkdirSync(join(restoreRoot, 'system-data'), { recursive: true });
    mkdirSync(join(restoreRoot, 'companions', 'one'), { recursive: true });
    mkdirSync(join(restoreRoot, 'companions', 'two'), { recursive: true });
    return restoreRoot;
  }

  it('captures split cluster/companion artifacts and rehearses a whole-fleet rollback to fresh roots', () => {
    const { runtimeRoot, systemDataDir, fleet, charge } = fixture();
    const snapshot = captureSystemOwnerFleetSnapshot({
      systemDataDir,
      fleet,
      outputDir: join(runtimeRoot, 'backups', 'pre-owner-migration'),
      now: () => new Date('2026-07-16T12:00:00.000Z'),
    });

    expect(executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': sha256(charge) },
    }).status).toBe('migrated');
    expect(existsSync(join(systemDataDir, 'charge-policy.json'))).toBe(false);

    const restoreRoot = provisionFreshRoots(runtimeRoot);
    const restored = restoreSystemOwnerFleetSnapshot({
      manifestPath: snapshot.manifestPath,
      restorePersistenceRoot: restoreRoot,
    });

    expect(restored.restoredRoots).toHaveLength(3);
    expect(readFileSync(join(restoreRoot, 'system-data', 'charge-policy.json'))).toEqual(charge);
    expect(existsSync(join(restoreRoot, 'system-data', 'migrations'))).toBe(false);
    expect(readFileSync(join(restoreRoot, 'companions', 'one', 'identity.txt'), 'utf8'))
      .toBe('companion-1\n');
    expect(readFileSync(join(restoreRoot, 'companions', 'two', 'identity.txt'), 'utf8'))
      .toBe('companion-2\n');
    expect(existsSync(join(restoreRoot, 'companions', 'one', 'charge-policy.json'))).toBe(false);
    expect(existsSync(join(restoreRoot, 'companions', 'two', 'charge-policy.json'))).toBe(false);
  });

  it('refuses a changed split artifact manifest before writing any fresh restore root', () => {
    const { runtimeRoot, systemDataDir, fleet } = fixture();
    const snapshot = captureSystemOwnerFleetSnapshot({
      systemDataDir,
      fleet,
      outputDir: join(runtimeRoot, 'backups', 'tampered'),
    });
    const cluster = snapshot.manifest.cluster;
    const treeManifest = join(
      join(runtimeRoot, 'backups', 'tampered'),
      cluster.artifactDir,
      'system-tree-manifest.json',
    );
    writeFileSync(treeManifest, `${readFileSync(treeManifest, 'utf8')}\n`);
    const restoreRoot = provisionFreshRoots(runtimeRoot);

    expect(() => restoreSystemOwnerFleetSnapshot({
      manifestPath: snapshot.manifestPath,
      restorePersistenceRoot: restoreRoot,
    })).toThrow(/manifest digest does not match/);
    expect(readdirSync(join(restoreRoot, 'system-data'))).toEqual([]);
    expect(readdirSync(join(restoreRoot, 'companions', 'one'))).toEqual([]);
    expect(readdirSync(join(restoreRoot, 'companions', 'two'))).toEqual([]);
  });
});
