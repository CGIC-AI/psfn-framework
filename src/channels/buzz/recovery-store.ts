import type { Event as NostrEvent } from 'nostr-tools';
import {
  compareBuzzMembershipPositions,
  type BuzzMembershipChange,
  type BuzzMembershipSnapshot,
} from './protocol.js';

export type BuzzInboundRecoveryState = 'processing' | 'ready' | 'completed' | 'suppressed';

export type BuzzSuppressionReason =
  | 'autonomous_hop_limit'
  | 'duplicate_causal_edge'
  | 'invalid_causal_parent'
  | 'no_information_acknowledgement'
  | 'fatigue_suppressed'
  | 'broadcast_approval_required'
  | 'intentional_no_reply'
  | 'observation_only'
  | 'empty_response'
  | 'turn_cancelled';

export function isBuzzSuppressionReason(value: unknown): value is BuzzSuppressionReason {
  return value === 'autonomous_hop_limit'
    || value === 'duplicate_causal_edge'
    || value === 'invalid_causal_parent'
    || value === 'no_information_acknowledgement'
    || value === 'fatigue_suppressed'
    || value === 'broadcast_approval_required'
    || value === 'intentional_no_reply'
    || value === 'observation_only'
    || value === 'empty_response'
    || value === 'turn_cancelled';
}

export interface BuzzInboundRecoveryRecord {
  eventId: string;
  channelId: string;
  eventCreatedAt: number;
  state: BuzzInboundRecoveryState;
  outboundEvent?: NostrEvent;
  suppressionReason?: BuzzSuppressionReason;
}

export interface BuzzRecoveryScope {
  community: string;
  companionId: string;
}

export interface BuzzRecoveryStore {
  waitUntilReady(): Promise<void>;
  claimInbound(input: {
    eventId: string;
    channelId: string;
    eventCreatedAt: number;
  }): Promise<{ claimed: boolean; record: BuzzInboundRecoveryRecord }>;
  markReady(eventId: string, outboundEvent: NostrEvent): Promise<void>;
  markCompleted(eventId: string): Promise<void>;
  markSuppressed(eventId: string, reason: BuzzSuppressionReason): Promise<void>;
  listRecoverable(): Promise<BuzzInboundRecoveryRecord[]>;
  loadReplayCursor(): Promise<number | null>;
  advanceReplayCursor(eventCreatedAt: number): Promise<void>;
  replaceMemberships(memberships: readonly BuzzMembershipSnapshot[]): Promise<void>;
  setMembership(change: BuzzMembershipChange): Promise<void>;
  close(): Promise<void>;
}

/** Deterministic test/embedding store with the same claim semantics as Postgres. */
export class InMemoryBuzzRecoveryStore implements BuzzRecoveryStore {
  private readonly records = new Map<string, BuzzInboundRecoveryRecord>();
  private readonly memberships = new Map<string, BuzzMembershipChange>();
  private cursor: number | null = null;

  async waitUntilReady(): Promise<void> {}

  async claimInbound(input: {
    eventId: string;
    channelId: string;
    eventCreatedAt: number;
  }): Promise<{ claimed: boolean; record: BuzzInboundRecoveryRecord }> {
    const existing = this.records.get(input.eventId);
    if (existing) return { claimed: false, record: structuredClone(existing) };
    const record: BuzzInboundRecoveryRecord = { ...input, state: 'processing' };
    this.records.set(input.eventId, record);
    return { claimed: true, record: structuredClone(record) };
  }

  async markReady(
    eventId: string,
    outboundEvent: NostrEvent,
  ): Promise<void> {
    this.updateProcessing(eventId, { state: 'ready', outboundEvent: structuredClone(outboundEvent) });
  }

  async markCompleted(eventId: string): Promise<void> {
    const record = this.requireRecord(eventId);
    if (record.state !== 'ready') {
      throw new Error(`Buzz recovery event ${eventId} cannot complete from ${record.state}`);
    }
    this.records.set(eventId, { ...record, state: 'completed' });
  }

  async markSuppressed(eventId: string, reason: BuzzSuppressionReason): Promise<void> {
    const record = this.requireRecord(eventId);
    if (record.state !== 'processing' && record.state !== 'ready') {
      throw new Error(`Buzz recovery event ${eventId} cannot suppress from ${record.state}`);
    }
    this.records.set(eventId, {
      eventId: record.eventId,
      channelId: record.channelId,
      eventCreatedAt: record.eventCreatedAt,
      state: 'suppressed',
      suppressionReason: reason,
    });
  }

  async listRecoverable(): Promise<BuzzInboundRecoveryRecord[]> {
    return [...this.records.values()]
      .filter(record => record.state === 'processing' || record.state === 'ready')
      .map(record => structuredClone(record));
  }

  async loadReplayCursor(): Promise<number | null> {
    return this.cursor;
  }

  async advanceReplayCursor(eventCreatedAt: number): Promise<void> {
    this.cursor = Math.max(this.cursor ?? 0, eventCreatedAt);
  }

  async replaceMemberships(memberships: readonly BuzzMembershipSnapshot[]): Promise<void> {
    this.memberships.clear();
    for (const membership of memberships) {
      this.memberships.set(membership.channelId, { ...membership, active: true });
    }
  }

  async setMembership(change: BuzzMembershipChange): Promise<void> {
    const current = this.memberships.get(change.channelId);
    if (current && compareBuzzMembershipPositions(current.position, change.position) >= 0) return;
    this.memberships.set(change.channelId, structuredClone(change));
  }

  async close(): Promise<void> {}

  private requireRecord(eventId: string): BuzzInboundRecoveryRecord {
    const record = this.records.get(eventId);
    if (!record) throw new Error(`Buzz recovery event ${eventId} was not claimed`);
    return record;
  }

  private updateProcessing(
    eventId: string,
    update: Pick<BuzzInboundRecoveryRecord, 'state'>
      & Partial<Pick<BuzzInboundRecoveryRecord, 'outboundEvent' | 'suppressionReason'>>,
  ): void {
    const record = this.requireRecord(eventId);
    if (record.state !== 'processing') {
      throw new Error(`Buzz recovery event ${eventId} cannot leave ${record.state}`);
    }
    this.records.set(eventId, { ...record, ...update });
  }

}
