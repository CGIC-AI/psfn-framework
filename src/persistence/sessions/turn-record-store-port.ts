import type { TurnRecord } from '../../shared/contracts/runtime.js';

export interface TurnRecordStorePort {
  appendTurnRecord(record: TurnRecord): void;
  readRecentTurnRecords(channelId: string, limit: number): TurnRecord[];
}
