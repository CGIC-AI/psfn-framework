import { describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import type { AgentFacingIcpAutonomyRuntime } from '../icp/agent-facing-autonomy.js';
import type { PostTurnActionHandler } from '../agent/post-turn-action-runtime.js';
import { createNotifyTool, type NotifyDispatcher } from './ntfy.js';
import {
  COMPANION_NOTIFY_QUEUED_TEXT,
  DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
  inferDeferredCompanionOutreachActions,
  isDeferredCompanionOutreachExecutionAuthorized,
  registerDeferredCompanionOutreachRuntime,
  type DeferredCompanionOutreachAuthorizationEvidence,
  type DeferredCompanionOutreachAuthorizationRuntime,
} from './notify-companion-handoff.js';

const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const ORIGIN_AUTHORIZATION: DeferredCompanionOutreachAuthorizationEvidence = {
  version: 1,
  toolName: 'notify',
  toolScope: 'extended',
  activationSource: 'extended_loaded',
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

describe('permit-governed notify companion handoff', () => {
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
    }, 'extended_loaded');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload: {
        contactId: 'peer-contact-b',
        permitId: PERMIT_ID,
        authorization: ORIGIN_AUTHORIZATION,
      },
      maxRetries: 2,
    });
    expect(actions[0]?.dedupeKey).not.toContain(PERMIT_ID);
  });

  it('does not persist outreach without current origin overlay evidence', () => {
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
      resolveOriginActivationSource: () => 'extended_loaded',
      isExecutionAuthorized: () => true,
    });
    await handler?.({
      id: 'action-1',
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload: {
        contactId: 'peer-contact-b',
        permitId: PERMIT_ID,
        authorization: ORIGIN_AUTHORIZATION,
      },
    } as InferredPostTurnAction);
    expect(owner.executeCompanionOutreach).toHaveBeenCalledWith(
      'peer-contact-b',
      PERMIT_ID,
      expect.any(Function),
    );
    dispose();
    expect(unregisterHandler).toHaveBeenCalledOnce();
    expect(unregisterInferer).toHaveBeenCalledOnce();
  });

  it('rechecks capability and tool-overlay authorization before deferred execution', async () => {
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
      resolveOriginActivationSource: () => null,
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
      resolveOriginActivationSource: () => null,
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

  it('uses durable origin evidence after restart without requiring the ephemeral active overlay', () => {
    const authorizationRuntime: DeferredCompanionOutreachAuthorizationRuntime = {
      hasExternalCompanionCapability: () => true,
      isNotifyToolRegistered: () => true,
      isNotifyOverlayEligible: () => true,
      getNotifyActivationSource: () => null,
    };
    expect(isDeferredCompanionOutreachExecutionAuthorized(
      ORIGIN_AUTHORIZATION,
      authorizationRuntime,
    )).toBe(true);
  });

  it.each([
    { name: 'capability revocation', capability: false, registered: true, overlay: true },
    { name: 'tool removal or wiring disable', capability: true, registered: false, overlay: true },
    { name: 'overlay policy disable', capability: true, registered: true, overlay: false },
  ])('fails closed on current $name', ({ capability, registered, overlay }) => {
    const authorizationRuntime: DeferredCompanionOutreachAuthorizationRuntime = {
      hasExternalCompanionCapability: () => capability,
      isNotifyToolRegistered: () => registered,
      isNotifyOverlayEligible: () => overlay,
      getNotifyActivationSource: () => null,
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
      resolveOriginActivationSource: () => null,
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
