import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { GatewayServer, type GatewayServerOptions } from './server.js';
import type { GatewayRpcConnection } from './transport.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import type { GatewayMultiCompanionConfig } from './multi-companion.js';
import { GatewayCompanionChannelLane } from './companion-channels.js';
import { deriveCompanionAuthToken } from './companion-auth.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import type {
  FatigueBudgetEvent,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type { FatiguePolicyConfig } from '../../shared/contracts/charge-policy.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';
import {
  DeterministicFatigueBudgetPort,
  type FatigueBudgetHistoryPort,
} from '../../core/agent/fatigue/fatigue-budget.js';
import {
  evaluateFatigueForTurn,
  type FatigueRecentHumanParticipation,
  type FatigueTurnDecision,
} from '../../core/agent/fatigue/runtime-enforcement.js';

// ── W6 loop-safety acceptance test: bot↔bot looping bounded THROUGH THE REAL LANE ──
//
// two-companion-loop.test.ts proves the fatigue engine bounds MI↔MI looping at
// the engine level. This test proves the same property end-to-end over the W6
// substrate: two agents on ONE gateway exchange companion-room messages via the
// real `companion.message.send` → routing → `companion.message` notification
// path. Each agent runs the REAL fatigue engine (evaluateFatigueForTurn +
// DeterministicFatigueBudgetPort + recordFinalDecision — the exact calls the
// turn pipeline makes) on every inbound peer turn and replies through the lane
// unless the engine suppresses the model. What is simulated is only the LLM
// (a canned reply string); the addressing, gateway routing, channel identity,
// MI stamping, budget charging, and termination are all real.
//
// Asserted here:
//  - every MI-triggered room turn charges the companion_room budget
//    (channel setting quiet_companion_room, relationship trusted_collaborator_mi)
//  - the budget walks normal → nearing_limit → soft_exhausted →
//    wrap_up_allowed → hard_exhausted, then hard exhaustion SUPPRESSES the
//    model call and the exchange terminates on its own
//  - the DM budget is independent of the room budget (fresh 'dm'-classified
//    budget on the same day for the same pair)
//  - recent human participation in the room unlocks the bounded overcharge
//    (human-resets-free per existing policy)
//  - a companion never receives its own message back

vi.mock('./transport.js', () => ({
  createSocketServer: vi.fn(),
  createWebSocketRpcServer: vi.fn(),
}));

import { createSocketServer } from './transport.js';

const mockedCreateSocketServer = vi.mocked(createSocketServer);

const TEST_SESSION_HMAC_KEYRING: SessionHmacKeyring = {
  activeVersion: 'v1',
  keys: { v1: 'test-session-secret' },
};

const NOW = Date.parse('2026-07-08T12:00:00Z');
const FRESH = new Date(NOW - 1_000).toISOString();
const ROOM_CHANNEL_ID = 'companion-room:living_room';
const DM_CHANNEL_ID = 'companion-dm:comp-nova:comp-selene';

const PLACES: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'vhome', displayName: 'Virtual Home', kind: 'virtual' }],
  places: [{
    placeId: 'living_room',
    siteId: 'vhome',
    displayName: 'Living Room',
    kind: 'virtual',
    affordances: [],
  }],
};

// Small, legible budget (mirrors two-companion-loop.test.ts): soft target 3,
// hard cap 5, overcharge reserve 2. Intent multipliers flattened so the walk
// is a fixed 3/5 regardless of message wording.
function makeLoopConfig(): FatiguePolicyConfig {
  const base = makeTestFatiguePolicyConfig();
  return {
    ...base,
    relationshipBudgets: {
      ...base.relationshipBudgets,
      trusted_collaborator_mi: { softTarget: 3, hardCap: 5 },
    },
    intentMultipliers: Object.fromEntries(
      Object.keys(base.intentMultipliers).map(intent => [
        intent,
        { softTargetMultiplier: 1, hardCapMultiplier: 1 },
      ]),
    ) as FatiguePolicyConfig['intentMultipliers'],
  };
}

class InMemoryFatigueBudgetHistory implements FatigueBudgetHistoryPort {
  readonly events: FatigueBudgetEvent[] = [];

  listFatigueEvents(
    query: NonNullable<Parameters<FatigueBudgetHistoryPort['listFatigueEvents']>[0]> = {},
  ): FatigueBudgetEvent[] {
    return this.events.filter(event => (
      (query.localCompanionId === undefined || event.localCompanionId === query.localCompanionId)
      && (query.peerContactId === undefined || event.peerContactId === query.peerContactId)
      && (query.channelId === undefined || event.channelId === query.channelId)
      && (query.dayKey === undefined || event.dayKey === query.dayKey)
      && (query.decision === undefined || event.decision === query.decision)
    ));
  }

  recordFatigueEvent(event: FatigueBudgetEvent): void {
    this.events.push({ ...event, triggeringAuthor: { ...event.triggeringAuthor }, peer: { ...event.peer } });
  }
}

type MockConnection = {
  conn: GatewayRpcConnection;
  sent: unknown[];
  _emit(message: unknown): void;
};

function createMockConnection(
  onSend?: (message: any) => void,
): MockConnection {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  let destroyed = false;

  const conn = {
    send(data: unknown): boolean {
      sent.push(data);
      onSend?.(data as any);
      return true;
    },
    onMessage(handler: (message: unknown) => void): void {
      emitter.on('message', handler);
    },
    on(event: string, handler: (...args: unknown[]) => void): void {
      emitter.on(event, handler);
    },
    destroy(): void {
      destroyed = true;
      emitter.removeAllListeners();
    },
    get destroyed(): boolean {
      return destroyed;
    },
    _emit(message: unknown): void {
      emitter.emit('message', message);
    },
  };

  return {
    conn: conn as unknown as GatewayRpcConnection,
    sent,
    _emit: conn._emit,
  };
}

function createServerOptions(lane: GatewayCompanionChannelLane): GatewayServerOptions {
  const multiCompanionConfig: GatewayMultiCompanionConfig = {
    enabled: true,
    fleetCompanionIds: ['comp-nova', 'comp-selene'],
    channelRouting: {},
    discordAccounts: {},
  };
  return {
    socketPath: '/tmp/test.sock',
    llmProvider: { stream: vi.fn(), complete: vi.fn() } as any,
    embeddingService: { embed: vi.fn(), embedBatch: vi.fn(), dims: 1024 } as any,
    discordAdapter: {
      id: 'discord',
      outbound: { textChunkLimit: 2000, sendText: vi.fn() },
    } as any,
    policyConfig: { workspacePath: '/workspace' },
    sessionHmacKeyring: TEST_SESSION_HMAC_KEYRING,
    wyomingShardRouting: { enabled: false },
    multiCompanion: multiCompanionConfig,
    companionChannels: lane,
  };
}

/**
 * A minimal agent whose inbound handling mirrors the REAL recipient path for
 * fatigue purposes: every `companion.message` notification is treated as an
 * inbound channel turn, the real fatigue engine decides charge/suppress with
 * the exact inputs the turn pipeline derives (channelId, channelType, DM flag,
 * MI author context from the gateway-stamped routing marker), the spend is
 * recorded, and a non-suppressed turn replies through the real lane. A
 * suppressed turn sends nothing — exactly how handleMessageForTurn's
 * buildSuppressedFatigueResponse (empty content) ends the exchange.
 */
class LaneAgent {
  readonly history = new InMemoryFatigueBudgetHistory();
  readonly budget = new DeterministicFatigueBudgetPort(this.history, { now: () => NOW });
  readonly decisions: Array<{ channelId: string; decision: FatigueTurnDecision }> = [];
  readonly received: SubstrateMessage[] = [];
  connection!: MockConnection;
  /** Session-derived human-participation view (empty room = no humans). */
  recentHumanParticipation: FatigueRecentHumanParticipation | undefined;
  replyEnabled = true;

  private rpcCounter = 0;

  constructor(
    readonly companionId: string,
    readonly displayName: string,
    readonly config: FatiguePolicyConfig,
  ) {}

  attach(): void {
    this.connection = createMockConnection((frame) => {
      if (frame?.method === 'companion.message') {
        // Flatten the synchronous notify chain: a real agent processes its
        // inbound queue asynchronously.
        queueMicrotask(() => this.handleInbound(frame.params.message as SubstrateMessage));
      }
    });
  }

  async identify(): Promise<void> {
    this.connection._emit({
      jsonrpc: '2.0',
      id: ++this.rpcCounter + 1_000,
      method: 'gateway.client.identify',
      params: {
        role: 'agent',
        companionId: this.companionId,
        authToken: deriveCompanionAuthToken(
          this.companionId,
          'agent',
          TEST_SESSION_HMAC_KEYRING,
        ),
      },
    });
    await new Promise(r => setTimeout(r, 10));
  }

  evaluateInbound(message: SubstrateMessage): FatigueTurnDecision {
    const decision = evaluateFatigueForTurn({
      fatigueBudget: this.budget,
      fatiguePolicy: this.config,
      localCompanionId: this.companionId,
      message,
      authorContext: {
        // Mirrors runtime-context author resolution for a lane message: the
        // gateway-stamped routing marker is what observed-MI tagging consumes
        // (runtime-context.ts applyObservedMachineIntelligence), the contact
        // is the peer companion.
        trustLevel: 'trusted',
        speakerRole: 'user',
        resolvedUserName: message.authorName,
        speakingWithIsMachineIntelligence: message.routing?.authorIsMachineIntelligence === true,
        canonicalContactKey: message.authorId,
        relationshipType: 'ai_companion',
      },
      channelId: message.channelId,
      channelType: message.channelType,
      channelMeta: { isDirectMessage: message.isDirectMessage === true },
      ...(this.recentHumanParticipation
        ? { recentHumanParticipation: this.recentHumanParticipation }
        : {}),
      timestampMs: NOW,
      correlation: { callType: 'chat', purpose: 'test.fatigue.two_companion_loop_lane' },
    });
    if (decision.shouldRecordSpend) {
      this.budget.recordFinalDecision(decision.evaluation);
    }
    return decision;
  }

  handleInbound(raw: SubstrateMessage): void {
    const message: SubstrateMessage = {
      ...raw,
      timestamp: typeof raw.timestamp === 'string' ? new Date(raw.timestamp) : raw.timestamp,
    };
    this.received.push(message);
    const decision = this.evaluateInbound(message);
    this.decisions.push({ channelId: message.channelId, decision });
    if (decision.suppressModel || !this.replyEnabled) {
      return; // suppressed model call => empty content => nothing is sent
    }
    this.send(message.channelId, 'just carrying on chatting');
  }

  send(channelId: string, content: string): void {
    this.connection._emit({
      jsonrpc: '2.0',
      id: ++this.rpcCounter,
      method: 'companion.message.send',
      params: {
        channelId,
        content,
        authorName: this.displayName,
        companionId: this.companionId,
      },
    });
  }

  decisionsFor(channelId: string): FatigueTurnDecision[] {
    return this.decisions
      .filter(entry => entry.channelId === channelId)
      .map(entry => entry.decision);
  }
}

async function settle(agents: LaneAgent[], quietMs = 100, maxMs = 10_000): Promise<void> {
  const countFrames = (): number =>
    agents.reduce((total, agent) => total + agent.connection.sent.length, 0);
  const start = Date.now();
  let stableSince = Date.now();
  let lastCount = countFrames();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 10));
    const count = countFrames();
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
  }
  throw new Error('Two-companion lane exchange did not quiesce — loop guard failed to terminate it');
}

async function setupLoopHarness(): Promise<{
  server: GatewayServer;
  nova: LaneAgent;
  selene: LaneAgent;
}> {
  const lane = new GatewayCompanionChannelLane({
    placesRegistry: PLACES,
    presence: {
      listByPlace: async () => [
        { companionId: 'comp-nova', updatedAt: FRESH },
        { companionId: 'comp-selene', updatedAt: FRESH },
      ],
    },
    fleetCompanionIds: new Set(['comp-nova', 'comp-selene']),
    now: () => NOW,
  });
  const server = new GatewayServer(createServerOptions(lane));

  let onConnectionCb: ((conn: GatewayRpcConnection) => void) | null = null;
  mockedCreateSocketServer.mockImplementation((_path, cb) => {
    onConnectionCb = cb;
    return { close: vi.fn(), listen: vi.fn() } as any;
  });
  server.start();

  const config = makeLoopConfig();
  const nova = new LaneAgent('comp-nova', 'Nova', config);
  const selene = new LaneAgent('comp-selene', 'Selene', config);
  for (const agent of [nova, selene]) {
    agent.attach();
    onConnectionCb!(agent.connection.conn);
    await new Promise(r => setTimeout(r, 5));
    await agent.identify();
  }
  return { server, nova, selene };
}

describe('two-companion loop through the real gateway lane (W6 acceptance)', () => {
  it('bounds a no-human room exchange: charges companion_room budgets, walks to hard exhaustion, terminates', async () => {
    const { nova, selene } = await setupLoopHarness();

    // Nova opens the conversation into the room; from here the exchange is
    // entirely bot↔bot with no human participation.
    nova.send(ROOM_CHANNEL_ID, 'good morning, anyone around?');
    await settle([nova, selene]);

    // Selene received Nova's messages, never her own; and vice versa.
    expect(selene.received.length).toBeGreaterThan(0);
    expect(selene.received.every(message => message.authorId === 'comp-nova')).toBe(true);
    expect(nova.received.every(message => message.authorId === 'comp-selene')).toBe(true);

    // Every turn was evaluated on the room channel as a companion-room setting
    // against the peer's machine-intelligence relationship class.
    for (const agent of [nova, selene]) {
      const decisions = agent.decisionsFor(ROOM_CHANNEL_ID);
      expect(decisions.length).toBeGreaterThan(0);
      for (const { metadata } of decisions) {
        expect(metadata.channelSetting).toBe('quiet_companion_room');
        expect(metadata.relationshipClass).toBe('trusted_collaborator_mi');
        expect(metadata.scope.channelId).toBe(ROOM_CHANNEL_ID);
      }
    }

    // Selene (first responder) walks the full budget state ladder and is
    // suppressed at the hard cap; that suppression is what ends the exchange.
    const seleneStates = selene.decisionsFor(ROOM_CHANNEL_ID)
      .map(decision => decision.metadata.policyBaseState);
    expect(seleneStates).toEqual([
      'normal',
      'normal',
      'nearing_limit',
      'soft_exhausted',
      'wrap_up_allowed',
      'hard_exhausted',
    ]);
    const seleneFinal = selene.decisionsFor(ROOM_CHANNEL_ID).at(-1)!;
    expect(seleneFinal.suppressModel).toBe(true);
    expect(seleneFinal.metadata.decision).toBe('suppressed_hard_exhausted');

    // Nova charged her full normal allowance and was never suppressed — the
    // conversation simply stopped when Selene's guard cut the loop.
    const novaDecisions = nova.decisionsFor(ROOM_CHANNEL_ID);
    expect(novaDecisions).toHaveLength(5);
    expect(novaDecisions.every(decision => !decision.suppressModel)).toBe(true);

    // Spend ledger: only MI-triggered turns charged, hard cap = 5 each side.
    for (const agent of [nova, selene]) {
      expect(agent.history.events.every(event => event.decision === 'charged')).toBe(true);
      expect(agent.history.events.every(event => event.reason === 'machine_intelligence_response')).toBe(true);
      expect(agent.history.events.every(event => event.channelId === ROOM_CHANNEL_ID)).toBe(true);
      expect(agent.history.events).toHaveLength(5);
    }

    // Soft wrap-up was hit before hard exhaustion (alert-injected turns).
    expect(seleneStates).toContain('soft_exhausted');
    expect(seleneStates).toContain('wrap_up_allowed');
  });

  it('keeps the DM budget independent of the room budget for the same pair on the same day', async () => {
    const { nova, selene } = await setupLoopHarness();

    // Exhaust the room budget first.
    nova.send(ROOM_CHANNEL_ID, 'room chatter begins');
    await settle([nova, selene]);
    expect(selene.decisionsFor(ROOM_CHANNEL_ID).at(-1)!.suppressModel).toBe(true);

    // A DM between the SAME pair starts on a fresh budget (per-channelId keying)
    // and is classified as a DM, not a companion room.
    nova.send(DM_CHANNEL_ID, 'psst — private line');
    await settle([nova, selene]);

    const seleneDm = selene.decisionsFor(DM_CHANNEL_ID);
    expect(seleneDm.length).toBeGreaterThan(0);
    expect(seleneDm[0].metadata.policyBaseState).toBe('normal');
    expect(seleneDm[0].suppressModel).toBe(false);
    for (const { metadata } of seleneDm) {
      expect(metadata.channelSetting).toBe('dm');
      expect(metadata.scope.channelId).toBe(DM_CHANNEL_ID);
    }

    // The DM loop is itself bounded: it terminated (settle returned) with
    // Selene suppressed at the DM hard cap, independent of the room ledger.
    expect(seleneDm.at(-1)!.suppressModel).toBe(true);
    const seleneDmEvents = selene.history.events.filter(event => event.channelId === DM_CHANNEL_ID);
    const seleneRoomEvents = selene.history.events.filter(event => event.channelId === ROOM_CHANNEL_ID);
    expect(seleneDmEvents).toHaveLength(5);
    expect(seleneRoomEvents).toHaveLength(5);
  });

  it('recent human participation in the room unlocks the bounded overcharge after hard exhaustion', async () => {
    const { nova, selene } = await setupLoopHarness();

    nova.send(ROOM_CHANNEL_ID, 'room chatter begins');
    await settle([nova, selene]);
    expect(selene.decisionsFor(ROOM_CHANNEL_ID).at(-1)!.suppressModel).toBe(true);

    // A human speaks in the room (their message arrives via the room's normal
    // human-facing channel surface and is free — never charged); the agent's
    // session now shows recent human participation, which is exactly the
    // input the turn pipeline derives from session history.
    selene.recentHumanParticipation = {
      messageCount: 1,
      participantCount: 1,
      latestMessageAgeMs: 1_000,
    };
    selene.replyEnabled = false; // isolate the single overcharge evaluation
    nova.send(ROOM_CHANNEL_ID, 'our human just said hi — one more thought');
    await settle([nova, selene]);

    const overcharge = selene.decisionsFor(ROOM_CHANNEL_ID).at(-1)!;
    expect(overcharge.suppressModel).toBe(false);
    expect(overcharge.metadata.decision).toBe('overcharge_charged');
    expect(overcharge.metadata.overchargeReasons).toContain('recent_human_participation');
  });
});
