import {
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { PostgresTenantAccessPlan } from '../../src/persistence/postgres/tenancy.js';
import { writeJsonAtomic } from '../../src/shared/utils/fs.js';
import { isRecord } from '../../src/shared/utils/types.js';
import { resolveCanonicalPathInsideRoot } from '../../src/system/config/companion-workspace-layout.js';
import {
  EXPECTED_PRIMARY_CARD_PATH,
  EXPECTED_SUPPORT_CARD_PATHS,
  EXPECTED_SUPPORT_SCHEMAS,
  PRIMARY_COMPANION_ID,
  SUPPORT_COMPANION_IDS,
  assertSupportFixtureStateMatches,
  buildSupportFixturePlans,
  buildSupportFixtureState,
  loadAndValidateSupportFixtureState,
  loadSupportFixtureContract,
  requireRegularFile,
  resolveSupportFixturePaths,
  sha256Text,
  type SupportFixturePaths,
} from './contract.js';

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
  const { primary, supports } = buildSupportFixturePlans(contract);
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
  writeJsonAtomic(
    paths.statePath,
    buildSupportFixtureState('preparing', paths, contract, input.templatePath),
  );

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
      buildSupportFixtureState('active', paths, contract, input.templatePath),
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
  const expectedActive = buildSupportFixtureState('active', paths, contract, input.templatePath);
  const expectedPreparing = buildSupportFixtureState('preparing', paths, contract, input.templatePath);
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
    ? assertSupportFixtureStateMatches(rawState, expectedActive)
    : loadAndValidateSupportFixtureState(paths, expectedPreparing);
  if (existsSync(paths.manifestPath)) {
    const actualManifestSha256 = sha256Text(readFileSync(paths.manifestPath, 'utf8'));
    if (actualManifestSha256 !== state.manifestSha256) {
      throw new Error('Support fixture manifest does not match the recorded fixture; refusing teardown');
    }
  } else if (state.phase === 'active') {
    throw new Error('Active support fixture manifest is missing; refusing partial teardown');
  }

  const { primary, supports } = buildSupportFixturePlans(contract);
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
