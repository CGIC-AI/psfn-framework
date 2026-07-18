import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { importCharacterCardToPath } from '../src/core/identity/importer.js';
import {
  createPostgresPool,
} from '../src/persistence/postgres.js';
import {
  assertPostgresTenantAccessProvisioned,
  dropPostgresTenantAccess,
  planPostgresTenantAccess,
  provisionPostgresTenantAccess,
  type PostgresTenantAccessPlan,
} from '../src/persistence/postgres/tenancy.js';
import { writeJsonAtomic } from '../src/shared/utils/fs.js';
import { parseBooleanEnv } from '../src/shared/utils/env.js';
import { isRecord } from '../src/shared/utils/types.js';
import {
  validateCompanionsConfig,
  type CompanionsFleetConfig,
} from '../src/system/config/companions-config.js';
import { resolveCanonicalPathInsideRoot } from '../src/system/config/companion-workspace-layout.js';

export const PRIMARY_COMPANION_ID = 'a7100000-0000-4000-8000-000000000001';
export const SUPPORT_COMPANION_IDS = [
  'b7100000-0000-4000-8000-000000000002',
  'c7100000-0000-4000-8000-000000000003',
] as const;

const FIXTURE_STATE_VERSION = 1;
const FIXTURE_STATE_FILENAME = 'shakedown-support-fixtures.json';
const SUPPORT_ROOT_DIRNAME = 'support-companions';
const EXPECTED_PRIMARY_SCHEMA = 'shakedown_artie';
const EXPECTED_SUPPORT_SCHEMAS = [
  'shakedown_support_mica',
  'shakedown_support_lumen',
] as const;
const EXPECTED_PRIMARY_CARD_PATH = 'companion-data/companion.json';
const EXPECTED_SUPPORT_CARD_PATHS = [
  'support-companions/mica/data/companion.json',
  'support-companions/lumen/data/companion.json',
] as const;
const EXPECTED_SUPPORT_DATA_DIRS = [
  'support-companions/mica/data',
  'support-companions/lumen/data',
] as const;

type FixturePhase = 'preparing' | 'active';

interface SupportFixtureState {
  version: typeof FIXTURE_STATE_VERSION;
  phase: FixturePhase;
  runtimeRoot: string;
  systemDataDir: string;
  manifestPath: string;
  supportRoot: string;
  manifestSha256: string;
  templateSha256: string;
  primaryCompanionId: typeof PRIMARY_COMPANION_ID;
  supportCompanions: Array<{
    companionId: (typeof SUPPORT_COMPANION_IDS)[number];
    postgresSchema: (typeof EXPECTED_SUPPORT_SCHEMAS)[number];
    companionDataDir: (typeof EXPECTED_SUPPORT_DATA_DIRS)[number];
    characterCardPath: (typeof EXPECTED_SUPPORT_CARD_PATHS)[number];
  }>;
}

export interface SupportFixturePaths {
  runtimeRoot: string;
  systemDataDir: string;
  manifestPath: string;
  statePath: string;
  supportRoot: string;
}

export interface SupportFixtureDatabasePort {
  assertRoundStopped(): Promise<void>;
  assertProvisioned(plan: PostgresTenantAccessPlan): Promise<void>;
  provision(plan: PostgresTenantAccessPlan): Promise<void>;
  drop(plan: PostgresTenantAccessPlan): Promise<void>;
  assertAbsent(plan: PostgresTenantAccessPlan): Promise<void>;
}

export interface SupportFixtureLifecycleInput {
  runtimeRoot: string;
  systemDataDir: string;
  templatePath: string;
  supportCardSources: ReadonlyMap<string, string>;
  database: SupportFixtureDatabasePort;
  importCard(sourcePath: string, destinationPath: string): void;
}

export interface SupportFixtureLifecycleEvidence {
  status: 'active' | 'clean';
  primaryCompanionId: typeof PRIMARY_COMPANION_ID;
  supportCompanionIds: typeof SUPPORT_COMPANION_IDS;
  supportSchemas: typeof EXPECTED_SUPPORT_SCHEMAS;
  manifestPath: string;
  statePath: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function jsonPayload(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireRegularFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} must be an existing regular file: ${path}`);
  }
}

function requireDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} must be an existing directory: ${path}`);
  }
}

function assertExactFixtureContract(contract: CompanionsFleetConfig): void {
  const expectedIds = [PRIMARY_COMPANION_ID, ...SUPPORT_COMPANION_IDS];
  const actualIds = contract.companions.map(companion => companion.companionId);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(
      `Support fixture template must enumerate the canonical Artie + support identities: ${expectedIds.join(', ')}`,
    );
  }
  const primary = contract.companions[0];
  if (
    !primary
    || primary.postgresSchema !== EXPECTED_PRIMARY_SCHEMA
    || primary.characterCardPath !== EXPECTED_PRIMARY_CARD_PATH
    || primary.companionDataDir !== 'companion-data'
  ) {
    throw new Error('Support fixture template changed the canonical Artie runtime binding');
  }
  for (let index = 0; index < SUPPORT_COMPANION_IDS.length; index += 1) {
    const support = contract.companions[index + 1];
    if (
      !support
      || support.postgresSchema !== EXPECTED_SUPPORT_SCHEMAS[index]
      || support.companionDataDir !== EXPECTED_SUPPORT_DATA_DIRS[index]
      || support.characterCardPath !== EXPECTED_SUPPORT_CARD_PATHS[index]
    ) {
      throw new Error(`Support fixture template changed support companion ${SUPPORT_COMPANION_IDS[index]}`);
    }
  }
}

export function loadSupportFixtureContract(templatePath: string): CompanionsFleetConfig {
  requireRegularFile(templatePath, 'Support fixture template');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(templatePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Support fixture template is not valid JSON: ${templatePath}`, { cause: error });
  }
  const contract = validateCompanionsConfig(raw, templatePath);
  assertExactFixtureContract(contract);
  return contract;
}

export function resolveSupportFixturePaths(
  runtimeRootInput: string,
  systemDataDirInput: string,
): SupportFixturePaths {
  requireDirectory(runtimeRootInput, 'PSFN_RUNTIME_ROOT');
  requireDirectory(systemDataDirInput, 'SYSTEM_DATA_DIR');
  const runtimeRoot = realpathSync(runtimeRootInput);
  const systemDataDir = realpathSync(systemDataDirInput);
  const canonicalSystemDataDir = resolveCanonicalPathInsideRoot(
    systemDataDir,
    runtimeRoot,
    'SYSTEM_DATA_DIR',
  );
  if (canonicalSystemDataDir !== systemDataDir) {
    throw new Error('SYSTEM_DATA_DIR must resolve canonically inside PSFN_RUNTIME_ROOT');
  }
  const supportRoot = resolveCanonicalPathInsideRoot(
    join(runtimeRoot, SUPPORT_ROOT_DIRNAME),
    runtimeRoot,
    'support fixture root',
  );
  return {
    runtimeRoot,
    systemDataDir,
    manifestPath: join(systemDataDir, 'companions.json'),
    statePath: join(systemDataDir, 'state', FIXTURE_STATE_FILENAME),
    supportRoot,
  };
}

function buildPlans(contract: CompanionsFleetConfig): {
  primary: PostgresTenantAccessPlan;
  supports: PostgresTenantAccessPlan[];
} {
  const [primary, ...supports] = contract.companions.map(companion => (
    planPostgresTenantAccess({
      schema: companion.postgresSchema,
      approvedSharedSchema: 'shared',
      approvedSharedAccess: 'read_write',
    })
  ));
  if (!primary || supports.length !== SUPPORT_COMPANION_IDS.length) {
    throw new Error('Support fixture contract did not produce the expected tenant plan');
  }
  return { primary, supports };
}

function buildState(
  phase: FixturePhase,
  paths: SupportFixturePaths,
  contract: CompanionsFleetConfig,
  templatePath: string,
): SupportFixtureState {
  return {
    version: FIXTURE_STATE_VERSION,
    phase,
    runtimeRoot: paths.runtimeRoot,
    systemDataDir: paths.systemDataDir,
    manifestPath: paths.manifestPath,
    supportRoot: paths.supportRoot,
    manifestSha256: sha256(jsonPayload(contract)),
    templateSha256: sha256(readFileSync(templatePath, 'utf8')),
    primaryCompanionId: PRIMARY_COMPANION_ID,
    supportCompanions: SUPPORT_COMPANION_IDS.map((companionId, index) => ({
      companionId,
      postgresSchema: EXPECTED_SUPPORT_SCHEMAS[index]!,
      companionDataDir: EXPECTED_SUPPORT_DATA_DIRS[index]!,
      characterCardPath: EXPECTED_SUPPORT_CARD_PATHS[index]!,
    })),
  };
}

function assertStateMatches(
  raw: unknown,
  expected: SupportFixtureState,
): SupportFixtureState {
  if (!isRecord(raw)) {
    throw new Error('Support fixture state must be a JSON object');
  }
  const serialized = JSON.stringify(raw);
  if (serialized !== JSON.stringify(expected)) {
    throw new Error('Support fixture state does not match the canonical fixture contract');
  }
  return raw as unknown as SupportFixtureState;
}

function loadAndValidateState(
  paths: SupportFixturePaths,
  expected: SupportFixtureState,
): SupportFixtureState {
  requireRegularFile(paths.statePath, 'Support fixture state');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.statePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Support fixture state is not valid JSON: ${paths.statePath}`, { cause: error });
  }
  return assertStateMatches(raw, expected);
}

function assertCleanStart(paths: SupportFixturePaths, primaryCardPath: string): void {
  requireRegularFile(primaryCardPath, 'Artie character card');
  const collisions = [
    paths.manifestPath,
    paths.statePath,
    paths.supportRoot,
  ].filter(existsSync);
  if (collisions.length > 0) {
    throw new Error(
      `Support fixture stand-up requires a clean round; existing fixture paths: ${collisions.join(', ')}`,
    );
  }
}

function removeFixtureFiles(paths: SupportFixturePaths): void {
  if (existsSync(paths.manifestPath)) {
    rmSync(paths.manifestPath);
  }
  if (existsSync(paths.supportRoot)) {
    rmSync(paths.supportRoot, { recursive: true });
  }
}

async function dropSupportPlans(
  database: SupportFixtureDatabasePort,
  supports: readonly PostgresTenantAccessPlan[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const plan of [...supports].reverse()) {
    try {
      await database.drop(plan);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'One or more support-companion tenants could not be removed');
  }
}

async function rollbackFailedStandUp(
  input: SupportFixtureLifecycleInput,
  paths: SupportFixturePaths,
  supports: readonly PostgresTenantAccessPlan[],
  originalError: unknown,
): Promise<never> {
  try {
    await dropSupportPlans(input.database, supports);
    for (const plan of supports) {
      await input.database.assertAbsent(plan);
    }
    removeFixtureFiles(paths);
    if (existsSync(paths.statePath)) {
      rmSync(paths.statePath);
    }
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      'Support fixture stand-up failed and rollback did not remove all fixture state',
    );
  }
  throw originalError;
}

function lifecycleEvidence(
  status: SupportFixtureLifecycleEvidence['status'],
  paths: SupportFixturePaths,
): SupportFixtureLifecycleEvidence {
  return {
    status,
    primaryCompanionId: PRIMARY_COMPANION_ID,
    supportCompanionIds: SUPPORT_COMPANION_IDS,
    supportSchemas: EXPECTED_SUPPORT_SCHEMAS,
    manifestPath: paths.manifestPath,
    statePath: paths.statePath,
  };
}

export async function standUpSupportFixtures(
  input: SupportFixtureLifecycleInput,
): Promise<SupportFixtureLifecycleEvidence> {
  const contract = loadSupportFixtureContract(input.templatePath);
  const paths = resolveSupportFixturePaths(input.runtimeRoot, input.systemDataDir);
  const { primary, supports } = buildPlans(contract);
  const primaryCardPath = resolveCanonicalPathInsideRoot(
    join(paths.runtimeRoot, EXPECTED_PRIMARY_CARD_PATH),
    paths.runtimeRoot,
    'Artie character card',
  );
  assertCleanStart(paths, primaryCardPath);
  for (const companionId of SUPPORT_COMPANION_IDS) {
    const sourcePath = input.supportCardSources.get(companionId);
    if (!sourcePath) {
      throw new Error(`Missing source card for support companion ${companionId}`);
    }
    requireRegularFile(sourcePath, `Source card for support companion ${companionId}`);
  }

  await input.database.assertRoundStopped();
  await input.database.assertProvisioned(primary);
  const preparingState = buildState('preparing', paths, contract, input.templatePath);
  writeJsonAtomic(paths.statePath, preparingState);

  try {
    for (let index = 0; index < SUPPORT_COMPANION_IDS.length; index += 1) {
      const sourcePath = input.supportCardSources.get(SUPPORT_COMPANION_IDS[index]!)!;
      const destinationPath = resolveCanonicalPathInsideRoot(
        join(paths.runtimeRoot, EXPECTED_SUPPORT_CARD_PATHS[index]!),
        paths.runtimeRoot,
        `support card ${SUPPORT_COMPANION_IDS[index]}`,
      );
      if (!destinationPath.startsWith(`${paths.supportRoot}/`)) {
        throw new Error(`Support card destination escaped the fixture root: ${destinationPath}`);
      }
      input.importCard(sourcePath, destinationPath);
    }
    for (const plan of supports) {
      await input.database.provision(plan);
    }
    for (const plan of supports) {
      await input.database.assertProvisioned(plan);
    }
    writeJsonAtomic(paths.manifestPath, contract);
    writeJsonAtomic(
      paths.statePath,
      buildState('active', paths, contract, input.templatePath),
    );
    return lifecycleEvidence('active', paths);
  } catch (error) {
    return rollbackFailedStandUp(input, paths, supports, error);
  }
}

export async function tearDownSupportFixtures(
  input: SupportFixtureLifecycleInput,
): Promise<SupportFixtureLifecycleEvidence> {
  const contract = loadSupportFixtureContract(input.templatePath);
  const paths = resolveSupportFixturePaths(input.runtimeRoot, input.systemDataDir);
  const expectedActive = buildState('active', paths, contract, input.templatePath);
  const expectedPreparing = buildState('preparing', paths, contract, input.templatePath);
  let rawState: unknown;
  try {
    rawState = JSON.parse(readFileSync(paths.statePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Support fixture teardown requires valid state at ${paths.statePath}`, {
      cause: error,
    });
  }
  const phase = isRecord(rawState) ? rawState.phase : undefined;
  const state = phase === 'active'
    ? assertStateMatches(rawState, expectedActive)
    : loadAndValidateState(paths, expectedPreparing);
  if (existsSync(paths.manifestPath)) {
    const actualManifestSha256 = sha256(readFileSync(paths.manifestPath, 'utf8'));
    if (actualManifestSha256 !== state.manifestSha256) {
      throw new Error('Support fixture manifest does not match the recorded fixture; refusing teardown');
    }
  } else if (state.phase === 'active') {
    throw new Error('Active support fixture manifest is missing; refusing partial teardown');
  }

  const { primary, supports } = buildPlans(contract);
  await input.database.assertRoundStopped();
  await input.database.assertProvisioned(primary);
  await dropSupportPlans(input.database, supports);
  for (const plan of supports) {
    await input.database.assertAbsent(plan);
  }
  await input.database.assertProvisioned(primary);

  removeFixtureFiles(paths);
  if (existsSync(paths.manifestPath) || existsSync(paths.supportRoot)) {
    throw new Error('Support fixture filesystem residue remained after teardown');
  }
  rmSync(paths.statePath);
  if (existsSync(paths.statePath)) {
    throw new Error('Support fixture state record remained after teardown');
  }
  return lifecycleEvidence('clean', paths);
}

class PostgresSupportFixtureDatabase implements SupportFixtureDatabasePort {
  constructor(
    private readonly pool: Pool,
    private readonly runtimeLoginRole: string,
  ) {}

  async assertRoundStopped(): Promise<void> {
    const result = await this.pool.query<{
      application_name: string;
      pid: number;
    }>(`
      SELECT pid, application_name
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
      ORDER BY pid
    `);
    if (result.rows.length > 0) {
      const sessions = result.rows
        .map(row => `${row.application_name || 'unnamed'}:${row.pid}`)
        .join(', ');
      throw new Error(
        `The shakedown round database still has runtime sessions (${sessions}); `
        + 'stop the split runtime before support-fixture stand-up or teardown',
      );
    }
  }

  async assertProvisioned(plan: PostgresTenantAccessPlan): Promise<void> {
    await assertPostgresTenantAccessProvisioned(this.pool, plan);
  }

  async provision(plan: PostgresTenantAccessPlan): Promise<void> {
    await provisionPostgresTenantAccess(this.pool, {
      plan,
      runtimeLoginRole: this.runtimeLoginRole,
    });
  }

  async drop(plan: PostgresTenantAccessPlan): Promise<void> {
    await dropPostgresTenantAccess({
      pool: this.pool,
      plan,
      runtimeLoginRole: this.runtimeLoginRole,
      dropRole: true,
    });
  }

  async assertAbsent(plan: PostgresTenantAccessPlan): Promise<void> {
    const result = await this.pool.query<{ role_exists: boolean; schema_exists: boolean }>(`
      SELECT
        to_regnamespace($1) IS NOT NULL AS schema_exists,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists
    `, [plan.schema, plan.role]);
    if (result.rows[0]?.schema_exists || result.rows[0]?.role_exists) {
      throw new Error(`Support PostgreSQL tenant ${plan.schema} still exists after teardown`);
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Source the shakedown env before managing support fixtures.`,
    );
  }
  return value;
}

function assertCliEnvironment(): {
  databaseUrl: string;
  runtimeRoot: string;
  systemDataDir: string;
} {
  const multiCompanion = parseBooleanEnv(process.env.PSFN_MULTI_COMPANION);
  if (multiCompanion !== true) {
    throw new Error('PSFN_MULTI_COMPANION must be explicitly enabled before managing support fixtures');
  }
  const companionId = requireEnv('COMPANION_ID');
  if (companionId !== PRIMARY_COMPANION_ID) {
    throw new Error(`COMPANION_ID must be the canonical Artie fixture id ${PRIMARY_COMPANION_ID}`);
  }
  return {
    databaseUrl: requireEnv('POSTGRES_DATABASE_URL'),
    runtimeRoot: requireEnv('PSFN_RUNTIME_ROOT'),
    systemDataDir: requireEnv('SYSTEM_DATA_DIR'),
  };
}

async function createPostgresDatabasePort(
  databaseUrl: string,
): Promise<{ database: SupportFixtureDatabasePort; close(): Promise<void> }> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-shakedown-support-fixtures',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    const runtimeLoginRole = result.rows[0]?.current_user;
    if (!runtimeLoginRole) {
      throw new Error('Could not resolve the PostgreSQL runtime login role');
    }
    return {
      database: new PostgresSupportFixtureDatabase(pool, runtimeLoginRole),
      close: async () => pool.end(),
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'stand-up' && command !== 'tear-down') {
    throw new Error('Usage: npm run shakedown:support -- <stand-up|tear-down>');
  }
  const env = assertCliEnvironment();
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
  const postgres = await createPostgresDatabasePort(env.databaseUrl);
  try {
    const input: SupportFixtureLifecycleInput = {
      runtimeRoot: env.runtimeRoot,
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
