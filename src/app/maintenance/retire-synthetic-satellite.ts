import '../../shared/utils/load-dotenv.js';
import { createFileSyntheticSatelliteRetirementService } from '../../channels/backplane/satellite-retirement-runtime.js';
import type { SyntheticSatelliteRetirementTarget } from '../../channels/backplane/satellite-retirement.js';
import { loadOperatorConfig } from '../../system/config/load-config.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  approvalId?: string;
  apply: boolean;
  backupDir?: string;
  dataDir?: string;
  endpointIds: string[];
  manifestId?: string;
  runId?: string;
  satelliteId?: string;
  showHelp: boolean;
}

export function printSyntheticSatelliteRetirementUsage(): void {
  console.log(
    'Usage: npm run satellite:retire-synthetic -- '
    + '--satellite <exact-id> --endpoint <exact-id> [--endpoint <exact-id> ...] '
    + '--run-id <exact-id> --manifest-id <exact-id> '
    + '[--data-dir <system-data-dir>] [--backup-dir <path>] '
    + '[--apply --approval-id <exact-id>]',
  );
  console.log('');
  console.log('Default mode is a content-free dry run.');
  console.log('Apply requires an exact synthetic testing-harness identity and explicit approval.');
  console.log('Physical, unknown, or provenance-mismatched satellites are rejected before backup or mutation.');
}

export function parseSyntheticSatelliteRetirementArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, endpointIds: [], showHelp: false },
    commonFlags: { backupDir: {}, dataDir: {} },
    extraFlags: {
      '--satellite': ({ options, readValue }) => {
        options.satelliteId = readValue();
      },
      '--endpoint': ({ options, readValue }) => {
        options.endpointIds.push(readValue());
      },
      '--run-id': ({ options, readValue }) => {
        options.runId = readValue();
      },
      '--manifest-id': ({ options, readValue }) => {
        options.manifestId = readValue();
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

function requireTarget(options: CliOptions): SyntheticSatelliteRetirementTarget {
  if (!options.satelliteId || !options.runId || !options.manifestId || options.endpointIds.length === 0) {
    throw new Error('--satellite, --endpoint, --run-id, and --manifest-id are required');
  }
  return {
    satelliteId: options.satelliteId,
    endpointIds: options.endpointIds,
    runId: options.runId,
    manifestId: options.manifestId,
  };
}

export function runSyntheticSatelliteRetirementCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return runMaintenanceCli({
    argv,
    label: 'Synthetic satellite retirement',
    parseArgs: parseSyntheticSatelliteRetirementArgs,
    printUsage: printSyntheticSatelliteRetirementUsage,
    run: async options => {
      const target = requireTarget(options);
      if (options.apply && !options.approvalId) {
        throw new Error('--apply requires --approval-id <exact-id>');
      }
      const runtime = await bootstrapMaintenanceRuntime({
        dataDir: options.dataDir,
        backupDir: options.backupDir,
        backupLabel: 'synthetic-satellite-retirement',
        hydrateSecrets: false,
        dependencies: { loadConfig: loadOperatorConfig },
      });
      const service = createFileSyntheticSatelliteRetirementService({
        systemDataDir: runtime.dataDir,
        backupDir: runtime.backupDir,
      });
      const result = await service.retire({
        target,
        dryRun: !options.apply,
        retiredAt: new Date().toISOString(),
        ...(options.apply
          ? {
              approval: {
                operatorApproved: true,
                approvalId: options.approvalId!,
              },
            }
          : {}),
      });
      console.log(`Status: ${result.status}`);
      console.log(`Satellite: ${result.satelliteId}`);
      console.log(`Endpoints: ${result.endpointIds.length}`);
      console.log(`Run: ${result.runId}`);
      console.log(`Manifest: ${result.manifestId}`);
      if (result.backupRef) console.log(`Backup: ${result.backupRef}`);
      return result;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runSyntheticSatelliteRetirementCli();
}
