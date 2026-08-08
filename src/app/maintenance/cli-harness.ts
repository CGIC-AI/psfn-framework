import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyGatewayTlsConfig } from '../../boundary/gateway/tls.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { loadConfig } from '../../system/config/load-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';

export interface CommonMaintenanceArgs {
  backupDir?: string;
  dataDir?: string;
  showHelp: boolean;
}

interface CommonValueFlag {
  allowMissingValue?: boolean;
  transform?: (value: string) => string;
}

export interface MaintenanceFlagContext<T> {
  arg: string;
  options: T;
  readValue: () => string;
}

export interface ParseCommonMaintenanceArgsConfig<T extends CommonMaintenanceArgs> {
  commonFlags?: {
    backupDir?: CommonValueFlag;
    dataDir?: CommonValueFlag;
  };
  extraFlags?: Readonly<Record<string, (context: MaintenanceFlagContext<T>) => void>>;
  initial: T;
}

export function parseCommonMaintenanceArgs<T extends CommonMaintenanceArgs>(
  argv: readonly string[],
  config: ParseCommonMaintenanceArgsConfig<T>,
): T {
  const options = config.initial;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }

    const commonFlag = arg === '--data-dir'
      ? config.commonFlags?.dataDir
      : arg === '--backup-dir'
        ? config.commonFlags?.backupDir
        : undefined;
    if (commonFlag) {
      const value = argv[index + 1];
      if (!value && !commonFlag.allowMissingValue) {
        throw new Error(`Missing value for ${arg}`);
      }
      const parsed = value && commonFlag.transform ? commonFlag.transform(value) : value;
      if (arg === '--data-dir') {
        options.dataDir = parsed;
      } else {
        options.backupDir = parsed;
      }
      index += 1;
      continue;
    }

    const handler = config.extraFlags && Object.hasOwn(config.extraFlags, arg)
      ? config.extraFlags[arg]
      : undefined;
    if (!handler) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    handler({
      arg,
      options,
      readValue: () => {
        const value = argv[index + 1];
        if (!value) {
          throw new Error(`Missing value for ${arg}`);
        }
        index += 1;
        return value;
      },
    });
  }

  return options;
}

interface MaintenanceRuntimeDependencies {
  applyGatewayTlsConfig: (config: {
    caPath?: string;
    rejectUnauthorized?: boolean;
  }) => unknown;
  hydrateSecretBearingConfig: (
    config: SubstrateConfig,
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<unknown>;
  loadConfig: (env?: NodeJS.ProcessEnv) => SubstrateConfig;
  now: () => Date;
}

export interface BootstrapMaintenanceRuntimeOptions {
  backupDir?: string;
  backupLabel?: string;
  dataDir?: string;
  dependencies?: Partial<MaintenanceRuntimeDependencies>;
  env?: NodeJS.ProcessEnv;
  hydrateSecrets?: boolean;
}

export interface MaintenanceRuntime {
  backupDir?: string;
  config: SubstrateConfig;
  dataDir: string;
}

const defaultRuntimeDependencies: MaintenanceRuntimeDependencies = {
  applyGatewayTlsConfig,
  hydrateSecretBearingConfig,
  loadConfig,
  now: () => new Date(),
};

export function bootstrapMaintenanceRuntime(
  options: BootstrapMaintenanceRuntimeOptions & { backupLabel: string },
): Promise<MaintenanceRuntime & { backupDir: string }>;
export function bootstrapMaintenanceRuntime(
  options?: BootstrapMaintenanceRuntimeOptions,
): Promise<MaintenanceRuntime>;
export async function bootstrapMaintenanceRuntime(
  options: BootstrapMaintenanceRuntimeOptions = {},
): Promise<MaintenanceRuntime> {
  const dependencies = {
    ...defaultRuntimeDependencies,
    ...options.dependencies,
  };
  const env = options.env ?? process.env;
  const config = dependencies.loadConfig(env);

  if (options.hydrateSecrets !== false) {
    dependencies.applyGatewayTlsConfig({
      caPath: config.gatewayTlsCaPath,
      rejectUnauthorized: config.gatewayTlsRejectUnauthorized,
    });
    await dependencies.hydrateSecretBearingConfig(config, { env });
  }

  const dataDir = resolve(options.dataDir ?? config.dataDir);
  const backupDir = options.backupDir !== undefined
    ? resolve(options.backupDir)
    : options.backupLabel
      ? resolve(
        join(
          dataDir,
          'repair-backups',
          `${options.backupLabel}-${dependencies.now().toISOString().replace(/[:.]/gu, '-')}`,
        ),
      )
      : undefined;

  return {
    ...(backupDir ? { backupDir } : {}),
    config,
    dataDir,
  };
}

interface RepairCliLogger {
  error: (message: string) => void;
  log: (message: string) => void;
}

export interface RunMaintenanceCliOptions<
  TOptions extends { showHelp: boolean },
  TResult,
> {
  argv?: readonly string[];
  exit?: (code: number) => void;
  label: string;
  logger?: RepairCliLogger;
  parseArgs: (argv: readonly string[]) => TOptions;
  printUsage: () => void;
  run: (options: TOptions) => Promise<TResult> | TResult;
}

export async function runMaintenanceCli<
  TOptions extends { showHelp: boolean },
  TResult = void,
>(
  config: RunMaintenanceCliOptions<TOptions, TResult>,
): Promise<TResult | undefined> {
  const logger = config.logger ?? console;

  try {
    const options = config.parseArgs(config.argv ?? process.argv.slice(2));
    if (options.showHelp) {
      config.printUsage();
      return undefined;
    }
    return await config.run(options);
  } catch (error) {
    logger.error(`${config.label} failed: ${toErrorMessage(error)}`);
    (config.exit ?? process.exit)(1);
    throw error;
  }
}

export interface RepairCliRunContext<TOptions, TRuntime, TKeyring> {
  keyring: TKeyring;
  options: TOptions;
  runtime: TRuntime;
}

export interface RunRepairCliOptions<
  TOptions extends { showHelp: boolean },
  TRuntime,
  TKeyring,
  TReport,
> {
  argv?: readonly string[];
  bootstrap: (options: TOptions) => Promise<TRuntime> | TRuntime;
  exit?: (code: number) => void;
  label: string;
  logger?: RepairCliLogger;
  parseArgs: (argv: readonly string[]) => TOptions;
  printUsage: () => void;
  reportFields: (
    report: TReport,
    context: RepairCliRunContext<TOptions, TRuntime, TKeyring>,
  ) => readonly string[];
  resolveKeyring: (runtime: TRuntime) => Promise<TKeyring> | TKeyring;
  runRepair: (
    context: RepairCliRunContext<TOptions, TRuntime, TKeyring>,
  ) => Promise<TReport> | TReport;
}

export async function runRepairCli<
  TOptions extends { showHelp: boolean },
  TRuntime,
  TKeyring,
  TReport,
>(
  config: RunRepairCliOptions<TOptions, TRuntime, TKeyring, TReport>,
): Promise<TReport | undefined> {
  const logger = config.logger ?? console;
  return runMaintenanceCli({
    argv: config.argv,
    exit: config.exit,
    label: config.label,
    logger,
    parseArgs: config.parseArgs,
    printUsage: config.printUsage,
    run: async options => {
      const runtime = await config.bootstrap(options);
      const keyring = await config.resolveKeyring(runtime);
      const context = { keyring, options, runtime };
      const report = await config.runRepair(context);
      for (const line of config.reportFields(report, context)) {
        logger.log(line);
      }
      return report;
    },
  });
}

export function isMaintenanceCliEntrypoint(
  importMetaUrl: string,
  argv: readonly string[] = process.argv,
): boolean {
  const entrypoint = argv[1];
  return entrypoint
    ? pathToFileURL(resolve(entrypoint)).href === importMetaUrl
    : false;
}
