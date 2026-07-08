import type {
  RunChargeLedgerData,
  RunChargeLedgerQuery,
} from '../../../../shared/telemetry/charge-ledger.js';
import type {
  FatigueLedgerData,
  FatigueLedgerQuery,
} from '../../../../shared/telemetry/fatigue-ledger.js';
import type {
  ModelUsageData,
  ModelUsageQuery,
} from '../../../../shared/telemetry/model-usage.js';
import type { FatigueTuningReport } from '../../../../core/agent/fatigue/adaptive-tuning.js';

export interface AdminChargeLedgerService {
  getChargeLedgerData(query?: RunChargeLedgerQuery & FatigueLedgerQuery): Promise<RunChargeLedgerData & {
    fatigue?: FatigueLedgerData;
    fatigueTuning?: FatigueTuningReport;
  }>;
}

export interface AdminModelUsageService {
  getModelUsageData(query?: ModelUsageQuery): Promise<ModelUsageData>;
}
