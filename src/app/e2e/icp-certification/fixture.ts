import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { deriveCompanionAuthToken } from '../../../boundary/gateway/companion-auth.js';
import { createBootstrapStarterCard } from '../../../core/identity/loader.js';
import { isRecord } from '../../../shared/utils/types.js';
import { PER_COMPANION_OWNER_FILES } from '../../../system/config/settings-contract.js';
import { seedCompanionStartupOwnerFiles } from '../../../system/config/startup-owner-files.js';
import { DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG, DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG } from '../../../system/config/scheduler-config.js';
import {
  resolveCompanionAdminTransportSocketPath,
} from '../../../operator/garden/transport-paths.js';
import {
  CERTIFICATION_COMPANION_A,
  CERTIFICATION_COMPANION_B,
  CERTIFICATION_EMBEDDING_DIMS,
  CERTIFICATION_ROLE_A,
  CERTIFICATION_ROLE_B,
  CERTIFICATION_SCHEMA_A,
  CERTIFICATION_SCHEMA_B,
  CERTIFICATION_SESSION_KEYRING,
} from './constants.js';
import {
  loadSupportFixtureContract,
  SUPPORT_COMPANION_IDS,
} from '../../../../scripts/shakedown-support-fixtures/contract.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SUPPORT_FIXTURE_TEMPLATE_PATH = join(
  REPO_ROOT,
  'shakedown',
  'support',
  'companions.template.json',
);
const OWNER_NAMES = [
  'backup',
  'capability-tier',
  'charge-policy',
  'intake-policy',
  'models',
  'providers',
  'scheduler',
  'settings',
  'skills',
  'trust-policy',
] as const;

export interface IcpCertificationCompanionFixture {
  companionId: string;
  companionDataDir: string;
  characterCardPath: string;
  env: NodeJS.ProcessEnv;
  name: string;
  postgresSchema: string;
  /** Configured tenant owner role the agent runtime asserts (from companions.json). */
  postgresRole: string;
  workspacePath: string;
}

export interface IcpCertificationFixture {
  artifactsPath: string;
  companions: readonly [IcpCertificationCompanionFixture, IcpCertificationCompanionFixture];
  gatewaySocketPath: string;
  rootDir: string;
  runtimeRoot: string;
  systemDataDir: string;
  topology: 'multi_companion' | 'single_companion';
  cleanup(): void;
}

export type IcpCertificationCostProfile =
  | 'permissive'
  | 'lowered_warning'
  | 'lowered_hard'
  | 'missing';
export type IcpCertificationFatigueProfile = 'default' | 'final_reserve' | 'room_continuity';

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function setIcpCertificationAutonomyEnabled(
  fixture: Pick<IcpCertificationFixture, 'companions'>,
  enabled: boolean,
): void {
  for (const { companionDataDir: dir } of fixture.companions) {
    const schedulerPath = join(dir, 'scheduler.json');
    const scheduler = readJson(schedulerPath);
    const icpAutonomy = scheduler.icpAutonomy;
    if (!isRecord(icpAutonomy)) {
      throw new Error('Certification scheduler owner is missing icpAutonomy');
    }
    icpAutonomy.enabled = enabled;
    writeJson(schedulerPath, scheduler);
  }
}

function copyCanonicalOwners(seedDir: string, systemDataDir: string): void {
  for (const owner of [...OWNER_NAMES, 'mcp-servers', 'partner-affect-shadow'] as const) {
    const ownerFile = `${owner}.json`;
    if (!PER_COMPANION_OWNER_FILES.has(ownerFile)) {
      cpSync(join(seedDir, `${owner}.seed.json`), join(systemDataDir, ownerFile));
    }
  }
}

function configureSystemOwnerFiles(systemDataDir: string): void {
  const settingsPath = join(systemDataDir, 'settings.json');
  const settings = readJson(settingsPath);
  settings.extractionInterval = 1;
  settings.extractionThresholdPct = 10;
  settings.compactionThresholdPct = 30;
  settings.sessionHistoryBudgetPct = 2;
  settings.memoryRetrievalBudgetPct = 2;
  settings.embeddingDims = CERTIFICATION_EMBEDDING_DIMS;
  writeJson(settingsPath, settings);

  const modelsPath = join(systemDataDir, 'models.json');
  const models = readJson(modelsPath);
  const primaryModel = (models.models as Array<Record<string, unknown>>).find(
    model => model.id === 'primary',
  );
  if (!primaryModel) throw new Error('Certification model owner requires the primary model');
  primaryModel.capabilities = {
    ...(primaryModel.capabilities as Record<string, unknown>),
    maxOutputTokens: 1_024,
    contextWindow: 4_096,
  };
  primaryModel.tuning = {
    ...(primaryModel.tuning as Record<string, unknown>),
    maxOutputTokens: 1_024,
  };
  writeJson(modelsPath, models);

  const places = readJson(join('config', 'places.seed.json'));
  places.sites = [{ siteId: 'certification', displayName: 'Certification', kind: 'virtual' }];
  places.places = [{
    placeId: 'certification_private_room',
    siteId: 'certification',
    displayName: 'Certification Private Room',
    kind: 'virtual',
    privacy: 'private',
    affordances: [],
  }];
  writeJson(join(systemDataDir, 'places.json'), places);
}

function configureCompanionOwnerFiles(
  companionDataDir: string,
  autonomyEnabled: boolean,
  fatigueProfile: IcpCertificationFatigueProfile,
): void {
  const schedulerPath = join(companionDataDir, 'scheduler.json');
  const scheduler = readJson(schedulerPath);
  scheduler.icpAutonomy = {
    enabled: autonomyEnabled,
    candidate: {
      defaultTtlMs: 120_000,
      retryCadenceMs: 50,
      maxRetryAttempts: 3,
    },
    permit: { ttlMs: 60_000 },
    availability: { operatorLeaseTtlMs: 120_000 },
    policyHolds: { ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG.policyHolds },
  };
  scheduler.weightedThoughtOutreach = {
    ...(scheduler.weightedThoughtOutreach as Record<string, unknown>),
    enabled: true,
    checkIntervalMs: 1_000,
    nudgeThreshold: 0.1,
    maxNudgesPerRun: 1,
  };
  scheduler.episodicProcessing = {
    enabled: false,
    startLocalTime: '00:00',
    endLocalTime: '23:59',
    timeZone: 'UTC',
    inactivityThresholdMinutes: 60,
  };
  scheduler.backgroundWorkWelfare = { ...DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG };
  writeJson(schedulerPath, scheduler);
  const capabilityPath = join(companionDataDir, 'capability-tier.json');
  writeJson(capabilityPath, { tier: 'autonomous', customTokens: [] });

  const chargePath = join(companionDataDir, 'charge-policy.json');
  const charge = readJson(chargePath);
  charge.runChargeQuotaByLane = {
    ...(charge.runChargeQuotaByLane as Record<string, unknown>),
    companion_social: fatigueProfile === 'room_continuity' ? 20 : 4,
  };
  charge.icpCostBreaker = {
    enabled: true,
    warningThresholdUsd: 0.0003,
    hardLimitUsd: 0.0004,
    finalCloseoutReserveUsd: 0.0001,
    pendingReservationStaleAfterMs: 60_000,
    includedCostPurposes: {
      conversation_turn: true,
      tool: true,
      summary: true,
      extraction: true,
      sidecar: true,
    },
  };
  const fatigue = charge.fatigue as Record<string, unknown>;
  fatigue.relationshipBudgets = {
    ...(fatigue.relationshipBudgets as Record<string, unknown>),
    trusted_collaborator_mi: fatigueProfile === 'final_reserve'
      ? { softTarget: 1, hardCap: 1 }
      : fatigueProfile === 'room_continuity'
        ? { softTarget: 12, hardCap: 16 }
        : { softTarget: 2, hardCap: 3 },
  };
  if (fatigueProfile === 'final_reserve') {
    fatigue.overcharge = {
      ...(fatigue.overcharge as Record<string, unknown>),
      reserveResponses: 1,
    };
  }
  writeJson(chargePath, charge);
}

function makeCompanion(input: {
  authSocketDir: string;
  characterCardPath: string;
  characterCardSourcePath?: string;
  companionDataDir: string;
  companionId: string;
  configDir: string;
  databaseUrl: string;
  gatewaySocketPath: string;
  name: string;
  postgresSchema: string;
  postgresRole: string;
  runtimeRoot: string;
  systemDataDir: string;
  workspacePath: string;
}): IcpCertificationCompanionFixture {
  const characterCardPath = input.characterCardPath;
  const postgresCredentialPath = join(
    input.authSocketDir,
    `postgres-${input.companionId}.url`,
  );
  if (input.characterCardSourcePath) {
    cpSync(input.characterCardSourcePath, characterCardPath);
  } else {
    writeJson(characterCardPath, createBootstrapStarterCard(input.name));
  }
  writeFileSync(postgresCredentialPath, `${input.databaseUrl}\n`, { encoding: 'utf8', mode: 0o600 });
  mkdirSync(input.workspacePath, { recursive: true });
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PSFN_RUNTIME_LAYOUT_MODE: 'production',
    PSFN_RUNTIME_ROOT: input.runtimeRoot,
    SYSTEM_DATA_DIR: input.systemDataDir,
    COMPANION_DATA_DIR: input.companionDataDir,
    WORKSPACE_PATH: input.workspacePath,
    PSFN_LOGS_DIR: join(dirname(input.runtimeRoot), `logs-${input.companionId}`),
    PSFN_TEMP_DIR: join(dirname(input.runtimeRoot), `tmp-${input.companionId}`),
    BACKUP_ROOT_DIR: join(dirname(input.runtimeRoot), `backups-${input.companionId}`),
    PSFN_BACKUP_ENCRYPTION_KEY: 'icp-certification-backup-key-not-for-production',
    CONFIG_DIR: input.configDir,
    PERSISTENCE_BACKEND: 'postgres',
    POSTGRES_DATABASE_URL_FILE: postgresCredentialPath,
    COMPANION_ID: input.companionId,
    COMPANION_PG_SCHEMA: input.postgresSchema,
    CHARACTER_CARD_PATH: characterCardPath,
    GATEWAY_SOCKET: input.gatewaySocketPath,
    GATEWAY_COMPANION_AUTH_TOKEN: deriveCompanionAuthToken(
      input.companionId,
      'agent',
      CERTIFICATION_SESSION_KEYRING,
    ),
    GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN: deriveCompanionAuthToken(
      input.companionId,
      'internal_session_integrity',
      CERTIFICATION_SESSION_KEYRING,
    ),
    DISCORD_ENABLED: 'false',
    TELEGRAM_ENABLED: 'false',
    OBSERVER_EVAL_SIDECAR_ENABLED: 'false',
  };
  delete baseEnv.POSTGRES_DATABASE_URL;
  delete baseEnv.POSTGRES_DATABASE_URL_FD;
  baseEnv.ADMIN_TRANSPORT_SOCKET = resolveCompanionAdminTransportSocketPath(
    input.companionId,
    { ...baseEnv, ADMIN_TRANSPORT_SOCKET: join(input.authSocketDir, 'garden-admin.sock') },
  );
  return {
    companionId: input.companionId,
    companionDataDir: input.companionDataDir,
    characterCardPath,
    env: baseEnv,
    name: input.name,
    postgresSchema: input.postgresSchema,
    postgresRole: input.postgresRole,
    workspacePath: input.workspacePath,
  };
}

export function createIcpCertificationFixture(input: {
  autonomyEnabled?: boolean;
  databaseUrl: string;
  costProfile?: IcpCertificationCostProfile;
  fatigueProfile?: IcpCertificationFatigueProfile;
  seedDir?: string;
  topology?: 'multi_companion' | 'single_companion';
}): IcpCertificationFixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'psfn-icp-certification-'));
  const runtimeRoot = join(rootDir, 'runtime');
  const systemDataDir = join(runtimeRoot, 'system-data');
  const socketDir = join(rootDir, 'sockets');
  const gatewaySocketPath = join(socketDir, 'gateway.sock');
  const seedDir = resolve(input.seedDir ?? 'config');
  const supportContract = loadSupportFixtureContract(SUPPORT_FIXTURE_TEMPLATE_PATH);
  const companionAContract = supportContract.companions[0]!;
  const companionBContract = supportContract.companions[1]!;
  if (
    companionAContract.companionId !== CERTIFICATION_COMPANION_A
    || companionAContract.postgresSchema !== CERTIFICATION_SCHEMA_A
    || companionAContract.postgresRole !== CERTIFICATION_ROLE_A
    || companionBContract.companionId !== CERTIFICATION_COMPANION_B
    || companionBContract.postgresSchema !== CERTIFICATION_SCHEMA_B
    || companionBContract.postgresRole !== CERTIFICATION_ROLE_B
  ) {
    throw new Error('Canonical support fixture contract drifted from ICP certification identities');
  }
  const companionDataA = join(runtimeRoot, companionAContract.companionDataDir);
  const companionDataB = join(runtimeRoot, companionBContract.companionDataDir);
  mkdirSync(systemDataDir, { recursive: true });
  mkdirSync(companionDataA, { recursive: true });
  mkdirSync(companionDataB, { recursive: true });
  mkdirSync(socketDir, { recursive: true });
  copyCanonicalOwners(seedDir, systemDataDir);
  configureSystemOwnerFiles(systemDataDir);
  seedCompanionStartupOwnerFiles({ seedDir, companionDataDir: companionDataA });
  seedCompanionStartupOwnerFiles({ seedDir, companionDataDir: companionDataB });
  configureCompanionOwnerFiles(
    companionDataA,
    input.autonomyEnabled ?? true,
    input.fatigueProfile ?? 'default',
  );
  configureCompanionOwnerFiles(
    companionDataB,
    input.autonomyEnabled ?? true,
    input.fatigueProfile ?? 'default',
  );
  for (const support of supportContract.companions.slice(2)) {
    const companionDataDir = join(runtimeRoot, support.companionDataDir);
    mkdirSync(companionDataDir, { recursive: true });
    seedCompanionStartupOwnerFiles({ seedDir, companionDataDir });
    configureCompanionOwnerFiles(
      companionDataDir,
      input.autonomyEnabled ?? true,
      input.fatigueProfile ?? 'default',
    );
    const supportIndex = SUPPORT_COMPANION_IDS.indexOf(
      support.companionId as (typeof SUPPORT_COMPANION_IDS)[number],
    );
    if (supportIndex < 0) {
      throw new Error(`Unsupported companion in canonical fixture contract: ${support.companionId}`);
    }
    cpSync(
      join(
        REPO_ROOT,
        'shakedown',
        'support',
        'cards',
        supportIndex === 0 ? 'mica.json' : 'lumen.json',
      ),
      join(runtimeRoot, support.characterCardPath),
    );
    mkdirSync(
      join(runtimeRoot, 'workspaces', 'personal', support.companionId),
      { recursive: true },
    );
  }
  const modelsPath = join(systemDataDir, 'models.json');
  const models = readJson(modelsPath);
  const modelEntries = models.models as Array<Record<string, unknown>>;
  const primaryModel = modelEntries.find(
    model => model.id === 'primary',
  );
  if (!primaryModel) throw new Error('Certification model owner requires the primary model');
  const costProfile = input.costProfile ?? 'permissive';
  // The room-continuity scenario requires two distinct conversations in the
  // same durable fatigue window. Give chat turns a small deterministic cost so
  // the production per-conversation breaker closes each exchange before the
  // first one can exhaust relationship pressure and correctly block the next.
  const boundedRoomContinuity = input.fatigueProfile === 'room_continuity'
    && costProfile === 'permissive';
  if (costProfile !== 'missing') {
    for (const model of modelEntries) {
      const chatCapable = (model.purposes as Array<{ purpose?: unknown }>).some(
        purpose => purpose.purpose === 'chat',
      );
      let outputPer1MUsd = 0;
      if (chatCapable) {
        if (costProfile === 'lowered_hard') outputPer1MUsd = 20;
        else if (costProfile === 'lowered_warning') outputPer1MUsd = 10;
        else if (boundedRoomContinuity) outputPer1MUsd = 10;
      }
      model.cost = {
        inputPer1MUsd: 0,
        outputPer1MUsd,
        cacheReadPer1MUsd: 0,
        cacheWritePer1MUsd: 0,
        currency: 'USD',
      };
      if (chatCapable && (costProfile !== 'permissive' || boundedRoomContinuity)) {
        model.capabilities = {
          ...(model.capabilities as Record<string, unknown>),
          maxOutputTokens: 10,
        };
        model.tuning = {
          ...(model.tuning as Record<string, unknown>),
          maxOutputTokens: 10,
        };
      }
    }
  }
  writeJson(modelsPath, models);

  if (costProfile === 'lowered_warning' || costProfile === 'lowered_hard') {
    // The recipient (companion B) owns the lowered boundary. Companion A keeps
    // the permissive baseline so the certification proves identity-bound
    // resolution rather than two identical policies producing different cost.
    const chargePath = join(companionDataB, 'charge-policy.json');
    const charge = readJson(chargePath);
    charge.icpCostBreaker = costProfile === 'lowered_hard'
      ? {
          enabled: true,
          warningThresholdUsd: 0.00015,
          hardLimitUsd: 0.0002,
          finalCloseoutReserveUsd: 0.00005,
          pendingReservationStaleAfterMs: 60_000,
          includedCostPurposes: {
            conversation_turn: true,
            tool: true,
            summary: true,
            extraction: true,
            sidecar: true,
          },
        }
      : {
          enabled: true,
          warningThresholdUsd: 0.0001,
          hardLimitUsd: 0.0003,
          finalCloseoutReserveUsd: 0.0002,
          pendingReservationStaleAfterMs: 60_000,
          includedCostPurposes: {
            conversation_turn: true,
            tool: true,
            summary: true,
            extraction: true,
            sidecar: true,
          },
        };
    writeJson(chargePath, charge);
  }
  writeJson(join(systemDataDir, 'companions.json'), supportContract);

  const companions = [
    makeCompanion({
      authSocketDir: socketDir,
      characterCardPath: join(runtimeRoot, companionAContract.characterCardPath),
      companionDataDir: companionDataA,
      companionId: CERTIFICATION_COMPANION_A,
      configDir: seedDir,
      databaseUrl: input.databaseUrl,
      gatewaySocketPath,
      name: companionAContract.displayName ?? 'ARTEMIS',
      postgresSchema: CERTIFICATION_SCHEMA_A,
      postgresRole: companionAContract.postgresRole,
      runtimeRoot,
      systemDataDir,
      workspacePath: join(runtimeRoot, 'workspaces', 'personal', CERTIFICATION_COMPANION_A),
    }),
    makeCompanion({
      authSocketDir: socketDir,
      characterCardPath: join(runtimeRoot, companionBContract.characterCardPath),
      characterCardSourcePath: join(
        REPO_ROOT,
        'shakedown',
        'support',
        'cards',
        'mica.json',
      ),
      companionDataDir: companionDataB,
      companionId: CERTIFICATION_COMPANION_B,
      configDir: seedDir,
      databaseUrl: input.databaseUrl,
      gatewaySocketPath,
      name: companionBContract.displayName ?? 'Mica',
      postgresSchema: CERTIFICATION_SCHEMA_B,
      postgresRole: companionBContract.postgresRole,
      runtimeRoot,
      systemDataDir,
      workspacePath: join(runtimeRoot, 'workspaces', 'personal', CERTIFICATION_COMPANION_B),
    }),
  ] as const;
  const topology = input.topology ?? 'multi_companion';
  if (topology === 'single_companion') {
    delete companions[0].env.COMPANION_PG_SCHEMA;
    // Single-companion topology is a one-entry fleet: the manifest is still
    // mandatory, but a lone entry makes multiCompanion derive false (behavior
    // identical to the old single-companion topology).
    writeJson(join(systemDataDir, 'companions.json'), {
      postgres: supportContract.postgres,
      companions: [supportContract.companions[0]],
    });
  }

  const artifactsPath = join(rootDir, 'artifacts', 'certification.jsonl');
  let cleaned = false;
  return {
    artifactsPath,
    companions,
    gatewaySocketPath,
    rootDir,
    runtimeRoot,
    systemDataDir,
    topology,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

export function configureIcpCertificationModelEndpoint(
  fixture: IcpCertificationFixture,
  baseUrl: string,
): void {
  const modelsPath = join(fixture.systemDataDir, 'models.json');
  const models = readJson(modelsPath);
  for (const model of models.models as Array<Record<string, unknown>>) {
    const identity = model.identity as Record<string, unknown>;
    identity.source = {
      ...(identity.source as Record<string, unknown>),
      baseUrl,
    };
  }
  writeJson(modelsPath, models);
}
