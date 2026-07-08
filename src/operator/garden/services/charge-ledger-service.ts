import type {
  RunChargeLedger,
  RunChargeLedgerData,
  RunChargeLedgerQuery,
} from '../../../shared/telemetry/charge-ledger.js';
import type {
  FatigueLedger,
  FatigueLedgerData,
  FatigueLedgerQuery,
} from '../../../shared/telemetry/fatigue-ledger.js';
import {
  buildFatigueTuningReport,
  type FatigueTuningReport,
} from '../../../core/agent/fatigue/adaptive-tuning.js';
import type { FatiguePolicyConfig } from '../../../shared/contracts/charge-policy.js';
import type { AdminChargeLedgerService } from './types.js';

export class AdminChargeLedgerDataService implements AdminChargeLedgerService {
  constructor(
    private readonly ledger: RunChargeLedger,
    private readonly fatigueLedger?: Pick<FatigueLedger, 'getData'> | null,
    private readonly fatiguePolicy?: FatiguePolicyConfig | null,
  ) {}

  async getChargeLedgerData(query: RunChargeLedgerQuery & FatigueLedgerQuery = {}): Promise<RunChargeLedgerData & {
    fatigue?: FatigueLedgerData;
    fatigueTuning?: FatigueTuningReport;
  }> {
    const data = this.ledger.getData(query);
    if (!this.fatigueLedger) {
      return data;
    }
    const fatigue = this.fatigueLedger.getData(query);
    return {
      ...data,
      fatigue,
      ...(this.fatiguePolicy
        ? {
            fatigueTuning: buildFatigueTuningReport({
              events: fatigue.events.map(entry => entry.event),
              policy: this.fatiguePolicy,
            }),
          }
        : {}),
    };
  }
}
