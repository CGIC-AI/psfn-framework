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
