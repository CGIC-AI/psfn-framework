import 'dotenv/config';
import { join, resolve } from 'node:path';
import { runSessionRepairScan } from './session/repair.js';
import { loadConfig } from './types.js';
import { toErrorMessage } from './utils/errors.js';

interface CliOptions {
  sessionsDir?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run session:repair [-- --sessions-dir <path>]');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { showHelp: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--sessions-dir' || arg === '-d') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.sessionsDir = value;
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }

  const config = loadConfig();
  const sessionsDir = resolve(options.sessionsDir ?? join(config.dataDir, 'sessions'));
  const report = runSessionRepairScan(sessionsDir);

  console.log(`Session repair scan: ${sessionsDir}`);
  console.log(`Scanned ${report.scannedFiles} JSONL files`);

  if (report.scannedFiles === 0) {
    console.log('No JSONL files found.');
    return;
  }

  if (report.filesWithCorruption.length === 0) {
    console.log('No corruption found.');
    return;
  }

  console.log('');
  for (const file of report.filesWithCorruption) {
    const channelLabel = file.channelId ?? 'unknown';
    console.log(`- ${file.filePath}`);
    console.log(`  channel=${channelLabel} quarantined=${file.quarantinedEntries} loaded=${file.loadedEntries}`);
    console.log(`  sidecar=${file.quarantinePath}`);
  }

  console.log('');
  console.log(
    `Detected ${report.quarantinedEntries} quarantined lines across ${report.filesWithCorruption.length} files.`,
  );
  process.exitCode = 1;
}

main().catch((error) => {
  const message = toErrorMessage(error);
  console.error(`Session repair failed: ${message}`);
  process.exit(1);
});
