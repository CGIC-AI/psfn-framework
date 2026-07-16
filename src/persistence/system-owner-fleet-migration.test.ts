import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { PER_COMPANION_OWNER_FILES } from '../system/config/settings-contract.js';
import { verifyStartupOwnerFiles } from '../system/config/startup-owner-files.js';
import {
  buildSystemOwnerFleetMigrationPlan,
  executeSystemOwnerFleetMigration,
} from './system-owner-fleet-migration.js';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const FLEET: CompanionsFleetConfig = {
  companions: [
    {
      companionId: FIRST_ID,
      companionDataDir: 'companions/one',
      characterCardPath: 'companions/one/companion.json',
      postgresSchema: 'one',
    },
    {
      companionId: SECOND_ID,
      companionDataDir: 'companions/two',
      characterCardPath: 'companions/two/companion.json',
      postgresSchema: 'two',
    },
  ],
};

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('system-owner fleet migration', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function fixture() {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-system-owner-fleet-'));
    roots.push(runtimeRoot);
    const systemDataDir = join(runtimeRoot, 'system-data');
    mkdirSync(systemDataDir);
    const fleet = resolveCompanionFleetPaths(FLEET, runtimeRoot);
    return { runtimeRoot, systemDataDir, fleet };
  }

  it('fans exact owner bytes to every configured companion, retires sources, and passes startup verification', () => {
    const { systemDataDir, fleet } = fixture();
    const seedDir = join(process.cwd(), 'config');
    for (const ownerFile of [
      'settings',
      'models',
      'providers',
      'trust-policy',
      'backup',
      'intake-policy',
    ]) {
      copyFileSync(
        join(seedDir, `${ownerFile}.seed.json`),
        join(systemDataDir, `${ownerFile}.json`),
      );
    }
    writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify(FLEET, null, 2)}\n`);

    const approvals: Record<string, string> = {};
    const sourceBytes = new Map<string, Buffer>();
    for (const ownerFile of PER_COMPANION_OWNER_FILES) {
      const bytes = readFileSync(join(seedDir, ownerFile.replace(/\.json$/u, '.seed.json')));
      writeFileSync(join(systemDataDir, ownerFile), bytes);
      approvals[ownerFile] = sha256(bytes);
      sourceBytes.set(ownerFile, bytes);
    }

    const plan = buildSystemOwnerFleetMigrationPlan({ systemDataDir, fleet });
    expect(plan.canApply).toBe(true);
    expect(plan.sourceCount).toBe(PER_COMPANION_OWNER_FILES.size);
    const result = executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: approvals,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });

    expect(result.status).toBe('migrated');
    for (const ownerFile of PER_COMPANION_OWNER_FILES) {
      expect(existsSync(join(systemDataDir, ownerFile))).toBe(false);
      for (const companion of fleet.companions) {
        expect(readFileSync(join(companion.companionDataDir, ownerFile)))
          .toEqual(sourceBytes.get(ownerFile));
      }
    }
    for (const companion of fleet.companions) {
      expect(verifyStartupOwnerFiles({
        dataDir: systemDataDir,
        companionDataDir: companion.companionDataDir,
        seedDir,
        defaultContextWindow: 128_000,
        multiCompanion: true,
      })).toEqual({ ok: true, errors: [] });
    }

    const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8')) as {
      status: string;
      files: Array<{
        ownerFile: string;
        sourceSha256: string;
        status: string;
        destinations: Array<{ sha256: string; status: string }>;
      }>;
    };
    expect(receipt.status).toBe('completed');
    expect(receipt.files).toHaveLength(PER_COMPANION_OWNER_FILES.size);
    for (const file of receipt.files) {
      expect(file.sourceSha256).toBe(approvals[file.ownerFile]);
      expect(file.status).toBe('retired');
      expect(file.destinations).toHaveLength(fleet.companions.length);
      expect(file.destinations.every(destination => (
        destination.sha256 === file.sourceSha256 && destination.status === 'verified'
      ))).toBe(true);
    }

    expect(executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: approvals,
    }).status).toBe('already_completed');
  });

  it('refuses changed sources and any pre-existing destination without overwrite or merge', () => {
    const { systemDataDir, fleet } = fixture();
    const sourcePath = join(systemDataDir, 'skills.json');
    const original = '{"owner":"system"}\n';
    writeFileSync(sourcePath, original);
    const destinationPath = join(fleet.companions[0].companionDataDir, 'skills.json');
    mkdirSync(fleet.companions[0].companionDataDir, { recursive: true });
    writeFileSync(destinationPath, original);

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': sha256(original) },
    })).toThrow(/destination conflicts/);
    expect(readFileSync(destinationPath, 'utf8')).toBe(original);
    expect(readFileSync(sourcePath, 'utf8')).toBe(original);

    rmSync(destinationPath);
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': '0'.repeat(64) },
    })).toThrow(/Source digest changed/);
    expect(existsSync(join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json'))).toBe(false);
  });

  it('retries a receipt-recorded partial fan-out deterministically and denies later tampering', () => {
    const { systemDataDir, fleet } = fixture();
    const sourcePath = join(systemDataDir, 'charge-policy.json');
    const source = Buffer.from('{"quota":"individual"}\n');
    const digest = sha256(source);
    writeFileSync(sourcePath, source);
    let verifiedCount = 0;

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
      afterDestinationVerified: () => {
        verifiedCount += 1;
        if (verifiedCount === 1) throw new Error('simulated interruption');
      },
    })).toThrow('simulated interruption');

    const firstDestination = join(fleet.companions[0].companionDataDir, 'charge-policy.json');
    const secondDestination = join(fleet.companions[1].companionDataDir, 'charge-policy.json');
    expect(readFileSync(firstDestination)).toEqual(source);
    expect(existsSync(secondDestination)).toBe(false);
    expect(readFileSync(sourcePath)).toEqual(source);

    writeFileSync(sourcePath, 'changed\n');
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    })).toThrow(/Source changed/);
    writeFileSync(sourcePath, source);

    expect(executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    }).status).toBe('migrated');
    expect(readFileSync(secondDestination)).toEqual(source);
    expect(existsSync(sourcePath)).toBe(false);

    writeFileSync(firstDestination, 'tampered\n');
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    })).toThrow(/Destination conflict/);
  });
});
