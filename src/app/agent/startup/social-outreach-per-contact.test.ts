// ── Acceptance: per-contact proactive outreach end to end (psfn-framework-vcq8v.4) ──
//
// A felt EmoSim impulse raises per-contact social pressure; each eligible
// contact gets ONE fresh companion turn in its own internal outreach channel
// carrying who they are, when you last talked, the last exchange, what you did
// since, and how you feel. The companion writes the message with
// notify action=outreach_send; the runtime routes it to the human's private
// DM (ProactiveOutboundDispatcher) or to the companion through ICP. There is
// no group path, and nothing from the outreach channel reaches a session store.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { wireReflectionRuntime } from '../../startup/composition/parity.js';
import { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime-base.js';
import { composeCompanionDmChannelId } from '../../../shared/contracts/companion-channels.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import type { PostTurnActionHandler, PostTurnActionRuntime } from '../../../core/agent/post-turn-action-runtime.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { EmoSimProactivityImpulse } from '../../../core/emotion/emosim-proactivity-port.js';
import type {
  SocialImpulseLedgerRecord,
  SocialImpulseOutreachStorePort,
} from '../../../core/emotion/social-impulse-outreach.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND } from '../../../core/intention/appraisal.js';
import type { ActiveConcernSnapshot } from '../../../core/intention/appraisal/types.js';
import type { ActiveConcern } from '../../../core/intention/concerns.js';
import { createFileOutreachOutboxStore } from '../../../core/intention/outreach-outbox.js';
import {
  createApprovedPrimaryChannelPolicy,
  ProactiveOutboundDispatcher,
} from '../../../core/intention/proactive-outbound.js';
import {
  createInMemorySocialDesireBackend,
  createSocialDesireStorePort,
} from '../../../core/intention/social-desire-store-port.js';
import type { SocialDesire } from '../../../core/intention/social-desire.js';
import { createSocialOutreachDraftRegistry } from '../../../core/intention/social-outreach-turn/drafts.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import { buildGroupChatSession } from '../../../core/session/group-chat-harness/fixtures.js';
import { createNotifyTool } from '../../../core/tools/ntfy.js';
import { ExternalCommunicationRateLimiter } from '../../../system/capabilities/safeguards.js';
import { DEFAULT_SOCIAL_DESIRE_CONFIG } from '../../../system/config/scheduler-config.js';
import { registerSocialDesireLane } from './social-desire-lane.js';
import { registerSocialImpulseOutreachLane } from './social-impulse-outreach-lane.js';

const HOUR = 3_600_000;
const LOCAL_COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const PEER_COMPANION_ID = '22222222-2222-4222-8222-222222222222';
const HUMAN_DM = '123456789012345678';
const GROUP_ROOM = '876543210987654321';
const COMPANION_DM = composeCompanionDmChannelId(
  createCompanionId(LOCAL_COMPANION_ID),
  createCompanionId(PEER_COMPANION_ID),
);
const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function contacts(nowMs: number): Map<string, Contact> {
  const seen = new Date(nowMs - 2 * HOUR).toISOString();
  return new Map<string, Contact>([
    ['contact-human', {
      id: 'contact-human', displayName: 'Morgan Example', nickname: 'Mo', trustLevel: 'primary',
      relationshipType: 'partner', timezone: 'UTC', firstSeen: seen, lastSeen: seen,
      conversationChannels: [
        { channel: 'discord', channelId: HUMAN_DM, firstSeen: seen, lastSeen: seen },
        { channel: 'discord', channelId: GROUP_ROOM, firstSeen: seen, lastSeen: seen },
      ],
    }],
    ['contact-peer', {
      id: 'contact-peer', displayName: 'Nova', trustLevel: 'known', relationshipType: 'ai_companion',
      isMachineIntelligence: true, firstSeen: seen, lastSeen: seen,
    }],
  ]);
}

function liveDesire(contactId: string, nowMs: number, tier: SocialDesire['tierAtLastTick']): SocialDesire {
  const felt = new Date(nowMs - 16 * HOUR).toISOString();
  return {
    contactId, warmPressure: 0.3, repairPressure: 0, pressureAnchorAt: new Date(nowMs).toISOString(),
    lastWarmFeltAt: felt, lastWarmTickAt: felt, tickCount: 3, absorbedSignalCount: 0,
    tierAtLastTick: tier, reinforcedConcernIds: [], createdAt: felt,
  };
}

function memoryLedger(): SocialImpulseOutreachStorePort {
  const rows = new Map<string, SocialImpulseLedgerRecord>();
  return {
    async recordImpulse(record) {
      const prior = rows.get(record.impulseId);
      if (prior) return { created: false, record: prior };
      rows.set(record.impulseId, record);
      return { created: true, record };
    },
    async settleImpulse(input) {
      const settled = {
        ...rows.get(input.impulseId)!, state: input.state,
        boostedContactCount: input.boostedContactCount, reasonCode: input.reasonCode ?? null,
      };
      rows.set(input.impulseId, settled);
      return settled;
    },
  };
}

function impulse(nowMs: number): EmoSimProactivityImpulse {
  const correlationId = `felt-impulse:would_message:${nowMs}`;
  return {
    schemaVersion: 1, impulseVersion: 'emosim-proactivity.impulse.v1', kind: 'would_message',
    companionId: LOCAL_COMPANION_ID, source: { model: 'test', version: '1' },
    lineage: {
      schemaVersion: 1, inputId: 'input-1', projectionVersion: 'v1',
      privacyClass: 'content_redacted', rawContentRedacted: true,
    },
    firstCrossingMs: nowMs, firedAtMs: nowMs,
    thresholdProfile: {} as EmoSimProactivityImpulse['thresholdProfile'],
    dedupeKey: correlationId, correlationId, confidence: 1,
    availability: 'available', authority: 'qualified_source_fire',
  };
}

async function harness(options: {
  nowMs: number;
  desires?: SocialDesire[];
  concernStore?: { list: (...args: never[]) => Promise<ActiveConcern[]>; transitionConcernStatus: (...args: never[]) => Promise<ActiveConcern | null> };
  getActiveConcerns?: () => Promise<readonly ActiveConcernSnapshot[]>;
}) {
    const nowMs = options.nowMs;
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-social-outreach-'));
    TEMP_DIRS.push(dataDir);
    const { manager, store: sessionStore } = buildGroupChatSession(dataDir);
    manager.recordUserMessage(HUMAN_DM, 'I am heading to the coast this weekend', 'discord-mo', 'Mo', true);
    manager.recordAssistantMessage(HUMAN_DM, 'Oh lovely, send me a picture of the sea!', undefined, true);
    manager.recordAssistantMessage(COMPANION_DM, 'Your garden notes were great.', undefined, true);
    const channelsBefore = new Set(sessionStore.listChannels().map(entry => entry.channelId));

    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
    const handlers = new Map<string, PostTurnActionHandler>();
    const enqueued: InferredPostTurnAction[] = [];
    const postTurnActions = fromAny<PostTurnActionRuntime, unknown>({
      enqueue: vi.fn((action: InferredPostTurnAction) => { enqueued.push(action); return 'queued'; }),
      registerHandler: vi.fn((kind: string, handler: PostTurnActionHandler) => {
        handlers.set(kind, handler);
        return () => undefined;
      }),
      getStatus: vi.fn(() => ({ persistence: { enabled: false } })),
    });
    const sentToHumans: Array<{ channelId: string; content: string }> = [];
    const proactiveOutbound = new ProactiveOutboundDispatcher({
      sender: { send: async (channelId, content) => { sentToHumans.push({ channelId, content }); } },
      rateLimiter: new ExternalCommunicationRateLimiter(),
      isApprovedPrimaryChannel: createApprovedPrimaryChannelPolicy(HUMAN_DM),
    });
    // The ICP candidate broker only accepts companion destinations.
    const icpSubmit = vi.fn(async (input: { payload: { channelType: string } }) => (
      input.payload.channelType === 'companion'
        ? {
            kind: 'submitted' as const,
            result: {
              outcome: 'sent' as const, candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              status: 'consumed' as const, deliveryDisposition: 'delivered' as const,
            },
          }
        : { kind: 'not_companion' as const }
    ));
    const outreachOutbox = createFileOutreachOutboxStore(join(dataDir, 'outreach-outbox.jsonl'));
    const contactMap = contacts(nowMs);
    const contactStore = { getById: async (id: string) => contactMap.get(id) };
    const socialDesireStore = createSocialDesireStorePort(createInMemorySocialDesireBackend(
      options.desires ?? [
        liveDesire('contact-human', nowMs, 'partner'),
        liveDesire('contact-peer', nowMs, 'ai_companion'),
      ],
    ));

    // The companion's turn: she sees the prompt and answers with the tool.
    const drafts = createSocialOutreachDraftRegistry();
    const notify = createNotifyTool({ dispatch: vi.fn() }, { socialOutreachDrafts: drafts });
    const prompts = new Map<string, string>();
    const handleMessage = vi.fn(async (message: SubstrateMessage) => {
      // What the agent loop would record for this turn: nothing may persist.
      manager.recordUserMessage(message.channelId, message.content, message.authorId, message.authorName);
      prompts.set(message.channelId, message.content);
      const words = message.channelId.endsWith('contact-human')
        ? 'Did you get to see the sea?'
        : 'Want to trade garden notes later?';
      await runWithRequestContext({ channelId: message.channelId }, async () => {
        await notify.execute('outreach-send', { action: 'outreach_send', message: words });
      });
      manager.recordAssistantMessage(message.channelId, '__no_reply__');
      return { content: '__no_reply__' };
    });

    const { socialDesireOutbound, socialDesireHumanDeliveryPolicy, impulseTarget } = registerSocialDesireLane({
      schedulerConfig: {
        socialDesire: {
          ...DEFAULT_SOCIAL_DESIRE_CONFIG,
          enabled: true,
          outreach: { ...DEFAULT_SOCIAL_DESIRE_CONFIG.outreach, maxConsentMomentsPerRun: 2 },
        },
        episodicProcessing: {
          enabled: false, startLocalTime: '01:00', endLocalTime: '06:00', timeZone: 'UTC',
          inactivityThresholdMinutes: 180,
        },
      },
      scheduler,
      postTurnActions,
      eventBus,
      log: createComponentLogger('SocialOutreachAcceptance'),
      socialDesireStore,
      outreachOutbox,
      heartbeatChannel: { channelId: HUMAN_DM, channelType: 'discord' },
      contactStore,
      icpPeers: fromAny({
        resolveKnownPeer: async (contactId: string) => ({
          contactId, displayName: 'Nova', peerCompanionId: PEER_COMPANION_ID,
        }),
      }),
      localCompanionId: LOCAL_COMPANION_ID,
      turns: { handleMessage },
      sessions: sessionStore,
      readEmotion: () => ({
        vad: { valence: 0.2, arousal: 0.1, dominance: 0 },
        mood: { valence: 0.3, arousal: 0, dominance: 0 },
        discrete: { longing: 0.6 },
        confidence: 0.8,
      }),
      drafts,
      concernStore: options.concernStore ?? { list: async () => [], transitionConcernStatus: async () => null },
      companionName: 'Companion',
      attachFeltSignalWriter: vi.fn(),
    });
    await wireReflectionRuntime(
      { registerTool: vi.fn() },
      scheduler,
      { handleMessage: vi.fn(), followUp: vi.fn(), registerPostTurnActionInferer: vi.fn(() => () => undefined) },
      { send: vi.fn() },
      dataDir,
      undefined,
      {
        eventBus,
        postTurnActions,
        llmProvider: { stream: vi.fn(), complete: vi.fn() },
        proactiveOutbound,
        outreachOutbox,
        intentionAppraisalEnabled: false,
        sessionManager: manager,
        icpIntentionCandidateAdapter: {
          submit: icpSubmit,
          getLinkedCandidateStatus: vi.fn().mockResolvedValue(null),
        },
        ...(socialDesireOutbound ? { socialDesireOutbound } : {}),
        ...(socialDesireHumanDeliveryPolicy ? { socialDesireHumanDeliveryPolicy } : {}),
        ...(options.getActiveConcerns ? { getActiveConcerns: options.getActiveConcerns } : {}),
      },
    );

    return {
      manager, sessionStore, channelsBefore, enqueued, handlers, sentToHumans, icpSubmit,
      handleMessage, prompts, impulseTarget,
    };
}

describe('per-contact proactive outreach (acceptance)', () => {
  it('turns a felt impulse into one fresh per-contact turn and delivers what she wrote to each contact', async () => {
    const nowMs = Date.now();
    const {
      manager, sessionStore, channelsBefore, enqueued, handlers, sentToHumans, icpSubmit,
      handleMessage, prompts, impulseTarget,
    } = await harness({ nowMs });
    // Felt impulse -> per-contact pressure -> durable immediate evaluation.
    const impulseLane = registerSocialImpulseOutreachLane({
      companionId: LOCAL_COMPANION_ID, store: memoryLedger(), getMode: () => 'on',
    });
    impulseLane.setDesireTarget(impulseTarget);
    await expect(impulseLane.runtime.onImpulse(impulse(nowMs))).resolves.toMatchObject({
      outcome: 'applied', record: { boostedContactCount: 2 },
    });
    const evaluation = enqueued.splice(0).find(action => action.kind === 'social-desire.outreach.evaluate');
    expect(evaluation).toBeDefined();
    await handlers.get('social-desire.outreach.evaluate')!(evaluation!);

    // One fresh turn per contact, each in that contact's own channel.
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect([...prompts.keys()].sort()).toEqual([
      'internal:social-outreach:contact-human',
      'internal:social-outreach:contact-peer',
    ]);
    const humanPrompt = prompts.get('internal:social-outreach:contact-human')!;
    expect(humanPrompt).toContain('You have been thinking about Mo (your partner, a person in your life).');
    expect(humanPrompt).toMatch(/You last talked (less than an hour|about \d+ hours?) ago/);
    expect(humanPrompt).toContain('  Mo: I am heading to the coast this weekend');
    expect(humanPrompt).toContain('  You: Oh lovely, send me a picture of the sea!');
    expect(humanPrompt).toMatch(/Since then you have: |You have not done much else since then\./);
    expect(humanPrompt).toContain('strongest feelings: longing 0.60.');
    expect(humanPrompt).toContain('Do you want to message Mo?');
    expect(prompts.get('internal:social-outreach:contact-peer')).toContain('Nova (your ai companion, another companion)');

    // The runtime routes what she wrote: human DM and companion DM only.
    const outbound = enqueued.filter(action => action.kind === INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
    expect(outbound.map(action => (action.payload as { channelId: string }).channelId).sort())
      .toEqual([COMPANION_DM, HUMAN_DM].sort());
    expect(outbound.some(action => (action.payload as { channelId: string }).channelId === GROUP_ROOM)).toBe(false);
    const handler = handlers.get(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND)!;
    for (const action of outbound) await handler(action);

    expect(sentToHumans).toEqual([{ channelId: HUMAN_DM, content: 'Did you get to see the sea?' }]);
    const companionSubmissions = icpSubmit.mock.calls.filter(([input]) => input.payload.channelType === 'companion');
    expect(companionSubmissions).toHaveLength(1);
    expect(companionSubmissions[0]![0]).toMatchObject({
      payload: { channelId: COMPANION_DM, channelType: 'companion', content: 'Want to trade garden notes later?' },
    });

    // Containment: the outreach channels never reached a session store, and
    // the human DM history gains only the delivered message itself.
    const channelsAfter = sessionStore.listChannels().map(entry => entry.channelId);
    expect(channelsAfter.filter(channelId => channelId.startsWith('internal:social-outreach:'))).toEqual([]);
    expect(channelsAfter.filter(channelId => !channelsBefore.has(channelId))).toEqual([]);
    const dmHistory = manager.getRecentMessages(HUMAN_DM, 10).map(entry => entry.content);
    expect(dmHistory).toContain('Did you get to see the sea?');
    expect(dmHistory.join('\n')).not.toContain('Do you want to message');

    // Per-contact pacing: a second impulse right away asks no one again.
    await impulseLane.runtime.onImpulse(impulse(nowMs + 1));
    const second = enqueued.splice(0).find(action => action.kind === 'social-desire.outreach.evaluate');
    await handlers.get('social-desire.outreach.evaluate')!(second!);
    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it('follows up a due concern about a contact through that contact\'s outreach turn and delivers it (vcq8v.5)', async () => {
    const nowMs = Date.now();
    const concern = {
      id: 'concern-interview',
      text: 'Mo had a job interview on Tuesday',
      priority: 'medium',
      source: 'appraisal',
      status: 'active',
      contactId: 'contact-human',
      createdAt: new Date(nowMs - 48 * HOUR).toISOString(),
      expiresAt: new Date(nowMs + 24 * HOUR).toISOString(),
      nextReviewAt: new Date(nowMs - HOUR).toISOString(),
    } as ActiveConcern;
    let live: ActiveConcern = concern;
    const transitionConcernStatus = vi.fn(async (_id: string, input: { nextReviewAt?: string; clearNextReview?: boolean }) => {
      const { nextReviewAt: _previous, ...rest } = live;
      live = input.clearNextReview ? rest as ActiveConcern : { ...rest, ...(input.nextReviewAt ? { nextReviewAt: input.nextReviewAt } : {}) } as ActiveConcern;
      return live;
    });
    const { enqueued, handlers, sentToHumans, handleMessage, prompts } = await harness({
      nowMs,
      // No social desire at all: the follow-up comes from the concern alone.
      desires: [],
      concernStore: fromAny({ list: async () => [live], transitionConcernStatus }),
      getActiveConcerns: async () => [{ id: concern.id, title: concern.text, status: 'active' }],
    });

    await handlers.get('social-desire.outreach.evaluate')!({
      id: 'evaluate-1', kind: 'social-desire.outreach.evaluate', dedupeKey: 'evaluate-1',
      payload: { sourceId: 'manual' }, channelId: 'internal:social-outreach',
      sourceMessageId: 'manual', inferredAt: nowMs,
    });

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const prompt = prompts.get('internal:social-outreach:contact-human')!;
    expect(prompt).toContain('On your mind: You meant to follow up with them about this: Mo had a job interview on Tuesday');
    expect(prompt).toContain('Do you want to message Mo?');
    // Answered: the concern stops asking (no next review) and stays a live concern.
    expect(live.nextReviewAt).toBeUndefined();

    const outbound = enqueued.filter(action => action.kind === INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.payload).toMatchObject({
      channelId: HUMAN_DM,
      concernIds: ['concern-interview'],
      reason: 'concern_follow_up',
    });
    await handlers.get(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND)!(outbound[0]!);
    expect(sentToHumans).toEqual([{ channelId: HUMAN_DM, content: 'Did you get to see the sea?' }]);
  });
});
