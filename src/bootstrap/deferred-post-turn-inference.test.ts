import { describe, expect, it, vi } from 'vitest';
import { DEFERRED_TOOL_HANDOFF_ACTION_KIND } from '../agent/deferred-tool-handoff.js';
import {
  inferComposedDeferredPostTurnActions,
  inferDeferredPostTurnActions,
} from './deferred-post-turn-inference.js';

describe('inferDeferredPostTurnActions', () => {
  it('extracts deferred heartbeat actions from heartbeat_run_template tool results', () => {
    const actions = inferDeferredPostTurnActions({
      message: {
        id: 'msg-1',
        channelId: 'terminal:dev',
        channelType: 'terminal',
        authorId: 'user-1',
        authorName: 'Test User',
        content: 'trigger heartbeat',
        timestamp: new Date(),
      },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'heartbeat_run_template',
        result: {
          details: {
            deferredAction: {
              kind: 'heartbeat.run_template',
              payload: { templateId: 'whisper' },
              dedupeKey: 'heartbeat.run_template:whisper',
              maxRetries: 2,
            },
          },
        },
      }, {
        role: 'toolResult',
        toolName: 'heartbeat_run_template',
        result: {
          details: {
            deferredAction: {
              kind: 'other.action',
              payload: { ignored: true },
            },
          },
        },
      }],
      deferredHeartbeatActionKind: 'heartbeat.run_template',
    });

    expect(actions).toEqual([{
      kind: 'heartbeat.run_template',
      payload: { templateId: 'whisper' },
      dedupeKey: 'heartbeat.run_template:whisper',
      maxRetries: 2,
    }]);
  });

  it('builds deferred tool handoff actions and forwards normalized payloads', () => {
    const onDeferredToolHandoffPayload = vi.fn();
    const actions = inferDeferredPostTurnActions({
      message: {
        id: 'msg-2',
        channelId: 'internal:reflection:whisper',
        channelType: 'terminal',
        authorId: 'user-2',
        authorName: 'Test User',
        content: 'continue with extended tools',
        timestamp: new Date(),
      },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'toolset',
        result: {
          details: {
            deferredToolHandoff: {
              toolNames: [' extended_probe_tool ', 'extended_probe_tool'],
              intendedAction: '  collect diagnostics  ',
              maxRetries: 1,
            },
          },
        },
      }],
      deferredHeartbeatActionKind: 'heartbeat.run_template',
      onDeferredToolHandoffPayload,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: DEFERRED_TOOL_HANDOFF_ACTION_KIND,
      maxRetries: 1,
      payload: {
        toolNames: ['extended_probe_tool'],
        intendedAction: 'collect diagnostics',
        turn: {
          turnId: 'msg-2',
          requestId: 'msg-2',
          channelId: 'internal:reflection:whisper',
          channelType: 'terminal',
          authorId: 'user-2',
          authorName: 'Test User',
          callType: 'scheduled',
        },
      },
    });

    const dedupeKey = actions[0]?.dedupeKey;
    expect(dedupeKey).toContain(`${DEFERRED_TOOL_HANDOFF_ACTION_KIND}:msg-2:`);
    expect(onDeferredToolHandoffPayload).toHaveBeenCalledWith(
      dedupeKey,
      expect.objectContaining({
        toolNames: ['extended_probe_tool'],
        intendedAction: 'collect diagnostics',
      }),
    );
  });

  it('composes signal passes and deduplicates repeated deferred tool handoffs', async () => {
    const onDeferredToolHandoffPayload = vi.fn();
    const actions = await inferComposedDeferredPostTurnActions({
      message: {
        id: 'msg-3',
        channelId: 'terminal:dev',
        channelType: 'terminal',
        authorId: 'user-3',
        authorName: 'Test User',
        content: 'continue with extended tools',
        timestamp: new Date(),
      },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'toolset',
        result: {
          details: {
            deferredToolHandoff: {
              toolNames: ['extended_probe_tool'],
              intendedAction: 'Collect diagnostics.',
              maxRetries: 1,
            },
          },
        },
      }, {
        role: 'toolResult',
        toolName: 'toolset',
        result: {
          details: {
            deferredToolHandoff: {
              toolNames: ['extended_probe_tool'],
              intendedAction: 'Collect diagnostics.',
              maxRetries: 1,
            },
          },
        },
      }],
      deferredHeartbeatActionKind: 'heartbeat.run_template',
      onDeferredToolHandoffPayload,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: DEFERRED_TOOL_HANDOFF_ACTION_KIND,
      payload: {
        toolNames: ['extended_probe_tool'],
        intendedAction: 'Collect diagnostics.',
      },
    });
    expect(onDeferredToolHandoffPayload).toHaveBeenCalledTimes(2);
  });
});
