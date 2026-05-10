import type {
  RunChargeLedger,
  RunChargeLedgerData,
  RunChargeLedgerQuery,
} from '../../../shared/telemetry/charge-ledger.js';
import type { AdminChargeLedgerService } from './types.js';

export class AdminChargeLedgerDataService implements AdminChargeLedgerService {
  constructor(private readonly ledger: RunChargeLedger) {}

  async getChargeLedgerData(query: RunChargeLedgerQuery = {}): Promise<RunChargeLedgerData> {
    return this.ledger.getData(query);
  }
}
