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
import type { AdminChargeLedgerService } from './types.js';

export class AdminChargeLedgerDataService implements AdminChargeLedgerService {
  constructor(
    private readonly ledger: RunChargeLedger,
    private readonly fatigueLedger?: Pick<FatigueLedger, 'getData'> | null,
  ) {}

  async getChargeLedgerData(query: RunChargeLedgerQuery & FatigueLedgerQuery = {}): Promise<RunChargeLedgerData & {
    fatigue?: FatigueLedgerData;
  }> {
    const data = this.ledger.getData(query);
    if (!this.fatigueLedger) {
      return data;
    }
    return {
      ...data,
      fatigue: this.fatigueLedger.getData(query),
    };
  }
}
