// ── Social-desire provenance at the outbound gate (epic oth4, bead oth4.2) ──
//
// Regression-first coverage of the outbound-security seam: unconsented
// payloads still fail closed (missing_live_provenance), fabricated or expired
// consents are rejected, a verified consent dispatches through the
// ProactiveOutboundDispatcher exactly once and releases pressure, budget
// exhaustion is a structured block that dampens (never releases), and a
// companion-target action routes as an ICP candidate instead of a human send.
// The REAL consent ledger / outbound runtime / desire store are used so the
// acceptance is provably impossible to satisfy without a real consent record
// tied to a real desire.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wireReflectionRuntime } from '../../app/startup/composition/parity.js';
import type { ChannelType, InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import type {
  PostTurnActionHandler,
  PostTurnActionQueueStatus,
  PostTurnActionRuntime,
} from '../agent/post-turn-action-runtime.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND } from '../intention/appraisal.js';
import { toInferredPostTurnActions } from '../intention/appraisal/action-translation.js';
import { createFileOutreachOutboxStore } from '../intention/outreach-outbox.js';
import { ProactiveOutboundDispatcher } from '../intention/proactive-outbound.js';
import type { SocialDesireHumanDeliveryPolicy } from '../intention/social-desire-human-policy.js';
import {
  accumulateSocialDesireSignal,
  decayedSocialDesirePressure,
  type SocialDesire,
  type SocialDesireLifecycleConfig,
} from '../intention/social-desire.js';
import {
  createInMemorySocialDesireBackend,
  createSocialDesireStorePort,
  createContactSocialDesireTierSource,
  recordSocialDesireFeltSignal,
  type SocialDesireStorePort,
} from '../intention/social-desire-store-port.js';
import {
  createSocialDesireConsentLedger,
  createSocialDesireOutboundRuntime,
  fingerprintSocialDesireOutboundAction,
  runSocialDesireOutreachOnce,
  type SocialDesireConsentLedger,
} from '../intention/social-desire-outreach.js';
import { ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import type { ReflectionAgent } from './reflection-runtime-contracts.js';
import { Scheduler } from './scheduler.js';

const HOUR = 60 * 60 * 1000;
const CONTACT_ID = 'contact-primary';

const LIFECYCLE: SocialDesireLifecycleConfig = {
  baseGain: 0.15,
  pressureCap: 3,
  actionThreshold: 1,
  pressureFloor: 0.05,
  decay: { warmHalflifeMs: 72 * HOUR, repairHalflifeMs: 96 * HOUR },
  coolingOff: { warmMs: 1 * HOUR, repairMs: 12 * HOUR },
  releaseFactor: 0.25,
  dampeningFactor: 0.5,
  concernReinforcementGain: 0.3,
  maxReinforcedConcernIds: 16,
  tiers: {
    acquaintance: { gainMultiplier: 0.5, tickGapMs: 24 * HOUR },
    friend: { gainMultiplier: 1, tickGapMs: 8 * HOUR },
    family: { gainMultiplier: 1.4, tickGapMs: 4 * HOUR },
    partner: { gainMultiplier: 2, tickGapMs: 2 * HOUR },
    ai_companion: { gainMultiplier: 1, tickGapMs: 8 * HOUR },
  },
};

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seededDesire(contactId = CONTACT_ID): SocialDesire {
  const nowMs = Date.now();
  let desire: SocialDesire | null = null;
  for (const offset of [-64 * HOUR, -48 * HOUR, -32 * HOUR, -16 * HOUR]) {
    desire = accumulateSocialDesireSignal(
      desire,
      { contactId, orientation: 'warm', intensity: 1 },
      'partner',
      LIFECYCLE,
      nowMs + offset,
    ).desire;
  }
  if (!desire) throw new Error('expected desire to accumulate');
  return desire;
}

function emptyQueueStatus(): PostTurnActionQueueStatus {
  return {
    timestamp: 1,
    processing: false,
    queueDepth: 0,
    maxQueueDepth: 4,
    availableSlots: 4,
    saturated: false,
    readyCount: 0,
    scheduledCount: 0,
    retryScheduledCount: 0,
    runningCount: 0,
    lanes: [],
    queued: [],
    backPressure: { droppedCount: 0, recentDrops: [] },
    failures: { failedCount: 0, recentFailures: [] },
    terminal: { cancelledCount: 0, acknowledgedCount: 0, recentTerminals: [] },
    completions: { completedCount: 0, recentCompletions: [] },
    quarantine: { count: 0, persisted: true, entries: [] },
    persistence: {
      enabled: false,
      loadState: 'not_configured',
      loadedEntries: 0,
      quarantinedEntries: 0,
      quarantinePersisted: false,
    },
  };
}

interface WireOptions {
  withSocialDesireRuntime?: boolean;
  seedDesires?: SocialDesire[];
  budget?: { maxSendsPerWindow: number; windowMs: number };
  icp?: 'delivered' | 'deferred' | 'declined';
  failTerminalAppendOnce?: boolean;
  failSettlementOnce?: boolean;
  humanPolicy?: SocialDesireHumanDeliveryPolicy;
  dataDir?: string;
  store?: SocialDesireStorePort;
  intentionAppraisalEnabled?: boolean;
}

function wire(options: WireOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'psfn-social-desire-'));
  if (!options.dataDir) TEMP_DIRS.push(dataDir);
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
  const handlers = new Map<string, PostTurnActionHandler>();
  const sent: string[] = [];
  const proactiveOutbound = new ProactiveOutboundDispatcher({
    sender: { send: vi.fn(async (_channelId: string, content: string) => { sent.push(content); }) },
    rateLimiter: new ExternalCommunicationRateLimiter(),
    isApprovedPrimaryChannel: () => true,
  });
  const dispatch = vi.spyOn(proactiveOutbound, 'dispatch');
  const durableOutreachOutbox = createFileOutreachOutboxStore(join(dataDir, 'outreach-outbox.jsonl'));
  let terminalAppendFailurePending = options.failTerminalAppendOnce === true;
  const outreachOutbox = {
    ...durableOutreachOutbox,
    append: (input: Parameters<typeof durableOutreachOutbox.append>[0]) => {
      if (terminalAppendFailurePending && (input.phase === 'sent' || input.phase === 'blocked')) {
        terminalAppendFailurePending = false;
        throw new Error('injected terminal outbox append failure');
      }
      return durableOutreachOutbox.append(input);
    },
  };

  const store: SocialDesireStorePort = options.store ?? createSocialDesireStorePort(
    createInMemorySocialDesireBackend(options.seedDesires ?? [seededDesire()]),
  );
  const consents: SocialDesireConsentLedger = createSocialDesireConsentLedger({ ttlMs: 60_000 });
  let settlementFailurePending = options.failSettlementOnce === true;
  const settlementStore = {
    getByContactId: (contactId: string) => store.getByContactId(contactId),
    settle: async (input: Parameters<typeof store.settle>[0]) => {
      if (settlementFailurePending) {
        settlementFailurePending = false;
        throw new Error('injected Postgres settlement save failure');
      }
      return store.settle(input);
    },
  };
  const socialDesireOutbound = createSocialDesireOutboundRuntime({
    store: settlementStore,
    lifecycle: LIFECYCLE,
    consents,
    budget: options.budget ?? { maxSendsPerWindow: 2, windowMs: 24 * HOUR },
    countRecentSends: sinceMs => outreachOutbox.countSentSince({
      sinceMs,
      reasonPrefix: 'social_desire',
    }),
  });

  const icpSubmit = vi.fn().mockResolvedValue(
    options.icp === 'delivered'
      ? {
          kind: 'submitted',
          result: {
            outcome: 'sent',
            candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            status: 'consumed',
            deliveryDisposition: 'delivered',
          },
        }
      : options.icp === 'deferred'
        ? {
            kind: 'submitted',
            result: {
              outcome: 'deferred',
              candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              status: 'deferred',
              retryEligibleAtMs: Date.now() + HOUR,
            },
          }
        : options.icp === 'declined'
          ? {
              kind: 'submitted',
              result: {
                outcome: 'declined',
                candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                status: 'declined',
              },
            }
          : { kind: 'not_companion' },
  );

  const postTurnActions: PostTurnActionRuntime = {
    enqueue: vi.fn(() => 'queued'),
    registerHandler: vi.fn((actionKind: string, handler: PostTurnActionHandler) => {
      handlers.set(actionKind, handler);
      return () => undefined;
    }),
    listQueued: vi.fn().mockReturnValue([]),
    cancel: vi.fn().mockReturnValue(false),
    acknowledge: vi.fn().mockReturnValue(false),
    getActionStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(emptyQueueStatus()),
  };
  const agentLoop: ReflectionAgent = {
    handleMessage: vi.fn(),
    followUp: vi.fn(),
    registerPostTurnActionInferer: vi.fn(() => () => undefined),
  };
  const llmProvider: LLMProviderPort = {
    stream: vi.fn(),
    complete: vi.fn(),
  };
  void wireReflectionRuntime(
    { registerTool: vi.fn() },
    scheduler,
    agentLoop,
    { send: vi.fn() },
    dataDir,
    undefined,
    {
      eventBus,
      postTurnActions,
      llmProvider,
      proactiveOutbound,
      outreachOutbox,
      socialDesireHumanDeliveryPolicy: options.humanPolicy ?? {
        evaluate: vi.fn(async () => ({ allowed: true as const })),
      },
      intentionAppraisalEnabled: options.intentionAppraisalEnabled ?? true,
      ...(options.icp
        ? {
            icpIntentionCandidateAdapter: {
              submit: icpSubmit,
              getLinkedCandidateStatus: vi.fn().mockResolvedValue(null),
            },
          }
        : {}),
      ...(options.withSocialDesireRuntime === false ? {} : { socialDesireOutbound }),
    },
  );
  const handler = handlers.get(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
  if (!handler) throw new Error('intention outbound handler was not registered');
  return {
    handler,
    dispatch,
    sent,
    icpSubmit,
    store,
    consents,
    outreachOutbox,
    socialDesireOutbound,
    dataDir,
  };
}

function desireAction(
  consentId: string,
  overrides: { channelId?: string; dedupeSuffix?: string } = {},
): InferredPostTurnAction {
  const channelId = overrides.channelId ?? 'discord:primary';
  return {
    id: `action-${overrides.dedupeSuffix ?? consentId}`,
    kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
    dedupeKey: `${INTENTION_OUTBOUND_MESSAGE_ACTION_KIND}:social-desire:${CONTACT_ID}:${consentId}${overrides.dedupeSuffix ?? ''}`,
    channelId,
    sourceMessageId: 'social-desire-moment-1',
    inferredAt: Date.now(),
    payload: {
      channelId,
      channelType: 'discord',
      content: 'hey, I was thinking about you',
      reason: 'social_desire:warm',
      socialDesire: {
        contactId: CONTACT_ID,
        consentId,
        orientation: 'warm',
      },
    },
  };
}

function bindConsentToAction(
  consents: SocialDesireConsentLedger,
  consentId: string,
  action: InferredPostTurnAction,
): void {
  const payload = action.payload as {
    channelId: string;
    channelType: ChannelType;
    content: string;
    reason: string;
    socialDesire: { orientation: 'warm' };
  };
  consents.bind(consentId, {
    actionId: action.id,
    dedupeKey: action.dedupeKey,
    channelId: payload.channelId,
    channelType: payload.channelType,
    content: payload.content,
    orientation: payload.socialDesire.orientation,
    reason: payload.reason,
    actionFingerprint: fingerprintSocialDesireOutboundAction(action),
  });
}

function pressureOf(store: SocialDesireStorePort): Promise<number> {
  return store.getByContactId(CONTACT_ID).then((desire) => {
    if (!desire) throw new Error('desire missing');
    return decayedSocialDesirePressure(desire, LIFECYCLE, Date.now()).total;
  });
}

describe('social-desire provenance at the outbound gate', () => {
  it('registers and executes social-desire delivery when LLM intention appraisal is disabled', async () => {
    const { handler, dispatch, consents } = wire({ intentionAppraisalEnabled: false });
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);

    await expect(handler(action)).resolves.toEqual({ detail: 'sent' });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('still blocks a payload without any live provenance (missing_live_provenance)', async () => {
    const { handler, dispatch } = wire();
    await expect(handler({
      ...desireAction('unused'),
      payload: {
        channelId: 'discord:primary',
        channelType: 'discord',
        content: 'unprovoked message',
      },
    })).resolves.toEqual({ detail: 'blocked:missing_live_provenance' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails closed when the social-desire runtime is not wired (lane disabled)', async () => {
    const { handler, dispatch, sent } = wire({ withSocialDesireRuntime: false });
    await expect(handler(desireAction('11111111-1111-4111-8111-111111111111')))
      .resolves.toEqual({ detail: 'blocked:social_desire_runtime_unavailable' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('rejects a fabricated consent id that was never issued by the ledger', async () => {
    const { handler, dispatch, store } = wire();
    const before = await pressureOf(store);
    await expect(handler(desireAction('11111111-1111-4111-8111-111111111111')))
      .resolves.toEqual({ detail: 'blocked:social_desire_consent_invalid' });
    expect(dispatch).not.toHaveBeenCalled();
    // An invalid consent never touches the desire: pressure is preserved
    // (tolerance covers natural decay between wall-clock reads).
    expect(await pressureOf(store)).toBeCloseTo(before, 5);
  });

  it('rejects a real consent bound to a different contact', async () => {
    const { handler, dispatch, consents } = wire();
    const consent = consents.issue({ contactId: 'someone-else', orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);
    await expect(handler(action))
      .resolves.toEqual({ detail: 'blocked:social_desire_consent_invalid' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a consent whose desire record no longer exists', async () => {
    const { handler, dispatch, consents } = wire({ seedDesires: [] });
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);
    await expect(handler(action))
      .resolves.toEqual({ detail: 'blocked:social_desire_record_missing' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches a verified consent exactly once, releases pressure, and spends the consent', async () => {
    const { handler, dispatch, sent, store, consents, outreachOutbox } = wire();
    const before = await pressureOf(store);
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);

    await expect(handler(action)).resolves.toEqual({ detail: 'sent' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sent).toEqual(['hey, I was thinking about you']);

    // Pressure released (residual survives so the desire can rebuild).
    expect(await pressureOf(store)).toBeCloseTo(before * LIFECYCLE.releaseFactor, 5);
    // Consent is single-use: it no longer verifies.
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(false);
    // The durable ledger counts the desire send for the rate budget.
    expect(outreachOutbox.countSentSince({ sinceMs: 0, reasonPrefix: 'social_desire' })).toBe(1);

    // Replaying the same action is terminally deduped — never a second send.
    await expect(handler(action)).resolves.toEqual({ detail: 'skipped:terminal_dedupe:sent' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['human', undefined],
    ['shared ICP', 'delivered' as const],
  ])('does not duplicate %s delivery when the first terminal outbox append fails', async (_path, icp) => {
    const { handler, dispatch, icpSubmit, sent, store, consents } = wire({
      ...(icp ? { icp } : {}),
      failTerminalAppendOnce: true,
    });
    const before = await pressureOf(store);
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);

    await expect(handler(action)).rejects.toThrow('injected terminal outbox append failure');
    await expect(handler(action)).resolves.toMatchObject({
      detail: icp ? 'sent' : 'sent',
    });

    expect(icp ? icpSubmit : dispatch).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(icp ? 0 : 1);
    expect(await pressureOf(store)).toBeCloseTo(before * LIFECYCLE.releaseFactor, 5);
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(false);
  });

  it('reconciles a terminal delivery after restart when settlement had not committed', async () => {
    const first = wire({ failSettlementOnce: true });
    const before = await pressureOf(first.store);
    const consent = first.consents.issue({
      contactId: CONTACT_ID,
      orientation: 'warm',
      nowMs: Date.now(),
    });
    const action = desireAction(consent.consentId);
    bindConsentToAction(first.consents, consent.consentId, action);
    await expect(first.handler(action)).rejects.toThrow('injected Postgres settlement save failure');
    expect(first.dispatch).toHaveBeenCalledOnce();

    // Fresh runtime and consent ledger over the same durable outbox/store.
    const restarted = wire({ dataDir: first.dataDir, store: first.store });
    await expect(restarted.handler(action)).resolves.toEqual({
      detail: 'skipped:terminal_dedupe:sent',
    });
    expect(restarted.dispatch).not.toHaveBeenCalled();
    expect(await pressureOf(restarted.store)).toBeCloseTo(before * LIFECYCLE.releaseFactor, 5);
  });

  it('rejects a mutated retry while reconciling a post-delivery terminal append failure', async () => {
    const { handler, dispatch, sent, consents } = wire({ failTerminalAppendOnce: true });
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);
    await expect(handler(action)).rejects.toThrow('injected terminal outbox append failure');

    await expect(handler({
      ...action,
      payload: { ...action.payload, content: 'mutated after delivery' },
    })).resolves.toEqual({ detail: 'blocked:social_desire_consent_invalid' });
    await expect(handler(action)).resolves.toEqual({ detail: 'sent' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sent).toEqual(['hey, I was thinking about you']);
  });

  it('rejects mutation of any payload or top-level field after consent binding', async () => {
    const mutations: Array<(action: InferredPostTurnAction) => InferredPostTurnAction> = [
      action => ({ ...action, sourceMessageId: 'changed-source' }),
      action => ({ ...action, inferredAt: action.inferredAt + 1 }),
      action => ({ ...action, maxRetries: 9 }),
      action => ({ ...action, runAt: Date.now() + HOUR }),
      action => ({ ...action, payload: { ...action.payload, injectedProvenance: 'changed' } }),
    ];
    for (const mutate of mutations) {
      const { handler, dispatch, consents } = wire();
      const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
      const action = desireAction(consent.consentId);
      bindConsentToAction(consents, consent.consentId, action);

      await expect(handler(mutate(action))).resolves.toEqual({
        detail: 'blocked:social_desire_consent_invalid',
      });
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['human', undefined],
    ['shared ICP', 'delivered' as const],
  ])('eventually settles %s delivery once when the first durable settlement save fails', async (_path, icp) => {
    const { handler, dispatch, icpSubmit, sent, store, consents, outreachOutbox } = wire({
      ...(icp ? { icp } : {}),
      failSettlementOnce: true,
    });
    const before = await pressureOf(store);
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);

    await expect(handler(action)).rejects.toThrow('injected Postgres settlement save failure');
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(true);
    await expect(handler(action)).resolves.toMatchObject({ detail: 'sent' });

    expect(icp ? icpSubmit : dispatch).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(icp ? 0 : 1);
    expect(await pressureOf(store)).toBeCloseTo(before * LIFECYCLE.releaseFactor, 5);
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(false);
    expect(outreachOutbox.countSentSince({ sinceMs: 0, reasonPrefix: 'social_desire' })).toBe(1);
  });

  it('replays an interrupted durable ICP submission after restart', async () => {
    const first = wire({ icp: 'delivered' });
    first.icpSubmit.mockRejectedValueOnce(new Error('transient ICP submission failure'));
    const before = await pressureOf(first.store);
    const consent = first.consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(first.consents, consent.consentId, action);

    await expect(first.handler(action)).rejects.toThrow('transient ICP submission failure');
    const restarted = wire({ icp: 'delivered', dataDir: first.dataDir, store: first.store });
    await expect(restarted.handler(action)).resolves.toEqual({
      detail: 'icp_candidate:sent:consumed',
    });
    expect(restarted.icpSubmit).toHaveBeenCalledOnce();
    expect(restarted.dispatch).not.toHaveBeenCalled();
    expect(await pressureOf(restarted.store)).toBeCloseTo(before * LIFECYCLE.releaseFactor, 5);
  });

  it('a spent consent cannot authorize a second action', async () => {
    const { handler, dispatch, consents } = wire();
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);
    await expect(handler(action)).resolves.toEqual({ detail: 'sent' });
    await expect(handler(desireAction(consent.consentId, { dedupeSuffix: ':replayed' })))
      .resolves.toEqual({ detail: 'blocked:social_desire_consent_invalid' });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('budget exhaustion is a structured block that dampens (never releases) the desire', async () => {
    const { handler, dispatch, store, consents, outreachOutbox } = wire({
      budget: { maxSendsPerWindow: 1, windowMs: 24 * HOUR },
    });
    // Exhaust the budget with a prior desire-tagged send in the durable ledger.
    outreachOutbox.append({
      phase: 'sent',
      actionId: 'earlier-action',
      dedupeKey: 'earlier-dedupe',
      channelId: 'discord:primary',
      channelType: 'discord',
      sourceMessageId: 'earlier-source',
      reason: 'social_desire:warm',
    });

    const before = await pressureOf(store);
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);
    await expect(handler(action))
      .resolves.toEqual({ detail: 'blocked:social_desire_budget_exhausted' });
    expect(dispatch).not.toHaveBeenCalled();

    // Dampened, not released — and definitely not zeroed: it can retry later.
    const after = await pressureOf(store);
    expect(after).toBeCloseTo(before * LIFECYCLE.dampeningFactor, 5);
    expect(after).toBeGreaterThan(0);
    // The blocked attempt is a durable, structured record.
    expect(outreachOutbox.getTerminal(
      `${INTENTION_OUTBOUND_MESSAGE_ACTION_KIND}:social-desire:${CONTACT_ID}:${consent.consentId}`,
    )).toMatchObject({ phase: 'blocked', reason: 'social_desire_budget_exhausted' });
    // The consent is spent; a retry needs a fresh consent moment.
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(false);
  });

  it('dampens when the dispatcher blocks the send outright', async () => {
    const { handler, store, consents } = wire();
    const before = await pressureOf(store);
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    // Unsupported channel type is a terminal dispatcher block.
    const action = desireAction(consent.consentId);
    const mutatedAction = {
      ...action,
      payload: { ...(action.payload as Record<string, unknown>), channelType: 'api' },
    };
    bindConsentToAction(consents, consent.consentId, mutatedAction);
    await expect(handler(mutatedAction)).resolves.toEqual({ detail: 'blocked:unsupported_channel_type' });
    expect(await pressureOf(store)).toBeCloseTo(before * LIFECYCLE.dampeningFactor, 5);
  });

  it('revalidates live human policy on retry and blocks after trust is revoked', async () => {
    let trustRevoked = false;
    const humanPolicy: SocialDesireHumanDeliveryPolicy = {
      evaluate: vi.fn(async () => trustRevoked
        ? { allowed: false as const, reason: 'social_desire_contact_not_primary' }
        : { allowed: false as const, reason: 'quiet_hours', rescheduleAt: Date.now() + HOUR }),
    };
    const { handler, dispatch, store, consents } = wire({ humanPolicy });
    const before = await pressureOf(store);
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);

    await expect(handler(action)).resolves.toMatchObject({
      detail: 'quiet_hours',
      rescheduleAt: expect.any(Number),
    });
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(true);
    trustRevoked = true;
    await expect(handler(action)).resolves.toEqual({
      detail: 'blocked:social_desire_contact_not_primary',
    });

    expect(humanPolicy.evaluate).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await pressureOf(store)).toBeCloseTo(before * LIFECYCLE.dampeningFactor, 5);
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(false);
  });

  it('routes a companion-target desire as an ICP candidate, not a direct send', async () => {
    const { handler, dispatch, icpSubmit, store, consents, outreachOutbox } = wire({ icp: 'delivered' });
    const before = await pressureOf(store);
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);
    await expect(handler(action))
      .resolves.toEqual({ detail: 'icp_candidate:sent:consumed' });

    expect(icpSubmit).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    // Delivered candidate settles like a send: release + budget entry.
    expect(await pressureOf(store)).toBeCloseTo(before * LIFECYCLE.releaseFactor, 5);
    expect(outreachOutbox.countSentSince({ sinceMs: 0, reasonPrefix: 'social_desire' })).toBe(1);
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(false);
  });

  it('keeps the consent live across an ICP deferral so the durable retry can pass the gate', async () => {
    const { handler, dispatch, store, consents } = wire({ icp: 'deferred' });
    const before = await pressureOf(store);
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);
    const result = await handler(action);
    expect(result).toMatchObject({
      detail: 'icp_candidate:deferred:deferred',
      rescheduleAt: expect.any(Number),
    });
    expect(dispatch).not.toHaveBeenCalled();
    // Deferred is non-terminal: consent still live, pressure untouched.
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(true);
    expect(await pressureOf(store)).toBeCloseTo(before, 5);
  });

  it('dampens and spends the consent when the ICP candidate is declined', async () => {
    const { handler, store, consents } = wire({ icp: 'declined' });
    const before = await pressureOf(store);
    const consent = consents.issue({ contactId: CONTACT_ID, orientation: 'warm', nowMs: Date.now() });
    const action = desireAction(consent.consentId);
    bindConsentToAction(consents, consent.consentId, action);
    await expect(handler(action))
      .resolves.toEqual({ detail: 'icp_candidate:declined:declined' });
    expect(await pressureOf(store)).toBeCloseTo(before * LIFECYCLE.dampeningFactor, 5);
    expect(consents.hasLiveConsentForContact(CONTACT_ID, Date.now())).toBe(false);
  });

  it('runs a canonical ai_companion from the live tier source through consent into an ICP candidate', async () => {
    const { handler, dispatch, icpSubmit, store, consents } = wire({
      seedDesires: [],
      icp: 'delivered',
    });
    const tierSource = createContactSocialDesireTierSource({
      getById: async () => ({ relationshipType: 'ai_companion' as const }),
    });
    const nowMs = Date.now();
    for (let tick = 0; tick < 16; tick += 1) {
      await recordSocialDesireFeltSignal(
        store,
        tierSource,
        LIFECYCLE,
        { contactId: CONTACT_ID, orientation: 'warm', intensity: 1 },
        nowMs - (16 - tick) * 8 * HOUR - 2 * HOUR,
      );
    }
    const outreach = await runSocialDesireOutreachOnce({
      store,
      lifecycle: LIFECYCLE,
      tierSource,
      consentEvaluator: { evaluate: async () => ({ action: 'message', content: 'hello, fellow companion' }) },
      consents,
      maxConsentMomentsPerRun: 1,
      resolveDeliveryChannel: async () => ({
        channelId: 'companion:dm:local:peer',
        channelType: 'companion',
        companionTarget: true,
      }),
      isBudgetExhausted: () => false,
    }, nowMs);
    expect(outreach.produced).toHaveLength(1);
    const produced = outreach.produced[0]!;
    const message = {
      id: `social-desire-outreach:${produced.contactId}:${produced.consentId}`,
      channelId: produced.channelId,
      channelType: produced.channelType,
      authorId: 'system:social-desire-outreach',
      authorName: 'Social Desire',
      content: 'Social-desire consent moment accepted.',
      timestamp: new Date(nowMs),
    };
    const action = toInferredPostTurnActions([produced.candidate], message)[0]!;
    bindConsentToAction(consents, produced.consentId, action);

    await expect(handler(action)).resolves.toEqual({ detail: 'icp_candidate:sent:consumed' });
    expect(icpSubmit).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
