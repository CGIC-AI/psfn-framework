import { describe, expect, it } from 'vitest';
import {
  inferDeferredPostTurnActions,
} from './deferred-post-turn-inference.js';

describe('inferDeferredPostTurnActions', () => {
  it('extracts deferred reflection actions from schedule tool results', () => {
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
        toolName: 'schedule',
        result: {
          details: {
            deferredAction: {
              kind: 'heartbeat.run_template',
              payload: { templateId: 'daily-review' },
              dedupeKey: 'heartbeat.run_template:daily-review',
              maxRetries: 2,
            },
          },
        },
      }, {
        role: 'toolResult',
        toolName: 'schedule',
        result: {
          details: {
            deferredAction: {
              kind: 'other.action',
              payload: { ignored: true },
            },
          },
        },
      }],
      deferredReflectionActionKind: 'heartbeat.run_template',
    });

    expect(actions).toEqual([{
      kind: 'heartbeat.run_template',
      payload: { templateId: 'daily-review' },
      dedupeKey: 'heartbeat.run_template:daily-review',
      maxRetries: 2,
    }]);
  });

  it('extracts deferred reflection actions from schedule run_template tool results', () => {
    const actions = inferDeferredPostTurnActions({
      message: {
        id: 'msg-schedule',
        channelId: 'terminal:dev',
        channelType: 'terminal',
        authorId: 'user-1',
        authorName: 'Test User',
        content: 'trigger heartbeat through schedule',
        timestamp: new Date(),
      },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'schedule',
        result: {
          content: [{ type: 'text', text: 'Queued manual reflection run "Musing" (musing) for post-turn execution.' }],
          details: {
            deferredAction: {
              kind: 'heartbeat.run_template',
              payload: { templateId: 'musing', sendToDiscordOverride: false },
              dedupeKey: 'heartbeat.run_template:musing:discord:false',
              maxRetries: 2,
            },
          },
        },
      }],
      deferredReflectionActionKind: 'heartbeat.run_template',
    });

    expect(actions).toEqual([{
      kind: 'heartbeat.run_template',
      payload: { templateId: 'musing', sendToDiscordOverride: false },
      dedupeKey: 'heartbeat.run_template:musing:discord:false',
      maxRetries: 2,
    }]);
  });

});
