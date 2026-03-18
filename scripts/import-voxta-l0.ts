import { resolve } from 'node:path';
import {
  describeVoxtaImportSource,
  importVoxtaCharacterChats,
} from '../src/session/importers/voxta.js';

interface CliArgs {
  dbPath?: string;
  sessionsDir?: string;
  characterId?: string;
  channelPrefix?: string;
  defaultChannelVisibility?: string;
  chatIds: string[];
  allowExistingChannels: boolean;
  dryRun: boolean;
}

function printUsage(): void {
  console.log(
    [
      'Usage: tsx scripts/import-voxta-l0.ts [options]',
      '',
      'Required:',
      '  --db <path>                   Path to Voxta.sqlite.db',
      '  --sessions-dir <path>         Output PSFN sessions directory',
      '  --character-id <uuid>         Voxta character LocalId to export',
      '',
      'Options:',
      '  --chat-id <uuid>              Limit export to a specific Voxta chat (repeatable)',
      '  --channel-prefix <prefix>     Channel prefix for generated PSFN channels (default: voxta)',
      '  --visibility <level>          channelVisibility for imported entries (default: private)',
      '  --allow-existing              Append into existing generated channels instead of refusing',
      '  --dry-run                     Inspect what would be written without writing any files',
      '  --help                        Show this help text',
      '',
      'Example:',
      '  tsx scripts/import-voxta-l0.ts \\',
      '    --db /mnt/samesung/ai/voxta/Data/Voxta.sqlite.db \\',
      '    --sessions-dir /tmp/voxta-l0 \\',
      '    --character-id cf0a06ea-5b6c-9a4d-945a-1c32ad4349bd',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    chatIds: [],
    allowExistingChannels: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--allow-existing') {
      args.allowExistingChannels = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--db') {
      const value = argv[index + 1];
      if (!value) throw new Error('--db requires a value');
      args.dbPath = value;
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
    if (arg === '--character-id') {
      const value = argv[index + 1];
      if (!value) throw new Error('--character-id requires a value');
      args.characterId = value;
      index += 1;
      continue;
    }
    if (arg === '--chat-id') {
      const value = argv[index + 1];
      if (!value) throw new Error('--chat-id requires a value');
      args.chatIds.push(value);
      index += 1;
      continue;
    }
    if (arg === '--channel-prefix') {
      const value = argv[index + 1];
      if (!value) throw new Error('--channel-prefix requires a value');
      args.channelPrefix = value;
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

  if (!args.dbPath) throw new Error('--db is required');
  if (!args.sessionsDir) throw new Error('--sessions-dir is required');
  if (!args.characterId) throw new Error('--character-id is required');

  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = importVoxtaCharacterChats({
    dbPath: args.dbPath,
    sessionsDir: args.sessionsDir,
    characterId: args.characterId,
    channelPrefix: args.channelPrefix,
    defaultChannelVisibility: args.defaultChannelVisibility,
    chatIds: args.chatIds,
    allowExistingChannels: args.allowExistingChannels,
    dryRun: args.dryRun,
  });

  console.log(JSON.stringify({
    source: describeVoxtaImportSource(args.dbPath),
    dbPath: resolve(args.dbPath),
    sessionsDir: resolve(args.sessionsDir),
    characterId: result.characterId,
    characterName: result.characterName,
    dryRun: result.dryRun,
    chatCount: result.chats.length,
    totalMessages: result.totalMessages,
    chats: result.chats,
  }, null, 2));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[import-voxta-l0] ${message}`);
  process.exit(1);
}
