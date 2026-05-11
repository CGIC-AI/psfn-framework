import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { AgentApiBackend } from './agent-backend.js';

function createSessionManagerStub() {
  return {
    getMessageCount: vi.fn(() => 0),
    recordUserMessage: vi.fn(),
    recordAssistantMessage: vi.fn(),
  } as any;
}

describe('AgentApiBackend chat completion deadlines', () => {
  it('returns at visible turn completion instead of waiting for post-turn cleanup', async () => {
    vi.useFakeTimers();
    try {
      const eventBus = new EventBus();
      const response = {
        content: 'visible answer',
        channelId: 'api:principal-1:completion-session',
        metadata: {
          inputTokens: 11,
          outputTokens: 7,
        },
      };
      const backend = new AgentApiBackend({
        agentLoop: {
          handleMessage: vi.fn((message) => {
            setTimeout(() => {
              void eventBus.emit('agent.turn.end', { message, response } as any);
            }, 10);
            return new Promise(() => undefined);
          }),
          abort: vi.fn(),
        } as any,
        eventBus,
        sessionManager: createSessionManagerStub(),
      });

      const resultPromise = backend.handleChatCompletion({
        requestId: 'req-visible-complete',
        request: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Finish before cleanup' }],
        },
        principal: { id: 'principal-1', mode: 'api_key' },
        headers: { 'x-session-id': 'completion-session' },
        timeoutMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(resultPromise).resolves.toEqual({
        ok: true,
        response: {
          content: 'visible answer',
          channelId: 'api:principal-1:completion-session',
          inputTokens: 11,
          outputTokens: 7,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the substrate turn and returns request_timeout when the RPC deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn();
      const backend = new AgentApiBackend({
        agentLoop: {
          handleMessage: vi.fn(() => new Promise(() => undefined)),
          abort,
        } as any,
        eventBus: new EventBus(),
        sessionManager: createSessionManagerStub(),
      });

      const resultPromise = backend.handleChatCompletion({
        requestId: 'req-timeout',
        request: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Long task' }],
        },
        principal: { id: 'principal-1', mode: 'api_key' },
        headers: { 'x-session-id': 'deadline-session' },
        timeoutMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(abort).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        ok: false,
        error: {
          status: 504,
          type: 'request_timeout',
          message: 'Request timed out before turn completed',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
