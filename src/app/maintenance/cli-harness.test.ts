import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  bootstrapMaintenanceRuntime,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
  runRepairCli,
} from './cli-harness.js';

function createTestConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    characterCardPath: '',
    compactionThresholdPct: 70,
    dataDir: './data',
    databasePath: '',
    defaultContextWindow: 128_000,
    extractionInterval: 5,
    extractionMaxTokens: 8_192,
    extractionModel: 'test-extraction-model',
    extractionProvider: 'test-provider',
    extractionThresholdPct: 30,
    maintenanceIntervalMs: 300_000,
    primaryMaxTokens: 16_384,
    primaryModel: 'test-primary-model',
    primaryProvider: 'test-provider',
    ...overrides,
  };
}

interface TestOptions {
  apply: boolean;
  backupDir?: string;
  dataDir?: string;
  output?: string;
  showHelp: boolean;
}

describe('parseCommonMaintenanceArgs', () => {
  it('parses opted-in common flags and tool-specific flags in argument order', () => {
    const options = parseCommonMaintenanceArgs<TestOptions>(
      ['--data-dir', './data', '--apply', '--backup-dir', './backups', '--output', 'report.json', '-h'],
      {
        initial: { apply: false, showHelp: false },
        commonFlags: {
          dataDir: {},
          backupDir: {},
        },
        extraFlags: {
          '--apply': ({ options: parsed }) => {
            parsed.apply = true;
          },
          '--output': ({ options: parsed, readValue }) => {
            parsed.output = readValue();
          },
        },
      },
    );

    expect(options).toEqual({
      apply: true,
      backupDir: './backups',
      dataDir: './data',
      output: 'report.json',
      showHelp: true,
    });
  });

  it('preserves the legacy unknown-argument and missing-value errors', () => {
    expect(() => parseCommonMaintenanceArgs(['--unknown'], {
      initial: { showHelp: false },
    })).toThrow('Unknown argument: --unknown');
    expect(() => parseCommonMaintenanceArgs(['toString'], {
      initial: { showHelp: false },
      extraFlags: {
        '--known': () => undefined,
      },
    })).toThrow('Unknown argument: toString');

    expect(() => parseCommonMaintenanceArgs(['--data-dir'], {
      initial: { showHelp: false },
      commonFlags: { dataDir: {} },
    })).toThrow('Missing value for --data-dir');
  });

  it('can preserve legacy common flags that accepted an omitted value', () => {
    expect(parseCommonMaintenanceArgs(['--backup-dir'], {
      initial: { showHelp: false },
      commonFlags: {
        backupDir: { allowMissingValue: true },
      },
    })).toEqual({
      backupDir: undefined,
      showHelp: false,
    });
  });
});

describe('bootstrapMaintenanceRuntime', () => {
  it('loads and hydrates config while deriving a timestamped repair backup directory', async () => {
    const config = createTestConfig({
      dataDir: '/configured/data',
      gatewayTlsCaPath: '/tls/ca.pem',
      gatewayTlsRejectUnauthorized: true,
    });
    const applyTls = vi.fn();
    const hydrateSecrets = vi.fn().mockResolvedValue(undefined);
    const env = { SESSION_HMAC_KEY: 'secret' };

    const runtime = await bootstrapMaintenanceRuntime({
      dataDir: './override-data',
      backupLabel: 'attribution',
      env,
      dependencies: {
        applyGatewayTlsConfig: applyTls,
        hydrateSecretBearingConfig: hydrateSecrets,
        loadConfig: () => config,
        now: () => new Date('2026-07-19T18:30:45.123Z'),
      },
    });

    expect(runtime).toEqual({
      backupDir: resolve(
        './override-data',
        'repair-backups',
        'attribution-2026-07-19T18-30-45-123Z',
      ),
      config,
      dataDir: resolve('./override-data'),
    });
    expect(applyTls).toHaveBeenCalledWith({
      caPath: '/tls/ca.pem',
      rejectUnauthorized: true,
    });
    expect(hydrateSecrets).toHaveBeenCalledWith(config, { env });
  });

  it('preserves an explicit backup directory', async () => {
    const config = createTestConfig({ dataDir: '/configured/data' });

    const runtime = await bootstrapMaintenanceRuntime({
      backupDir: './operator-backup',
      hydrateSecrets: false,
      dependencies: {
        loadConfig: () => config,
      },
    });

    expect(runtime.backupDir).toBe(resolve('./operator-backup'));
  });

  it('preserves an explicitly empty backup path as the current working directory', async () => {
    const config = createTestConfig({ dataDir: '/configured/data' });

    const runtime = await bootstrapMaintenanceRuntime({
      backupDir: '',
      backupLabel: 'repair',
      hydrateSecrets: false,
      dependencies: {
        loadConfig: () => config,
      },
    });

    expect(runtime.backupDir).toBe(resolve(''));
  });
});

describe('runRepairCli', () => {
  it('runs the repair lifecycle and emits the configured report fields', async () => {
    const log = vi.fn();
    const resolveKeyring = vi.fn().mockReturnValue('keyring');
    const runRepair = vi.fn().mockReturnValue({ backupsDir: '/backup', repaired: 3 });

    const report = await runRepairCli({
      argv: ['--data-dir', '/data'],
      bootstrap: vi.fn().mockResolvedValue({ dataDir: '/data' }),
      label: 'Example repair',
      logger: { error: vi.fn(), log },
      parseArgs: argv => parseCommonMaintenanceArgs(argv, {
        initial: { showHelp: false },
        commonFlags: { dataDir: {} },
      }),
      printUsage: vi.fn(),
      reportFields: result => [
        `Backups: ${result.backupsDir}`,
        `Repaired: ${result.repaired}`,
      ],
      resolveKeyring,
      runRepair,
    });

    expect(report).toEqual({ backupsDir: '/backup', repaired: 3 });
    expect(resolveKeyring).toHaveBeenCalledWith({ dataDir: '/data' });
    expect(runRepair).toHaveBeenCalledWith({
      keyring: 'keyring',
      options: { dataDir: '/data', showHelp: false },
      runtime: { dataDir: '/data' },
    });
    expect(log.mock.calls).toEqual([
      ['Backups: /backup'],
      ['Repaired: 3'],
    ]);
  });

  it('prints help without bootstrapping the runtime', async () => {
    const bootstrap = vi.fn();
    const printUsage = vi.fn();

    await runRepairCli({
      argv: ['--help'],
      bootstrap,
      label: 'Example repair',
      logger: { error: vi.fn(), log: vi.fn() },
      parseArgs: argv => parseCommonMaintenanceArgs(argv, {
        initial: { showHelp: false },
      }),
      printUsage,
      reportFields: () => [],
      resolveKeyring: () => undefined,
      runRepair: vi.fn(),
    });

    expect(printUsage).toHaveBeenCalledOnce();
    expect(bootstrap).not.toHaveBeenCalled();
  });
});

describe('runMaintenanceCli', () => {
  it('preserves the tool failure label and exit code', async () => {
    const error = vi.fn();
    const exit = vi.fn();

    await expect(runMaintenanceCli({
      argv: ['--apply'],
      exit,
      label: 'Migration',
      logger: { error, log: vi.fn() },
      parseArgs: () => ({ showHelp: false }),
      printUsage: vi.fn(),
      run: () => {
        throw new Error('database unavailable');
      },
    })).rejects.toThrow('database unavailable');

    expect(error).toHaveBeenCalledWith('Migration failed: database unavailable');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
