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
    || value === 'empty_response'
    || value === 'turn_cancelled';
}

export interface BuzzCausalEvent {
  eventId: string;
  channelId: string;
  rootEventId: string;
  parentEventId: string | null;
  hop: number;
  authorPubkey: string;
}

export type BuzzCausalClaimResult = 'claimed' | 'duplicate' | 'invalid_parent';

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
  registerHumanRoot(input: Omit<BuzzCausalEvent, 'rootEventId' | 'parentEventId' | 'hop'>): Promise<void>;
  claimCausalEvent(input: BuzzCausalEvent): Promise<BuzzCausalClaimResult>;
  markReady(eventId: string, outboundEvent: NostrEvent, causalEvent: BuzzCausalEvent): Promise<void>;
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
  private readonly causalEvents = new Map<string, BuzzCausalEvent>();
  private readonly causalEdges = new Set<string>();
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

  async registerHumanRoot(
    input: Omit<BuzzCausalEvent, 'rootEventId' | 'parentEventId' | 'hop'>,
  ): Promise<void> {
    this.causalEvents.set(input.eventId, {
      ...input,
      rootEventId: input.eventId,
      parentEventId: null,
      hop: 0,
    });
  }

  async claimCausalEvent(input: BuzzCausalEvent): Promise<BuzzCausalClaimResult> {
    if (!this.hasValidCausalParent(input)) return 'invalid_parent';
    const edge = `${input.rootEventId}:${input.parentEventId}:${input.authorPubkey}`;
    if (this.causalEdges.has(edge) || this.causalEvents.has(input.eventId)) return 'duplicate';
    this.causalEdges.add(edge);
    this.causalEvents.set(input.eventId, structuredClone(input));
    return 'claimed';
  }

  async markReady(
    eventId: string,
    outboundEvent: NostrEvent,
    causalEvent: BuzzCausalEvent,
  ): Promise<void> {
    if (!this.hasValidCausalParent(causalEvent)) {
      throw new Error(`Buzz outbound event ${causalEvent.eventId} has an invalid causal parent`);
    }
    this.updateProcessing(eventId, { state: 'ready', outboundEvent: structuredClone(outboundEvent) });
    this.causalEvents.set(causalEvent.eventId, structuredClone(causalEvent));
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
    if (record.outboundEvent) this.causalEvents.delete(record.outboundEvent.id);
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

  private hasValidCausalParent(input: BuzzCausalEvent): boolean {
    if (!input.parentEventId || input.hop < 1) return false;
    const parent = this.causalEvents.get(input.parentEventId);
    return parent !== undefined
      && parent.rootEventId === input.rootEventId
      && parent.channelId === input.channelId
      && input.hop === parent.hop + 1;
  }
}
