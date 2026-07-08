import '../../shared/utils/load-dotenv.js';
import { inspect } from 'node:util';
import type { QueryResultRow } from 'pg';
import { SessionStore } from '../../persistence/sessions/store.js';
import {
  createPostgresEpisodicStore,
  EpisodicSynthesizer,
  type EpisodicSynthesisOptions,
  type EpisodicSynthesisRunResult,
} from '../../faculties/memory/episodic/index.js';
import { createPostgresPool, queryOne } from '../../persistence/postgres.js';
import { loadConfig } from '../../system/config/load-config.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { applyGatewayTlsConfig } from '../../boundary/gateway/tls.js';

export interface ForcedEpisodicSynthesisInput extends EpisodicSynthesisOptions {
  postgresDatabaseUrl: string;
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

interface EpisodeCountRow extends QueryResultRow {
  count?: number | string;
}

async function countEpisodes(postgresDatabaseUrl: string): Promise<number> {
  const pool = createPostgresPool(postgresDatabaseUrl, {
    applicationName: 'psfn-force-episodic-synthesis-count',
    allowExitOnIdle: true,
  });
  try {
    const row = await queryOne<EpisodeCountRow>(pool, 'SELECT count(*) AS count FROM l01_episodes');
    return Number(row?.count ?? 0);
  } finally {
    await pool.end();
  }
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

  const postgresDatabaseUrl = requiredText(input.postgresDatabaseUrl, 'postgresDatabaseUrl');
  const sessionsDir = requiredText(input.sessionsDir, 'sessionsDir');
  const sessionId = requiredText(input.sessionId, 'sessionId');

  const episodicStore = createPostgresEpisodicStore(postgresDatabaseUrl);
  const sessionStore = new SessionStore(sessionsDir);
  const beforeEpisodeCount = await countEpisodes(postgresDatabaseUrl);
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
  const afterEpisodeCount = await countEpisodes(postgresDatabaseUrl);

  return {
    ...result,
    sessionId,
    beforeEpisodeCount,
    afterEpisodeCount,
  };
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
      case '--postgres-url':
        options.postgresDatabaseUrl = next();
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
    '  --postgres-url <url> --sessions-dir <path> --session-id <channelId>',
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
  const config = loadConfig();
  applyGatewayTlsConfig({
    caPath: config.gatewayTlsCaPath,
    rejectUnauthorized: config.gatewayTlsRejectUnauthorized,
  });
  await hydrateSecretBearingConfig(config, { env: process.env });
  const result = await runForcedEpisodicSynthesis({
    postgresDatabaseUrl: options.postgresDatabaseUrl ?? config.postgresDatabaseUrl ?? '',
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
