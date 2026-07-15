import type { TurnRecord } from '../../shared/contracts/runtime.js';

export interface TurnRecordStorePort {
  appendTurnRecord(record: TurnRecord): void;
  /** Reads a page ordered oldest-to-newest, with offset counted from the newest record. */
  readRecentTurnRecords(channelId: string, limit: number, offset?: number): TurnRecord[];
  findTurnRecord(channelId: string, turnId: string): TurnRecord | null;
}
