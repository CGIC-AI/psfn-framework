import type { Pool } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchemaWithAdvisoryLock,
} from '../postgres.js';
import {
  POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK,
  POSTGRES_MODEL_USAGE_MIGRATIONS,
} from './migrations.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  FleetModelUsageQuery,
  FleetModelUsageSummary,
  FleetModelUsageSummaryQueryPort,
  IcpConversationCostAccountingPort,
  IcpConversationCostProjection,
  IcpConversationCostProjectionQuery,
  IcpConversationCostReservationInput,
  IcpConversationCostReservationResult,
  ModelUsageBudgetQueryPort,
  ModelUsageBudgetSpendSnapshot,
  ModelUsageCostHydrationData,
  ModelUsageCostHydrationQueryPort,
  ModelUsageData,
  ModelUsageEvent,
  ModelUsageEventInput,
  ModelUsageExportData,
  ModelUsageExportPort,
  ModelUsageGroupDimension,
  ModelUsageQuery,
  ModelUsageQueryPort,
  ModelUsageReconciliationQuery,
  ModelUsageReconciliationQueryPort,
  ModelUsageRecorder,
} from '../../shared/telemetry/model-usage.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  startPostgresStoreReadiness,
  type PostgresStoreReadinessHandle,
} from './runtime-readiness.js';
import { assertModelUsageLedgerReadable } from './model-usage-access.js';
import { PostgresModelUsageCapture } from './model-usage-store/capture.js';
import { optionalText } from './model-usage-store/common.js';
import { PostgresModelUsageQueries } from './model-usage-store/queries.js';

export type ModelUsageStoreScope =
  | { companionId: string; fleetAggregation?: never }
  | { companionId?: never; fleetAggregation: true };

export interface ModelUsageStoreConnectionOptions {
  access: 'migration_authority' | 'read_only';
  schema?: string;
  role?: string;
}

function resolveStoreCompanionId(scope: unknown): string | undefined {
  if (!isRecord(scope)) {
    throw new Error('PostgresModelUsageStore scope must be an object');
  }
  const keys = Object.keys(scope);
  if (keys.some(key => key !== 'companionId' && key !== 'fleetAggregation')) {
    throw new Error('PostgresModelUsageStore scope contains unsupported fields');
  }
  const hasCompanion = Object.prototype.hasOwnProperty.call(scope, 'companionId');
  const hasFleet = Object.prototype.hasOwnProperty.call(scope, 'fleetAggregation');
  if (hasCompanion === hasFleet) {
    throw new Error(
      'PostgresModelUsageStore scope requires exactly one of companionId or fleetAggregation',
    );
  }
  if (hasCompanion) {
    const companionId = optionalText(
      typeof scope.companionId === 'string' ? scope.companionId : undefined,
    );
    if (!companionId) {
      throw new Error('PostgresModelUsageStore companionId must be non-empty');
    }
    return companionId;
  }
  if (scope.fleetAggregation !== true) {
    throw new Error('PostgresModelUsageStore fleetAggregation must be true');
  }
  return undefined;
}

export class PostgresModelUsageStore implements ModelUsageRecorder, ModelUsageQueryPort, ModelUsageCostHydrationQueryPort, ModelUsageBudgetQueryPort, FleetModelUsageSummaryQueryPort, ModelUsageExportPort, ModelUsageReconciliationQueryPort, IcpConversationCostAccountingPort {
  private readonly readiness: PostgresStoreReadinessHandle;
  private readonly companionId?: string;
  private readonly capture: PostgresModelUsageCapture;
  private readonly queries: PostgresModelUsageQueries;

  constructor(
    private readonly pool: Pool,
    options: ModelUsageStoreScope,
    connection: Pick<ModelUsageStoreConnectionOptions, 'access'> = {
      access: 'migration_authority',
    },
  ) {
    const access: unknown = connection.access;
    if (access !== 'migration_authority' && access !== 'read_only') {
      throw new Error('PostgresModelUsageStore connection access is unsupported');
    }
    this.companionId = resolveStoreCompanionId(options);
    this.readiness = startPostgresStoreReadiness(
      options.fleetAggregation === true
        ? 'model_usage_accounting'
        : 'model_usage_diagnostics',
      access === 'read_only'
        ? () => assertModelUsageLedgerReadable(pool)
        : () => ensurePostgresSchemaWithAdvisoryLock(
            pool,
            POSTGRES_MODEL_USAGE_MIGRATIONS,
            POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK,
          ),
    );
    const waitUntilReady = (): Promise<void> => this.waitUntilReady();
    this.capture = new PostgresModelUsageCapture(pool, this.companionId, waitUntilReady);
    this.queries = new PostgresModelUsageQueries(pool, this.companionId, waitUntilReady);
  }

  static connect(
    databaseUrl: string,
    options: ModelUsageStoreScope,
    connection: ModelUsageStoreConnectionOptions = { access: 'migration_authority' },
  ): PostgresModelUsageStore {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-model-usage',
      allowExitOnIdle: true,
      ...(connection.schema ? { schema: connection.schema } : {}),
      ...(connection.role ? { role: connection.role } : {}),
      ...(connection.access === 'read_only' ? { readOnly: true } : {}),
    });
    return new PostgresModelUsageStore(pool, options, connection);
  }

  async waitUntilReady(): Promise<void> {
    await this.readiness.waitUntilReady();
  }

  async getIcpConversationCostProjection(
    query: IcpConversationCostProjectionQuery,
  ): Promise<IcpConversationCostProjection> {
    return await this.capture.getIcpConversationCostProjection(query);
  }

  async reserveIcpConversationCost(
    input: IcpConversationCostReservationInput,
  ): Promise<IcpConversationCostReservationResult> {
    return await this.capture.reserveIcpConversationCost(input);
  }

  async recordUsageEvent(input: ModelUsageEventInput): Promise<void> {
    await this.capture.recordUsageEvent(input);
  }

  async getUsageData(query: ModelUsageQuery = {}): Promise<ModelUsageData> {
    return await this.queries.getUsageData(query);
  }

  async getUsageEventsForReconciliation(
    query: ModelUsageReconciliationQuery = {},
  ): Promise<ModelUsageEvent[]> {
    return await this.queries.getUsageEventsForReconciliation(query);
  }

  async getUsageCostHydrationData(
    query: ModelUsageQuery = {},
    dimensions: readonly ModelUsageGroupDimension[],
  ): Promise<ModelUsageCostHydrationData> {
    return await this.queries.getUsageCostHydrationData(query, dimensions);
  }

  async exportUsageEvents(query: ModelUsageQuery = {}): Promise<ModelUsageExportData> {
    return await this.queries.exportUsageEvents(query);
  }

  async getFleetModelUsageSummary(
    query: FleetModelUsageQuery,
    companionIds: readonly string[],
    nowMs = Date.now(),
  ): Promise<FleetModelUsageSummary> {
    return await this.queries.getFleetModelUsageSummary(query, companionIds, nowMs);
  }

  async getModelBudgetSpend(
    nowMs = Date.now(),
    scope?: { companionId: string },
  ): Promise<ModelUsageBudgetSpendSnapshot> {
    return await this.queries.getModelBudgetSpend(nowMs, scope);
  }
}

export function createPostgresModelUsageStoreFromConfig(
  config: Pick<
    SubstrateConfig,
    | 'persistenceBackend'
    | 'postgresDatabaseUrl'
    | 'companionId'
    | 'companionFleet'
    | 'multiCompanion'
    | 'postgresSchema'
    | 'postgresRole'
  >,
  scope?: ModelUsageStoreScope,
  access: ModelUsageStoreConnectionOptions['access'] = 'migration_authority',
): PostgresModelUsageStore | null {
  if (config.persistenceBackend !== 'postgres') {
    return null;
  }
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) return null;
  const primary = config.companionFleet?.companions.at(0);
  const primarySchema = primary?.postgresSchema.trim();
  const primaryRole = primary?.postgresRole.trim();
  const currentRole = config.postgresRole?.trim();
  if (config.multiCompanion === true && (!primarySchema || !primaryRole)) {
    throw new Error('Multi-companion model usage persistence requires canonical fleet topology');
  }
  if (access === 'migration_authority' && primaryRole
    && currentRole && currentRole !== primaryRole) { // ubs:ignore — compares topology role identifiers, not secrets
    throw new Error(
      'Model usage migration authority must be the primary/canonical companion role',
    );
  }
  const connectionRole = access === 'read_only' ? currentRole ?? primaryRole : primaryRole;
  const connection: ModelUsageStoreConnectionOptions = {
    access,
    ...(primarySchema ? { schema: primarySchema } : {}),
    ...(connectionRole ? { role: connectionRole } : {}),
  };
  if (scope) return PostgresModelUsageStore.connect(databaseUrl, scope, connection);
  const companionId = optionalText(config.companionId);
  if (!companionId) {
    throw new Error('PostgreSQL model usage persistence requires a configured companionId');
  }
  return PostgresModelUsageStore.connect(databaseUrl, { companionId }, connection);
}
