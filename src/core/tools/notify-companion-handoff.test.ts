import { describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import type { AgentFacingIcpAutonomyRuntime } from '../icp/agent-facing-autonomy.js';
import type { PostTurnActionHandler } from '../agent/post-turn-action-runtime.js';
import { createIcpAutonomyCandidateSchedulerMessage } from '../icp/candidate-scheduler-origin.js';
import type { IcpInitiationCandidate } from '../icp/initiation-candidate.js';
import { createNotifyTool, type NotifyDispatcher } from './ntfy.js';
import {
  COMPANION_NOTIFY_QUEUED_TEXT,
  DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
  inferDeferredCompanionOutreachActions,
  isDeferredCompanionOutreachExecutionAuthorized,
  parseDeferredCompanionOutreachAuthorizationEvidence,
  registerDeferredCompanionOutreachRuntime,
  type DeferredCompanionOutreachAuthorizationEvidence,
  type DeferredCompanionOutreachAuthorizationRuntime,
} from './notify-companion-handoff.js';

const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const CANDIDATE_ORIGIN = {
  candidateId: '11111111-1111-4111-8111-111111111111',
  rootInitiationId: '22222222-2222-4222-8222-222222222222',
  source: 'intention',
  provenanceRef: 'icp-prov:11111111-1111-4111-8111-111111111111',
  continuationTaskKind: 'research',
} as const;
const ORIGIN_AUTHORIZATION: DeferredCompanionOutreachAuthorizationEvidence = {
  version: 2,
  toolName: 'notify',
  toolScope: 'extended',
  catalogSource: 'extended',
  requiredCapability: 'external.companion',
  originToolCallId: 'call-outreach',
  originTurnId: 'turn-1',
};

function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map(part => part.text).join('');
}

function runtime(): AgentFacingIcpAutonomyRuntime {
  return {
    resolveKnownPeer: vi.fn(),
    readKnownPeerAvailability: vi.fn(),
    listKnownPeerAvailability: vi.fn(),
    readOwnAvailability: vi.fn(),
    publishOwnAvailability: vi.fn(),
    clearOwnAvailability: vi.fn(),
    listOpenDyads: vi.fn().mockResolvedValue([]),
    listDyads: vi.fn().mockResolvedValue([]),
    transitionDyad: vi.fn(),
    inspectOpenDyad: vi.fn().mockResolvedValue({
      dyadId: '77777777-7777-4777-8777-777777777777',
      peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerContactId: 'peer-contact-b',
      peerDisplayLabel: 'Peer',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'open',
      availability: { peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', connectionState: 'online', eligible: true },
    }),
    executeDyadContinuation: vi.fn().mockResolvedValue({ disposition: 'delivered' }),
    prepareCompanionOutreach: vi.fn().mockResolvedValue(undefined),
    executeCompanionOutreach: vi.fn().mockResolvedValue({ disposition: 'delivered' }),
  };
}

function tool(owner: AgentFacingIcpAutonomyRuntime) {
  const dispatcher: NotifyDispatcher = { dispatch: vi.fn() };
  return createNotifyTool(dispatcher, { companionOutreach: owner });
}

function ordinaryContext<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({
    channelId: 'discord:owner',
  }, fn);
}

function candidateSchedulerMessage() {
  const candidate = {
    ...CANDIDATE_ORIGIN,
    localCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    peerContactId: 'peer-contact-b',
    peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    preferredChannel: 'dm',
    reasonSummary: 'Continue the approved private research task.',
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    status: 'permitted',
    revision: 1,
  } satisfies IcpInitiationCandidate;
  return createIcpAutonomyCandidateSchedulerMessage({
    candidate,
    permit: {
      permitId: PERMIT_ID,
      candidateId: candidate.candidateId,
      conversationId: '55555555-5555-4555-8555-555555555555',
      senderCompanionId: candidate.localCompanionId,
      recipientCompanionId: candidate.peerCompanionId,
      channelId: `companion-dm:${candidate.localCompanionId}:${candidate.peerCompanionId}`,
      provenanceRef: candidate.provenanceRef,
      issuedAtMs: 1_500,
      expiresAtMs: 5_000,
      status: 'issued',
      revision: 1,
    },
  }, new Date(2_000));
}

describe('permit-governed notify companion handoff', () => {
  it('advertises content-free open-dyad discovery and private-intent continuation', () => {
    const schema = tool(runtime()).parameters;
    expect(Value.Check(schema, { action: 'list_dyads', target_kind: 'companion' })).toBe(true);
    expect(Value.Check(schema, {
      action: 'send',
      target_kind: 'companion',
      dyad_id: '77777777-7777-4777-8777-777777777777',
      private_intent: 'Check in naturally.',
    })).toBe(true);
    expect(Value.Check(schema, {
      action: 'send',
      target_kind: 'companion',
      dyad_id: '77777777-7777-4777-8777-777777777777',
      private_intent: 'Check in naturally.',
      message: 'raw peer-visible content',
    })).toBe(false);
  });

  it('returns only the redacted dyad projection supplied by companion authority', async () => {
    const owner = runtime();
    vi.mocked(owner.listDyads).mockResolvedValueOnce([{
      dyadId: '77777777-7777-4777-8777-777777777777',
      peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerContactId: 'peer-contact-b',
      peerDisplayLabel: 'Peer',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'open',
      ownState: { relationshipState: 'open', blocked: false },
      peerState: { relationshipState: 'open', blocked: false },
      lifecycleRevision: 4,
    }]);
    const result = await ordinaryContext(async () => await tool(owner).execute('call-list', {
      action: 'list_dyads', target_kind: 'companion',
    }));
    expect(JSON.parse(text(result))).toEqual({
      dyads: [expect.objectContaining({
        dyadId: '77777777-7777-4777-8777-777777777777',
        peerDisplayLabel: 'Peer',
        status: 'open',
        lifecycleRevision: 4,
      })],
    });
    expect(text(result)).not.toMatch(/message|summary|memory|reasoning|motivation|session/iu);
  });

  it('applies a lifecycle action immediately without scheduling peer content', async () => {
    const owner = runtime();
    vi.mocked(owner.transitionDyad).mockResolvedValueOnce({
      outcome: 'updated',
      dyadId: '77777777-7777-4777-8777-777777777777',
      status: 'paused',
      ownState: { relationshipState: 'paused', blocked: false },
      peerState: { relationshipState: 'open', blocked: false },
      lifecycleRevision: 5,
      revokedPermitCount: 1,
      fencedDeliveryCount: 2,
    });
    const params = {
      action: 'dyad_lifecycle' as const,
      target_kind: 'companion' as const,
      dyad_id: '77777777-7777-4777-8777-777777777777',
      expected_revision: 4,
      lifecycle_action: 'pause' as const,
    };

    const result = await ordinaryContext(async () => await tool(owner).execute('call-pause', params));

    expect(JSON.parse(text(result))).toMatchObject({ status: 'paused', lifecycleRevision: 5 });
    expect(owner.transitionDyad).toHaveBeenCalledWith({
      dyadId: params.dyad_id,
      expectedRevision: 4,
      action: 'pause',
    });
    expect(inferDeferredCompanionOutreachActions({
      message: { id: 'source-1', channelId: 'discord:owner', routing: {} } as never,
      turnMessages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'call-pause', name: 'notify', arguments: params }] } as never,
        { role: 'toolResult', toolCallId: 'call-pause', toolName: 'notify', isError: false,
          content: [{ type: 'text', text: text(result) }] } as never,
      ],
      turnId: 'turn-pause' as never,
      completedAt: 1_000,
    }, 'extended')).toEqual([]);
  });

  it('queues an owned open-dyad continuation without an initiation permit', async () => {
    const owner = runtime();
    const params = {
      action: 'send' as const,
      target_kind: 'companion' as const,
      dyad_id: '77777777-7777-4777-8777-777777777777',
      private_intent: 'Check in naturally.',
    };
    const result = await ordinaryContext(async () => await tool(owner).execute('call-dyad', params));
    expect(text(result)).toBe(COMPANION_NOTIFY_QUEUED_TEXT);
    expect(owner.inspectOpenDyad).toHaveBeenCalledWith(params.dyad_id);
    expect(owner.prepareCompanionOutreach).not.toHaveBeenCalled();

    const actions = inferDeferredCompanionOutreachActions({
      message: { id: 'source-1', channelId: 'discord:owner', routing: {} } as never,
      turnMessages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'call-dyad', name: 'notify', arguments: params }] } as never,
        { role: 'toolResult', toolCallId: 'call-dyad', toolName: 'notify', isError: false,
          content: [{ type: 'text', text: COMPANION_NOTIFY_QUEUED_TEXT }] } as never,
      ],
      turnId: 'turn-dyad' as never,
      completedAt: 1_000,
    }, 'extended');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload).toMatchObject({
      mode: 'continuation',
      dyadId: params.dyad_id,
      privateIntent: params.private_intent,
    });
    expect(actions[0]?.payload).not.toHaveProperty('permitId');
    expect(actions[0]?.payload).not.toHaveProperty('contactId');
  });

  it('advertises an exact companion variant that excludes raw delivery fields', () => {
    const schema = tool(runtime()).parameters;
    const exact = {
      action: 'send',
      target_kind: 'companion',
      contact_id: 'peer-contact-b',
      initiation_permit: PERMIT_ID,
    };
    expect(Value.Check(schema, exact)).toBe(true);
    expect(Value.Check(schema, { ...exact, message: 'forbidden raw content' })).toBe(false);
    expect(Value.Check(schema, { ...exact, delivery_channel: 'discord' })).toBe(false);
    expect(Value.Check(schema, { ...exact, delivery_target: 'guessed-peer' })).toBe(false);
  });

  it('queues a content-free exact contact/permit handoff and redacts the permit from output', async () => {
    const owner = runtime();
    const result = await ordinaryContext(async () => await tool(owner).execute('call-1', {
      action: 'send',
      target_kind: 'companion',
      contact_id: 'peer-contact-b',
      initiation_permit: PERMIT_ID,
    }));
    expect(text(result)).toBe(COMPANION_NOTIFY_QUEUED_TEXT);
    expect(text(result)).not.toContain(PERMIT_ID);
    expect(owner.prepareCompanionOutreach).toHaveBeenCalledWith('peer-contact-b', PERMIT_ID);
  });

  it.each([
    { message: 'raw content is forbidden' },
    { delivery_channel: 'discord' },
    { delivery_target: 'guessed-peer' },
    { extra: true },
  ])('strictly rejects mixed/raw companion send fields: %j', async extra => {
    const owner = runtime();
    const result = await ordinaryContext(async () => await tool(owner).execute('call-2', {
      action: 'send',
      target_kind: 'companion',
      contact_id: 'peer-contact-b',
      initiation_permit: PERMIT_ID,
      ...extra,
    } as never));
    expect(result.details?.isError).toBe(true);
    expect(text(result)).toMatch(/unknown key/i);
    expect(owner.prepareCompanionOutreach).not.toHaveBeenCalled();
  });

  it('blocks recursive outreach from an ICP-correlated turn before prepare or command', async () => {
    const owner = runtime();
    const result = await runWithRequestContext({
      channelId: 'companion-dm:a:b',
      requesterProvenance: 'human',
      icpCorrelation: {} as never,
    }, async () => await tool(owner).execute('call-3', {
      action: 'send',
      target_kind: 'companion',
      contact_id: 'peer-contact-b',
      initiation_permit: PERMIT_ID,
    }));
    expect(result.details?.isError).toBe(true);
    expect(text(result)).toMatch(/blocked during an ICP-correlated turn/i);
    expect(owner.prepareCompanionOutreach).not.toHaveBeenCalled();
    expect(owner.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('infers one redacted-dedupe durable action only from the successful tool result', () => {
    const actions = inferDeferredCompanionOutreachActions({
      message: candidateSchedulerMessage(),
      response: {} as never,
      turnMessages: [
        {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            id: 'call-outreach',
            name: 'notify',
            arguments: {
              action: 'send',
              target_kind: 'companion',
              contact_id: 'peer-contact-b',
              initiation_permit: PERMIT_ID,
            },
          }],
        } as never,
        {
          role: 'toolResult',
          toolCallId: 'call-outreach',
          toolName: 'notify',
          isError: false,
          content: [{ type: 'text', text: COMPANION_NOTIFY_QUEUED_TEXT }],
        } as never,
      ],
      turnId: 'turn-1' as never,
      completedAt: 1_000,
      taskKind: 'research',
    }, 'extended');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload: {
        contactId: 'peer-contact-b',
        permitId: PERMIT_ID,
        candidateOrigin: CANDIDATE_ORIGIN,
        authorization: ORIGIN_AUTHORIZATION,
      },
      maxRetries: 2,
    });
    expect(actions[0]?.dedupeKey).not.toContain(PERMIT_ID);
  });

  it('does not persist outreach without current origin catalog evidence', () => {
    expect(inferDeferredCompanionOutreachActions({
      message: { id: 'source-1', channelId: 'discord:owner' } as never,
      response: {} as never,
      turnMessages: [
        {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            id: 'call-outreach',
            name: 'notify',
            arguments: {
              action: 'send',
              target_kind: 'companion',
              contact_id: 'peer-contact-b',
              initiation_permit: PERMIT_ID,
            },
          }],
        } as never,
        {
          role: 'toolResult',
          toolCallId: 'call-outreach',
          toolName: 'notify',
          isError: false,
          content: [{ type: 'text', text: COMPANION_NOTIFY_QUEUED_TEXT }],
        } as never,
      ],
      turnId: 'turn-1' as never,
      completedAt: 1_000,
    })).toEqual([]);
  });

  it('does not promote free-form task labels into privileged continuation evidence', () => {
    const actions = inferDeferredCompanionOutreachActions({
      message: { id: 'source-1', channelId: 'discord:owner' } as never,
      response: {} as never,
      turnMessages: [
        {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            id: 'call-outreach',
            name: 'notify',
            arguments: {
              action: 'send',
              target_kind: 'companion',
              contact_id: 'peer-contact-b',
              initiation_permit: PERMIT_ID,
            },
          }],
        } as never,
        {
          role: 'toolResult',
          toolCallId: 'call-outreach',
          toolName: 'notify',
          isError: false,
          content: [{ type: 'text', text: COMPANION_NOTIFY_QUEUED_TEXT }],
        } as never,
      ],
      turnId: 'turn-1' as never,
      completedAt: 1_000,
      taskKind: 'research requested in motivation prose',
    }, 'extended');

    expect(actions[0]?.payload).not.toHaveProperty('continuationTaskKind');
    expect(actions[0]?.payload).not.toHaveProperty('candidateOrigin');
  });

  it('registers a background post-turn handler that revalidates before W3 execution', async () => {
    const owner = runtime();
    let handler: PostTurnActionHandler | undefined;
    const unregisterHandler = vi.fn();
    const unregisterInferer = vi.fn();
    const dispose = registerDeferredCompanionOutreachRuntime({
      agentLoop: { registerPostTurnActionInferer: vi.fn(() => unregisterInferer) },
      postTurnActions: {
        registerHandler: vi.fn((_kind, callback, options) => {
          handler = callback;
          expect(options).toEqual({ executionMode: 'background' });
          return unregisterHandler;
        }),
      } as never,
      runtime: owner,
      resolveOriginCatalogSource: () => 'extended',
      isExecutionAuthorized: () => true,
    });
    await handler?.({
      id: 'action-1',
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload: {
        contactId: 'peer-contact-b',
        permitId: PERMIT_ID,
        candidateOrigin: CANDIDATE_ORIGIN,
        authorization: ORIGIN_AUTHORIZATION,
      },
    } as InferredPostTurnAction);
    expect(owner.executeCompanionOutreach).toHaveBeenCalledWith(
      'peer-contact-b',
      PERMIT_ID,
      CANDIDATE_ORIGIN,
      expect.any(Function),
    );
    dispose();
    expect(unregisterHandler).toHaveBeenCalledOnce();
    expect(unregisterInferer).toHaveBeenCalledOnce();
  });

  it('rechecks capability and tool registration before deferred execution', async () => {
    const owner = runtime();
    let handler: PostTurnActionHandler | undefined;
    registerDeferredCompanionOutreachRuntime({
      agentLoop: {},
      postTurnActions: {
        registerHandler: vi.fn((_kind, callback) => {
          handler = callback;
          return () => undefined;
        }),
      } as never,
      runtime: owner,
      resolveOriginCatalogSource: () => null,
      isExecutionAuthorized: () => false,
    });
    await expect(handler?.({
      id: 'action-disabled',
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload: {
        contactId: 'peer-contact-b',
        permitId: PERMIT_ID,
        authorization: ORIGIN_AUTHORIZATION,
      },
    } as InferredPostTurnAction)).rejects.toThrow(/no longer capability\/tool-policy authorized/i);
    expect(owner.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('rejects unknown persisted payload fields before execution', async () => {
    const owner = runtime();
    let handler: PostTurnActionHandler | undefined;
    registerDeferredCompanionOutreachRuntime({
      agentLoop: {},
      postTurnActions: {
        registerHandler: vi.fn((_kind, callback) => {
          handler = callback;
          return () => undefined;
        }),
      } as never,
      runtime: owner,
      resolveOriginCatalogSource: () => null,
      isExecutionAuthorized: () => true,
    });
    await expect(handler?.({
      id: 'action-malformed',
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload: {
        contactId: 'peer-contact-b',
        permitId: PERMIT_ID,
        authorization: ORIGIN_AUTHORIZATION,
        message: 'forbidden',
      },
    } as InferredPostTurnAction)).rejects.toThrow(/payload is malformed/i);
    expect(owner.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('uses durable origin catalog evidence after restart without requiring ephemeral activation state', () => {
    const authorizationRuntime: DeferredCompanionOutreachAuthorizationRuntime = {
      hasExternalCompanionCapability: () => true,
      isNotifyToolRegistered: () => true,
    };
    expect(isDeferredCompanionOutreachExecutionAuthorized(
      ORIGIN_AUTHORIZATION,
      authorizationRuntime,
    )).toBe(true);
  });

  it.each([
    ['authorization v1', { ...ORIGIN_AUTHORIZATION, version: 1 }],
    ['unknown authorization field', { ...ORIGIN_AUTHORIZATION, unexpected: true }],
    ['malformed catalog evidence', { ...ORIGIN_AUTHORIZATION, catalogSource: 'promoted' }],
  ])('rejects stale or malformed persisted %s', (_name, evidence) => {
    expect(parseDeferredCompanionOutreachAuthorizationEvidence(evidence)).toBeNull();
  });

  it.each([
    { name: 'capability revocation', capability: false, registered: true },
    { name: 'tool removal or wiring disable', capability: true, registered: false },
  ])('fails closed on current $name', ({ capability, registered }) => {
    const authorizationRuntime: DeferredCompanionOutreachAuthorizationRuntime = {
      hasExternalCompanionCapability: () => capability,
      isNotifyToolRegistered: () => registered,
    };
    expect(isDeferredCompanionOutreachExecutionAuthorized(
      ORIGIN_AUTHORIZATION,
      authorizationRuntime,
    )).toBe(false);
  });

  it('rejects a persisted action without exact origin authorization evidence', async () => {
    const owner = runtime();
    let handler: PostTurnActionHandler | undefined;
    registerDeferredCompanionOutreachRuntime({
      agentLoop: {},
      postTurnActions: {
        registerHandler: vi.fn((_kind, callback) => {
          handler = callback;
          return () => undefined;
        }),
      } as never,
      runtime: owner,
      resolveOriginCatalogSource: () => null,
      isExecutionAuthorized: () => true,
    });
    await expect(handler?.({
      id: 'action-no-origin',
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload: { contactId: 'peer-contact-b', permitId: PERMIT_ID },
    } as InferredPostTurnAction)).rejects.toThrow(/payload is malformed/i);
    expect(owner.executeCompanionOutreach).not.toHaveBeenCalled();
  });
});
