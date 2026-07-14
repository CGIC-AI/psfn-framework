import { describe, expect, it, vi } from 'vitest';

import type {
  IcpAutonomyInvalidationFence,
  IcpPermitConsumptionInput,
  IcpPermitConsumptionResult,
  IcpSharedAutonomyStorePort,
  IcpConversationTransitionInput,
} from '../../core/icp/autonomy-store-ports.js';
import {
  IcpAutonomyInvalidationConflictError,
  IcpOutstandingInvitationConflictError,
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
const PROVENANCE_HANDLE = `icp-prov:${CANDIDATE_ID}`;

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
    provenanceRef: PROVENANCE_HANDLE,
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
  invalidationGenerations = new Map<string, number>();
  invalidationReasons = new Map<string, IcpAutonomyReasonCode>();
  beforeCreateEpisodeAndIssuePermit?: () => Promise<void>;
  beforeConsumePermit?: () => Promise<void>;
  beforeAvailabilityInvalidationCommit?: () => Promise<void>;

  async publishAvailability(lease: IcpAvailabilityLease): Promise<IcpAvailabilityLease> {
    return this.publishAvailabilityNow(lease);
  }

  private publishAvailabilityNow(lease: IcpAvailabilityLease): IcpAvailabilityLease {
    const current = this.availability.get(lease.companionId);
    if ((current && current.revision + 1 !== lease.revision) || (!current && lease.revision !== 1)) {
      throw new Error('revision conflict');
    }
    if (current?.source === 'operator'
      && current.expiresAtMs > lease.issuedAtMs
      && lease.source !== 'operator') {
      throw new Error('operator availability override');
    }
    this.availability.set(lease.companionId, lease);
    return lease;
  }

  async publishAvailabilityAndInvalidate(
    lease: IcpAvailabilityLease,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<{ lease: IcpAvailabilityLease; revokedPermits: IcpInitiationPermit[] }> {
    await this.beforeAvailabilityInvalidationCommit?.();
    const published = this.publishAvailabilityNow(lease);
    const revokedPermits = this.revokeOutstandingPermitsForCompanionNow(
      lease.companionId,
      lease.issuedAtMs,
      reasonCode,
    );
    return { lease: published, revokedPermits };
  }

  async getAvailability(companionId: string): Promise<IcpAvailabilityLease | null> {
    return this.availability.get(companionId) ?? null;
  }

  async clearAvailability(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilityLease['source']; nowMs: number },
  ): Promise<boolean> {
    return this.clearAvailabilityNow(companionId, expectedRevision, request);
  }

  private clearAvailabilityNow(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilityLease['source']; nowMs: number },
  ): boolean {
    const current = this.availability.get(companionId);
    if (current?.revision !== expectedRevision) return false;
    if (current.source === 'operator'
      && current.expiresAtMs > request.nowMs
      && request.source !== 'operator') return false;
    return this.availability.delete(companionId);
  }

  async clearAvailabilityAndInvalidate(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilityLease['source']; nowMs: number },
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<{ cleared: boolean; revokedPermits: IcpInitiationPermit[] }> {
    await this.beforeAvailabilityInvalidationCommit?.();
    const cleared = this.clearAvailabilityNow(companionId, expectedRevision, request);
    return {
      cleared,
      revokedPermits: cleared
        ? this.revokeOutstandingPermitsForCompanionNow(companionId, request.nowMs, reasonCode)
        : [],
    };
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

  async captureInvalidationFence(
    firstCompanionId: string,
    secondCompanionId: string,
  ): Promise<IcpAutonomyInvalidationFence> {
    const pair = [firstCompanionId, secondCompanionId].sort();
    return { companions: [
      { companionId: pair[0]!, generation: this.invalidationGenerations.get(pair[0]!) ?? 0 },
      { companionId: pair[1]!, generation: this.invalidationGenerations.get(pair[1]!) ?? 0 },
    ] };
  }

  assertInvalidationFence(fence: IcpAutonomyInvalidationFence): void {
    for (const entry of fence.companions) {
      if ((this.invalidationGenerations.get(entry.companionId) ?? 0) === entry.generation) continue;
      throw new IcpAutonomyInvalidationConflictError(
        this.invalidationReasons.get(entry.companionId) ?? 'operator_cancelled',
      );
    }
  }

  async issuePermit(input: {
    permit: IcpInitiationPermit;
    expectedInvalidationFence: IcpAutonomyInvalidationFence;
  }): Promise<IcpInitiationPermit> {
    this.assertInvalidationFence(input.expectedInvalidationFence);
    const { permit } = input;
    const outstanding = await this.findOutstandingPermitBetween(
      permit.senderCompanionId,
      permit.recipientCompanionId,
      permit.issuedAtMs,
    );
    if (outstanding) throw new IcpOutstandingInvitationConflictError();
    this.permits.set(permit.permitId, permit);
    return permit;
  }

  async createEpisodeAndIssuePermit(input: {
    episode: IcpConversationEpisode;
    permit: IcpInitiationPermit;
    expectedInvalidationFence: IcpAutonomyInvalidationFence;
  }): Promise<{ episode: IcpConversationEpisode; permit: IcpInitiationPermit }> {
    await this.beforeCreateEpisodeAndIssuePermit?.();
    this.assertInvalidationFence(input.expectedInvalidationFence);
    const episode = await this.createEpisode(input.episode);
    try {
      const permit = await this.issuePermit({
        permit: input.permit,
        expectedInvalidationFence: input.expectedInvalidationFence,
      });
      return { episode, permit };
    } catch (error) {
      this.episodes.delete(episode.conversationId);
      throw error;
    }
  }

  async getPermit(permitId: string): Promise<IcpInitiationPermit | null> {
    return this.permits.get(permitId) ?? null;
  }

  async getPermitByCandidate(candidateId: string): Promise<IcpInitiationPermit | null> {
    return [...this.permits.values()].find(permit => permit.candidateId === candidateId) ?? null;
  }

  async consumePermit(input: IcpPermitConsumptionInput): Promise<IcpPermitConsumptionResult> {
    await this.beforeConsumePermit?.();
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
    this.assertInvalidationFence(input.expectedInvalidationFence);
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
    return this.revokeOutstandingPermitsForCompanionNow(companionId, revokedAtMs, reasonCode);
  }

  private revokeOutstandingPermitsForCompanionNow(
    companionId: string,
    revokedAtMs: number,
    reasonCode: IcpAutonomyReasonCode,
  ): IcpInitiationPermit[] {
    this.invalidationGenerations.set(
      companionId,
      (this.invalidationGenerations.get(companionId) ?? 0) + 1,
    );
    this.invalidationReasons.set(companionId, reasonCode);
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

  async revokeOutstandingPermitsOutsideFleet(
    knownCompanionIds: readonly string[],
    revokedAtMs: number,
  ): Promise<IcpInitiationPermit[]> {
    const known = new Set(knownCompanionIds);
    const revoked: IcpInitiationPermit[] = [];
    for (const permit of this.permits.values()) {
      if (permit.status !== 'issued'
        || (known.has(permit.senderCompanionId) && known.has(permit.recipientCompanionId))) continue;
      for (const companionId of [permit.senderCompanionId, permit.recipientCompanionId]) {
        if (known.has(companionId)) continue;
        this.invalidationGenerations.set(
          companionId,
          (this.invalidationGenerations.get(companionId) ?? 0) + 1,
        );
        this.invalidationReasons.set(companionId, 'unknown_participant');
      }
      const next: IcpInitiationPermit = {
        ...permit,
        status: 'revoked',
        revokedAtMs,
        reasonCode: 'unknown_participant',
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
  policy?: IcpInitiationPolicySnapshot;
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
    policyAuthority: {
      resolve: async () => input.policy ?? OPEN_POLICY,
      authorizeHandoff: async () => ({
        eligible: input.policy?.canonicalPeerContact !== false
          && input.policy?.trustAllows !== false
          && input.policy?.senderBlocksPeer !== true
          && input.policy?.peerBlocksSender !== true,
        ...(input.policy?.canonicalPeerContact === false
          ? { reasonCode: 'invalid_identity' as const }
          : input.policy?.senderBlocksPeer === true || input.policy?.peerBlocksSender === true
            ? { reasonCode: 'peer_blocked' as const }
            : input.policy?.trustAllows === false
              ? { reasonCode: 'policy_denied' as const }
              : {}),
      }),
      runAuthorizedHandoff: async (_input, operation) => {
        const eligible = input.policy?.canonicalPeerContact !== false
          && input.policy?.trustAllows !== false
          && input.policy?.senderBlocksPeer !== true
          && input.policy?.peerBlocksSender !== true;
        if (!eligible) {
          return {
            decision: {
              eligible: false as const,
              reasonCode: input.policy?.canonicalPeerContact === false
                ? 'invalid_identity' as const
                : input.policy?.senderBlocksPeer === true || input.policy?.peerBlocksSender === true
                  ? 'peer_blocked' as const
                  : 'policy_denied' as const,
            },
          };
        }
        return { decision: { eligible: true as const }, result: await operation() };
      },
    },
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

function deferred(): { reached: Promise<void>; release: () => void; wait: () => Promise<void> } {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { markReached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return {
    reached,
    release,
    wait: async () => {
      markReached();
      await released;
    },
  };
}

type InvalidationRaceKind =
  | 'dnd'
  | 'sender_block'
  | 'recipient_block'
  | 'disconnect'
  | 'operator_cancel';

const INVALIDATION_RACES: readonly [
  kind: InvalidationRaceKind,
  reasonCode: IcpAutonomyReasonCode,
][] = [
  ['dnd', 'peer_do_not_disturb'],
  ['sender_block', 'peer_blocked'],
  ['recipient_block', 'peer_blocked'],
  ['disconnect', 'peer_offline'],
  ['operator_cancel', 'operator_cancelled'],
];

async function triggerInvalidationRace(
  broker: GatewayIcpAutonomyBroker,
  kind: InvalidationRaceKind,
): Promise<void> {
  switch (kind) {
    case 'dnd':
      await broker.publishAvailability(B, {
        state: 'do_not_disturb',
        expiresAtMs: NOW + 30_000,
        revision: 2,
      });
      return;
    case 'sender_block':
      await broker.invalidateForCompanion(A, 'peer_blocked');
      return;
    case 'recipient_block':
      await broker.invalidateForCompanion(B, 'peer_blocked');
      return;
    case 'disconnect':
      await broker.invalidateForCompanion(B, 'peer_offline');
      return;
    case 'operator_cancel':
      await broker.invalidateForCompanion(B, 'operator_cancelled');
  }
}

describe('GatewayIcpAutonomyBroker', () => {
  it('strictly rejects private candidate fields and sender-supplied policy claims', () => {
    expect(() => parseIcpInitiationPreflightInput({
      candidate: { ...candidate(), reasonSummary: 'must stay private' },
      channelId: CHANNEL,
    }, NOW)).toThrow(/unknown key.*reasonSummary/i);
    expect(() => parseIcpInitiationPreflightInput({
      candidate: candidate(),
      channelId: CHANNEL,
      policy: OPEN_POLICY,
    }, NOW)).toThrow(/unknown key.*policy/i);
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
    const { broker, store } = makeBroker({ policy: { ...OPEN_POLICY, [key]: value } });
    await makeAvailable(store);
    await expect(broker.preflight(A, {
      candidate: candidate(),
      channelId: CHANNEL,
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

  it('reads own effective availability and explains operator control without peer lookup', async () => {
    const { broker, store } = makeBroker();
    await expect(broker.readOwnAvailability(A)).resolves.toEqual({
      eligible: false,
      reasonCode: 'availability_missing',
      control: 'missing',
      mutableByCompanion: true,
    });
    store.availability.set(A, {
      companionId: A,
      state: 'do_not_disturb',
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 60_000,
      source: 'operator',
      revision: 4,
    });
    await expect(broker.readOwnAvailability(A)).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'peer_do_not_disturb',
      control: 'operator_override',
      mutableByCompanion: false,
      lease: { source: 'operator', revision: 4 },
    });
  });

  it('prepares only an exact current permit handoff and returns no candidate text', async () => {
    const { broker, store } = makeBroker();
    await makeAvailable(store);
    const issued = await broker.issuePermit(A, {
      candidate: candidate(),
      channelId: CHANNEL,
      permitExpiresAtMs: NOW + 30_000,
    });
    expect(issued.permit).toBeDefined();

    const result = await broker.prepareInitiationHandoff(A, {
      permitId: issued.permit!.permitId,
      peerContactId: 'peer-contact-b',
    });
    expect(result).toMatchObject({
      authorized: true,
      rootInitiationId: ROOT_ID,
      permit: {
        permitId: PERMIT_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
      },
    });
    expect(JSON.stringify(result)).not.toContain('reasonSummary');

    await expect(broker.prepareInitiationHandoff(B, {
      permitId: issued.permit!.permitId,
      peerContactId: 'peer-contact-a',
    })).resolves.toEqual({ authorized: false, reasonCode: 'permit_mismatch' });
  });

  it('reconciles permit issue idempotently by candidate after a response is lost', async () => {
    const { broker, store, eventBus } = makeBroker();
    await makeAvailable(store);
    const lifecycle = vi.fn();
    eventBus.on('icp.permit.lifecycle', lifecycle);
    const input = {
      candidate: candidate(),
      channelId: CHANNEL,
      permitExpiresAtMs: NOW + 30_000,
    };

    const committed = await broker.issuePermit(A, input);
    const reconciled = await broker.issuePermit(A, input);

    expect(reconciled).toEqual(committed);
    expect(store.permits.size).toBe(1);
    expect(store.episodes.size).toBe(1);
    expect(lifecycle).toHaveBeenCalledOnce();
  });

  it.each([
    ['revoked', 'permit_revoked'],
    ['expired', 'permit_expired'],
  ] as const)('rejects %s permits before target-channel handoff', async (status, reasonCode) => {
    const { broker, store } = makeBroker();
    await makeAvailable(store);
    store.episodes.set(CONVERSATION_ID, {
      conversationId: CONVERSATION_ID,
      channelId: CHANNEL,
      participantCompanionIds: [A, B],
      rootInitiationId: ROOT_ID,
      initiatedByCompanionId: A,
      initiationSource: 'foreground',
      provenanceRef: PROVENANCE_HANDLE,
      openedAtMs: NOW - 1_000,
      lastActivityAtMs: NOW - 1_000,
      status: 'invited',
      revision: 1,
    });
    store.permits.set(PERMIT_ID, {
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      provenanceRef: PROVENANCE_HANDLE,
      issuedAtMs: NOW - 2_000,
      expiresAtMs: status === 'expired' ? NOW - 1 : NOW + 10_000,
      status,
      ...(status === 'revoked' ? { revokedAtMs: NOW - 1_000 } : {}),
      reasonCode,
      revision: 2,
    });
    await expect(broker.prepareInitiationHandoff(A, {
      permitId: PERMIT_ID,
      peerContactId: 'peer-contact-b',
    })).resolves.toEqual({ authorized: false, reasonCode });
  });

  it('admits only exact W3 recovery for an already-consumed permit without a current lease', async () => {
    const { broker, store } = makeBroker({ ready: false });
    store.episodes.set(CONVERSATION_ID, {
      conversationId: CONVERSATION_ID,
      channelId: CHANNEL,
      participantCompanionIds: [A, B],
      rootInitiationId: ROOT_ID,
      initiatedByCompanionId: A,
      initiationSource: 'foreground',
      provenanceRef: PROVENANCE_HANDLE,
      openedAtMs: NOW - 10_000,
      lastActivityAtMs: NOW - 10_000,
      status: 'invited',
      revision: 1,
    });
    store.permits.set(PERMIT_ID, {
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      provenanceRef: PROVENANCE_HANDLE,
      issuedAtMs: NOW - 20_000,
      expiresAtMs: NOW - 1,
      status: 'consumed',
      consumedAtMs: NOW - 5_000,
      revision: 2,
    });
    await expect(broker.prepareInitiationHandoff(A, {
      permitId: PERMIT_ID,
      peerContactId: 'peer-contact-b',
    })).resolves.toMatchObject({
      authorized: true,
      rootInitiationId: ROOT_ID,
      permit: { status: 'consumed', permitId: PERMIT_ID },
    });
  });

  it('issues one exact-bound permit, consumes once, and classifies replay/substitution', async () => {
    const { broker, store, alarm } = makeBroker();
    await makeAvailable(store);
    const input = parseIcpInitiationPermitIssueInput({
      candidate: candidate(),
      channelId: CHANNEL,
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
      rootInitiationId: ROOT_ID,
      peerContactId: 'contact-b',
    };
    await expect(broker.consumePermit(A, { ...consumeInput, rootInitiationId: C }))
      .resolves.toMatchObject({ outcome: 'mismatch' });
    expect(store.permits.get(PERMIT_ID)).toMatchObject({ status: 'issued', revision: 1 });
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

  it('revalidates canonical handoff policy while the final permit operation is guarded', async () => {
    const policy = { ...OPEN_POLICY };
    const { broker, store } = makeBroker({ policy });
    await makeAvailable(store);
    await expect(broker.issuePermit(A, {
      candidate: candidate(),
      channelId: CHANNEL,
      permitExpiresAtMs: NOW + 30_000,
    })).resolves.toMatchObject({ decision: { eligible: true } });
    policy.trustAllows = false;

    await expect(broker.consumePermit(A, {
      permitId: PERMIT_ID,
      conversationId: CONVERSATION_ID,
      recipientCompanionId: B,
      channelId: CHANNEL,
      rootInitiationId: ROOT_ID,
      peerContactId: 'contact-b',
    })).resolves.toMatchObject({ outcome: 'mismatch', reasonCode: 'policy_denied' });
    expect(store.permits.get(PERMIT_ID)).toMatchObject({ status: 'issued', revision: 1 });
  });

  it('allows only one outstanding invitation per unordered pair', async () => {
    const { broker, store } = makeBroker();
    await makeAvailable(store);
    const input = {
      candidate: candidate(),
      channelId: CHANNEL,
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

  it('preserves unrelated store failures even when an invitation is outstanding', async () => {
    const { broker, store } = makeBroker();
    await makeAvailable(store);
    const input = {
      candidate: candidate(),
      channelId: CHANNEL,
      permitExpiresAtMs: NOW + 30_000,
    };
    await expect(broker.issuePermit(A, input)).resolves.toMatchObject({
      decision: { eligible: true },
    });

    const databaseFailure = new Error('database unavailable');
    vi.spyOn(store, 'findOutstandingPermitBetween').mockResolvedValueOnce(null);
    vi.spyOn(store, 'createEpisodeAndIssuePermit').mockRejectedValueOnce(databaseFailure);
    await expect(broker.issuePermit(A, {
      ...input,
      candidate: candidate({ candidateId: C }),
    })).rejects.toBe(databaseFailure);
  });

  it.each(INVALIDATION_RACES)(
    'linearizes permit issue against %s invalidation',
    async (kind, reasonCode) => {
      const { broker, store } = makeBroker();
      await makeAvailable(store);
      const gate = deferred();
      store.beforeCreateEpisodeAndIssuePermit = gate.wait;
      const issuing = broker.issuePermit(A, {
        candidate: candidate(),
        channelId: CHANNEL,
        permitExpiresAtMs: NOW + 30_000,
      });
      await gate.reached;
      await triggerInvalidationRace(broker, kind);
      gate.release();

      await expect(issuing).resolves.toMatchObject({
        decision: { eligible: false, reasonCode },
      });
      expect(store.permits.size).toBe(0);
      expect(store.episodes.size).toBe(0);
    },
  );

  it.each(INVALIDATION_RACES)(
    'linearizes permit consumption against %s invalidation',
    async (kind, reasonCode) => {
      const { broker, store } = makeBroker();
      await makeAvailable(store);
      const issued = await broker.issuePermit(A, {
        candidate: candidate(),
        channelId: CHANNEL,
        permitExpiresAtMs: NOW + 30_000,
      });
      expect(issued.permit).toBeDefined();
      const gate = deferred();
      store.beforeConsumePermit = gate.wait;
      const consuming = broker.consumePermit(A, {
        permitId: PERMIT_ID,
        conversationId: CONVERSATION_ID,
        recipientCompanionId: B,
        channelId: CHANNEL,
        rootInitiationId: ROOT_ID,
        peerContactId: 'contact-b',
      });
      await gate.reached;
      await triggerInvalidationRace(broker, kind);
      gate.release();

      await expect(consuming).resolves.toMatchObject({
        outcome: 'revoked',
        permit: { status: 'revoked', reasonCode },
      });
    },
  );

  it('does not expose restrictive availability before its fence and permit invalidation commit', async () => {
    const { broker, store } = makeBroker();
    await makeAvailable(store);
    store.permits.set(PERMIT_ID, {
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      provenanceRef: PROVENANCE_HANDLE,
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 30_000,
      status: 'issued',
      revision: 1,
    });
    const gate = deferred();
    store.beforeAvailabilityInvalidationCommit = gate.wait;

    const publishing = broker.publishAvailability(B, {
      state: 'do_not_disturb',
      expiresAtMs: NOW + 30_000,
      revision: 2,
    });
    await gate.reached;
    expect(store.availability.get(B)?.state).toBe('open_to_chat');
    expect(store.permits.get(PERMIT_ID)?.status).toBe('issued');
    gate.release();

    await expect(publishing).resolves.toMatchObject({ state: 'do_not_disturb' });
    expect(store.permits.get(PERMIT_ID)).toMatchObject({
      status: 'revoked',
      reasonCode: 'peer_do_not_disturb',
    });
  });

  it('does not expose a cleared lease before its fence and permit invalidation commit', async () => {
    const { broker, store } = makeBroker();
    await makeAvailable(store);
    store.permits.set(PERMIT_ID, {
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      provenanceRef: PROVENANCE_HANDLE,
      issuedAtMs: NOW - 1_000,
      expiresAtMs: NOW + 30_000,
      status: 'issued',
      revision: 1,
    });
    const gate = deferred();
    store.beforeAvailabilityInvalidationCommit = gate.wait;

    const clearing = broker.clearAvailability(B, 1);
    await gate.reached;
    expect(store.availability.get(B)?.state).toBe('open_to_chat');
    expect(store.permits.get(PERMIT_ID)?.status).toBe('issued');
    gate.release();

    await expect(clearing).resolves.toBe(true);
    expect(store.availability.has(B)).toBe(false);
    expect(store.permits.get(PERMIT_ID)).toMatchObject({
      status: 'revoked',
      reasonCode: 'availability_missing',
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
      provenanceRef: PROVENANCE_HANDLE,
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
      permitExpiresAtMs: NOW + 30_000,
    });
    expect(gates).toHaveLength(1);
    expect(permits).toHaveLength(1);
    expect(JSON.stringify({ gates, permits })).not.toContain(PERMIT_ID);
    expect(JSON.stringify({ gates, permits })).not.toContain('reasonSummary');
  });
});
