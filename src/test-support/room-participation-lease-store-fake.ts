import type {
  ClaimRoomParticipationContinuationInput,
  CloseRoomParticipationLeaseInput,
  OpenRoomParticipationLeaseInput,
  RecordRoomParticipationAppraisalInput,
  RefreshRoomParticipationLeaseInput,
  RoomParticipationLeaseSnapshot,
  RoomParticipationLeaseStorePort,
} from '../core/participation/room-participation-lease.js';

/**
 * In-memory mirror of the Postgres store's conditional semantics: every
 * mutation applies exactly the predicate the SQL applies, so the coordinator
 * contract (including the lost-claim race) is exercised without a container.
 * The live SQL itself is proved in room-participation-lease-store.integration.
 */
export class FakeRoomParticipationLeaseStore implements RoomParticipationLeaseStorePort {
  private readonly rows = new Map<string, RoomParticipationLeaseSnapshot>();

  private key(companionId: string, channelId: string): string {
    return `${companionId}\u0000${channelId}`;
  }

  async read(input: {
    companionId: string;
    channelId: string;
  }): Promise<RoomParticipationLeaseSnapshot | null> {
    const row = this.rows.get(this.key(input.companionId, input.channelId));
    return row ? { ...row } : null;
  }

  async open(
    input: OpenRoomParticipationLeaseInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const existing = this.rows.get(this.key(input.companionId, input.channelId));
    // The bot-loop fence survives the opening exactly as it does in SQL: a
    // machine-authored disposition never revives a lease the fence closed, and
    // never clears the machine streak it carried.
    if (input.authorIsMachine
      && existing?.status === 'closed'
      && existing.closeReason === 'machine_streak') {
      return null;
    }
    const snapshot: RoomParticipationLeaseSnapshot = {
      companionId: input.companionId,
      channelId: input.channelId,
      status: 'active',
      openedDisposition: input.disposition,
      openedAtMs: input.nowMs,
      lastActivityAtMs: input.nowMs,
      expiresAtMs: input.expiresAtMs,
      watermarkMessageId: input.watermarkMessageId,
      watermarkTimestampMs: input.watermarkTimestampMs,
      consideredCount: 0,
      ignoreStreak: 0,
      machineStreak: input.authorIsMachine ? existing?.machineStreak ?? 0 : 0,
      closedAtMs: null,
      closeReason: null,
      revision: (existing?.revision ?? 0) + 1,
    };
    this.rows.set(this.key(input.companionId, input.channelId), snapshot);
    return { ...snapshot };
  }

  async refresh(
    input: RefreshRoomParticipationLeaseInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const row = this.rows.get(this.key(input.companionId, input.channelId));
    if (!row || row.status !== 'active' || row.expiresAtMs <= input.nowMs) return null;
    row.lastActivityAtMs = input.nowMs;
    row.expiresAtMs = Math.max(row.expiresAtMs, input.expiresAtMs);
    if (isAfter(input.watermarkTimestampMs, input.watermarkMessageId, row)) {
      row.watermarkMessageId = input.watermarkMessageId;
      row.watermarkTimestampMs = input.watermarkTimestampMs;
    }
    if (!input.authorIsMachine) row.ignoreStreak = 0;
    row.revision += 1;
    return { ...row };
  }

  async claimContinuation(
    input: ClaimRoomParticipationContinuationInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const row = this.rows.get(this.key(input.companionId, input.channelId));
    if (!row
      || row.status !== 'active'
      || row.expiresAtMs <= input.nowMs
      || !isAfter(input.timestampMs, input.messageId, row)
      || row.consideredCount >= input.maxContinuationCandidates
      || (input.authorIsMachine
        && row.machineStreak >= input.maxConsecutiveMachineContinuations)) {
      return null;
    }
    row.watermarkMessageId = input.messageId;
    row.watermarkTimestampMs = input.timestampMs;
    row.lastActivityAtMs = input.nowMs;
    row.consideredCount += 1;
    row.machineStreak = input.authorIsMachine ? row.machineStreak + 1 : 0;
    row.revision += 1;
    return { ...row };
  }

  async recordAppraisal(
    input: RecordRoomParticipationAppraisalInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const row = this.rows.get(this.key(input.companionId, input.channelId));
    if (!row || row.status !== 'active') return null;
    row.ignoreStreak = input.action === 'ignore' ? row.ignoreStreak + 1 : 0;
    row.lastActivityAtMs = Math.max(row.lastActivityAtMs, input.nowMs);
    row.revision += 1;
    return { ...row };
  }

  async close(
    input: CloseRoomParticipationLeaseInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const row = this.rows.get(this.key(input.companionId, input.channelId));
    if (!row || row.status !== 'active') return null;
    row.status = 'closed';
    row.closedAtMs = input.nowMs;
    row.closeReason = input.reason;
    row.revision += 1;
    return { ...row };
  }

  async shutdown(): Promise<void> {
    this.rows.clear();
  }
}

function isAfter(
  timestampMs: number,
  messageId: string,
  row: Pick<RoomParticipationLeaseSnapshot, 'watermarkMessageId' | 'watermarkTimestampMs'>,
): boolean {
  if (timestampMs !== row.watermarkTimestampMs) return timestampMs > row.watermarkTimestampMs;
  return messageId > row.watermarkMessageId;
}
