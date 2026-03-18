import { resolve } from 'node:path';
import {
  describeVoxtaImportSource,
  importVoxtaCharacterChats,
} from '../src/session/importers/voxta.js';

interface CliArgs {
  dbPath?: string;
  sessionsDir?: string;
  characterId?: string;
  channelId?: string;
  defaultChannelVisibility?: string;
  profileDatabasePath?: string;
  profileAuthorId?: string;
  profileAuthorName?: string;
  consolidateToSingleSession: boolean;
  chatIds: string[];
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
      '  --channel-id <id>             L0 channelId for imported sessions (default: voxta)',
      '  --visibility <level>          channelVisibility for imported entries (default: private)',
      '  --profile-db <path>           Profile attribution DB (default: ./data/purrsephone.db)',
      '  --profile-id <id>             Override imported user authorId',
      '  --profile-name <name>         Override imported user authorName',
      '  --consolidate                 Write all matched Voxta chats into one L0 session file',
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
    consolidateToSingleSession: false,
    dryRun: false,
  };

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
    if (arg === '--consolidate') {
      args.consolidateToSingleSession = true;
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
    if (arg === '--profile-db') {
      const value = argv[index + 1];
      if (!value) throw new Error('--profile-db requires a value');
      args.profileDatabasePath = value;
      index += 1;
      continue;
    }
    if (arg === '--profile-id') {
      const value = argv[index + 1];
      if (!value) throw new Error('--profile-id requires a value');
      args.profileAuthorId = value;
      index += 1;
      continue;
    }
    if (arg === '--profile-name') {
      const value = argv[index + 1];
      if (!value) throw new Error('--profile-name requires a value');
      args.profileAuthorName = value;
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
    channelId: args.channelId,
    defaultChannelVisibility: args.defaultChannelVisibility,
    chatIds: args.chatIds,
    profileDatabasePath: args.profileDatabasePath,
    profileAuthorId: args.profileAuthorId,
    profileAuthorName: args.profileAuthorName,
    consolidateToSingleSession: args.consolidateToSingleSession,
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
    writtenSessionCount: result.writtenSessionCount,
    writtenFilePaths: result.writtenFilePaths,
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
