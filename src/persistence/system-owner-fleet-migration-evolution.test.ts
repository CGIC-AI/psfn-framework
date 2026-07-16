import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import { executeSystemOwnerFleetMigration } from './system-owner-fleet-migration.js';

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

interface CompletedReceiptFile {
  ownerFile: string;
  quarantinePath: string;
  destinations: Array<{
    companionId: string;
    destinationPath: string;
    temporaryPath: string;
  }>;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
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
    return { runtimeRoot, systemDataDir, fleet };
  }

  function migrateSingleOwner(ownerFile = 'charge-policy.json') {
    const context = fixture();
    const source = Buffer.from('{"quota":"individual","revision":1}\n');
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
      'intake-policy',
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
      approvals[ownerFile] = sha256(bytes);
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
        multiCompanion: true,
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
    const replacement = { quota: 'individual', revision: 2 };

    writeJsonAtomic(destination.destinationPath, replacement);

    expect(executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    }).status).toBe('already_completed');
    expect(JSON.parse(readFileSync(destination.destinationPath, 'utf8'))).toEqual(replacement);
    expect(readFileSync(destination.temporaryPath)).toEqual(source);
    expect(readFileSync(file.quarantinePath)).toEqual(source);
  });

  it('denies in-place mutation of hard-linked retained migration evidence', () => {
    const { systemDataDir, fleet, digest, file } = migrateSingleOwner();
    const destination = file.destinations[0];
    writeFileSync(destination.destinationPath, '{"quota":"tampered"}\n');

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'charge-policy.json': digest },
    })).toThrow(/Migration-owned temporary conflict/);
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
      error: /live or unretired source/,
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
