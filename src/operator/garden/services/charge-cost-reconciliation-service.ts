import type {
  RunChargeLedger,
  RunChargeReconciliationQuery,
} from '../../../shared/telemetry/charge-ledger.js';
import {
  reconcileChargeCosts,
  type ChargeCostReconciliationData,
  type ChargeCostReconciliationQuery,
} from '../../../shared/telemetry/charge-cost-reconciliation.js';
import type {
  ModelUsageReconciliationQuery,
  ModelUsageReconciliationQueryPort,
} from '../../../shared/telemetry/model-usage.js';
import type { AdminChargeCostReconciliationService } from './types.js';

type ChargeLedgerReconciliationPort = Pick<RunChargeLedger, 'listReconciliationEntries'>;

export class AdminChargeCostReconciliationDataService implements AdminChargeCostReconciliationService {
  private readonly tenantCompanionId: string;

  constructor(
    private readonly chargeLedger: ChargeLedgerReconciliationPort,
    private readonly modelUsage: ModelUsageReconciliationQueryPort,
    tenantCompanionId: string,
  ) {
    this.tenantCompanionId = tenantCompanionId.trim();
    if (!this.tenantCompanionId) {
      throw new Error('Charge-cost reconciliation requires a companion tenant');
    }
  }

  async getChargeCostReconciliation(
    query: ChargeCostReconciliationQuery = {},
  ): Promise<ChargeCostReconciliationData> {
    if (query.companionId && query.companionId !== this.tenantCompanionId) {
      throw new Error(`Charge-cost query companion ${JSON.stringify(query.companionId)} is outside the reconciliation tenant`);
    }
    const chargeQuery: RunChargeReconciliationQuery = {
      ...(query.sinceMs !== undefined ? { sinceMs: query.sinceMs } : {}),
      ...(query.untilMs !== undefined ? { untilMs: query.untilMs } : {}),
    };
    const usageQuery: ModelUsageReconciliationQuery = {
      ...(query.sinceMs !== undefined ? { sinceMs: query.sinceMs } : {}),
      ...(query.untilMs !== undefined ? { untilMs: query.untilMs } : {}),
      companionId: this.tenantCompanionId,
      ...(query.channelId ? { channelId: query.channelId } : {}),
      ...(query.lane ? { chargeLane: query.lane } : {}),
      ...(query.surface ? { chargeSurface: query.surface } : {}),
      ...(query.runId ? { chargeRunId: query.runId } : {}),
      ...(query.rootRunId ? { chargeRootRunId: query.rootRunId } : {}),
    };
    const chargeEntries = this.chargeLedger.listReconciliationEntries(chargeQuery);
    const usageEvents = await this.modelUsage.getUsageEventsForReconciliation(usageQuery);
    return reconcileChargeCosts({
      tenantCompanionId: this.tenantCompanionId,
      chargeEntries,
      usageEvents,
      query: { ...query, companionId: this.tenantCompanionId },
    });
  }
}
