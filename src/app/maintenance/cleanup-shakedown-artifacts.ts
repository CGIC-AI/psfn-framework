import '../../shared/utils/load-dotenv.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TESTING_HARNESS_SESSION_CHANNEL_ID } from '../../shared/contracts/testing-harness.js';
import { loadOperatorConfig } from '../../system/config/load-config.js';
import {
  resolveBackupRuntimeConfig,
  type BackupRuntimeConfig,
} from '../../persistence/backups/config.js';
import { parseShakedownCleanupManifest } from '../../system/lifecycle/shakedown-artifact-cleanup.js';
import type { ShakedownArtifactCleanupRuntime } from './shakedown-artifact-cleanup-runtime.js';
import { createShakedownArtifactCleanupRuntime } from './shakedown-artifact-cleanup-runtime.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
  type MaintenanceRuntime,
} from './cli-harness.js';
import {
  resolveTestingSessionPurgeTarget,
  type TestingSessionPurgeTarget,
} from './testing-session-purge-target.js';

interface CliOptions {
  approvalId?: string;
  apply: boolean;
  backupDir?: string;
  companionId?: string;
  dataDir?: string;
  manifestFile?: string;
  showHelp: boolean;
}

interface ShakedownCleanupCliDependencies {
  bootstrapRuntime(options: {
    backupDir?: string;
    dataDir?: string;
  }): Promise<MaintenanceRuntime & { backupDir: string }>;
  createRuntime: typeof createShakedownArtifactCleanupRuntime;
  resolveBackupConfig(options: {
    dataDir: string;
    defaultRootDir: string;
  }): BackupRuntimeConfig;
  resolveTarget(
    runtime: Pick<MaintenanceRuntime, 'config' | 'dataDir'>,
    options: { companionId?: string; dataDir?: string },
  ): TestingSessionPurgeTarget;
}

const defaultDependencies: ShakedownCleanupCliDependencies = {
  bootstrapRuntime: options => bootstrapMaintenanceRuntime({
    dataDir: options.dataDir,
    backupDir: options.backupDir,
    backupLabel: 'shakedown-cleanup',
    dependencies: { loadConfig: loadOperatorConfig },
  }),
  createRuntime: createShakedownArtifactCleanupRuntime,
  resolveBackupConfig: options => resolveBackupRuntimeConfig(options),
  resolveTarget: resolveTestingSessionPurgeTarget,
};

export function printShakedownCleanupUsage(): void {
  console.log(
    'Usage: npm run shakedown:cleanup -- --manifest <exact-manifest.json> '
    + '[--companion-id <uuid>] [--data-dir <path>] [--backup-dir <path>] '
    + '[--apply --approval-id <exact-id>]',
  );
  console.log('');
  console.log('Default mode is a content-free dry run of the canonical testing-harness session.');
  console.log('The manifest binds companion, session, run, manifest, and every logical artifact id.');
  console.log('Apply creates and verifies a rollback-capable backup before exact deletion.');
  console.log('Stop the owning runtime workloads before apply so the fenced snapshot stays stable.');
  console.log('The command fails unless every stored message has the requested run provenance.');
}

export function parseShakedownCleanupArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: {
      apply: false,
      showHelp: false,
    },
    commonFlags: { backupDir: {}, dataDir: {} },
    extraFlags: {
      '--companion-id': ({ options, readValue }) => {
        options.companionId = readValue();
      },
      '--manifest': ({ options, readValue }) => {
        options.manifestFile = readValue();
      },
      '--apply': ({ options }) => {
        options.apply = true;
      },
      '--approval-id': ({ options, readValue }) => {
        options.approvalId = readValue();
      },
    },
  });
}

export function runShakedownCleanupCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: ShakedownCleanupCliDependencies = defaultDependencies,
): Promise<unknown> {
  return runMaintenanceCli({
    argv,
    label: 'Shakedown artifact cleanup',
    parseArgs: parseShakedownCleanupArgs,
    printUsage: printShakedownCleanupUsage,
    run: async options => {
      if (!options.manifestFile) {
        throw new Error('--manifest <exact-manifest.json> is required');
      }
      const target = parseShakedownCleanupManifest(
        JSON.parse(readFileSync(resolve(options.manifestFile), 'utf8')),
      );
      if (target.sessionId !== TESTING_HARNESS_SESSION_CHANNEL_ID) {
        throw new Error('Cleanup manifest must name the canonical testing-harness session');
      }
      if (options.apply && !options.approvalId) {
        throw new Error('--apply requires --approval-id <exact-id>');
      }
      const runtime = await dependencies.bootstrapRuntime({
        dataDir: options.dataDir,
        backupDir: options.backupDir,
      });
      const databaseUrl = runtime.config.postgresDatabaseUrl?.trim();
      if (!databaseUrl) {
        throw new Error('Shakedown cleanup requires config.postgresDatabaseUrl');
      }
      const resolved = dependencies.resolveTarget(runtime, {
        companionId: options.companionId ?? target.companionId,
        dataDir: options.dataDir,
      });
      const companionId = resolved.companionId ?? runtime.config.companionId?.trim();
      if (!companionId || companionId !== target.companionId) {
        throw new Error('Cleanup manifest companion does not match resolved runtime authority');
      }
      const backup = options.apply
        ? dependencies.resolveBackupConfig({
            dataDir: runtime.dataDir,
            defaultRootDir: runtime.backupDir,
          })
        : undefined;
      let cleanupRuntime: ShakedownArtifactCleanupRuntime | undefined;
      try {
        cleanupRuntime = await dependencies.createRuntime({
          ...(backup ? { backup } : {}),
          companionDataDir: resolved.companionDataDir,
          databaseUrl,
          mode: options.apply ? 'apply' : 'dry-run',
          multiCompanion: runtime.config.multiCompanion === true,
          postgresSchema: resolved.postgresSchema,
          sessionsDir: resolved.sessionsDir,
          target,
        });
        const result = options.apply
          ? await cleanupRuntime.service.apply(target, {
              operatorApproved: true,
              approvalId: options.approvalId!,
            })
          : await cleanupRuntime.service.dryRun(target);
        console.log(`Status: ${result.status}`);
        console.log(`Companion: ${result.companionId}`);
        console.log(`Session: ${result.sessionId}`);
        console.log(`Run: ${result.runId}`);
        console.log(`Manifest: ${result.manifestId}`);
        console.log(`Target revision: ${result.targetRevision}`);
        console.log(`Artifact counts: ${JSON.stringify(result.artifactCounts)}`);
        if ('backupRef' in result && result.backupRef) console.log(`Backup: ${result.backupRef}`);
        if ('rollbackRef' in result && result.rollbackRef) console.log(`Rollback: ${result.rollbackRef}`);
        return result;
      } finally {
        await cleanupRuntime?.close();
      }
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runShakedownCleanupCli();
}
