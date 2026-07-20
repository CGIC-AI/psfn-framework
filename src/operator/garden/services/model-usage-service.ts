import type {
  ModelUsageData,
  ModelUsageExportPort,
  ModelUsageQuery,
  ModelUsageQueryPort,
} from '../../../shared/telemetry/model-usage.js';
import type { AdminModelUsageService } from './types.js';
import {
  serializeModelUsageExport,
  type ModelUsageExportFormat,
  type SerializedModelUsageExport,
} from './model-usage-export.js';

/**
 * Garden's accounting service is deliberately a transparent projection of the immutable ledger.
 * Missing historical prices remain unknown; query-time model catalogs must not silently reprice
 * old calls or make totals, buckets, groups, and exports disagree.
 */
export class AdminModelUsageDataService implements AdminModelUsageService {
  constructor(private readonly store: ModelUsageQueryPort & ModelUsageExportPort) {}

  async getModelUsageData(query: ModelUsageQuery = {}): Promise<ModelUsageData> {
    // #49: the operator surface never exposes companion-private per-call detail,
    // but aggregate totals must still reflect that spend. Query the full ledger
    // for totals and an operator_visible-only slice for the detail projections.
    const aggregateQuery = { ...query };
    delete aggregateQuery.telemetryVisibility;
    const [aggregateData, operatorData] = await Promise.all([
      this.store.getUsageData(aggregateQuery),
      this.store.getUsageData({ ...aggregateQuery, telemetryVisibility: 'operator_visible' }),
    ]);
    return combineAggregateTotalsWithOperatorDetails(aggregateData, operatorData);
  }

  async exportModelUsageData(
    query: ModelUsageQuery,
    format: ModelUsageExportFormat,
  ): Promise<SerializedModelUsageExport> {
    return serializeModelUsageExport(await this.store.exportUsageEvents(query), format);
  }
}

function combineAggregateTotalsWithOperatorDetails(
  aggregateData: ModelUsageData,
  operatorData: ModelUsageData,
): ModelUsageData {
  const { previousPeriod: _operatorPreviousPeriod, ...operatorDetails } = operatorData;
  return {
    ...operatorDetails,
    query: aggregateData.query,
    totals: aggregateData.totals,
    // Aggregate buckets, like headline totals, include the complete ledger. Segmented
    // series remain operator-visible detail, so their shortfall is exactly the
    // companion-private share and never identifies a private model or call.
    timeSeries: aggregateData.timeSeries,
    ...(operatorData.seriesByDimension
      ? { seriesByDimension: operatorData.seriesByDimension }
      : {}),
    ...(aggregateData.previousPeriod ? { previousPeriod: aggregateData.previousPeriod } : {}),
    recentEvents: operatorData.recentEvents.filter(event => event.telemetryVisibility !== 'companion_private'),
    expensiveEvents: operatorData.expensiveEvents.filter(event => event.telemetryVisibility !== 'companion_private'),
  };
}
