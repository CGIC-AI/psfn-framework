import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
        quarantinePath: string;
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
      expect(readFileSync(file.quarantinePath)).toEqual(sourceBytes.get(file.ownerFile));
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

  it.each([
    'after_bootstrap_receipt',
    'after_quarantine_directory_create',
    'after_quarantine_identity_receipt',
    'after_staging_directory_create',
    'after_staging_identity_receipt',
    'after_bootstrap_finalize',
    'after_temporary_create',
    'after_temporary_identity_receipt',
    'during_temporary_copy',
    'after_temporary_fsync',
    'after_publish',
    'after_publish_directory_sync',
    'before_receipt_update',
    'after_receipt_update',
    'before_source_retirement',
    'after_source_quarantine',
    'after_quarantine_sync',
    'before_final_receipt',
    'after_final_receipt',
  ] as const)('recovers deterministically from the %s crash window', (stage) => {
    const { systemDataDir, fleet } = fixture();
    const sourcePath = join(systemDataDir, 'skills.json');
    const source = Buffer.from('{"enabled":true,"padding":"crash-window"}\n');
    const digest = sha256(source);
    writeFileSync(sourcePath, source);
    let injected = false;

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (!injected && event.stage === stage) {
          injected = true;
          throw new Error(`crash:${stage}`);
        }
      },
    })).toThrow(`crash:${stage}`);
    expect(injected).toBe(true);

    const recovered = executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
    });
    expect(recovered.status).toBe(stage === 'after_final_receipt' ? 'already_completed' : 'migrated');
    expect(existsSync(sourcePath)).toBe(false);
    const completedReceipt = JSON.parse(readFileSync(recovered.receiptPath, 'utf8')) as {
      files: Array<{
        destinations: Array<{
          companionId: string;
          supersededTemporaryFiles: Array<{ path: string }>;
          temporaryPath: string;
        }>;
      }>;
    };
    for (const companion of fleet.companions) {
      expect(readFileSync(join(companion.companionDataDir, 'skills.json'))).toEqual(source);
      const destination = completedReceipt.files[0].destinations
        .find(entry => entry.companionId === companion.companionId);
      if (!destination) throw new Error(`Missing receipt destination for ${companion.companionId}`);
      expect(readFileSync(destination.temporaryPath)).toEqual(source);
      for (const superseded of destination.supersededTemporaryFiles) {
        expect(existsSync(superseded.path)).toBe(true);
      }
    }
  });

  it('fsyncs a recovered source quarantine before a second crash and receipt completion', () => {
    const { systemDataDir, fleet } = fixture();
    const source = Buffer.from('{"enabled":true,"recovered-quarantine-sync":true}\n');
    const digest = sha256(source);
    const sourcePath = join(systemDataDir, 'skills.json');
    writeFileSync(sourcePath, source);

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (event.stage === 'after_source_quarantine') throw new Error('crash:after-source-quarantine');
      },
    })).toThrow('crash:after-source-quarantine');

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (event.stage === 'after_quarantine_sync') throw new Error('crash:after-recovered-sync');
      },
    })).toThrow('crash:after-recovered-sync');

    const receiptPath = join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json');
    const interruptedReceipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      status: string;
      files: Array<{ quarantinePath: string; status: string }>;
    };
    expect(interruptedReceipt.status).toBe('in_progress');
    expect(interruptedReceipt.files[0].status).toBe('pending');
    expect(existsSync(sourcePath)).toBe(false);
    expect(readFileSync(interruptedReceipt.files[0].quarantinePath)).toEqual(source);

    expect(executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
    }).status).toBe('migrated');
  });

  it('denies pre-existing or symlinked migration temp/final/source paths', () => {
    const preexisting = fixture();
    const source = Buffer.from('{"enabled":true}\n');
    const digest = sha256(source);
    writeFileSync(join(preexisting.systemDataDir, 'skills.json'), source);
    const firstDir = preexisting.fleet.companions[0].companionDataDir;
    mkdirSync(firstDir, { recursive: true });
    const preexistingStagingDirectory = join(
      firstDir,
      '.system-owner-fleet-reroot-staging',
    );
    mkdirSync(preexistingStagingDirectory);
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir: preexisting.systemDataDir,
      fleet: preexisting.fleet,
      expectedSourceDigests: { 'skills.json': digest },
      temporaryId: () => 'fixed',
    })).toThrow(/Pre-existing migration-owned staging artifacts conflict/);

    const linkedSource = fixture();
    const outsideSource = join(linkedSource.runtimeRoot, 'outside-skills.json');
    writeFileSync(outsideSource, source);
    symlinkSync(outsideSource, join(linkedSource.systemDataDir, 'skills.json'));
    expect(() => buildSystemOwnerFleetMigrationPlan({
      systemDataDir: linkedSource.systemDataDir,
      fleet: linkedSource.fleet,
    })).toThrow(/regular file without symlinks/);

    const linkedFinal = fixture();
    writeFileSync(join(linkedFinal.systemDataDir, 'skills.json'), source);
    const outsideFinal = join(linkedFinal.runtimeRoot, 'outside-final.json');
    writeFileSync(outsideFinal, source);
    mkdirSync(linkedFinal.fleet.companions[0].companionDataDir, { recursive: true });
    symlinkSync(outsideFinal, join(linkedFinal.fleet.companions[0].companionDataDir, 'skills.json'));
    expect(() => buildSystemOwnerFleetMigrationPlan({
      systemDataDir: linkedFinal.systemDataDir,
      fleet: linkedFinal.fleet,
    })).toThrow(/symlink/);

    const linkedTemp = fixture();
    writeFileSync(join(linkedTemp.systemDataDir, 'skills.json'), source);
    let interrupted = false;
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir: linkedTemp.systemDataDir,
      fleet: linkedTemp.fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (!interrupted && event.stage === 'during_temporary_copy') {
          interrupted = true;
          throw new Error('partial-temp');
        }
      },
    })).toThrow('partial-temp');
    const receipt = JSON.parse(readFileSync(
      join(linkedTemp.systemDataDir, 'migrations', 'system-owner-fleet-reroot.json'),
      'utf8',
    )) as { files: Array<{ destinations: Array<{ temporaryPath: string }> }> };
    const ownedTemp = receipt.files[0].destinations[0].temporaryPath;
    unlinkSync(ownedTemp);
    symlinkSync(outsideFinal, ownedTemp);
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir: linkedTemp.systemDataDir,
      fleet: linkedTemp.fleet,
      expectedSourceDigests: { 'skills.json': digest },
    })).toThrow(/regular file without symlinks/);
  });

  it('durably supersedes and preserves an unbound temporary across a second crash', () => {
    const { systemDataDir, fleet } = fixture();
    const source = Buffer.from('{"enabled":true,"supersede":true}\n');
    const digest = sha256(source);
    writeFileSync(join(systemDataDir, 'skills.json'), source);

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (event.stage === 'after_temporary_create') throw new Error('crash:unbound-temporary');
      },
    })).toThrow('crash:unbound-temporary');

    let supersessionCrashed = false;
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (!supersessionCrashed && event.stage === 'after_temporary_superseded_receipt') {
          supersessionCrashed = true;
          throw new Error('crash:superseded-receipt');
        }
      },
    })).toThrow('crash:superseded-receipt');
    expect(supersessionCrashed).toBe(true);

    const result = executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
    });
    expect(result.status).toBe('migrated');
    const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8')) as {
      files: Array<{
        destinations: Array<{
          supersededTemporaryFiles: Array<{ path: string }>;
          temporaryPath: string;
        }>;
      }>;
    };
    const destination = receipt.files[0].destinations[0];
    expect(destination.supersededTemporaryFiles).toHaveLength(1);
    expect(readFileSync(destination.supersededTemporaryFiles[0].path)).toHaveLength(0);
    expect(readFileSync(destination.temporaryPath)).toEqual(source);
  });

  it('preserves and denies a replacement of an identity-bound partial temporary', () => {
    const { runtimeRoot, systemDataDir, fleet } = fixture();
    const source = Buffer.from('{"enabled":true,"partial-replacement":true}\n');
    const digest = sha256(source);
    writeFileSync(join(systemDataDir, 'skills.json'), source);
    let interrupted = false;
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (!interrupted && event.stage === 'during_temporary_copy') {
          interrupted = true;
          throw new Error('crash:bound-partial');
        }
      },
    })).toThrow('crash:bound-partial');
    const receiptPath = join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      files: Array<{ destinations: Array<{ temporaryPath: string }> }>;
    };
    const temporaryPath = receipt.files[0].destinations[0].temporaryPath;
    const preservedPartial = join(runtimeRoot, 'preserved-partial');
    renameSync(temporaryPath, preservedPartial);
    writeFileSync(temporaryPath, 'replacement\n');

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
    })).toThrow(/changed identity/);
    expect(readFileSync(temporaryPath, 'utf8')).toBe('replacement\n');
    expect(readFileSync(preservedPartial).length).toBeGreaterThan(0);
  });

  it('denies unrecorded artifacts introduced into a receipt-owned staging directory', () => {
    const { systemDataDir, fleet } = fixture();
    const source = Buffer.from('{"enabled":true,"unknown-artifact":true}\n');
    const digest = sha256(source);
    writeFileSync(join(systemDataDir, 'skills.json'), source);
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (event.stage === 'after_bootstrap_finalize') throw new Error('crash:bootstrap-finalized');
      },
    })).toThrow('crash:bootstrap-finalized');
    const receipt = JSON.parse(readFileSync(
      join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json'),
      'utf8',
    )) as { files: Array<{ destinations: Array<{ stagingDirectoryPath: string }> }> };
    const unknownPath = join(receipt.files[0].destinations[0].stagingDirectoryPath, 'unknown-artifact');
    writeFileSync(unknownPath, 'unknown\n');
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
    })).toThrow(/unknown artifacts/);
    expect(readFileSync(unknownPath, 'utf8')).toBe('unknown\n');
  });

  it('keeps system, receipt, and destination writes on pinned directory identities after path swaps', () => {
    const { runtimeRoot, systemDataDir, fleet } = fixture();
    const source = Buffer.from('{"enabled":true,"pinned":true}\n');
    const digest = sha256(source);
    const sourcePath = join(systemDataDir, 'skills.json');
    writeFileSync(sourcePath, source);
    const movedDestination = join(runtimeRoot, 'pinned-destination');
    const outsideDestination = join(runtimeRoot, 'outside-destination');
    const movedReceiptDirectory = join(runtimeRoot, 'pinned-receipts');
    const outsideReceiptDirectory = join(runtimeRoot, 'outside-receipts');
    const movedSystemDirectory = join(runtimeRoot, 'pinned-system');
    const outsideSystemDirectory = join(runtimeRoot, 'outside-system');
    let destinationSwapped = false;
    let receiptSwapped = false;
    let systemSwapped = false;

    const result = executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (!destinationSwapped && event.stage === 'after_temporary_fsync') {
          destinationSwapped = true;
          renameSync(fleet.companions[0].companionDataDir, movedDestination);
          mkdirSync(outsideDestination);
          symlinkSync(outsideDestination, fleet.companions[0].companionDataDir, 'dir');
        }
        if (!receiptSwapped && event.stage === 'before_receipt_update') {
          receiptSwapped = true;
          renameSync(join(systemDataDir, 'migrations'), movedReceiptDirectory);
          mkdirSync(outsideReceiptDirectory);
          symlinkSync(outsideReceiptDirectory, join(systemDataDir, 'migrations'), 'dir');
        }
        if (!systemSwapped && event.stage === 'before_source_retirement') {
          systemSwapped = true;
          renameSync(systemDataDir, movedSystemDirectory);
          mkdirSync(outsideSystemDirectory);
          writeFileSync(join(outsideSystemDirectory, 'skills.json'), 'outside-decoy\n');
          symlinkSync(outsideSystemDirectory, systemDataDir, 'dir');
        }
      },
    });

    expect(result.status).toBe('migrated');
    expect([destinationSwapped, receiptSwapped, systemSwapped]).toEqual([true, true, true]);
    expect(readFileSync(join(movedDestination, 'skills.json'))).toEqual(source);
    expect(existsSync(join(outsideDestination, 'skills.json'))).toBe(false);
    expect(existsSync(join(movedReceiptDirectory, 'system-owner-fleet-reroot.json'))).toBe(true);
    expect(existsSync(join(outsideReceiptDirectory, 'system-owner-fleet-reroot.json'))).toBe(false);
    expect(readFileSync(join(outsideSystemDirectory, 'skills.json'), 'utf8')).toBe('outside-decoy\n');
    expect(existsSync(join(movedSystemDirectory, 'skills.json'))).toBe(false);
  });

  it('rejects receipt and ancestor symlinks without writing through them', () => {
    const receiptDirectoryLink = fixture();
    const source = Buffer.from('{"enabled":true}\n');
    const digest = sha256(source);
    writeFileSync(join(receiptDirectoryLink.systemDataDir, 'skills.json'), source);
    const outsideReceipts = join(receiptDirectoryLink.runtimeRoot, 'outside-receipts');
    mkdirSync(outsideReceipts);
    symlinkSync(outsideReceipts, join(receiptDirectoryLink.systemDataDir, 'migrations'), 'dir');
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir: receiptDirectoryLink.systemDataDir,
      fleet: receiptDirectoryLink.fleet,
      expectedSourceDigests: { 'skills.json': digest },
    })).toThrow(/receipt directory must be a directory without symlinks/);
    expect(readdirSync(outsideReceipts)).toEqual([]);

    const receiptLeafLink = fixture();
    writeFileSync(join(receiptLeafLink.systemDataDir, 'skills.json'), source);
    const migrationsDirectory = join(receiptLeafLink.systemDataDir, 'migrations');
    const outsideReceipt = join(receiptLeafLink.runtimeRoot, 'outside-receipt.json');
    mkdirSync(migrationsDirectory);
    writeFileSync(outsideReceipt, 'outside-receipt\n');
    symlinkSync(outsideReceipt, join(migrationsDirectory, 'system-owner-fleet-reroot.json'));
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir: receiptLeafLink.systemDataDir,
      fleet: receiptLeafLink.fleet,
      expectedSourceDigests: { 'skills.json': digest },
    })).toThrow(/receipt must be a regular file without symlinks/);
    expect(readFileSync(outsideReceipt, 'utf8')).toBe('outside-receipt\n');

    const destinationAncestorLink = fixture();
    writeFileSync(join(destinationAncestorLink.systemDataDir, 'skills.json'), source);
    const outsideCompanions = join(destinationAncestorLink.runtimeRoot, 'outside-companions');
    mkdirSync(outsideCompanions);
    symlinkSync(outsideCompanions, join(destinationAncestorLink.runtimeRoot, 'companions'), 'dir');
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir: destinationAncestorLink.systemDataDir,
      fleet: destinationAncestorLink.fleet,
      expectedSourceDigests: { 'skills.json': digest },
    })).toThrow(/destination directory must be a directory without symlinks/);
    expect(readdirSync(outsideCompanions)).toEqual([]);
  });

  it('preserves and denies a source replacement at the final retirement boundary', () => {
    const { systemDataDir, fleet } = fixture();
    const sourcePath = join(systemDataDir, 'skills.json');
    const approvedSource = Buffer.from('{"approved":true}\n');
    const replacement = Buffer.from('{"replacement":true}\n');
    const savedApprovedSource = join(systemDataDir, 'approved-source.saved');
    const digest = sha256(approvedSource);
    writeFileSync(sourcePath, approvedSource);
    let replaced = false;

    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
      faultInjection: (event) => {
        if (!replaced && event.stage === 'before_source_retirement') {
          replaced = true;
          renameSync(sourcePath, savedApprovedSource);
          writeFileSync(sourcePath, replacement);
        }
      },
    })).toThrow(/Source replacement was preserved in quarantine/);
    expect(readFileSync(savedApprovedSource)).toEqual(approvedSource);
    expect(existsSync(sourcePath)).toBe(false);
    const receipt = JSON.parse(readFileSync(
      join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json'),
      'utf8',
    )) as { files: Array<{ quarantinePath: string }> };
    expect(readFileSync(receipt.files[0].quarantinePath)).toEqual(replacement);
    expect(() => executeSystemOwnerFleetMigration({
      systemDataDir,
      fleet,
      expectedSourceDigests: { 'skills.json': digest },
    })).toThrow(/changed identity/);
    expect(readFileSync(receipt.files[0].quarantinePath)).toEqual(replacement);
  });
});
