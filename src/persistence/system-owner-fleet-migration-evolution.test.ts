import { createHash } from 'node:crypto';
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveCompanionFleetPaths,
  type CompanionsFleetConfig,
} from '../system/config/companions-config.js';
import { migrateLegacySchedulerOwner } from '../system/config/scheduler-owner-migration.js';
import { PER_COMPANION_OWNER_FILES } from '../system/config/settings-contract.js';
import { verifyStartupOwnerFiles } from '../system/config/startup-owner-files.js';
import { writeJsonAtomic } from '../shared/utils/fs.js';
import {
  executeSystemOwnerFleetMigration,
  SYSTEM_OWNER_FLEET_MIGRATION_FILES,
} from './system-owner-fleet-migration.js';

const FLEET: CompanionsFleetConfig = {
  postgres: {
    sharedMigrationRole: 'shared_schema_migration',
    sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_MIGRATION_URL' },
  },
  companions: [
    {
      companionId: '11111111-1111-4111-8111-111111111111',
      companionDataDir: 'companions/one',
      characterCardPath: 'companions/one/companion.json',
      postgresSchema: 'one',
      postgresRole: 'companion_one_runtime',
      postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_ONE_DATABASE_URL' },
    },
    {
      companionId: '22222222-2222-4222-8222-222222222222',
      companionDataDir: 'companions/two',
      characterCardPath: 'companions/two/companion.json',
      postgresSchema: 'two',
      postgresRole: 'companion_two_runtime',
      postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_TWO_DATABASE_URL' },
    },
  ],
};

interface CompletedReceiptFile {
  ownerFile: string;
  quarantinePath: string;
  destinations: Array<{
    companionId: string;
    destinationPath: string;
    temporaryPath: string;
    currentOwner?: {
      bytes: number;
      sha256: string;
      identity: { device: string; inode: string };
      observedAt: string;
      provenance: 'canonical-owner-after-verified-source-retirement';
    };
  }>;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validChargeSource(interactiveQuota: number): Buffer {
  const value = JSON.parse(
    readFileSync(join(process.cwd(), 'config', 'charge-policy.seed.json'), 'utf8'),
  ) as { runChargeQuotaByLane: { interactive: number } };
  value.runChargeQuotaByLane.interactive = interactiveQuota;
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function validSkillsSource(marker: string): Buffer {
  const value = JSON.parse(
    readFileSync(join(process.cwd(), 'config', 'skills.seed.json'), 'utf8'),
  ) as { disabledSkills: string[] };
  value.disabledSkills = [marker];
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function snapshotFiles(paths: readonly string[]): string {
  return JSON.stringify(paths.map(path => {
    const stats = statSync(path, { bigint: true });
    return {
      path,
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      links: stats.nlink.toString(),
      bytes: stats.size.toString(),
      sha256: sha256(readFileSync(path)),
    };
  }));
}

describe('completed system-owner fleet migration owner evolution', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-owner-evolution-'));
    roots.push(runtimeRoot);
    const systemDataDir = join(runtimeRoot, 'system-data');
    mkdirSync(systemDataDir);
    const fleet = resolveCompanionFleetPaths(FLEET, runtimeRoot);
    for (const companion of fleet.companions) {
      mkdirSync(companion.companionDataDir, { recursive: true });
    }
    return { runtimeRoot, systemDataDir, fleet };
  }

  function migrateSingleOwner(ownerFile = 'charge-policy.json') {
    const context = fixture();
    const source = validChargeSource(25);
    const digest = sha256(source);
    writeFileSync(join(context.systemDataDir, ownerFile), source);
    const result = executeSystemOwnerFleetMigration({
      systemDataDir: context.systemDataDir,
      fleet: context.fleet,
      expectedSourceDigests: { [ownerFile]: digest },
    });
    const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8')) as {
      files: CompletedReceiptFile[];
    };
    const file = receipt.files.find(candidate => candidate.ownerFile === ownerFile);
    if (!file) throw new Error(`Missing completed receipt file for ${ownerFile}`);
    return { ...context, source, digest, file };
  }

  it('fans a pre-bundled scheduler, durably migrates each schema, passes preflight, and retries', () => {
    const { systemDataDir, fleet } = fixture();
    const seedDir = join(process.cwd(), 'config');
    for (const ownerFile of [
      'settings',
      'models',
      'providers',
      'trust-policy',
      'backup',
      'mcp-servers',
      'intake-policy',
      'partner-affect-shadow',
    ]) {
      copyFileSync(join(seedDir, `${ownerFile}.seed.json`), join(systemDataDir, `${ownerFile}.json`));
    }
    writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify(FLEET, null, 2)}\n`);

    const approvals: Record<string, string> = {};
    for (const ownerFile of PER_COMPANION_OWNER_FILES) {
      const sourcePath = ownerFile === 'scheduler.json'
        ? join(process.cwd(), 'src/system/config/fixtures/scheduler.pre-bundled-owner.json')
        : join(seedDir, ownerFile.replace(/\.json$/u, '.seed.json'));
      const bytes = readFileSync(sourcePath);
      writeFileSync(join(systemDataDir, ownerFile), bytes);
      if (SYSTEM_OWNER_FLEET_MIGRATION_FILES.has(ownerFile)) {
        approvals[ownerFile] = sha256(bytes);
      } else {
        for (const companion of fleet.companions) {
          writeFileSync(join(companion.companionDataDir, ownerFile), bytes);
        }
      }
    }

    expect(executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: approvals,
    }).status).toBe('migrated');

    for (const companion of fleet.companions) {
      expect(migrateLegacySchedulerOwner({
        dataDir: companion.companionDataDir,
        apply: true,
      }).status).toBe('applied');
      expect(verifyStartupOwnerFiles({
        dataDir: systemDataDir,
        companionDataDir: companion.companionDataDir,
        seedDir,
        defaultContextWindow: 128_000,
      })).toEqual({ ok: true, errors: [] });
    }

    expect(executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: approvals,
    }).status).toBe('already_completed');
  });

  it('accepts an atomic live-owner replacement while retaining exact migration evidence', () => {
    const { systemDataDir, fleet, source, digest, file } = migrateSingleOwner();
    const destination = file.destinations[0];
    const replacement = JSON.parse(validChargeSource(26).toString('utf8')) as unknown;

    writeJsonAtomic(destination.destinationPath, replacement);

    expect(executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    }).status).toBe('already_completed');
    expect(JSON.parse(readFileSync(destination.destinationPath, 'utf8'))).toEqual(replacement);
    expect(readFileSync(destination.temporaryPath)).toEqual(source);
    expect(readFileSync(file.quarantinePath)).toEqual(source);
    const currentBytes = readFileSync(destination.destinationPath);
    const currentStats = statSync(destination.destinationPath, { bigint: true });
    const evolvedReceipt = JSON.parse(readFileSync(
      join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json'),
      'utf8',
    )) as { files: CompletedReceiptFile[] };
    expect(evolvedReceipt.files[0].destinations[0].currentOwner).toMatchObject({
      bytes: currentBytes.byteLength,
      sha256: sha256(currentBytes),
      identity: {
        device: currentStats.dev.toString(),
        inode: currentStats.ino.toString(),
      },
      provenance: 'canonical-owner-after-verified-source-retirement',
    });
    const receiptBytes = readFileSync(
      join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json'),
    );
    expect(executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    }).status).toBe('already_completed');
    expect(readFileSync(
      join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json'),
    )).toEqual(receiptBytes);
  });

  it.each(['outside', 'quarantine'] as const)(
    'rejects an evolved owner with an unrecorded %s hard-link alias',
    (aliasKind) => {
      const { runtimeRoot, systemDataDir, fleet, digest, file } = migrateSingleOwner();
      const destination = file.destinations[0];
      writeJsonAtomic(
        destination.destinationPath,
        JSON.parse(validChargeSource(42).toString('utf8')) as unknown,
      );
      if (aliasKind === 'outside') {
        linkSync(destination.destinationPath, join(runtimeRoot, 'outside-owner-alias.json'));
      } else {
        unlinkSync(destination.destinationPath);
        linkSync(file.quarantinePath, destination.destinationPath);
      }
      const receiptPath = join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json');
      const evidencePaths = [
        receiptPath,
        destination.destinationPath,
        destination.temporaryPath,
        file.quarantinePath,
        ...(aliasKind === 'outside' ? [join(runtimeRoot, 'outside-owner-alias.json')] : []),
      ];
      const beforeRecovery = snapshotFiles(evidencePaths);

      expect(() => executeSystemOwnerFleetMigration({
        systemDataDir,
        fleet,
        expectedSourceDigests: { 'charge-policy.json': digest },
      })).toThrow(/unrecorded hard-link alias/);
      expect(snapshotFiles(evidencePaths)).toBe(beforeRecovery);
    },
  );

  it.each([
    { ownerFile: 'charge-policy.json', replacement: validChargeSource(41) },
    { ownerFile: 'skills.json', replacement: validSkillsSource('recovered-evolution') },
  ])('recovers every post-quarantine crash after atomic $ownerFile evolution', ({
    ownerFile,
    replacement,
  }) => {
    for (const crashStage of [
      'after_source_quarantine',
      'after_quarantine_sync',
      'before_final_receipt',
    ] as const) {
      const context = fixture();
      const source = ownerFile === 'charge-policy.json'
        ? validChargeSource(40)
        : validSkillsSource('migration-source');
      const digest = sha256(source);
      writeFileSync(join(context.systemDataDir, ownerFile), source);
      let interrupted = false;
      expect(() => executeSystemOwnerFleetMigration({
        systemDataDir: context.systemDataDir,
        fleet: context.fleet,
        expectedSourceDigests: { [ownerFile]: digest },
        faultInjection: (event) => {
          if (!interrupted && event.stage === crashStage) {
            interrupted = true;
            throw new Error(`crash:${crashStage}`);
          }
        },
      })).toThrow(`crash:${crashStage}`);
      expect(interrupted).toBe(true);

      const evolved = JSON.parse(replacement.toString('utf8')) as unknown;
      for (const companion of context.fleet.companions) {
        writeJsonAtomic(join(companion.companionDataDir, ownerFile), evolved);
      }

      const result = executeSystemOwnerFleetMigration({
        systemDataDir: context.systemDataDir,
        fleet: context.fleet,
        expectedSourceDigests: { [ownerFile]: digest },
      });
      expect(result.status).toBe('migrated');
      const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8')) as {
        status: string;
        files: CompletedReceiptFile[];
      };
      const file = receipt.files.find(candidate => candidate.ownerFile === ownerFile);
      if (!file) throw new Error(`Missing recovered receipt file for ${ownerFile}`);
      expect(receipt.status).toBe('completed');
      expect(readFileSync(file.quarantinePath)).toEqual(source);
      for (const destination of file.destinations) {
        const currentBytes = readFileSync(destination.destinationPath);
        const currentStats = statSync(destination.destinationPath, { bigint: true });
        expect(JSON.parse(currentBytes.toString('utf8'))).toEqual(evolved);
        expect(readFileSync(destination.temporaryPath)).toEqual(source);
        expect(destination.currentOwner).toMatchObject({
          bytes: currentBytes.byteLength,
          sha256: sha256(currentBytes),
          identity: {
            device: currentStats.dev.toString(),
            inode: currentStats.ino.toString(),
          },
          provenance: 'canonical-owner-after-verified-source-retirement',
        });
        expect(destination.currentOwner?.observedAt).toEqual(expect.any(String));
      }
    }
  });

  it('denies in-place mutation of hard-linked retained migration evidence', () => {
    const { systemDataDir, fleet, digest, file } = migrateSingleOwner();
    const destination = file.destinations[0];
    writeFileSync(destination.destinationPath, validChargeSource(27));

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    })).toThrow(/Migration-owned temporary conflict/);
  });

  it('fails closed on a malformed atomic owner after completed receipt reuse', () => {
    const { systemDataDir, fleet, digest, file } = migrateSingleOwner();
    const destination = file.destinations[0];
    writeJsonAtomic(destination.destinationPath, { schemaVersion: 0 });

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    })).toThrow(/Invalid charge policy/);
  });

  it('fails closed on a malformed current owner while recovering after source quarantine', () => {
    const context = fixture();
    const source = validChargeSource(28);
    const digest = sha256(source);
    writeFileSync(join(context.systemDataDir, 'charge-policy.json'), source);
    let interrupted = false;
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir: context.systemDataDir,
      fleet: context.fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
      faultInjection: (event) => {
        if (!interrupted && event.stage === 'after_source_quarantine') {
          interrupted = true;
          throw new Error('crash:after-source-quarantine');
        }
      },
    })).toThrow('crash:after-source-quarantine');
    expect(interrupted).toBe(true);

    const destinationPath = join(
      context.fleet.companions[0].companionDataDir,
      'charge-policy.json',
    );
    writeJsonAtomic(destinationPath, { schemaVersion: 0 });
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir: context.systemDataDir,
      fleet: context.fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    })).toThrow(/Invalid charge policy/);
  });

  it.each([
    {
      label: 'a missing live destination',
      mutate: (file: CompletedReceiptFile, _runtimeRoot: string) => {
        unlinkSync(file.destinations[0].destinationPath);
      },
      error: /Verified destination disappeared/,
    },
    {
      label: 'a symlinked live destination',
      mutate: (file: CompletedReceiptFile, runtimeRoot: string) => {
        const destination = file.destinations[0].destinationPath;
        const outside = join(runtimeRoot, 'outside-owner.json');
        writeFileSync(outside, '{"outside":true}\n');
        unlinkSync(destination);
        symlinkSync(outside, destination);
      },
      error: /regular file without symlinks/,
    },
    {
      label: 'changed quarantine evidence',
      mutate: (file: CompletedReceiptFile, _runtimeRoot: string) => {
        writeFileSync(file.quarantinePath, '{"tampered":true}\n');
      },
      error: /Quarantined source changed/,
    },
    {
      label: 'a reappeared retired source',
      mutate: (file: CompletedReceiptFile, runtimeRoot: string) => {
        const sourcePath = join(runtimeRoot, 'system-data', file.ownerFile);
        writeFileSync(sourcePath, '{"reappeared":true}\n');
      },
      error: /Retired migration source reappeared/,
    },
  ])('fails closed on $label after completion', ({ mutate, error }) => {
    const { runtimeRoot, systemDataDir, fleet, digest, file } = migrateSingleOwner();
    mutate(file, runtimeRoot);

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    })).toThrow(error);
  });
});
