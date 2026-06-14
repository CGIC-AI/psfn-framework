import type {
  ModelUsageData,
  ModelUsageQuery,
  ModelUsageQueryPort,
} from '../../../shared/telemetry/model-usage.js';
import type { AdminModelUsageService } from './types.js';

export class AdminModelUsageDataService implements AdminModelUsageService {
  constructor(private readonly store: ModelUsageQueryPort) {}

  async getModelUsageData(query: ModelUsageQuery = {}): Promise<ModelUsageData> {
    return await this.store.getUsageData(query);
  }
}
