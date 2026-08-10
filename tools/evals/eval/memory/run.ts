import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MEMORY_REGRESSION_FIXTURES } from './fixtures.js';
import { buildMemoryRegressionReport, evaluateFixtureFailures } from './metrics.js';
import { DeterministicMemoryRegressionProvider } from './provider.js';
import type {
  MemoryRegressionFixture,
  MemoryRegressionFixtureResult,
  MemoryRegressionProvider,
  MemoryRegressionReport,
} from './types.js';

interface MemoryRegressionBenchmarkOptions {
  fixtures?: readonly MemoryRegressionFixture[];
  providerFactory?: () => MemoryRegressionProvider;
  generatedAt?: string;
  k?: number;
}

interface CliOptions {
  outputPath?: string;
  pretty: boolean;
}

export async function runMemoryRegressionBenchmark(
  options: MemoryRegressionBenchmarkOptions = {},
): Promise<MemoryRegressionReport> {
  const fixtures = options.fixtures ?? MEMORY_REGRESSION_FIXTURES;
  const providerFactory = options.providerFactory ?? (() => new DeterministicMemoryRegressionProvider());
  const fixtureResults: MemoryRegressionFixtureResult[] = [];
  let providerId = 'unknown';

  for (const fixture of fixtures) {
    const provider = providerFactory();
    providerId = provider.id;
    await provider.seedFixture(fixture);
    const writes = [];
    for (const operation of fixture.writes) {
      writes.push(await provider.writeMemory(operation));
    }
    const maintenance = await provider.runMaintenance(fixture);

    const retrievals = [];
    for (const probe of fixture.retrievals) {
      retrievals.push(await provider.retrieve(probe));
    }
    if (fixture.backupRestore) {
      const snapshot = await provider.backup();
      await provider.restore(snapshot);
      retrievals.push(await provider.retrieve(fixture.backupRestore.probeAfterRestore));
    }

    const failures = evaluateFixtureFailures({
      fixture,
      writes,
      retrievals,
      maintenance,
    });
    fixtureResults.push({
      fixtureId: fixture.id,
      family: fixture.family,
      status: failures.length === 0 ? 'pass' : 'fail',
      writes,
      retrievals,
      maintenance,
      failures,
    });
  }

  return buildMemoryRegressionReport({
    providerId,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    fixtures,
    fixtureResults,
    ...(options.k ? { k: options.k } : {}),
  });
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let outputPath: string | undefined;
  let pretty = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--output':
        outputPath = resolvePath(requireNextArg(args, ++index, '--output'));
        break;
      case '--pretty':
        pretty = true;
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }

  return {
    ...(outputPath ? { outputPath } : {}),
    pretty,
  };
}

function requireNextArg(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function printUsage(): void {
  console.log('Usage: npm run eval:memory -- [options]');
  console.log('');
  console.log('Run deterministic memory regression fixtures and emit a machine-readable JSON report.');
  console.log('');
  console.log('Options:');
  console.log('  --output <path>  Write JSON report to a file instead of stdout');
  console.log('  --pretty         Pretty-print JSON output');
  console.log('  --help           Show this help');
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const report = await runMemoryRegressionBenchmark();
  const json = JSON.stringify(report, null, options.pretty ? 2 : 0);
  if (options.outputPath) {
    writeFileSync(options.outputPath, `${json}\n`, 'utf8');
  } else {
    console.log(json);
  }
  if (report.status !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[eval:memory] failed: ${message}`);
    process.exit(1);
  });
}
