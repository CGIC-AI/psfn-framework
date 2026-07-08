import '../../shared/utils/load-dotenv.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../system/config/load-config.js';
import {
  resolveConfiguredCompanionDataDir,
  resolveCoreMemoryPath,
} from '../../persistence/layout.js';
import { auditCoreMemoryScopes } from '../../faculties/core-memory/scope-audit.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  filePath?: string;
  json: boolean;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run audit:core-memory-scopes [-- OPTIONS]');
  console.log('');
  console.log('Reports core-memory rows that are legacy_global scoped or whose scope key');
  console.log('does not match the canonical "channel:<channelId>" derivation. Report only:');
  console.log('it never migrates or mutates the core-memory file.');
  console.log('');
  console.log('Options:');
  console.log('  --file <path>   Override the core-memory file path (default: companion-data core_memory.json).');
  console.log('  --json          Emit the full audit report as JSON.');
  console.log('  -h, --help      Show this help message.');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, showHelp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--file') {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      options.filePath = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function resolveCoreMemoryFilePath(override?: string): string {
  if (override) return resolve(override);
  const config = loadConfig();
  const companionDataDir = resolveConfiguredCompanionDataDir(config);
  return resolveCoreMemoryPath(companionDataDir);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }

  const filePath = resolveCoreMemoryFilePath(options.filePath);
  if (!existsSync(filePath)) {
    console.log(`No core-memory file at ${filePath}; nothing to audit.`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to parse core-memory file ${filePath}: ${toErrorMessage(error)}`);
  }

  const report = auditCoreMemoryScopes(parsed);

  if (options.json) {
    console.log(JSON.stringify({ filePath, ...report }, null, 2));
    process.exitCode = report.issues.length > 0 ? 1 : 0;
    return;
  }

  console.log(`Core-memory scope audit: ${filePath}`);
  console.log(`File version: ${report.fileVersion}`);
  console.log(`Channel scopes: ${report.scopeCount} (${report.channelScopeKeys.length} canonical)`);

  if (report.issues.length === 0) {
    console.log('No legacy_global or mismatched scope keys found.');
    return;
  }

  console.log('');
  console.log(`Found ${report.issues.length} issue(s):`);
  for (const issue of report.issues) {
    const keyLabel = issue.key ? ` [${issue.key}]` : '';
    console.log(`- ${issue.kind}${keyLabel}: ${issue.detail}`);
  }
  console.log('');
  console.log('Report only — no migration performed.');
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`Core-memory scope audit failed: ${toErrorMessage(error)}`);
  process.exit(1);
}
