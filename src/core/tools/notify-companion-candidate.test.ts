import { Value } from '@sinclair/typebox/value';
import { describe, expect, it, vi } from 'vitest';

import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import { wirePostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import type { PostTurnActionHandler } from '../agent/post-turn-action-runtime.js';
import type { IcpInitiationSourceRuntime } from '../icp/initiation-source-runtime.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { toInferredPostTurnActions } from '../intention/appraisal/action-translation.js';
import { createNotifyTool, type NotifyDispatcher } from './ntfy.js';
import {
  COMPANION_CANDIDATE_QUEUED_TEXT,
  ICP_INITIATION_CANDIDATE_ACTION_KIND,
  inferIcpInitiationCandidateActions,
  registerIcpInitiationCandidatePostTurnRuntime,
} from './notify-companion-candidate.js';

const params = {
  action: 'consider',
  target_kind: 'companion',
  contact_id: 'peer-contact',
  reason_summary: 'I would like to catch up.',
} as const;

function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map(part => part.text).join('');
}

function context(channelId: string, icpRoot?: string, durableRoot?: string) {
  return {
    message: {
      id: 'source-message',
      channelId,
      ...((icpRoot || durableRoot)
        ? {
            routing: {
              ...(icpRoot ? { icpCorrelation: { rootInitiationId: icpRoot } } : {}),
              ...(durableRoot ? { originIcpRootInitiationId: durableRoot } : {}),
            },
          }
        : {}),
    } as never,
    response: {} as never,
    turnMessages: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'candidate-call', name: 'notify', arguments: params }],
      } as never,
      {
        role: 'toolResult',
        toolCallId: 'candidate-call',
        toolName: 'notify',
        isError: false,
        content: [{ type: 'text', text: COMPANION_CANDIDATE_QUEUED_TEXT }],
      } as never,
    ],
    turnId: 'turn-1' as never,
    completedAt: 1_000,
  };
}

describe('notify companion candidate action', () => {
  it('advertises a strict private candidate variant with no message or permit', () => {
    const tool = createNotifyTool({ dispatch: vi.fn() } as NotifyDispatcher, {
      companionCandidateEnabled: true,
    });
    expect(Value.Check(tool.parameters, params)).toBe(true);
    expect(Value.Check(tool.parameters, { ...params, message: 'bypass' })).toBe(false);
    expect(Value.Check(tool.parameters, { ...params, initiation_permit: 'x' })).toBe(false);
  });

  it('returns only a queued marker and does not send during the tool call', async () => {
    const dispatcher: NotifyDispatcher = { dispatch: vi.fn() };
    const authorizedTool = createNotifyTool(dispatcher, {
      companionCandidateEnabled: true,
      isCompanionCandidateAuthorized: () => true,
    });
    const output = await authorizedTool.execute('candidate-call', params as never);
    expect(text(output)).toBe(COMPANION_CANDIDATE_QUEUED_TEXT);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('does not report queued success when live companion authorization is unavailable', async () => {
    const dispatcher: NotifyDispatcher = { dispatch: vi.fn() };
    const tool = createNotifyTool(dispatcher, {
      companionCandidateEnabled: true,
      isCompanionCandidateAuthorized: () => false,
    });

    const output = await tool.execute('candidate-call', params as never);

    expect(output.details).toMatchObject({ isError: true });
    expect(text(output)).toContain('not capability/tool-policy authorized');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['internal:free-time:idle', 'free_time'],
    ['discord:owner', 'foreground'],
  ] as const)('infers %s only after the successful tool result', (channelId, source) => {
    const actions = inferIcpInitiationCandidateActions(context(channelId), 'extended');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: ICP_INITIATION_CANDIDATE_ACTION_KIND,
      payload: {
        request: {
          source,
          peerContactId: 'peer-contact',
          sourceRecordId: 'turn-1:candidate-call',
          reasonSummary: params.reason_summary,
          cause: { kind: 'independent' },
        },
      },
    });
  });

  it('preserves an inherited ICP root instead of minting a recursive root', () => {
    const root = '55555555-5555-4555-8555-555555555555';
    const actions = inferIcpInitiationCandidateActions(context('companion-dm:a:b', root), 'extended');
    expect(actions[0]?.payload).toMatchObject({
      request: { cause: { kind: 'icp_conversation', rootInitiationId: root } },
    });
  });

  it('consumes durable generated-turn lineage and rejects malformed or conflicting roots', () => {
    const root = '55555555-5555-4555-8555-555555555555';
    const otherRoot = '66666666-6666-4666-8666-666666666666';
    const durable = inferIcpInitiationCandidateActions(
      context('discord:owner', undefined, root),
      'extended',
    );
    expect(durable[0]?.payload).toMatchObject({
      request: { cause: { kind: 'icp_conversation', rootInitiationId: root } },
    });
    expect(() => inferIcpInitiationCandidateActions(
      context('companion-dm:a:b', root, otherRoot),
      'extended',
    )).toThrow('conflicting ICP root lineage');
    expect(() => inferIcpInitiationCandidateActions(
      context('discord:owner', undefined, 'not-a-root'),
      'extended',
    )).toThrow('malformed ICP root lineage (durable)');
  });

  it('registers a foreground-idle handler and revalidates capability before submit', async () => {
    const runtime: IcpInitiationSourceRuntime = { submit: vi.fn().mockResolvedValue({ outcome: 'sent' }) };
    let handler: PostTurnActionHandler | undefined;
    registerIcpInitiationCandidatePostTurnRuntime({
      agentLoop: { registerPostTurnActionInferer: vi.fn(() => () => undefined) },
      postTurnActions: {
        registerHandler: vi.fn((_kind, callback, options) => {
          handler = callback;
          expect(options).toBeUndefined();
          return () => undefined;
        }),
      } as never,
      runtime,
      resolveOriginCatalogSource: () => null,
      isExecutionAuthorized: () => true,
    });
    const actions = inferIcpInitiationCandidateActions(context('discord:owner'), 'extended');
    const action = actions.at(0);
    if (!action) throw new Error('expected a durable companion candidate action');
    await handler?.({ id: 'action', kind: action.kind, payload: action.payload } as InferredPostTurnAction);
    expect(runtime.submit).toHaveBeenCalledOnce();
  });

  it('executes free-time and foreground choices through the post-turn appraisal lane', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
    });
    const waitForIdle = vi.fn().mockResolvedValue(undefined);
    const postTurnActions = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop: { waitForIdle },
      intervalMs: 1,
    });
    const runtime: IcpInitiationSourceRuntime = {
      submit: vi.fn().mockResolvedValue({
        outcome: 'sent',
        candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'consumed',
      }),
    };
    registerIcpInitiationCandidatePostTurnRuntime({
      agentLoop: { registerPostTurnActionInferer: vi.fn(() => () => undefined) },
      postTurnActions,
      runtime,
      resolveOriginCatalogSource: () => null,
      isExecutionAuthorized: () => true,
    });
    const inferredContext = context('internal:free-time:idle');
    const candidates = inferIcpInitiationCandidateActions(
      inferredContext,
      'extended',
    );
    const message = {
      id: 'source-message',
      channelId: 'internal:free-time:idle',
      channelType: 'terminal' as const,
      authorId: 'scheduler',
      authorName: 'Free Time',
      content: 'Use the ordinary internal turn.',
      timestamp: new Date(),
    };
    await eventBus.emit('agent.post_turn.actions.inferred', {
      message,
      response: {
        content: '',
        channelId: message.channelId,
        metadata: {
          model: 'test',
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
        },
      },
      actions: toInferredPostTurnActions(candidates, message),
    });
    expect(runtime.submit).not.toHaveBeenCalled();
    await scheduler.tick();
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(runtime.submit).toHaveBeenCalledOnce();
  });
});
