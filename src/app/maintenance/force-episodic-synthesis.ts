import { inspect } from 'node:util';
import Database from 'better-sqlite3';
import { SessionStore } from '../../persistence/sessions/store.js';
import { EpisodicStore } from '../../faculties/memory/episodic/store.js';
import {
  EpisodicSynthesizer,
  type EpisodicSynthesisOptions,
  type EpisodicSynthesisRunResult,
} from '../../faculties/memory/episodic/synthesis.js';

export interface ForcedEpisodicSynthesisInput extends EpisodicSynthesisOptions {
  companionDbPath: string;
  sessionsDir: string;
  sessionId: string;
  sourceMessageId?: string;
  allowIsolatedRuntime: boolean;
}

export interface ForcedEpisodicSynthesisResult extends EpisodicSynthesisRunResult {
  sessionId: string;
  beforeEpisodeCount: number;
  afterEpisodeCount: number;
}

interface CliOptions extends Partial<ForcedEpisodicSynthesisInput> {
  help?: boolean;
}

function countEpisodes(db: Database.Database): number {
  const row = db.prepare('SELECT count(*) AS count FROM l01_episodes').get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function requiredText(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

export async function runForcedEpisodicSynthesis(
  input: ForcedEpisodicSynthesisInput,
): Promise<ForcedEpisodicSynthesisResult> {
  if (input.allowIsolatedRuntime !== true) {
    throw new Error('Forced episodic synthesis requires allowIsolatedRuntime=true');
  }

  const companionDbPath = requiredText(input.companionDbPath, 'companionDbPath');
  const sessionsDir = requiredText(input.sessionsDir, 'sessionsDir');
  const sessionId = requiredText(input.sessionId, 'sessionId');

  const db = new Database(companionDbPath);
  try {
    const episodicStore = new EpisodicStore(db);
    const sessionStore = new SessionStore(sessionsDir);
    const beforeEpisodeCount = countEpisodes(db);
    const synthesizer = new EpisodicSynthesizer(
      episodicStore,
      {
        getRecentMessages: (channelId, limit) => sessionStore.getRecent(channelId, limit),
      },
      {
        transcriptMessageLimit: input.transcriptMessageLimit,
        maxEpisodesPerRun: input.maxEpisodesPerRun,
        maxPriorCandidates: input.maxPriorCandidates,
        gapSplitMinutes: input.gapSplitMinutes,
        maxEntriesPerEpisode: input.maxEntriesPerEpisode,
      },
    );
    const result = await synthesizer.run({
      sessionId,
      sourceMessageId: input.sourceMessageId,
    });
    const afterEpisodeCount = countEpisodes(db);

    return {
      ...result,
      sessionId,
      beforeEpisodeCount,
      afterEpisodeCount,
    };
  } finally {
    db.close();
  }
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      if (index + 1 >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      const value = argv[index + 1];
      if (value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--allow-isolated-runtime':
        options.allowIsolatedRuntime = true;
        break;
      case '--companion-db':
        options.companionDbPath = next();
        break;
      case '--sessions-dir':
        options.sessionsDir = next();
        break;
      case '--session-id':
        options.sessionId = next();
        break;
      case '--source-message-id':
        options.sourceMessageId = next();
        break;
      case '--transcript-message-limit':
        options.transcriptMessageLimit = parsePositiveInteger(next(), 'transcriptMessageLimit');
        break;
      case '--max-episodes-per-run':
        options.maxEpisodesPerRun = parsePositiveInteger(next(), 'maxEpisodesPerRun');
        break;
      case '--max-prior-candidates':
        options.maxPriorCandidates = parsePositiveInteger(next(), 'maxPriorCandidates');
        break;
      case '--gap-split-minutes':
        options.gapSplitMinutes = parsePositiveInteger(next(), 'gapSplitMinutes');
        break;
      case '--max-entries-per-episode':
        options.maxEntriesPerEpisode = parsePositiveInteger(next(), 'maxEntriesPerEpisode');
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    'Usage: tsx src/app/maintenance/force-episodic-synthesis.ts --allow-isolated-runtime \\',
    '  --companion-db <path> --sessions-dir <path> --session-id <channelId>',
    '',
    'Runs the L0.1 episodic synthesizer once against an existing isolated-runtime session.',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runForcedEpisodicSynthesis({
    companionDbPath: options.companionDbPath ?? '',
    sessionsDir: options.sessionsDir ?? '',
    sessionId: options.sessionId ?? '',
    sourceMessageId: options.sourceMessageId,
    transcriptMessageLimit: options.transcriptMessageLimit,
    maxEpisodesPerRun: options.maxEpisodesPerRun,
    maxPriorCandidates: options.maxPriorCandidates,
    gapSplitMinutes: options.gapSplitMinutes,
    maxEntriesPerEpisode: options.maxEntriesPerEpisode,
    allowIsolatedRuntime: options.allowIsolatedRuntime === true ? true : (() => {
      throw new Error('Pass --allow-isolated-runtime to run forced episodic synthesis');
    })(),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : inspect(error));
    process.exitCode = 1;
  });
}
