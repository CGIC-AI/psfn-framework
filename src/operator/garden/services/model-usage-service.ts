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
    return this.store.getUsageData(query);
  }

  async exportModelUsageData(
    query: ModelUsageQuery,
    format: ModelUsageExportFormat,
  ): Promise<SerializedModelUsageExport> {
    return serializeModelUsageExport(await this.store.exportUsageEvents(query), format);
  }
}
