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
import type {
  HumanAttentionPressureLedger,
  HumanAttentionPressureLedgerData,
} from '../../../core/agent/fatigue/human-attention-ledger.js';
import type { AdminChargeLedgerService } from './types.js';

export class AdminChargeLedgerDataService implements AdminChargeLedgerService {
  constructor(
    private readonly ledger: RunChargeLedger,
    private readonly fatigueLedger?: Pick<FatigueLedger, 'getData'> | null,
    private readonly fatiguePolicy?: FatiguePolicyConfig | null,
    private readonly humanAttentionLedger?: Pick<HumanAttentionPressureLedger, 'getData'> | null,
  ) {}

  async getChargeLedgerData(query: RunChargeLedgerQuery & FatigueLedgerQuery = {}): Promise<RunChargeLedgerData & {
    fatigue?: FatigueLedgerData;
    fatigueTuning?: FatigueTuningReport;
    fatigueSocialPolicy?: FatiguePolicyConfig['socialRegulation'];
    humanAttention?: HumanAttentionPressureLedgerData;
    humanAttentionPolicy?: FatiguePolicyConfig['humanAttention'];
  }> {
    const data = this.ledger.getData(query);
    if (!this.fatigueLedger) {
      return data;
    }
    const fatigue = this.fatigueLedger.getData(query);
    const humanAttention = this.humanAttentionLedger?.getData({
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.sinceMs !== undefined ? { sinceMs: query.sinceMs } : {}),
      ...(query.untilMs !== undefined ? { untilMs: query.untilMs } : {}),
      ...(query.channelId ? { channelId: query.channelId } : {}),
    });
    return {
      ...data,
      fatigue,
      ...(humanAttention ? { humanAttention } : {}),
      ...(this.fatiguePolicy
        ? {
            fatigueTuning: buildFatigueTuningReport({
              events: fatigue.events.map(entry => entry.event),
              policy: this.fatiguePolicy,
            }),
            fatigueSocialPolicy: { ...this.fatiguePolicy.socialRegulation },
            humanAttentionPolicy: structuredClone(this.fatiguePolicy.humanAttention),
          }
        : {}),
    };
  }
}
