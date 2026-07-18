import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  planPostgresTenantAccess,
  type PostgresTenantAccessPlan,
} from '../../src/persistence/postgres/tenancy.js';
import { isRecord } from '../../src/shared/utils/types.js';
import {
  validateCompanionsConfig,
  type CompanionsFleetConfig,
} from '../../src/system/config/companions-config.js';
import { resolveCanonicalPathInsideRoot } from '../../src/system/config/companion-workspace-layout.js';

export const PRIMARY_COMPANION_ID = 'a7100000-0000-4000-8000-000000000001';
export const SUPPORT_COMPANION_IDS = [
  'b7100000-0000-4000-8000-000000000002',
  'c7100000-0000-4000-8000-000000000003',
] as const;

const FIXTURE_STATE_VERSION = 1;
const FIXTURE_STATE_FILENAME = 'shakedown-support-fixtures.json';
const SUPPORT_ROOT_DIRNAME = 'support-companions';
export const EXPECTED_PRIMARY_SCHEMA = 'shakedown_artie';
export const EXPECTED_SUPPORT_SCHEMAS = [
  'shakedown_support_mica',
  'shakedown_support_lumen',
] as const;
export const EXPECTED_PRIMARY_CARD_PATH = 'companion-data/companion.json';
export const EXPECTED_SUPPORT_CARD_PATHS = [
  'support-companions/mica/data/companion.json',
  'support-companions/lumen/data/companion.json',
] as const;
const EXPECTED_SUPPORT_DATA_DIRS = [
  'support-companions/mica/data',
  'support-companions/lumen/data',
] as const;

export type FixturePhase = 'preparing' | 'active';

export interface SupportFixtureState {
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

export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function jsonPayload(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function requireRegularFile(path: string, label: string): void {
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

export function buildSupportFixturePlans(contract: CompanionsFleetConfig): {
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

export function buildSupportFixtureState(
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
    manifestSha256: sha256Text(jsonPayload(contract)),
    templateSha256: sha256Text(readFileSync(templatePath, 'utf8')),
    primaryCompanionId: PRIMARY_COMPANION_ID,
    supportCompanions: SUPPORT_COMPANION_IDS.map((companionId, index) => ({
      companionId,
      postgresSchema: EXPECTED_SUPPORT_SCHEMAS[index]!,
      companionDataDir: EXPECTED_SUPPORT_DATA_DIRS[index]!,
      characterCardPath: EXPECTED_SUPPORT_CARD_PATHS[index]!,
    })),
  };
}

export function assertSupportFixtureStateMatches(
  raw: unknown,
  expected: SupportFixtureState,
): SupportFixtureState {
  if (!isRecord(raw)) {
    throw new Error('Support fixture state must be a JSON object');
  }
  if (JSON.stringify(raw) !== JSON.stringify(expected)) {
    throw new Error('Support fixture state does not match the canonical fixture contract');
  }
  return raw as unknown as SupportFixtureState;
}

export function loadAndValidateSupportFixtureState(
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
  return assertSupportFixtureStateMatches(raw, expected);
}
