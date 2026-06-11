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

describe('AgentApiBackend direct model completions', () => {
  function createBackend(overrides: {
    complete?: ReturnType<typeof vi.fn>;
    handleMessage?: ReturnType<typeof vi.fn>;
    llmProvider?: false;
  } = {}) {
    const complete = overrides.complete ?? vi.fn(async () => ({
      content: 'raw model reply',
      toolCalls: [],
      model: 'claude-fable-5',
      inputTokens: 5,
      outputTokens: 9,
      stopReason: 'stop',
    }));
    const handleMessage = overrides.handleMessage ?? vi.fn(() => new Promise(() => undefined));
    const backend = new AgentApiBackend({
      agentLoop: { handleMessage, abort: vi.fn() } as any,
      eventBus: new EventBus(),
      sessionManager: createSessionManagerStub(),
      ...(overrides.llmProvider === false
        ? {}
        : { llmProvider: { complete, stream: vi.fn() } as any }),
    });
    return { backend, complete, handleMessage };
  }

  const participantRequest = {
    model: 'anthropic/claude-fable-5',
    provider: 'anthropic',
    messages: [{ role: 'user' as const, content: 'Hello raw model' }],
  };

  it('bypasses the companion pipeline and pins the overridden model', async () => {
    const { backend, complete, handleMessage } = createBackend();

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-1',
      request: { ...participantRequest, system_prompt_mode: 'none' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: { 'x-channel-id': 'model-room:room-1:claude-fable' },
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    const [context, purpose] = complete.mock.calls[0];
    expect(purpose).toBe('reasoning');
    expect(context.systemPrompt).toBe('');
    expect(context.messages).toEqual([{ role: 'user', content: 'Hello raw model' }]);
    expect(context.modelHint).toEqual({
      provider: 'anthropic',
      model: 'anthropic/claude-fable-5',
      pin: true,
    });
    expect(result).toEqual({
      ok: true,
      response: {
        content: 'raw model reply',
        channelId: 'model-room:room-1:claude-fable',
        inputTokens: 5,
        outputTokens: 9,
      },
    });
  });

  it('passes a custom system prompt through to the raw completion', async () => {
    const { backend, complete } = createBackend();

    await backend.handleChatCompletion({
      requestId: 'req-direct-2',
      request: {
        ...participantRequest,
        system_prompt_mode: 'custom',
        system_prompt: 'You are a frank advisor.',
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(complete.mock.calls[0][0].systemPrompt).toBe('You are a frank advisor.');
  });

  it('defaults to the raw path when a provider override has no system_prompt_mode', async () => {
    const { backend, complete, handleMessage } = createBackend();

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-3',
      request: { ...participantRequest },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('keeps the companion pipeline when system_prompt_mode=default is explicit', async () => {
    const handleMessage = vi.fn(() => new Promise(() => undefined));
    const { backend, complete } = createBackend({ handleMessage });

    const resultPromise = backend.handleChatCompletion({
      requestId: 'req-direct-4',
      request: { ...participantRequest, system_prompt_mode: 'default' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: { 'x-session-id': 'pipeline-session' },
      timeoutMs: 1_000,
    });

    const result = await resultPromise;
    expect(complete).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it('rejects system-role messages on the raw path', async () => {
    const { backend, complete } = createBackend();

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-5',
      request: {
        ...participantRequest,
        messages: [
          { role: 'system' as const, content: 'sneaky system prompt' },
          { role: 'user' as const, content: 'hi' },
        ],
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(complete).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
    }
  });

  it('fails closed when no LLM provider port is configured', async () => {
    const { backend, handleMessage } = createBackend({ llmProvider: false });

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-6',
      request: { ...participantRequest, system_prompt_mode: 'none' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(503);
      expect(result.error.type).toBe('direct_model_unavailable');
    }
  });

  it('surfaces pinned-model failures instead of falling back', async () => {
    const complete = vi.fn(async () => {
      throw new Error('404 No endpoints available');
    });
    const { backend } = createBackend({ complete });

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-7',
      request: { ...participantRequest, system_prompt_mode: 'none' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(502);
      expect(result.error.type).toBe('model_error');
      expect(result.error.message).toContain('anthropic/claude-fable-5');
      expect(result.error.message).toContain('404 No endpoints available');
    }
  });
});
