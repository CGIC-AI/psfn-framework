import type { Event as NostrEvent } from 'nostr-tools';

export type BuzzInboundRecoveryState = 'processing' | 'ready' | 'completed' | 'suppressed';

export interface BuzzInboundRecoveryRecord {
  eventId: string;
  channelId: string;
  eventCreatedAt: number;
  state: BuzzInboundRecoveryState;
  outboundEvent?: NostrEvent;
  suppressionReason?: string;
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
  claimCausalEdge(input: {
    chainId: string;
    parentEventId: string;
    authorPubkey: string;
    eventId: string;
  }): Promise<boolean>;
  registerHumanRoot(rootEventId: string, authorPubkey: string): Promise<void>;
  hasHumanRoot(rootEventId: string): Promise<boolean>;
  markReady(eventId: string, outboundEvent: NostrEvent): Promise<void>;
  markCompleted(eventId: string): Promise<void>;
  markSuppressed(eventId: string, reason: string): Promise<void>;
  listRecoverable(): Promise<BuzzInboundRecoveryRecord[]>;
  loadReplayCursor(): Promise<number | null>;
  advanceReplayCursor(eventCreatedAt: number): Promise<void>;
  replaceMemberships(channelIds: readonly string[], observedAtMs: number): Promise<void>;
  setMembership(channelId: string, active: boolean, observedAtMs: number): Promise<void>;
  close(): Promise<void>;
}

/** Deterministic test/embedding store with the same claim semantics as Postgres. */
export class InMemoryBuzzRecoveryStore implements BuzzRecoveryStore {
  private readonly records = new Map<string, BuzzInboundRecoveryRecord>();
  private readonly causalEdges = new Set<string>();
  private readonly humanRoots = new Set<string>();
  private readonly memberships = new Set<string>();
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

  async claimCausalEdge(input: {
    chainId: string;
    parentEventId: string;
    authorPubkey: string;
    eventId: string;
  }): Promise<boolean> {
    const edge = `${input.chainId}:${input.parentEventId}:${input.authorPubkey}`;
    if (this.causalEdges.has(edge)) return false;
    this.causalEdges.add(edge);
    return true;
  }

  async registerHumanRoot(rootEventId: string, _authorPubkey: string): Promise<void> {
    this.humanRoots.add(rootEventId);
  }

  async hasHumanRoot(rootEventId: string): Promise<boolean> {
    return this.humanRoots.has(rootEventId);
  }

  async markReady(eventId: string, outboundEvent: NostrEvent): Promise<void> {
    this.updateProcessing(eventId, { state: 'ready', outboundEvent: structuredClone(outboundEvent) });
  }

  async markCompleted(eventId: string): Promise<void> {
    const record = this.requireRecord(eventId);
    if (record.state !== 'ready') {
      throw new Error(`Buzz recovery event ${eventId} cannot complete from ${record.state}`);
    }
    this.records.set(eventId, { ...record, state: 'completed' });
  }

  async markSuppressed(eventId: string, reason: string): Promise<void> {
    this.updateProcessing(eventId, { state: 'suppressed', suppressionReason: reason });
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

  async replaceMemberships(channelIds: readonly string[], _observedAtMs: number): Promise<void> {
    this.memberships.clear();
    for (const channelId of channelIds) this.memberships.add(channelId);
  }

  async setMembership(channelId: string, active: boolean, _observedAtMs: number): Promise<void> {
    if (active) this.memberships.add(channelId);
    else this.memberships.delete(channelId);
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
