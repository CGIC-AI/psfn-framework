import { resolve } from 'node:path';
import {
  describeDiscordExportSource,
  importDiscordExportToL0,
} from '../src/session/importers/discord-export.js';

interface CliArgs {
  sourcePath?: string;
  sessionsDir?: string;
  channelId?: string;
  defaultChannelVisibility?: string;
  dryRun: boolean;
}

function printUsage(): void {
  console.log(
    [
      'Usage: tsx scripts/import-discord-export-l0.ts [options]',
      '',
      'Required:',
      '  --source <path>               Path to DiscordChatExporter JSON export',
      '  --sessions-dir <path>         Output PSFN sessions directory',
      '',
      'Options:',
      '  --channel-id <id>             Override L0 channelId (default: export channel.id)',
      '  --visibility <level>          channelVisibility for imported entries (default: private)',
      '  --dry-run                     Inspect what would be written without writing any files',
      '  --help                        Show this help text',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--source') {
      const value = argv[index + 1];
      if (!value) throw new Error('--source requires a value');
      args.sourcePath = value;
      index += 1;
      continue;
    }
    if (arg === '--sessions-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--sessions-dir requires a value');
      args.sessionsDir = value;
      index += 1;
      continue;
    }
    if (arg === '--channel-id') {
      const value = argv[index + 1];
      if (!value) throw new Error('--channel-id requires a value');
      args.channelId = value;
      index += 1;
      continue;
    }
    if (arg === '--visibility') {
      const value = argv[index + 1];
      if (!value) throw new Error('--visibility requires a value');
      args.defaultChannelVisibility = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.sourcePath) throw new Error('--source is required');
  if (!args.sessionsDir) throw new Error('--sessions-dir is required');
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = importDiscordExportToL0({
    sourcePath: args.sourcePath,
    sessionsDir: args.sessionsDir,
    channelId: args.channelId,
    defaultChannelVisibility: args.defaultChannelVisibility,
    dryRun: args.dryRun,
  });

  console.log(JSON.stringify({
    source: describeDiscordExportSource(args.sourcePath),
    sourcePath: resolve(args.sourcePath),
    sessionsDir: resolve(args.sessionsDir),
    dryRun: result.dryRun,
    summary: result.summary,
  }, null, 2));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[import-discord-export-l0] ${message}`);
  process.exit(1);
}
