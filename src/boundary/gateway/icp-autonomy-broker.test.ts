import { describe, expect, it, vi } from 'vitest';

import type {
  IcpPermitConsumptionInput,
  IcpPermitConsumptionResult,
  IcpSharedAutonomyStorePort,
  IcpConversationTransitionInput,
} from '../../core/icp/autonomy-store-ports.js';
import type { IcpInitiationCandidateSharedMetadata } from '../../core/icp/initiation-candidate.js';
import type {
  IcpAutonomyReasonCode,
  IcpAvailabilityLease,
  IcpConversationEpisode,
  IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import { EventBus } from '../../shared/event-bus.js';
import {
  GatewayIcpAutonomyBroker,
} from './icp-autonomy-broker.js';
import {
  parseIcpInitiationPermitIssueInput,
  parseIcpInitiationPreflightInput,
  type IcpInitiationPolicySnapshot,
} from './icp-autonomy-contract.js';

const NOW = 100_000;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const CHANNEL = `companion-dm:${A}:${B}`;

const OPEN_POLICY: IcpInitiationPolicySnapshot = {
  canonicalPeerContact: true,
  trustAllows: true,
  senderBlocksPeer: false,
  peerBlocksSender: false,
  quietHours: false,
  provenanceFresh: true,
  recursiveMiOnlyRoot: false,
  socialPressureAllows: true,
  chargeAllows: true,
  fatigueAllows: true,
  costAllows: true,
};

function candidate(overrides: Partial<IcpInitiationCandidateSharedMetadata> = {}): IcpInitiationCandidateSharedMetadata {
  return {
    candidateId: CANDIDATE_ID,
    rootInitiationId: ROOT_ID,
    localCompanionId: A,
    peerCompanionId: B,
    preferredChannel: 'dm',
    source: 'free_time',
    provenanceRef: 'free-time:block:17',
    createdAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    status: 'pending',
    revision: 1,
    ...overrides,
  };
}

class MemoryStore implements IcpSharedAutonomyStorePort {
  availability = new Map<string, IcpAvailabilityLease>();
  episodes = new Map<string, IcpConversationEpisode>();
  permits = new Map<string, IcpInitiationPermit>();

  async publishAvailability(lease: IcpAvailabilityLease): Promise<IcpAvailabilityLease> {
    const current = this.availability.get(lease.companionId);
    if ((current && current.revision + 1 !== lease.revision) || (!current && lease.revision !== 1)) {
      throw new Error('revision conflict');
    }
    this.availability.set(lease.companionId, lease);
    return lease;
  }

  async getAvailability(companionId: string): Promise<IcpAvailabilityLease | null> {
    return this.availability.get(companionId) ?? null;
  }

  async clearAvailability(companionId: string, expectedRevision: number): Promise<boolean> {
    if (this.availability.get(companionId)?.revision !== expectedRevision) return false;
    return this.availability.delete(companionId);
  }

  async createEpisode(episode: IcpConversationEpisode): Promise<IcpConversationEpisode> {
    this.episodes.set(episode.conversationId, episode);
    return episode;
  }

  async getEpisode(conversationId: string): Promise<IcpConversationEpisode | null> {
    return this.episodes.get(conversationId) ?? null;
  }

  async transitionEpisode(input: IcpConversationTransitionInput): Promise<IcpConversationEpisode> {
    const episode = this.episodes.get(input.conversationId);
    if (!episode) throw new Error('missing episode');
    const next: IcpConversationEpisode = {
      ...episode,
      status: input.status,
      lastActivityAtMs: input.lastActivityAtMs,
      ...(input.closeReasonCode ? { closeReasonCode: input.closeReasonCode } : {}),
      revision: episode.revision + 1,
    };
    this.episodes.set(next.conversationId, next);
    return next;
  }

  async issuePermit(permit: IcpInitiationPermit): Promise<IcpInitiationPermit> {
    const outstanding = await this.findOutstandingPermitBetween(
      permit.senderCompanionId,
      permit.recipientCompanionId,
      permit.issuedAtMs,
    );
    if (outstanding) throw new Error('outstanding invitation');
    this.permits.set(permit.permitId, permit);
    return permit;
  }

  async createEpisodeAndIssuePermit(input: {
    episode: IcpConversationEpisode;
    permit: IcpInitiationPermit;
  }): Promise<{ episode: IcpConversationEpisode; permit: IcpInitiationPermit }> {
    const episode = await this.createEpisode(input.episode);
    try {
      const permit = await this.issuePermit(input.permit);
      return { episode, permit };
    } catch (error) {
      this.episodes.delete(episode.conversationId);
      throw error;
    }
  }

  async getPermit(permitId: string): Promise<IcpInitiationPermit | null> {
    return this.permits.get(permitId) ?? null;
  }

  async consumePermit(input: IcpPermitConsumptionInput): Promise<IcpPermitConsumptionResult> {
    const permit = this.permits.get(input.permitId);
    if (!permit) return { outcome: 'not_found', permit: null };
    if (permit.senderCompanionId !== input.senderCompanionId
      || permit.recipientCompanionId !== input.recipientCompanionId
      || permit.conversationId !== input.conversationId
      || permit.channelId !== input.channelId) {
      return { outcome: 'mismatch', permit, reasonCode: 'permit_mismatch' };
    }
    if (permit.status === 'consumed') {
      return { outcome: 'replayed', permit, reasonCode: 'permit_replayed' };
    }
    if (permit.status === 'revoked') {
      return { outcome: 'revoked', permit, reasonCode: 'permit_revoked' };
    }
    const consumed: IcpInitiationPermit = {
      ...permit,
      status: 'consumed',
      consumedAtMs: input.consumedAtMs,
      revision: permit.revision + 1,
    };
    this.permits.set(permit.permitId, consumed);
    return { outcome: 'consumed', permit: consumed };
  }

  async revokePermit(
    permitId: string,
    expectedRevision: number,
    revokedAtMs: number,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<IcpInitiationPermit> {
    const permit = this.permits.get(permitId);
    if (!permit || permit.revision !== expectedRevision || permit.status !== 'issued') {
      throw new Error('revocation conflict');
    }
    const revoked: IcpInitiationPermit = {
      ...permit,
      status: 'revoked',
      revokedAtMs,
      reasonCode,
      revision: permit.revision + 1,
    };
    this.permits.set(permitId, revoked);
    return revoked;
  }

  async findOutstandingPermitBetween(
    firstCompanionId: string,
    secondCompanionId: string,
    nowMs: number,
  ): Promise<IcpInitiationPermit | null> {
    const pair = [firstCompanionId, secondCompanionId].sort().join(':');
    return [...this.permits.values()].find((permit) =>
      permit.status === 'issued'
      && permit.expiresAtMs > nowMs
      && [permit.senderCompanionId, permit.recipientCompanionId].sort().join(':') === pair
    ) ?? null;
  }

  async revokeOutstandingPermitsForCompanion(
    companionId: string,
    revokedAtMs: number,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<IcpInitiationPermit[]> {
    const revoked: IcpInitiationPermit[] = [];
    for (const permit of this.permits.values()) {
      if (permit.status !== 'issued'
        || (permit.senderCompanionId !== companionId && permit.recipientCompanionId !== companionId)) continue;
      const next: IcpInitiationPermit = {
        ...permit,
        status: 'revoked',
        revokedAtMs,
        reasonCode,
        revision: permit.revision + 1,
      };
      this.permits.set(permit.permitId, next);
      revoked.push(next);
    }
    return revoked;
  }

  async close(): Promise<void> {}
}

function makeBroker(input: {
  store?: MemoryStore;
  ready?: boolean;
  channelOk?: boolean;
  alarm?: ReturnType<typeof vi.fn>;
  eventBus?: EventBus;
} = {}) {
  const store = input.store ?? new MemoryStore();
  const eventBus = input.eventBus ?? new EventBus();
  const alarm = input.alarm ?? vi.fn();
  const ids = [CONVERSATION_ID, PERMIT_ID];
  const broker = new GatewayIcpAutonomyBroker({
    store,
    fleetCompanionIds: new Set([A, B, C]),
    isCompanionReady: () => input.ready ?? true,
    resolveInitiationChannel: async () => input.channelOk === false
      ? { ok: false, reasonCode: 'channel_mismatch' }
      : { ok: true },
    eventBus,
    alarm,
    now: () => NOW,
    randomUuid: () => ids.shift() ?? C,
  });
  return { broker, store, alarm, eventBus };
}

async function makeAvailable(store: MemoryStore, companionId = B): Promise<void> {
  await store.publishAvailability({
    companionId,
    state: 'open_to_chat',
    issuedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    source: 'companion',
    revision: 1,
  });
}

describe('GatewayIcpAutonomyBroker', () => {
  it('strictly rejects private candidate fields and missing policy gates', () => {
    expect(() => parseIcpInitiationPreflightInput({
      candidate: { ...candidate(), reasonSummary: 'must stay private' },
      channelId: CHANNEL,
      policy: OPEN_POLICY,
    }, NOW)).toThrow(/unknown key.*reasonSummary/i);
    expect(() => parseIcpInitiationPreflightInput({
      candidate: candidate(),
      channelId: CHANNEL,
      policy: { ...OPEN_POLICY, costAllows: undefined },
    }, NOW)).toThrow(/costAllows must be a boolean/);
  });

  it.each([
    ['canonicalPeerContact', false, 'invalid_identity', 'terminal'],
    ['trustAllows', false, 'policy_denied', 'terminal'],
    ['senderBlocksPeer', true, 'peer_blocked', 'terminal'],
    ['quietHours', true, 'quiet_hours', 'deferrable'],
    ['provenanceFresh', false, 'stale_provenance', 'terminal'],
    ['recursiveMiOnlyRoot', true, 'recursive_trigger', 'terminal'],
    ['socialPressureAllows', false, 'charge_pressure', 'deferrable'],
    ['chargeAllows', false, 'charge_pressure', 'deferrable'],
    ['fatigueAllows', false, 'fatigue_exhausted', 'terminal'],
    ['costAllows', false, 'cost_hard_stop', 'terminal'],
  ] as const)('closes %s deterministically with %s', async (key, value, reasonCode, reasonClass) => {
    const { broker, store } = makeBroker();
    await makeAvailable(store);
    await expect(broker.preflight(A, {
      candidate: candidate(),
      channelId: CHANNEL,
      policy: { ...OPEN_POLICY, [key]: value },
    })).resolves.toEqual({ eligible: false, reasonCode, reasonClass });
  });

  it('derives offline/missing/expired/busy/DND state without polling or model work', async () => {
    const offline = makeBroker({ ready: false });
    await expect(offline.broker.readPeerAvailability(A, B)).resolves.toMatchObject({
      eligible: false,
      connectionState: 'offline',
      reasonCode: 'peer_offline',
    });

    const { broker, store } = makeBroker();
    await expect(broker.readPeerAvailability(A, B)).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'availability_missing',
    });
    store.availability.set(B, {
      companionId: B,
      state: 'busy',
      issuedAtMs: NOW - 2_000,
      expiresAtMs: NOW - 1,
      source: 'runtime',
      revision: 1,
    });
    await expect(broker.readPeerAvailability(A, B)).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'availability_expired',
    });
    store.availability.set(B, { ...store.availability.get(B)!, expiresAtMs: NOW + 1_000 });
    await expect(broker.readPeerAvailability(A, B)).resolves.toMatchObject({ reasonCode: 'peer_busy' });
    store.availability.set(B, { ...store.availability.get(B)!, state: 'do_not_disturb' });
    await expect(broker.readPeerAvailability(A, B)).resolves.toMatchObject({
      reasonCode: 'peer_do_not_disturb',
    });
  });

  it('issues one exact-bound permit, consumes once, and classifies replay/substitution', async () => {
    const { broker, store, alarm } = makeBroker();
    await makeAvailable(store);
    const input = parseIcpInitiationPermitIssueInput({
      candidate: candidate(),
      channelId: CHANNEL,
      policy: OPEN_POLICY,
      permitExpiresAtMs: NOW + 30_000,
    }, NOW);
    const issued = await broker.issuePermit(A, input);
    expect(issued.decision).toEqual({ eligible: true });
    expect(issued.permit).toMatchObject({
      permitId: PERMIT_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
    });
    const consumeInput = {
      permitId: PERMIT_ID,
      conversationId: CONVERSATION_ID,
      recipientCompanionId: B,
      channelId: CHANNEL,
    };
    await expect(broker.consumePermit(A, consumeInput)).resolves.toMatchObject({ outcome: 'consumed' });
    await expect(broker.consumePermit(A, consumeInput)).resolves.toMatchObject({ outcome: 'replayed' });
    await expect(broker.consumePermit(A, { ...consumeInput, conversationId: ROOT_ID }))
      .resolves.toMatchObject({ outcome: 'mismatch' });
    expect(alarm).toHaveBeenCalledWith(
      'icp_permit_binding_mismatch',
      expect.any(String),
      expect.objectContaining({ senderCompanionId: A }),
    );
  });

  it('allows only one outstanding invitation per unordered pair', async () => {
    const { broker, store } = makeBroker();
    await makeAvailable(store);
    const input = {
      candidate: candidate(),
      channelId: CHANNEL,
      policy: OPEN_POLICY,
      permitExpiresAtMs: NOW + 30_000,
    };
    await expect(broker.issuePermit(A, input)).resolves.toMatchObject({
      decision: { eligible: true },
    });
    await expect(broker.preflight(A, { ...input, candidate: candidate({ candidateId: C }) }))
      .resolves.toEqual({
        eligible: false,
        reasonCode: 'invitation_outstanding',
        reasonClass: 'deferrable',
      });
  });

  it('preserves operator overrides and invalidates pending permits on DND/clear/disconnect', async () => {
    const { broker, store } = makeBroker();
    store.availability.set(B, {
      companionId: B,
      state: 'available',
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 60_000,
      source: 'operator',
      revision: 1,
    });
    await expect(broker.publishAvailability(B, {
      state: 'open_to_chat',
      expiresAtMs: NOW + 30_000,
      revision: 2,
    })).rejects.toThrow(/operator availability override/i);

    store.availability.set(B, { ...store.availability.get(B)!, source: 'runtime' });
    const pending: IcpInitiationPermit = {
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      provenanceRef: 'free-time:block:17',
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 30_000,
      status: 'issued',
      revision: 1,
    };
    store.permits.set(PERMIT_ID, pending);
    await broker.publishAvailability(B, {
      state: 'do_not_disturb',
      expiresAtMs: NOW + 30_000,
      revision: 2,
    });
    expect(store.permits.get(PERMIT_ID)).toMatchObject({
      status: 'revoked',
      reasonCode: 'peer_do_not_disturb',
    });

    store.permits.set(PERMIT_ID, pending);
    await broker.invalidateForCompanion(B, 'peer_offline');
    expect(store.permits.get(PERMIT_ID)).toMatchObject({ status: 'revoked', reasonCode: 'peer_offline' });
  });

  it('emits content-free gate/permit telemetry and never exposes the bearer permit id', async () => {
    const eventBus = new EventBus();
    const gates: unknown[] = [];
    const permits: unknown[] = [];
    eventBus.on('icp.initiation.gate', event => { gates.push(event); });
    eventBus.on('icp.permit.lifecycle', event => { permits.push(event); });
    const { broker, store } = makeBroker({ eventBus });
    await makeAvailable(store);
    await broker.issuePermit(A, {
      candidate: candidate(),
      channelId: CHANNEL,
      policy: OPEN_POLICY,
      permitExpiresAtMs: NOW + 30_000,
    });
    expect(gates).toHaveLength(1);
    expect(permits).toHaveLength(1);
    expect(JSON.stringify({ gates, permits })).not.toContain(PERMIT_ID);
    expect(JSON.stringify({ gates, permits })).not.toContain('reasonSummary');
  });
});
