import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCharacterCardToPath } from '../src/core/identity/importer.js';
import { parseBooleanEnv } from '../src/shared/utils/env.js';
import {
  PRIMARY_COMPANION_ID,
  SUPPORT_COMPANION_IDS,
} from './shakedown-support-fixtures/contract.js';
import {
  standUpSupportFixtures,
  tearDownSupportFixtures,
  type SupportFixtureLifecycleInput,
} from './shakedown-support-fixtures/lifecycle.js';
import { createPostgresSupportFixtureDatabase } from './shakedown-support-fixtures/postgres.js';

export {
  PRIMARY_COMPANION_ID,
  SUPPORT_COMPANION_IDS,
  loadSupportFixtureContract,
  resolveSupportFixturePaths,
} from './shakedown-support-fixtures/contract.js';
export {
  standUpSupportFixtures,
  tearDownSupportFixtures,
  type SupportFixtureDatabasePort,
  type SupportFixtureLifecycleEvidence,
  type SupportFixtureLifecycleInput,
} from './shakedown-support-fixtures/lifecycle.js';

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Source the shakedown env before managing support fixtures.`,
    );
  }
  return value;
}

export function resolveSupportFixtureCliEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): {
  databaseUrl: string;
  runtimeRoot: string;
  systemDataDir: string;
} {
  const multiCompanion = parseBooleanEnv(environment.PSFN_MULTI_COMPANION);
  if (multiCompanion !== true) {
    throw new Error('PSFN_MULTI_COMPANION must be explicitly enabled before managing support fixtures');
  }
  const companionId = requireEnv(environment, 'COMPANION_ID');
  if (companionId !== PRIMARY_COMPANION_ID) {
    throw new Error(`COMPANION_ID must be the canonical Artie fixture id ${PRIMARY_COMPANION_ID}`);
  }
  const shakedownRoot = requireEnv(environment, 'PSFN_SHAKEDOWN_ROOT');
  const runtimeRoot = environment.PSFN_RUNTIME_ROOT?.trim();
  if (runtimeRoot && resolve(shakedownRoot) !== resolve(runtimeRoot)) {
    throw new Error('PSFN_SHAKEDOWN_ROOT and PSFN_RUNTIME_ROOT must resolve to the same round root');
  }
  return {
    databaseUrl: requireEnv(environment, 'POSTGRES_DATABASE_URL'),
    runtimeRoot: shakedownRoot,
    systemDataDir: requireEnv(environment, 'SYSTEM_DATA_DIR'),
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'stand-up' && command !== 'tear-down') {
    throw new Error('Usage: npm run shakedown:support -- <stand-up|tear-down>');
  }
  const env = resolveSupportFixtureCliEnvironment();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const templatePath = join(repoRoot, 'shakedown', 'support', 'companions.template.json');
  const supportCardSources = new Map<string, string>([
    [
      SUPPORT_COMPANION_IDS[0],
      join(repoRoot, 'shakedown', 'support', 'cards', 'mica.json'),
    ],
    [
      SUPPORT_COMPANION_IDS[1],
      join(repoRoot, 'shakedown', 'support', 'cards', 'lumen.json'),
    ],
  ]);
  const postgres = await createPostgresSupportFixtureDatabase(env.databaseUrl);
  try {
    const input: SupportFixtureLifecycleInput = {
      runtimeRoot: env.runtimeRoot,
      seedDir: join(repoRoot, 'config'),
      systemDataDir: env.systemDataDir,
      templatePath,
      supportCardSources,
      database: postgres.database,
      importCard(sourcePath, destinationPath) {
        importCharacterCardToPath(sourcePath, destinationPath);
      },
    };
    const evidence = command === 'stand-up'
      ? await standUpSupportFixtures(input)
      : await tearDownSupportFixtures(input);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await postgres.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[shakedown-support-fixtures] ${message}\n`);
    process.exitCode = 1;
  });
}
